import { expectNoA11yViolations, fixture } from "./helpers";
import { createStudent, expect, expectNoHorizontalScroll, test } from "./admin-support";

test.describe("ダッシュボード（WEB-02）", () => {
  test("JSTの日付・指標・一覧を表示し、クラスの絞り込みをURLに保持する", async ({ page }) => {
    await page.goto("/dashboard");
    const student = await createStudent(page, fixture().classroomId, fixture().teacher.id);
    await page.reload();
    const hero = page.getByRole("region", { name: "新入社員の成長を、ひとつの画面で。" });
    await expect(hero.getByText(/^\d{4}年\d{1,2}月\d{1,2}日（[日月火水木金土]）$/)).toBeVisible();
    const stats = page.getByRole("region", { name: "主要な指標" });
    for (const label of ["在籍受講者", "平均研修進捗", "承認待ち予約", "本日の授業"]) await expect(stats.getByText(label)).toBeVisible();
    await expect(page.getByText(/最終取得/).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "今月のレポート" })).toHaveAttribute("href", /\/progress\?month=\d{4}-\d{2}$/);
    await expectNoA11yViolations(page);

    await page.getByLabel("クラス").selectOption(fixture().classroomId);
    await expect(page).toHaveURL(new RegExp(`classroom_id=${fixture().classroomId}`));
    await expect(page.getByRole("table", { name: "新入社員の進捗" })).toContainText(student.display_name);
    await page.reload();
    await expect(page.getByLabel("クラス")).toHaveValue(fixture().classroomId);
  });

  test("ダークテーマ（システム設定に連動）でも基準を満たす", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/dashboard");
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByRole("region", { name: "主要な指標" }).getByText("在籍受講者")).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("390px幅では横スクロールせず、表は枠内でスクロールする", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await expect(page.getByRole("region", { name: "主要な指標" }).getByText("在籍受講者")).toBeVisible();
    await expect(page.getByRole("button", { name: "メニューを開く" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
  });

  test.describe("講師ロール", () => {
    test.use({ role: "teacher" });

    test("講師は担当範囲のダッシュボードを閲覧できる", async ({ page }) => {
      await page.goto("/dashboard");
      await expect(page.getByRole("region", { name: "主要な指標" }).getByText("在籍受講者")).toBeVisible();
      await expect(page.getByLabel("クラス")).toContainText("担当のすべてのクラス");
      await expect(page.getByRole("link", { name: "授業・予約枠を追加" })).toHaveCount(0);
      await expectNoA11yViolations(page);
    });
  });
});
