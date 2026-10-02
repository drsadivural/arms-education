import { expect, test } from "@playwright/test";
import { expectNoA11yViolations, fixture, loginAs } from "./helpers";
import { createTeacher, setDepartment, toast, uniq } from "./admin-support";

test.describe("講師管理（WEB-03/04）", () => {
  test("講師を登録すると招待結果が表示され、一覧から停止できる", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/teachers");
    await expect(page.getByRole("heading", { name: "講師管理", level: 1 })).toBeVisible();
    await expect(page.getByText(/最終取得/).first()).toBeVisible();
    await expectNoA11yViolations(page);

    await page.getByRole("link", { name: "講師を登録" }).click();
    await expect(page.getByRole("heading", { name: "講師を登録", level: 1 })).toBeVisible();
    const n = uniq();
    await page.getByLabel("講師番号").fill(`T-${n}`);
    await page.getByLabel("氏名").fill(`佐藤 直子 ${n}`);
    await page.getByLabel("ふりがな").fill("さとう なおこ");
    await page.getByLabel("メールアドレス").fill(`e2e-sato-${n}@example.invalid`);
    await setDepartment(page.getByLabel("所属部署"), "人事部");
    const specialties = page.getByLabel("専門分野");
    await specialties.fill("新入社員研修");
    await specialties.press("Enter");
    await specialties.fill("コミュニケーション");
    await specialties.press("Enter");
    await expect(page.getByRole("button", { name: "新入社員研修を削除" })).toBeVisible();
    for (const d of ["月", "火", "水", "木", "金"]) await page.getByRole("checkbox", { name: `${d}曜日` }).check();
    await page.getByLabel("開始時刻").fill("09:00");
    await page.getByLabel("終了時刻").fill("17:00");
    await expectNoA11yViolations(page);

    await page.getByRole("button", { name: "登録して招待" }).click();
    await expect(page).toHaveURL(/\/teachers\/[0-9a-f-]{36}$/);
    await expect(toast(page, "講師を登録しました")).toBeVisible();
    await expect(page.getByRole("heading", { name: "講師情報の編集", level: 1 })).toBeVisible();
    await expect(page.getByText(/^(送信済み|送信失敗（再送可能）|送信待ち)$/)).toBeVisible();
    await expect(page.getByLabel("メールアドレス")).toHaveAttribute("readonly", "");
    await expect(page.getByRole("checkbox", { name: "水曜日" })).toBeChecked();

    await page.goto(`/teachers?q=T-${n}`);
    await expect(page.getByRole("searchbox", { name: "検索" })).toHaveValue(`T-${n}`);
    const row = page.getByRole("row", { name: new RegExp(`佐藤 直子 ${n}`) });
    await expect(row).toContainText("新入社員研修・コミュニケーション");
    await expect(row).toContainText("未担当");
    await row.getByRole("button", { name: `佐藤 直子 ${n}さんを停止` }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(`佐藤 直子 ${n}（T-${n}）`);
    await dialog.getByRole("button", { name: "停止する" }).click();
    await expect(toast(page, `佐藤 直子 ${n}さんを停止しました`)).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(`佐藤 直子 ${n}`) })).toHaveCount(0);
    await page.getByLabel("状態").selectOption("inactive");
    await expect(page).toHaveURL(/status=inactive/);
    await expect(page.getByRole("row", { name: new RegExp(`佐藤 直子 ${n}`) })).toContainText("停止中");
  });

  test("講師番号の重複は入力欄に日本語で表示され、入力は保持される", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/teachers");
    const existing = await createTeacher(page);
    await page.goto("/teachers/new");
    const n = uniq();
    await page.getByLabel("講師番号").fill(existing.teacher_number);
    await page.getByLabel("氏名").fill(`重複 ${n}`);
    await page.getByLabel("メールアドレス").fill(`e2e-dup-${n}@example.invalid`);
    await setDepartment(page.getByLabel("所属部署"), "開発部");
    await page.getByRole("button", { name: "登録して招待" }).click();
    const number = page.getByLabel("講師番号");
    await expect(number).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("この講師番号は既に登録されています。")).toBeVisible();
    await expect(page.getByText(/保存できませんでした。赤字の項目を確認してください/)).toBeVisible();
    await expect(page.getByLabel("氏名")).toHaveValue(`重複 ${n}`);
    await expect(page).toHaveURL(/\/teachers\/new$/);

    // Required fields are validated before anything is sent.
    await page.getByLabel("氏名").fill("");
    await expect(page.getByText("必須項目です。")).toBeVisible();
  });

  test("主担当のクラスがある講師は停止できず、理由が表示される（TEACHER_IS_PRIMARY）", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto(`/teachers?q=${encodeURIComponent(fixture().teacher.email)}`);
    const row = page.getByRole("row", { name: /田中 祥司/ });
    await expect(row).toContainText("（主）");
    await row.getByRole("button", { name: "田中 祥司さんを停止" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "停止する" }).click();
    await expect(dialog.getByText(/主担当のクラスがあるため停止できません/)).toBeVisible();
    await expect(dialog.getByText(/^主担当のクラス: /)).toBeVisible();
    await expect(dialog.getByText(/問い合わせ番号/)).toBeVisible();
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(row).toContainText("有効");
  });

  test("同時に更新された場合はIf-Matchで競合を検出し、最新の情報を読み込める", async ({ page, context }) => {
    await loginAs(page, "admin");
    await page.goto("/teachers");
    const teacher = await createTeacher(page);
    await page.goto(`/teachers/${teacher.id}`);
    await expect(page.getByLabel("ふりがな")).toHaveValue("こうし");

    const other = await context.newPage();
    await other.goto(`/teachers/${teacher.id}`);
    await other.getByLabel("ふりがな").fill("べつのたんまつ");
    await other.getByRole("button", { name: "変更を保存" }).click();
    await expect(toast(other, "講師情報を保存しました")).toBeVisible();
    await other.close();

    await page.getByLabel("ふりがな").fill("こちらのへんこう");
    await page.getByRole("button", { name: "変更を保存" }).click();
    await expect(page.getByText(/情報が更新されました。再読み込みしてください。/)).toBeVisible();
    await page.getByRole("button", { name: "最新の情報を読み込む" }).click();
    await expect(page.getByLabel("ふりがな")).toHaveValue("べつのたんまつ");
    await page.getByLabel("ふりがな").fill("さいへんしゅう");
    await page.getByRole("button", { name: "変更を保存" }).click();
    await expect(toast(page, "講師情報を保存しました")).toBeVisible();
  });

  test("保存していない変更がある場合は画面移動前に確認する", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/teachers/new");
    await page.getByLabel("氏名").fill("未保存の入力");
    await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "新入社員管理" }).click();
    const dialog = page.getByRole("alertdialog", { name: "保存されていない変更があります" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(page).toHaveURL(/\/teachers\/new$/);
    await expect(page.getByLabel("氏名")).toHaveValue("未保存の入力");
  });

  test("講師ロールは講師一覧を閲覧のみできる", async ({ page }) => {
    await loginAs(page, "teacher");
    await page.goto("/teachers");
    await expect(page.getByText("講師アカウントでは閲覧のみできます。登録・編集・停止は管理者が行います。")).toBeVisible();
    await expect(page.getByRole("link", { name: "講師を登録" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /停止/ })).toHaveCount(0);
    await page.getByRole("link", { name: "田中 祥司さんの詳細" }).click();
    await expect(page.getByRole("heading", { name: "田中 祥司さんの講師情報", level: 1 })).toBeVisible();
    await expect(page.getByLabel("氏名")).toBeDisabled();
    await expect(page.getByRole("button", { name: "変更を保存" })).toHaveCount(0);
    await expectNoA11yViolations(page);
  });
});
