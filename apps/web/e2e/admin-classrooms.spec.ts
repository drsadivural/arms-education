import { expectNoA11yViolations, fixture } from "./helpers";
import { createClassroom, createPublishedProgram, createStudent, createTeacher, expect, expectNoHorizontalScroll, test, toast, uniq } from "./admin-support";

test.describe("クラスルーム管理（WEB-07/08）", () => {
  test("クラスを追加し、補助講師と公開中の教育プログラムを割り当てられる", async ({ page }) => {
    await page.goto("/classrooms");
    const assistant = await createTeacher(page, `補助講師 ${uniq()}`);
    const program = await createPublishedProgram(page);

    await page.getByRole("link", { name: "クラスを追加" }).click();
    await expect(page.getByRole("heading", { name: "クラスを追加", level: 1 })).toBeVisible();
    const name = `2026年度 E2Eクラス ${uniq()}`;
    await page.getByLabel("クラス名").fill(name);
    await page.getByLabel("定員").fill("2");
    await page.getByLabel("主担当講師").selectOption(fixture().teacher.id);
    await page.getByLabel("開始日").fill("2026-10-01");
    await page.getByLabel("終了日").fill("2026-12-31");
    const assistants = page.getByRole("group", { name: /補助講師/ });
    await expect(assistants.getByRole("checkbox", { name: "田中 祥司" })).toHaveCount(0);
    await assistants.getByRole("checkbox", { name: assistant.display_name }).check();
    const programs = page.getByRole("group", { name: /教育プログラム/ });
    await programs.getByRole("checkbox", { name: `${program.name} v1` }).check();
    await expect(programs).toHaveAccessibleName(/1件選択中/);
    await expectNoA11yViolations(page);

    await page.getByRole("button", { name: "クラスを追加" }).click();
    await expect(page).toHaveURL(/\/classrooms\/[0-9a-f-]{36}$/);
    await expect(toast(page, "クラスを追加しました")).toBeVisible();
    await expect(page.getByRole("heading", { name: `${name}の詳細`, level: 1 })).toBeVisible();
    await expect(page.getByText("定員2名 / 残り2名")).toBeVisible();
    await expect(page.getByRole("group", { name: /補助講師/ }).getByRole("checkbox", { name: assistant.display_name })).toBeChecked();
    await expect(page.getByRole("group", { name: /教育プログラム/ }).getByRole("checkbox", { name: `${program.name} v1` })).toBeChecked();
    await expect(page.getByText("在籍中の新入社員はいません")).toBeVisible();
    await expectNoA11yViolations(page);

    // The list shows enrolled/capacity counted by the API.
    await page.goto(`/classrooms?q=${encodeURIComponent(name)}`);
    const card = page.getByRole("listitem").filter({ hasText: name });
    await expect(card).toContainText("0");
    await expect(card).toContainText("/ 2名");
    await expect(card).toContainText("主担当：田中 祥司");
  });

  test("定員を在籍人数未満にはできず、在籍者がいるクラスはアーカイブできない", async ({ page }) => {
    await page.goto("/classrooms");
    const classroom = await createClassroom(page, fixture().teacher.id, { capacity: 5 });
    await createStudent(page, classroom.id, fixture().teacher.id);
    await createStudent(page, classroom.id, fixture().teacher.id);

    await page.goto(`/classrooms/${classroom.id}`);
    await expect(page.getByText("定員5名 / 残り3名")).toBeVisible();
    await expect(page.getByRole("table", { name: /所属する新入社員/ }).getByRole("row")).toHaveCount(3);
    await page.getByLabel("定員").fill("1");
    await page.getByRole("button", { name: "変更を保存" }).click();
    await expect(page.getByText("在籍人数より少ない定員には変更できません。")).toBeVisible();
    await expect(page.getByLabel("定員")).toHaveAttribute("aria-invalid", "true");

    await page.getByLabel("定員").fill("5");
    await page.getByRole("button", { name: "クラスをアーカイブ" }).click();
    const dialog = page.getByRole("alertdialog", { name: "クラスをアーカイブしますか？" });
    await expect(dialog).toContainText(classroom.name);
    await dialog.getByRole("button", { name: "アーカイブする" }).click();
    await expect(dialog.getByText("在籍者がいるクラスは削除できません。")).toBeVisible();
    await dialog.getByRole("button", { name: "キャンセル" }).click();
  });

  test("在籍者のいないクラスはアーカイブでき、編集できなくなる", async ({ page }) => {
    await page.goto("/classrooms");
    const classroom = await createClassroom(page, fixture().teacher.id);
    await page.goto(`/classrooms/${classroom.id}`);
    await page.getByRole("button", { name: "クラスをアーカイブ" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "アーカイブする" }).click();
    await expect(toast(page, `${classroom.name}をアーカイブしました`)).toBeVisible();
    await expect(page.getByText("アーカイブ済みのクラスは編集できません。")).toBeVisible();
    await expect(page.getByLabel("クラス名")).toBeDisabled();
    await page.goto(`/classrooms?status=archived&q=${encodeURIComponent(classroom.name)}`);
    await expect(page.getByRole("listitem").filter({ hasText: classroom.name })).toContainText("アーカイブ済み");
  });

  test("クラス一覧は390pxでも横スクロールせず、アクセシブル", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/classrooms");
    await expect(page.getByRole("heading", { name: "クラスルーム管理", level: 1 })).toBeVisible();
    await expect(page.getByRole("list", { name: "クラス一覧" }).getByRole("link", { name: /の詳細を見る$/ }).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
  });
});
