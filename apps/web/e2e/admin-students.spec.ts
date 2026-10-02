import { expectNoA11yViolations, fixture } from "./helpers";
import { createClassroom, createStudent, createTeacher, expect, setDepartment, test, toast, uniq } from "./admin-support";

test.describe("新入社員管理（WEB-05/06）", () => {
  test("クラスを選ぶとそのクラスの講師だけが候補になり、登録すると招待結果が表示される", async ({ page }) => {
    await page.goto("/students");
    // A second classroom with its own primary teacher, so the candidates can be compared.
    const otherTeacher = await createTeacher(page, `別クラス講師 ${uniq()}`);
    const otherClass = await createClassroom(page, otherTeacher.id);

    await page.goto("/students/new");
    await expect(page.getByRole("heading", { name: "新入社員を登録", level: 1 })).toBeVisible();
    const teacherSelect = page.getByLabel("担当講師");
    await expect(teacherSelect).toBeDisabled();
    await expect(teacherSelect).toContainText("先にクラスを選択してください");

    const n = uniq();
    await page.getByLabel("社員番号").fill(`E-${n}`);
    await page.getByLabel("氏名").fill(`中村 翔太 ${n}`);
    await page.getByLabel("ふりがな").fill("なかむら しょうた");
    await page.getByLabel("メールアドレス").fill(`e2e-nakamura-${n}@example.invalid`);
    await page.getByLabel("会社名").fill("H&A研修センター");
    await setDepartment(page.getByLabel("所属部署"), "開発部");
    await page.getByLabel("入社日").fill("2026-10-01");

    const classSelect = page.getByLabel("所属クラス");
    await classSelect.selectOption(otherClass.id);
    await expect(teacherSelect.getByRole("option", { name: new RegExp(otherTeacher.display_name) })).toHaveCount(1);
    await expect(teacherSelect.getByRole("option", { name: /田中 祥司/ })).toHaveCount(0);
    await teacherSelect.selectOption(otherTeacher.id);

    await classSelect.selectOption(fixture().classroomId);
    await expect(teacherSelect).toHaveValue("");
    await expect(teacherSelect.getByRole("option", { name: "田中 祥司（主担当）" })).toHaveCount(1);
    await expect(teacherSelect.getByRole("option", { name: new RegExp(otherTeacher.display_name) })).toHaveCount(0);
    await teacherSelect.selectOption(fixture().teacher.id);
    // Training period defaults to the classroom period.
    await expect(page.getByLabel("研修開始日")).toHaveValue("2026-10-01");
    await expect(page.getByLabel("終了予定日")).toHaveValue("2026-12-31");
    await expectNoA11yViolations(page);

    await page.getByRole("button", { name: "登録して招待" }).click();
    await expect(page).toHaveURL(/\/students\/[0-9a-f-]{36}$/);
    await expect(toast(page, "新入社員を登録しました")).toBeVisible();
    await expect(page.getByText(/^(送信済み|送信失敗（再送可能）|送信待ち)$/).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "新入社員情報の編集", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "進捗を見る" })).toHaveAttribute("href", /\/progress\?student_id=/);
  });

  test("社員番号の重複と研修期間の誤りを入力欄に表示する", async ({ page }) => {
    await page.goto("/students");
    const existing = await createStudent(page, fixture().classroomId, fixture().teacher.id);
    await page.goto("/students/new");
    const n = uniq();
    await page.getByLabel("社員番号").fill(existing.employee_number);
    await page.getByLabel("氏名").fill(`重複 ${n}`);
    await page.getByLabel("メールアドレス").fill(`e2e-dup-${n}@example.invalid`);
    await setDepartment(page.getByLabel("所属部署"), "開発部");
    await page.getByLabel("入社日").fill("2026-10-01");
    await page.getByLabel("所属クラス").selectOption(fixture().classroomId);
    await page.getByLabel("担当講師").selectOption(fixture().teacher.id);
    await page.getByLabel("終了予定日").fill("2026-09-01");
    await page.getByRole("button", { name: "登録して招待" }).click();
    await expect(page.getByText("研修終了予定日は開始日以降にしてください。")).toBeVisible();
    await page.getByLabel("終了予定日").fill("2026-12-31");
    await page.getByRole("button", { name: "登録して招待" }).click();
    await expect(page.getByLabel("社員番号")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("この社員番号は既に登録されています。")).toBeVisible();
    await expect(page.getByLabel("氏名")).toHaveValue(`重複 ${n}`);
  });

  test("クラス移動は理由を記録して行い、在籍終了は確認してから実行する", async ({ page }) => {
    await page.goto("/students");
    const otherTeacher = await createTeacher(page, `移動先講師 ${uniq()}`);
    const target = await createClassroom(page, otherTeacher.id, { name: `移動先クラス ${uniq()}` });
    const student = await createStudent(page, fixture().classroomId, fixture().teacher.id);

    await page.goto(`/students/${student.id}`);
    await expect(page.getByLabel("所属クラス")).toHaveCount(0);
    await page.getByRole("button", { name: "クラス移動" }).click();
    const dialog = page.getByRole("dialog", { name: "クラス移動" });
    await dialog.getByLabel("移動先のクラス").selectOption(target.id);
    await dialog.getByLabel("担当講師").selectOption(otherTeacher.id);
    await dialog.getByRole("button", { name: "移動する" }).click();
    await expect(dialog.getByText("理由を入力してください。")).toBeVisible();
    await dialog.getByLabel("変更理由").fill("配属部署の変更に伴う移動");
    await expectNoA11yViolations(page);
    await dialog.getByRole("button", { name: "移動する" }).click();
    await expect(toast(page, "クラス・担当講師を変更しました")).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("link", { name: target.name })).toBeVisible();
    await expect(page.getByText(otherTeacher.display_name, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "在籍終了（アーカイブ）" }).click();
    const confirm = page.getByRole("alertdialog", { name: "在籍終了にしますか？" });
    await expect(confirm).toContainText(`${student.display_name}（${student.employee_number}）`);
    await confirm.getByRole("button", { name: "在籍終了にする" }).click();
    await expect(toast(page, `${student.display_name}さんを在籍終了にしました`)).toBeVisible();
    await expect(page.getByText("在籍終了", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "クラス移動" })).toBeDisabled();
  });

  test("トップバーの検索で /students?q= を開き、URLの絞り込みが一覧に反映される", async ({ page }) => {
    await page.goto("/students");
    const student = await createStudent(page, fixture().classroomId, fixture().teacher.id, { name: `検索 太郎 ${uniq()}` });
    await page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link", { name: "ダッシュボード" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByLabel("社員名で検索").fill(student.employee_number);
    await page.getByLabel("社員名で検索").press("Enter");
    await expect(page).toHaveURL(new RegExp(`/students\\?q=${student.employee_number}`));
    await expect(page.getByRole("searchbox", { name: "検索" })).toHaveValue(student.employee_number);
    const rows = page.getByRole("table", { name: "新入社員一覧" }).getByRole("row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText(student.display_name);
    await expect(rows.nth(1).getByRole("progressbar").or(rows.nth(1).getByText("未設定"))).toBeVisible();
    await expect(page.getByText(/最終取得/).first()).toBeVisible();
    await expectNoA11yViolations(page);

    await page.getByLabel("状態").selectOption("inactive");
    await expect(page).toHaveURL(/status=inactive/);
    await expect(page.getByText("条件に一致する新入社員はいません")).toBeVisible();
  });
});
