import { expect, test } from "@playwright/test";
import { expectNoA11yViolations, fixture, loginAs } from "./helpers";
import { a11yDetails, createStudent, expectNoPageOverflow, jstDate, seedPublishedProgram, uniq, webApi } from "./learning-helpers";

/** A minimal valid PDF (magic bytes %PDF-) for the quarantine upload. */
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

test.describe("WEB-09 教育プログラム管理", () => {
  test("管理者はプログラムを登録し、検索・絞り込み（URL保持）・アーカイブができる", async ({ page }) => {
    await loginAs(page, "admin");
    await page.goto("/programs");
    await expect(page.getByRole("heading", { level: 1, name: "教育プログラム管理" })).toBeVisible();
    await page.getByRole("link", { name: "プログラムを追加" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "教育プログラムを登録" })).toBeVisible();

    // Required field error in Japanese, nothing is created.
    await page.getByRole("button", { name: "登録する" }).click();
    await expect(page.getByText("必須項目です。")).toBeVisible();

    const name = `E2E基礎研修 ${uniq()}`;
    await page.getByLabel("名称").fill(name);
    await page.getByLabel("説明").fill("入社後3か月の基礎研修プログラム");
    await page.getByRole("button", { name: "登録する" }).click();
    await expect(page.getByText("プログラムを登録しました", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/programs\/[0-9a-f-]{36}$/);
    await expect(page.getByText("バージョンがまだありません。")).toBeVisible();

    await page.goto(`/programs?q=${encodeURIComponent(name)}`);
    const card = page.getByRole("article", { name });
    await expect(card).toBeVisible();
    await expect(card.getByText("バージョン未作成", { exact: true })).toBeVisible();
    await expect(card.getByText("0単元 / 0教材")).toBeVisible();
    await expect(page.getByLabel("プログラム名で検索")).toHaveValue(name);
    await expect(page.getByText(/最終取得/)).toBeVisible();
    await expectNoA11yViolations(page);

    await card.getByRole("button", { name: `「${name}」をアーカイブ` }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(`「${name}」をアーカイブし、一覧から非表示にします。`);
    await dialog.getByRole("button", { name: "アーカイブする" }).click();
    await expect(page.getByText("プログラムをアーカイブしました", { exact: true })).toBeVisible();
    await expect(page.getByText("条件に一致するプログラムはありません")).toBeVisible();

    await page.getByLabel("公開状態").selectOption("archived");
    await expect(page).toHaveURL(/status=archived/);
    await expect(page.getByRole("article", { name }).getByText("アーカイブ済み", { exact: true })).toBeVisible();
  });

  test("講師は閲覧のみ（追加・アーカイブ・単元編集の操作は表示されない）", async ({ page }) => {
    await loginAs(page, "admin");
    const seeded = await seedPublishedProgram(page);
    await page.context().clearCookies();
    await loginAs(page, "teacher");
    await page.goto(`/programs?q=${encodeURIComponent(seeded.name)}`);
    const card = page.getByRole("article", { name: seeded.name });
    await expect(card.getByText("公開中", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "プログラムを追加" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: /アーカイブ/ })).toHaveCount(0);
    await card.getByRole("link", { name: `「${seeded.name}」の教材を見る` }).click();
    await expect(page.getByRole("heading", { name: "単元と教材" })).toBeVisible();
    await expect(page.getByLabel("名称")).toBeDisabled();
    await expect(page.getByRole("button", { name: "単元を追加" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "新しいバージョンを作成" })).toHaveCount(0);
  });
});

test.describe("WEB-10 教育プログラム・教材を編集", () => {
  test("下書きで単元・リンク・確認テスト・ファイル教材を登録し、検査待ちのファイルがあると公開できない", async ({ page }) => {
    await loginAs(page, "admin");
    const name = `E2E教材編集 ${uniq()}`;
    const program = await webApi<{ data: { id: string } }>(page, { method: "POST", path: "/programs", body: { name, description: "", department_name: "" } });
    await page.goto(`/programs/${program.body.data.id}`);

    // Version with a fixed policy.
    await page.getByRole("button", { name: "新しいバージョンを作成" }).click();
    const vDialog = page.getByRole("dialog", { name: "新しいバージョンを作成" });
    await vDialog.getByLabel("確認テストの受験回数上限").fill("2");
    await vDialog.getByLabel("採点方式（複数回受験したとき）").selectOption("latest");
    await vDialog.getByRole("button", { name: "下書きを作成" }).click();
    await expect(page.getByText("下書き v1 を作成しました", { exact: true })).toBeVisible();
    await expect(page.getByText("2回・最新の点数を採用")).toBeVisible();
    await expect(page.getByRole("button", { name: "新しいバージョンを作成" })).toBeDisabled();

    // Unit.
    await page.getByRole("button", { name: "単元を追加" }).click();
    const uDialog = page.getByRole("dialog", { name: "単元を追加" });
    await uDialog.getByLabel("単元名").fill("IT基礎・セキュリティ");
    await uDialog.getByLabel("重み").fill("30");
    await uDialog.getByRole("button", { name: "単元を追加" }).click();
    await expect(page.getByText("単元を追加しました", { exact: true }).last()).toBeVisible();
    const unitRow = page.getByRole("row", { name: /IT基礎・セキュリティ/ });
    await expect(unitRow).toContainText("30");
    await expect(page.getByRole("heading", { name: "「IT基礎・セキュリティ」の教材" })).toBeVisible();

    // Link material: https only.
    await page.getByRole("button", { name: "教材を追加", exact: true }).click();
    let mDialog = page.getByRole("dialog", { name: "教材を追加" });
    await mDialog.getByLabel("種類").selectOption("link");
    await mDialog.getByLabel("教材名").fill("情報セキュリティ規程");
    await mDialog.getByLabel("URL").fill("http://example.com/policy");
    await mDialog.getByRole("button", { name: "教材を登録" }).click();
    await expect(mDialog.getByText("https:// から始まるURLを入力してください。")).toBeVisible();
    await mDialog.getByLabel("URL").fill("https://example.com/policy");
    await mDialog.getByRole("button", { name: "教材を登録" }).click();
    await expect(page.getByText("教材を登録しました", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("https://example.com/policy")).toBeVisible();

    // Preview of the link (the API returns the https URL).
    await page.getByRole("button", { name: "「情報セキュリティ規程」をプレビュー" }).click();
    const preview = page.getByRole("dialog", { name: "教材のプレビュー" });
    await expect(preview.getByRole("link", { name: "リンク先を新しいタブで開く" })).toHaveAttribute("href", "https://example.com/policy");
    await preview.getByRole("button", { name: "閉じる" }).click();

    // Quiz material + questions.
    await page.getByRole("button", { name: "教材を追加", exact: true }).click();
    mDialog = page.getByRole("dialog", { name: "教材を追加" });
    await mDialog.getByLabel("種類").selectOption("quiz");
    await mDialog.getByLabel("教材名").fill("セキュリティ確認テスト");
    await mDialog.getByRole("button", { name: "登録して問題を設定" }).click();
    const qDialog = page.getByRole("dialog", { name: "確認テストの問題を編集" });
    await expect(qDialog).toBeVisible();
    await qDialog.getByRole("button", { name: "問題を保存" }).click();
    await expect(qDialog.getByText("必須項目です。").first()).toBeVisible();
    await qDialog.getByLabel("問1の問題文").fill("パスワードの扱いとして正しいものは？");
    await qDialog.getByLabel("問1 選択肢1", { exact: true }).fill("他人に教えない");
    await qDialog.getByLabel("問1 選択肢2", { exact: true }).fill("付箋に書いて貼る");
    await qDialog.getByRole("button", { name: "問題を保存" }).click();
    await expect(qDialog.getByText("1件以上指定してください。")).toBeVisible();
    await qDialog.getByLabel("問1 選択肢1を正答にする").check();
    await qDialog.getByRole("button", { name: "問題を保存" }).click();
    await expect(page.getByText("確認テストを保存しました", { exact: true })).toBeVisible();
    await expect(page.getByText("1問", { exact: true })).toBeVisible();

    // File material: client-side type check, then quarantine upload with progress → 検査待ち.
    await page.getByRole("button", { name: "教材を追加", exact: true }).click();
    mDialog = page.getByRole("dialog", { name: "教材を追加" });
    await mDialog.getByLabel("教材名").fill("セキュリティ資料");
    const fileInput = mDialog.locator('input[type="file"]');
    await fileInput.setInputFiles({ name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("text") });
    await expect(mDialog.getByText(/PDF教材には \.pdf のファイルを選択してください。/)).toBeVisible();
    await fileInput.setInputFiles({ name: "security.pdf", mimeType: "application/pdf", buffer: PDF });
    await expect(mDialog.getByText("検査待ち", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(mDialog.getByText(/ファイル検査サービスが接続されていないため「検査待ち」のままです。/)).toBeVisible();
    await mDialog.getByRole("button", { name: "教材を登録" }).click();
    await expect(page.getByText("教材を登録しました", { exact: true }).last()).toBeVisible();
    const pdfItem = page.getByRole("listitem").filter({ hasText: "セキュリティ資料" });
    await expect(pdfItem.getByText("security.pdf")).toBeVisible();
    await expect(pdfItem.getByText("検査待ち", { exact: true })).toBeVisible();

    // The scan verdict is required before the material can be published.
    await pdfItem.getByRole("button", { name: "「セキュリティ資料」の公開準備" }).click();
    await expect(pdfItem.getByRole("alert")).toContainText("ファイル検査サービスに接続できないため、教材の公開を停止しています。");
    await expect(pdfItem.getByRole("alert")).toContainText("「セキュリティ資料」のファイル検査が完了していません。");

    // Version publish: the confirm dialog lists what gets fixed and shows the API blocker in Japanese.
    await expect(unitRow).toContainText("確認 + 80点以上");
    await page.getByRole("button", { name: "確認して公開" }).click();
    const pDialog = page.getByRole("alertdialog");
    await expect(pDialog).toContainText("単元 1件・教材 3件");
    await expect(pDialog).toContainText("確認テストの受験回数上限 2回・最新の点数を採用");
    await pDialog.getByRole("button", { name: "公開する" }).click();
    await expect(pDialog.getByRole("alert")).toContainText("ファイル検査サービスに接続できないため");
    await expect(pDialog.getByRole("alert")).toContainText("「セキュリティ資料」のファイル検査が完了していません。");
    expect(await a11yDetails(page)).toEqual([]);
    await expectNoA11yViolations(page);
    await pDialog.getByRole("button", { name: "キャンセル" }).click();
    await expect(page.getByText("下書き v1：単元 1件・教材 3件")).toBeVisible();
  });

  test("公開中は変更不可・新バージョン（コピー）作成・受講の割当（個人・クラス一括）", async ({ page }) => {
    await loginAs(page, "admin");
    const f = fixture();
    const seeded = await seedPublishedProgram(page);
    const learner = await createStudent(page, { classroomId: f.classroomId, teacherId: f.teacher.id, name: `割当 太郎${uniq().slice(-3)}` });
    await page.goto(`/programs/${seeded.programId}`);

    await expect(page.getByText(/v1 は公開中のため変更できません/)).toBeVisible();
    await expect(page.getByRole("button", { name: "単元を追加" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "確認して公開" })).toHaveCount(0);
    await page.getByRole("button", { name: "「ビジネスマナー」の教材を表示" }).click();
    await expect(page.getByText("マナー確認テスト")).toBeVisible();
    await expect(page.getByRole("button", { name: "教材を追加", exact: true })).toHaveCount(0);

    // Individual assignment of the published version.
    await page.getByLabel("新入社員を社員名・社員番号で検索").fill(learner.name);
    const enrollForm = page.getByRole("form", { name: "新入社員に割り当て" });
    const picker = enrollForm.getByRole("combobox", { name: /新入社員/ });
    await expect(picker).toContainText(learner.name);
    await picker.selectOption((await picker.locator("option", { hasText: learner.name }).getAttribute("value")) ?? "");
    await enrollForm.getByLabel("修了期限").fill(jstDate(60));
    await enrollForm.getByRole("button", { name: "割り当てる" }).click();
    await expect(page.getByText("受講を割り当てました", { exact: true })).toBeVisible();
    await expect(enrollForm.getByRole("link", { name: "教育進捗を見る" })).toHaveAttribute("href", `/progress/students/${learner.id}`);

    // Bulk assignment to the classroom: already-enrolled students are skipped.
    const bulk = page.getByRole("form", { name: "クラスに一括割り当て" });
    await bulk.getByLabel("クラス").selectOption(f.classroomId);
    await bulk.getByLabel("修了期限").fill(jstDate(60));
    await bulk.getByRole("button", { name: "一括で割り当てる" }).click();
    await expect(page.getByText("クラスに一括で割り当てました", { exact: true })).toBeVisible();
    await expect(bulk.getByRole("status")).toContainText("既に受講中などで対象外");

    // New draft version copied from the published one.
    await page.getByRole("button", { name: "新しいバージョンを作成" }).click();
    const vDialog = page.getByRole("dialog", { name: "新しいバージョンを作成" });
    await expect(vDialog.getByLabel("単元・教材のコピー元")).toHaveValue(seeded.versionId);
    await vDialog.getByRole("button", { name: "下書きを作成" }).click();
    await expect(page.getByText("下書き v2 を作成しました", { exact: true })).toBeVisible();
    await expect(page.getByText(/公開中 v1 の学習記録を保持し、変更は下書き v2 として保存します。/)).toBeVisible();
    await expect(page.getByRole("row", { name: /ビジネスマナー/ })).toBeVisible();
    await expect(page.getByLabel("公開状態・表示するバージョン")).toHaveValue(/.+/);
    await expect(page.getByRole("button", { name: "単元を追加" })).toBeVisible();

    // Reorder: add a second unit and move it up.
    await page.getByRole("button", { name: "単元を追加" }).click();
    const uDialog = page.getByRole("dialog", { name: "単元を追加" });
    await uDialog.getByLabel("単元名").fill("研修振り返り");
    await uDialog.getByRole("button", { name: "単元を追加" }).click();
    await expect(page.getByText("単元を追加しました", { exact: true }).last()).toBeVisible();
    await page.getByRole("button", { name: "「研修振り返り」を上へ移動" }).click();
    await expect(page.getByText("単元の順序を変更しました", { exact: true })).toBeVisible();
    const rows = page.getByRole("table", { name: "v2の単元一覧" }).getByRole("row");
    await expect(rows.nth(1)).toContainText("研修振り返り");
    await expect(rows.nth(2)).toContainText("ビジネスマナー");
  });

  test("390px幅でも横スクロールせず操作できる", async ({ page }) => {
    await loginAs(page, "admin");
    const seeded = await seedPublishedProgram(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/programs/${seeded.programId}`);
    await expect(page.getByRole("heading", { name: "単元と教材" })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.goto(`/programs?q=${encodeURIComponent(seeded.name)}`);
    await expect(page.getByRole("article", { name: seeded.name })).toBeVisible();
    await expectNoPageOverflow(page);
  });
});
