import { expect, test, type Page } from "@playwright/test";
import { expectNoA11yViolations, fixture, loginAs } from "./helpers";
import { a11yDetails, createRecord, createStudent, enroll, expectNoPageOverflow, jstDate, jstMonth, seedPublishedProgram, uniq } from "./learning-helpers";

const LEGACY_COLUMNS = ["終了予定日", "社員名", "教育担当部署", "教育担当者", "内容", "進捗", "状態", "操作"];

function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${y}年${m}月`;
}

async function expectAccessible(page: Page) {
  expect(await a11yDetails(page)).toEqual([]);
  await expectNoA11yViolations(page);
}

test.describe("WEB-11 社員教育進捗管理", () => {
  test("旧画面の列・月移動（URL保持）・クイック絞り込み・期限超過・2019年の記録・合計", async ({ page }) => {
    await loginAs(page, "admin");
    const f = fixture();
    const tag = uniq();
    const wada = await createStudent(page, { classroomId: f.classroomId, teacherId: f.teacher.id, name: `和田 一夫${tag}` });
    const takahashi = await createStudent(page, { classroomId: f.classroomId, teacherId: f.teacher.id, name: `高橋 健太${tag}`, department: "サポート部" });
    const thisMonth = jstMonth(0);
    const nextMonth = jstMonth(1);
    const yesterday = jstDate(-1);
    await createRecord(page, { studentId: wada.id, teacherId: f.teacher.id, department: "開発部", dueDate: `${thisMonth}-28`, content: `技術知識習得${tag}` });
    await createRecord(page, { studentId: takahashi.id, teacherId: f.teacher.id, department: "サポート部", dueDate: `${nextMonth}-05`, content: `メールサポート${tag}` });
    await createRecord(page, { studentId: takahashi.id, teacherId: f.teacher.id, department: "サポート部", dueDate: yesterday, content: `期限超過の研修${tag}` });
    await createRecord(page, { studentId: wada.id, teacherId: f.teacher.id, department: "開発部", dueDate: "2019-08-31", content: `プログラム言語習得${tag}`, state: "completed" });

    await page.goto(`/progress?q=${encodeURIComponent(tag)}`);
    await expect(page.getByRole("heading", { level: 1, name: "社員教育進捗管理" })).toBeVisible();
    await expect(page.getByRole("heading", { name: monthLabel(thisMonth) })).toBeVisible();
    await expect(page.getByRole("button", { name: "今月の教育" })).toHaveAttribute("aria-pressed", "true");
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveText(LEGACY_COLUMNS);
    await expect(table.getByRole("row", { name: new RegExp(`技術知識習得${tag}`) })).toContainText(`和田 一夫${tag}`);
    await expect(page.getByText("終了予定日・社員名・教育担当部署・教育担当者・内容は、既存データを引き継いで管理できます。")).toBeVisible();
    await expect(page.getByText(/最終取得/)).toBeVisible();

    // 期限超過 is derived by the API from the JST date (yesterday may fall in the previous month).
    if (yesterday.startsWith(thisMonth)) {
      await expect(table.getByRole("row", { name: new RegExp(`期限超過の研修${tag}`) }).getByText("期限超過", { exact: true })).toBeVisible();
      await expect(page.getByText("全2件")).toBeVisible();
    }

    // 来月 › keeps the other filters in the URL.
    await page.getByRole("link", { name: /^来月/ }).click();
    await expect(page).toHaveURL(new RegExp(`month=${nextMonth}`));
    await expect(page).toHaveURL(new RegExp(`q=${tag}`));
    await expect(page.getByRole("heading", { name: monthLabel(nextMonth) })).toBeVisible();
    await expect(page.getByRole("button", { name: "来月の教育" })).toHaveAttribute("aria-pressed", "true");
    await expect(table.getByRole("row", { name: new RegExp(`メールサポート${tag}`) })).toBeVisible();
    await expect(page.getByText("全1件")).toBeVisible();
    await expectAccessible(page);

    // Legacy 2019 rows keep their original date (with the year, since it differs from today's year).
    await page.goto(`/progress?month=2019-08&q=${encodeURIComponent(tag)}`);
    await expect(page.getByRole("heading", { name: "2019年8月" })).toBeVisible();
    const legacy = table.getByRole("row", { name: new RegExp(`プログラム言語習得${tag}`) });
    await expect(legacy).toContainText("2019年8月31日（土）");
    await expect(legacy.getByText("完了")).toBeVisible();
    await page.getByRole("link", { name: /^前の6か月/ }).click();
    await expect(page).toHaveURL(/month=2019-02/);
    await page.getByRole("link", { name: /^次の6か月/ }).click();
    await expect(page).toHaveURL(/month=2019-08/);
    await page.getByRole("link", { name: "今月", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`month=${thisMonth}`));

    // Department quick filter + select are bound to the same URL parameter.
    await page.getByRole("button", { name: "開発部担当" }).click();
    await expect(page).toHaveURL(/department=%E9%96%8B%E7%99%BA%E9%83%A8/);
    await expect(page.getByLabel("部署")).toHaveValue("開発部");
    await expect(table.getByRole("row", { name: new RegExp(`技術知識習得${tag}`) })).toBeVisible();
    await expect(table.getByRole("row", { name: new RegExp(`期限超過の研修${tag}`) })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "開発部担当" })).toHaveAttribute("aria-pressed", "true");

    // Status filter: 期限超過.
    await page.getByLabel("状態").selectOption("overdue");
    await expect(page).toHaveURL(/status=overdue/);
  });

  test("教育記録を登録（必須エラー → 登録）し、CSV/PDFを現在の条件で出力する", async ({ page }) => {
    await loginAs(page, "admin");
    const f = fixture();
    const tag = uniq();
    const learner = await createStudent(page, { classroomId: f.classroomId, teacherId: f.teacher.id, name: `加藤 美咲${tag}` });
    await page.goto(`/progress?q=${encodeURIComponent(tag)}`);
    await expect(page.getByText("条件に一致する教育記録はありません")).toBeVisible();

    await page.getByRole("button", { name: "教育記録を登録" }).click();
    const dialog = page.getByRole("dialog", { name: "教育記録を登録" });
    await dialog.getByRole("button", { name: "登録する" }).click();
    await expect(dialog.getByText("社員名を選択してください。")).toBeVisible();
    await expect(dialog.getByText("日付を正しく入力してください（例: 2026-10-05）。")).toBeVisible();

    await dialog.getByLabel("終了予定日").fill(`${jstMonth(0)}-20`);
    await dialog.getByLabel("社員名を社員名・社員番号で検索").fill(learner.name);
    const picker = dialog.getByRole("combobox", { name: /社員名/ });
    await expect(picker).toContainText(learner.name);
    await picker.selectOption((await picker.locator("option", { hasText: learner.name }).getAttribute("value")) ?? "");
    await expect(dialog.getByLabel("教育担当者")).toHaveValue(f.teacher.id);
    await expect(dialog.getByLabel("教育担当部署")).toHaveValue("開発部");
    await dialog.getByLabel("内容").fill(`営業同行・提案書の作成${tag}`);
    await dialog.getByRole("button", { name: "登録する" }).click();
    await expect(page.getByText("教育記録を登録しました", { exact: true })).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(`営業同行・提案書の作成${tag}`) })).toBeVisible();
    await expect(page.getByText("全1件")).toBeVisible();

    const csv = page.waitForEvent("download");
    await page.getByRole("button", { name: "CSV出力" }).click();
    const file = await csv;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    await expect(page.getByText(/CSV（1件）をダウンロードしました。/)).toBeVisible();

    // PDF: downloads when the Japanese font is deployed; otherwise PDF_FONT_UNAVAILABLE is shown (never fake success).
    const pdf = page.waitForEvent("download", { timeout: 20_000 }).then((d) => d.suggestedFilename()).catch(() => null);
    await page.getByRole("button", { name: "PDF出力" }).click();
    const outcome = await Promise.race([
      pdf,
      page
        .getByText("PDF出力用の日本語フォントが配置されていないため、PDFを作成できません。管理者にお問い合わせください。")
        .waitFor({ timeout: 20_000 })
        .then(() => "font-missing"),
    ]);
    expect(outcome === "font-missing" || /\.pdf$/.test(outcome ?? "")).toBe(true);
  });

  test("ダークテーマでもコントラスト基準を満たし、390px幅では表が横スクロールしページはスクロールしない", async ({ page }) => {
    await loginAs(page, "admin");
    const f = fixture();
    const tag = uniq();
    const learner = await createStudent(page, { classroomId: f.classroomId, teacherId: f.teacher.id, name: `鈴木 大輔${tag}` });
    await createRecord(page, { studentId: learner.id, teacherId: f.teacher.id, department: "開発部", dueDate: `${jstMonth(1)}-27`, content: `サーバー構築・製品動作試験${tag}` });
    await page.goto(`/progress?month=${jstMonth(1)}&q=${encodeURIComponent(tag)}`);
    await page.getByRole("button", { name: "アカウントメニュー" }).click();
    await page.getByRole("menuitemradio", { name: "ダーク" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("row", { name: new RegExp(`サーバー構築・製品動作試験${tag}`) })).toBeVisible();
    await expectAccessible(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("row", { name: new RegExp(`サーバー構築・製品動作試験${tag}`) })).toBeAttached();
    await expectNoPageOverflow(page);
    const scroller = page.getByRole("table").locator("xpath=..");
    expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // Restore the light theme for the following tests (saved per user on the server).
    await page.getByRole("button", { name: "アカウントメニュー" }).click();
    await page.getByRole("menuitemradio", { name: "ライト" }).click();
  });
});

test.describe("教育記録の詳細・訂正", () => {
  test("訂正には訂正理由が必須で、変更前後・理由・実施者が履歴に残る", async ({ page }) => {
    await loginAs(page, "admin");
    const f = fixture();
    const tag = uniq();
    const learner = await createStudent(page, { classroomId: f.classroomId, teacherId: f.teacher.id, name: `佐藤 玲奈${tag}` });
    const due = `${jstMonth(1)}-05`;
    const record = await createRecord(page, { studentId: learner.id, teacherId: f.teacher.id, department: "営業部", dueDate: due, content: "新規顧客開拓" });

    await page.goto(`/progress/records/${record.id}`);
    await expect(page.getByRole("heading", { level: 1, name: `佐藤 玲奈${tag}さんの教育記録` })).toBeVisible();
    await expect(page.getByRole("list", { name: "教育記録の変更履歴" })).toContainText("教育記録を登録");
    await expectAccessible(page);

    // Correct the record to the original legacy date (2019): the date is kept exactly as entered.
    await page.getByRole("button", { name: "訂正する" }).click();
    await expect(page).toHaveURL(/mode=edit/);
    await page.getByLabel("終了予定日").fill("2019-09-30");
    await page.getByLabel("内容").fill("新規顧客開拓・研修振り返り");
    await page.getByLabel("状態").selectOption("completed");
    await page.getByRole("button", { name: "訂正を保存" }).click();
    await expect(page.getByText("訂正理由を入力してください。")).toBeVisible();
    await page.getByLabel("訂正理由").fill("面談記録と照合して内容を修正");
    await page.getByRole("button", { name: "訂正を保存" }).click();
    await expect(page.getByText("教育記録を訂正しました", { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/mode=edit/);
    await expect(page.getByRole("definition").filter({ hasText: "2019年9月30日（月）" })).toBeVisible();
    const history = page.getByRole("list", { name: "教育記録の変更履歴" });
    await expect(history).toContainText("教育記録を訂正");
    await expect(history).toContainText("訂正理由：面談記録と照合して内容を修正");
    await expect(history).toContainText("終了予定日：");
    await expect(history).toContainText("→ 2019年9月30日（月）");
    await expect(history).toContainText("内容：新規顧客開拓 → 新規顧客開拓・研修振り返り");
    await expect(history).toContainText("状態：受講中 → 完了");
    await expect(history).toContainText("山田 太郎");
    await expectAccessible(page);
    await page.getByRole("link", { name: "教育進捗の詳細を見る" }).click();
    await expect(page).toHaveURL(new RegExp(`/progress/students/${learner.id}`));
  });
});

test.describe("WEB-12 新入社員の教育進捗", () => {
  test("受講中の進捗・単元の完了条件・課題の評価（講師）と履歴", async ({ page }) => {
    await loginAs(page, "admin");
    const f = fixture();
    const tag = uniq();
    const seeded = await seedPublishedProgram(page, { withAssignment: true });
    const learner = await createStudent(page, { classroomId: f.classroomId, teacherId: f.teacher.id, name: `和田 次郎${tag}`, withLogin: true });
    const empty = await createStudent(page, { classroomId: f.classroomId, teacherId: f.teacher.id, name: `未割当 花子${tag}` });
    await enroll(page, learner.id, seeded.versionId, jstDate(60));

    // The learner (iOS, Bearer) confirms the link, passes the quiz and submits the assignment.
    const headers = () => ({ "Idempotency-Key": crypto.randomUUID() });
    expect((await learner.api.post(`/api/v1/materials/${seeded.linkMaterialId}/receipt`, { headers: headers() })).status()).toBe(200);
    const quiz = (await (await learner.api.get(`/api/v1/materials/${seeded.quizMaterialId}/quiz`)).json()) as { data: { questions: { id: string }[] } };
    expect(
      (await learner.api.post(`/api/v1/materials/${seeded.quizMaterialId}/quiz-attempts`, { headers: headers(), data: { answers: [{ question_id: quiz.data.questions[0]!.id, selected_option_ids: ["c1"] }] } })).status(),
    ).toBe(200);
    expect((await learner.api.post(`/api/v1/materials/${seeded.assignmentMaterialId}/submissions`, { headers: headers(), data: { body: `研修で学んだこと${tag}` } })).status()).toBe(200);

    // Teacher of the student's classroom reviews it.
    await page.context().clearCookies();
    await loginAs(page, "teacher");
    await page.goto(`/progress/students/${learner.id}`);
    await expect(page.getByRole("heading", { level: 1, name: `和田 次郎${tag}さんの教育進捗` })).toBeVisible();
    await expect(page.getByRole("article", { name: `${seeded.name} v1` })).toContainText("必須単元 0 / 1 完了");
    const unitRow = page.getByRole("row", { name: /ビジネスマナー/ });
    await expect(unitRow).toContainText("1 / 1 確認済み");
    await expect(unitRow).toContainText("100点・合格");
    await expect(unitRow).toContainText("提出済み（確認待ち）");
    await expect(unitRow.getByText("確認待ち", { exact: true })).toBeVisible();
    await expect(page.getByText("評価待ちの課題が1件あります。")).toBeVisible();
    await expectAccessible(page);

    await page.getByRole("button", { name: "「振り返りレポート」を評価" }).click();
    const dialog = page.getByRole("dialog", { name: "課題を評価" });
    await expect(dialog).toContainText(`研修で学んだこと${tag}`);
    await dialog.getByLabel("再提出を依頼する").check();
    await dialog.getByRole("button", { name: "再提出を依頼する" }).click();
    await expect(dialog.getByText("再提出を依頼する理由を入力してください。")).toBeVisible();
    await dialog.getByLabel("承認する（単元の完了条件を満たします）").check();
    await dialog.getByLabel("講師コメント（任意・受講者に表示）").fill("よくまとまっています。");
    await dialog.getByRole("button", { name: "承認する" }).click();
    await expect(page.getByText("課題を承認しました", { exact: true })).toBeVisible();
    await expect(unitRow.getByText("完了", { exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: `${seeded.name} v1` })).toContainText("必須単元 1 / 1 完了");
    await expect(page.getByRole("progressbar", { name: `和田 次郎${tag}さんの研修進捗` })).toHaveAttribute("aria-valuenow", "100");
    const history = page.getByRole("list", { name: "教育進捗の変更履歴" });
    await expect(history).toContainText("「振り返りレポート」を承認");
    await expect(history).toContainText("「ビジネスマナー」を完了");

    // A student without enrollments shows 未設定 (null progress), never 0%.
    await page.goto(`/progress/students/${empty.id}`);
    await expect(page.getByRole("heading", { level: 1, name: `未割当 花子${tag}さんの教育進捗` })).toBeVisible();
    await expect(page.getByText("受講が割り当てられていません")).toBeVisible();
    await expect(page.getByRole("progressbar", { name: `未割当 花子${tag}さんの研修進捗` })).toHaveAttribute("aria-valuetext", "未設定");
  });
});
