/**
 * WEB-13〜15 + お知らせ against the real local stack. Student requests are made through the API with a Bearer
 * token (as the iOS app does) and must appear in the Web list within the 5-second polling interval.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { fixture, loginAs } from "./helpers";
import { WEB_ORIGIN, createSlot, createStudent, expectAccessible, jstDate, requestReservation, uniq, webApi } from "./booking-helpers";

// Signed-in storage state lives outside the repository (it contains session cookies).
const ADMIN_STATE = join(tmpdir(), `arms-e2e-booking-admin-${process.pid}.json`);
const TEACHER_STATE = join(tmpdir(), `arms-e2e-booking-teacher-${process.pid}.json`);

async function saveLogin(browser: Browser, role: "admin" | "teacher", path: string) {
  // Explicit empty state: newContext would otherwise inherit the describe-level storageState being created here.
  const ctx = await browser.newContext({ baseURL: WEB_ORIGIN, locale: "ja-JP", timezoneId: "Asia/Tokyo", storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await loginAs(page, role);
  await ctx.storageState({ path });
  await ctx.close();
}

// One sign-in per role for the whole file (the login endpoint is rate limited per account).
test.beforeAll(async ({ browser }) => {
  await saveLogin(browser, "admin", ADMIN_STATE);
  await saveLogin(browser, "teacher", TEACHER_STATE);
});

/**
 * Days ahead for seeded lessons. Each repeat/retry of a test shifts its lessons by two weeks so reruns against the
 * same organisation never hit the teacher's time-overlap constraint.
 */
const day = (n: number) => n + 14 * (test.info().repeatEachIndex + 4 * test.info().retry);

/** A slot of the fixture teacher in the fixture classroom, `days` ahead at a distinct hour. */
async function seedSlot(page: Page, opts: { days: number; start: string; end: string; title?: string; meetingUrl?: string; capacity?: number }) {
  const f = fixture();
  return createSlot(page, {
    classroomId: f.classroomId,
    teacherId: f.teacher.id,
    title: opts.title ?? `IT基礎 ${uniq()}`,
    date: jstDate(day(opts.days)),
    start: opts.start,
    end: opts.end,
    meetingUrl: opts.meetingUrl,
    capacity: opts.capacity,
  });
}

async function seedStudent(page: Page, name: string) {
  const f = fixture();
  return createStudent(page, { classroomId: f.classroomId, teacherId: f.teacher.id, name });
}

/** Toast title/description (Radix also mirrors toasts into a hidden live region, hence the exact match). */
const toast = (page: Page, text: string) => page.getByText(text, { exact: true });

const requestsTable = (page: Page) => page.getByRole("table", { name: "予約申請の一覧" });
const rowOf = (page: Page, text: string) => requestsTable(page).getByRole("row").filter({ hasText: text });

test.describe("オンライン予約システム（管理者）", () => {
  test.use({ storageState: ADMIN_STATE });

  test("受講者の申請が5秒以内に予約申請一覧へ表示され、承認すると承認済みになる", async ({ page }) => {
    await page.goto("/bookings");
    await expect(page.getByRole("heading", { level: 1, name: "オンライン予約システム" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /予約申請/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("承認待ちの申請も、保持期限までは席を確保します。却下・取消・削除・期限切れで席が解放されます。")).toBeVisible();

    const slot = await seedSlot(page, { days: 3, start: "10:00", end: "11:30" });
    const student = await seedStudent(page, `和田 一夫 ${uniq()}`);
    // The page is already open: only the 5-second polling can bring the new request in.
    const requestedAt = Date.now();
    await requestReservation(student, slot.id);
    const row = rowOf(page, student.name);
    await expect(row).toBeVisible({ timeout: 6_500 });
    expect(Date.now() - requestedAt).toBeLessThan(6_500);
    await expect(row.getByText("承認待ち")).toBeVisible();
    await expect(page.getByRole("tab", { name: /予約申請.*承認待ち/ })).toBeVisible();
    await expect(page.getByText(/最終取得/).first()).toBeVisible();
    await expectAccessible(page);

    await row.getByRole("button", { name: /^承認/ }).click();
    await expect(toast(page, "予約を承認しました")).toBeVisible();
    await expect(row.getByText("承認済み")).toBeVisible();
    await expect(row.getByRole("button", { name: /^承認/ })).toHaveCount(0);
  });

  test("却下には1〜1,000文字の理由が必須で、理由を見るで確認できる", async ({ page }) => {
    const slot = await seedSlot(page, { days: 3, start: "13:00", end: "14:00" });
    const student = await seedStudent(page, `鈴木 大輔 ${uniq()}`);
    await requestReservation(student, slot.id);
    await page.goto("/bookings");
    const row = rowOf(page, student.name);
    await row.getByRole("button", { name: /^却下/ }).click();
    const dialog = page.getByRole("dialog", { name: "予約申請を却下" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(student.name)).toBeVisible();
    await dialog.getByRole("button", { name: "却下する" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("理由を入力してください（1〜1,000文字）。");
    await expectAccessible(page);
    await dialog.getByLabel(/却下の理由/).fill("講師の日程変更のため");
    await dialog.getByRole("button", { name: "却下する" }).click();
    await expect(dialog).toBeHidden();
    await expect(toast(page, "予約申請を却下しました")).toBeVisible();
    await expect(row.getByText("却下", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: /^理由を見る/ }).click();
    const reason = page.getByRole("dialog", { name: "理由" });
    await expect(reason.getByText("講師の日程変更のため")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(reason).toBeHidden();
  });

  test("削除は「予約を削除し、履歴を保持します」の確認と理由が必要で、履歴タブに残る", async ({ page }) => {
    const slot = await seedSlot(page, { days: 3, start: "15:00", end: "16:00" });
    const student = await seedStudent(page, `高橋 健太 ${uniq()}`);
    const reservation = await requestReservation(student, slot.id);
    const approved = await webApi(page, { method: "POST", path: `/reservations/${reservation.id}/approve`, body: { expected_version: reservation.row_version } });
    expect(approved.status).toBe(200);

    await page.goto("/bookings");
    const row = rowOf(page, student.name);
    await expect(row.getByText("承認済み")).toBeVisible();
    await row.getByRole("button", { name: /^削除/ }).click();
    const confirm = page.getByRole("alertdialog", { name: "予約を削除" });
    await expect(confirm.getByText("予約を削除し、履歴を保持します。")).toBeVisible();
    await confirm.getByRole("button", { name: "削除する" }).click();
    await expect(confirm.getByRole("alert")).toHaveText("理由を入力してください（1〜1,000文字）。");
    await confirm.getByLabel(/削除の理由/).fill("受講者から欠席の連絡があったため");
    await confirm.getByRole("button", { name: "削除する" }).click();
    await expect(confirm).toBeHidden();
    await expect(toast(page, "予約を削除しました")).toBeVisible();
    await expect(row).toHaveCount(0);

    await page.getByRole("tab", { name: "履歴" }).click();
    await expect(page).toHaveURL(/tab=history/);
    const historyRow = page.getByRole("table", { name: "予約の履歴" }).getByRole("row").filter({ hasText: student.name });
    await expect(historyRow.getByText("削除済み")).toBeVisible();
    await expect(historyRow.getByText("受講者から欠席の連絡があったため")).toBeVisible();
    await expectAccessible(page);

    // The history (audit) survives on the detail page.
    await historyRow.getByRole("link", { name: /^詳細/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "予約申請の確認" })).toBeVisible();
    await expect(page.getByText("この予約は削除済みです。")).toBeVisible();
    await expect(page.getByText("削除（履歴を保持）")).toBeVisible();
  });

  test("予約申請の確認: 保持期限・履歴を表示し、承認後は授業URLを表示する", async ({ page }) => {
    const slot = await seedSlot(page, { days: 4, start: "10:00", end: "11:00", meetingUrl: "https://meet.example.invalid/arms-e2e" });
    const student = await seedStudent(page, `加藤 美咲 ${uniq()}`);
    const reservation = await requestReservation(student, slot.id);
    await page.goto(`/bookings/reservations/${reservation.id}`);
    await expect(page.getByRole("heading", { level: 1, name: "予約申請の確認" })).toBeVisible();
    await expect(page.getByText("席の保持期限")).toBeVisible();
    await expect(page.getByText(/あと\d+時間\d+分/)).toBeVisible();
    await expect(page.getByText("予約申請 · 承認待ち")).toBeVisible();
    await expect(page.getByText("オンライン授業URL")).toHaveCount(0);
    await expectAccessible(page);

    // 却下 from the detail page requires the shared reason field.
    await page.getByRole("button", { name: "却下する" }).click();
    await expect(page.getByText("理由を入力してください（1〜1,000文字）。")).toBeVisible();
    await expect(page.getByLabel(/却下・削除の理由/)).toBeFocused();

    await page.getByRole("button", { name: "承認する" }).click();
    await expect(toast(page, "予約を承認しました")).toBeVisible();
    await expect(page.getByText("この予約は「承認済み」です。承認・却下は承認待ちの申請にのみ行えます。")).toBeVisible();
    await expect(page.getByRole("link", { name: /https:\/\/meet\.example\.invalid\/arms-e2e/ })).toBeVisible();
    await expect(page.getByText(/承認 · 承認済み/)).toBeVisible();
  });

  test("授業・予約枠を追加し、重複時間と編集の競合を日本語で案内する", async ({ page }) => {
    const f = fixture();
    const title = `ビジネスマナー ${uniq()}`;
    const date = jstDate(day(5));
    await page.goto("/bookings/slots/new");
    await expect(page.getByRole("heading", { level: 1, name: "授業・予約枠を追加" })).toBeVisible();
    await page.getByLabel(/授業名/).fill(title);
    await page.getByLabel(/^クラス/).selectOption(f.classroomId);
    await expect(page.getByLabel(/^担当講師/)).toHaveValue(f.teacher.id);
    await page.getByLabel(/^授業日/).fill(date);
    await page.getByLabel(/^開始時刻/).fill("09:00");
    await page.getByLabel(/^終了時刻/).fill("10:30");
    await expect(page.getByLabel(/^予約締切日/)).not.toHaveValue("");
    await page.getByLabel(/^定員/).fill("8");
    await page.getByLabel("オンライン授業URL").fill("http://insecure.example.invalid");
    await page.getByRole("button", { name: "枠を登録" }).click();
    await expect(page.getByText("https:// から始まるURLを入力してください。")).toBeVisible();
    await page.getByLabel("オンライン授業URL").fill("https://meet.example.invalid/manner");
    await expectAccessible(page);
    await page.getByRole("button", { name: "枠を登録" }).click();
    await expect(toast(page, "授業・予約枠を登録しました")).toBeVisible();
    await expect(page).toHaveURL(/\/bookings\/slots\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: "授業・予約枠を編集" })).toBeVisible();
    const slotId = page.url().split("/").pop() ?? "";

    // Same teacher, overlapping time → SLOT_TIME_CONFLICT with a Japanese explanation.
    await page.goto("/bookings/slots/new");
    await page.getByLabel(/授業名/).fill(`重複 ${uniq()}`);
    await page.getByLabel(/^クラス/).selectOption(f.classroomId);
    await expect(page.getByLabel(/^担当講師/)).toHaveValue(f.teacher.id);
    await page.getByLabel(/^授業日/).fill(date);
    await page.getByLabel(/^開始時刻/).fill("10:00");
    await page.getByLabel(/^終了時刻/).fill("11:00");
    await page.getByRole("button", { name: "枠を登録" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "同じ講師またはクラスで時間が重なる授業枠があります。" }).first()).toBeVisible();

    // Edit conflict: someone else updates the slot after the form was loaded.
    await page.goto(`/bookings/slots/${slotId}`);
    await expect(page.getByLabel(/授業名/)).toHaveValue(title);
    const current = await webApi<{ data: Record<string, unknown> & { row_version: number } }>(page, { method: "GET", path: `/lesson-slots/${slotId}` });
    const d = current.body.data;
    const changed = await webApi(page, {
      method: "PATCH",
      path: `/lesson-slots/${slotId}`,
      ifMatch: d.row_version,
      body: {
        classroom_id: d.classroom_id,
        teacher_id: d.teacher_id,
        title: `${title}（別の担当者が変更）`,
        starts_at: d.starts_at,
        ends_at: d.ends_at,
        capacity: d.capacity,
        booking_closes_at: d.booking_closes_at,
        meeting_url: d.meeting_url,
        cancel_before_seconds: d.cancel_before_seconds,
        state: d.state,
      },
    });
    expect(changed.status).toBe(200);
    await page.getByLabel(/^定員/).fill("12");
    await page.getByRole("button", { name: "変更を保存" }).click();
    await expect(page.getByText("情報が更新されました。再読み込みしてください。")).toBeVisible();
    await page.getByRole("button", { name: "最新の内容を読み込む" }).click();
    await expect(page.getByLabel(/授業名/)).toHaveValue(`${title}（別の担当者が変更）`);
    await page.getByLabel(/^定員/).fill("12");
    await page.getByRole("button", { name: "変更を保存" }).click();
    await expect(toast(page, "授業・予約枠を保存しました")).toBeVisible();
    await expect(page.locator("dt", { hasText: /^定員$/ }).locator("xpath=following-sibling::dd[1]")).toHaveText("12名");
  });

  test("授業カレンダーと空き枠管理に枠が表示され、授業を取消すと予約も取消済みになる", async ({ page }) => {
    const slot = await seedSlot(page, { days: 2, start: "16:30", end: "17:30", title: `研修振り返り ${uniq()}` });
    const student = await seedStudent(page, `佐藤 玲奈 ${uniq()}`);
    await requestReservation(student, slot.id);

    await page.goto(`/bookings?tab=calendar&week=${jstDate(day(2))}`);
    const card = page.getByRole("link", { name: new RegExp(slot.title) });
    await expect(card).toBeVisible();
    await expect(card).toContainText("残席 4 / 定員 5");
    await expectAccessible(page);
    await page.getByRole("button", { name: "次の週" }).click();
    await expect(page.getByRole("link", { name: new RegExp(slot.title) })).toHaveCount(0);
    await page.getByRole("button", { name: "前の週" }).click();
    await expect(card).toBeVisible();

    await page.getByRole("tab", { name: "空き枠管理" }).click();
    const slotRow = page.getByRole("table", { name: "授業・予約枠の一覧" }).getByRole("row").filter({ hasText: slot.title });
    await expect(slotRow).toContainText("5 / 残4");
    await expectAccessible(page);
    await slotRow.getByRole("button", { name: /^取消/ }).click();
    const confirm = page.getByRole("alertdialog", { name: "授業を取消" });
    await expect(confirm.getByText(/承認待ち1件・承認済み0件の予約はすべて取消済みになり/)).toBeVisible();
    await confirm.getByLabel(/取消の理由/).fill("講師の体調不良のため");
    await confirm.getByRole("button", { name: "授業を取消" }).click();
    await expect(toast(page, "授業を取り消しました")).toBeVisible();
    await expect(toast(page, "1件の予約を取消済みにし、受講者へ通知しました。")).toBeVisible();

    await page.getByRole("tab", { name: "履歴" }).click();
    const historyRow = page.getByRole("table", { name: "予約の履歴" }).getByRole("row").filter({ hasText: student.name });
    await expect(historyRow.getByText("取消済み")).toBeVisible();
    await expect(historyRow.getByText("講師の体調不良のため")).toBeVisible();
  });

  test("390px幅・ダークテーマでも予約申請を確認できる", async ({ page }) => {
    const slot = await seedSlot(page, { days: 6, start: "10:00", end: "11:00" });
    const student = await seedStudent(page, `伊藤 凛 ${uniq()}`);
    await requestReservation(student, slot.id);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/bookings");
    await expect(page.locator("html")).toHaveClass(/dark/);
    const row = rowOf(page, student.name);
    await expect(row).toBeAttached();
    // The page itself never scrolls sideways; the table scrolls inside its container.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await row.getByRole("button", { name: /^承認/ }).scrollIntoViewIfNeeded();
    await expect(row.getByRole("button", { name: /^承認/ })).toBeVisible();
    await expectAccessible(page);
    await page.goto("/bookings/slots/new");
    await expect(page.getByRole("button", { name: "枠を登録" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await expectAccessible(page);
  });
});

test.describe("講師の予約判断とお知らせ", () => {
  test.use({ storageState: TEACHER_STATE });

  test("講師は担当授業の申請通知を開くと既読になり、予約詳細へ移動できる", async ({ page, browser }) => {
    // Students are registered by an administrator.
    const adminCtx = await browser.newContext({ baseURL: WEB_ORIGIN, storageState: ADMIN_STATE, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
    const admin = await adminCtx.newPage();
    const slot = await seedSlot(admin, { days: 7, start: "10:00", end: "11:00" });
    const student = await seedStudent(admin, `中村 翔太 ${uniq()}`);
    await adminCtx.close();
    const reservation = await requestReservation(student, slot.id);

    await page.goto("/notifications");
    await expect(page.getByRole("heading", { level: 1, name: "お知らせ" })).toBeVisible();
    // The notification is produced by the outbox dispatcher (queue) shortly after the request.
    const item = page.getByRole("listitem").filter({ hasText: student.name });
    await expect(async () => {
      await page.reload();
      await expect(item).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await expect(item.getByRole("heading", { name: /予約申請が届きました/ })).toBeVisible();
    await expect(item.getByText("未読", { exact: true })).toBeVisible();
    await expectAccessible(page);

    // The radio input is visually hidden; users click its visible label.
    await page.locator("label").filter({ hasText: /^未読（/ }).click();
    await expect(page).toHaveURL(/status=unread/);
    await expect(page.getByRole("radio", { name: /未読/ })).toBeChecked();
    await expect(item).toBeVisible();

    const markRead = page.waitForResponse((r) => r.url().includes("/api/v1/notifications/") && r.url().endsWith("/read") && r.request().method() === "POST");
    await item.getByRole("link", { name: /予約の詳細を開く/ }).click();
    expect((await markRead).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/bookings/reservations/${reservation.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: "予約申請の確認" })).toBeVisible();

    // A teacher may decide reservations of their own lessons.
    await page.getByRole("button", { name: "承認する" }).click();
    await expect(toast(page, "予約を承認しました")).toBeVisible();

    await page.goto("/notifications?status=unread");
    await expect(page.getByRole("listitem").filter({ hasText: student.name })).toHaveCount(0);
    await page.goto("/notifications");
    await expect(page.getByRole("listitem").filter({ hasText: student.name }).getByText(/^既読/)).toBeVisible();
    const readAll = page.getByRole("button", { name: "すべて既読にする" });
    if (await readAll.isEnabled()) {
      await readAll.click();
      await expect(toast(page, "すべて既読にしました")).toBeVisible();
    }
    await expect(readAll).toBeDisabled();
    await expect(page.getByRole("link", { name: "通知 0件未読" })).toBeVisible();
  });
});
