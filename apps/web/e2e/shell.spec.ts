import { expect, test } from "@playwright/test";
import { expectNoA11yViolations, fixture, loginAs } from "./helpers";

test.describe("ログインとアプリシェル", () => {
  test("ログイン画面はアクセシブルで、受講者はiOSアプリへ案内される", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "ARMSにログイン" })).toBeVisible();
    await expect(page.getByText("受講者の方はiOSアプリをご利用ください。")).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("誤ったパスワードは日本語のエラーになる", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(fixture().teacher.email);
    await page.getByLabel("パスワード").fill("wrong-password");
    await page.getByLabel("利用区分").selectOption("講師");
    await page.getByRole("button", { name: "ログイン" }).click();
    await expect(page.getByRole("alert")).toContainText("メールアドレスまたはパスワードが正しくありません");
  });

  test("講師アカウントで管理者を選ぶと利用区分エラーになる", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(fixture().teacher.email);
    await page.getByLabel("パスワード").fill(fixture().password);
    await page.getByRole("button", { name: "ログイン" }).click();
    await expect(page.getByRole("alert")).toContainText("このアカウントでは選択した利用区分にログインできません");
  });

  test("管理者はTOTPの二段階認証を経て、固定順の8メニューを使える", async ({ page }) => {
    await loginAs(page, "admin");
    const items = page.getByRole("navigation", { name: "メインメニュー" }).getByRole("link");
    await expect(items).toHaveText(["ダッシュボード", "講師管理", "新入社員管理", "クラスルーム管理", "教育プログラム管理", "社員教育進捗管理", "オンライン予約システム", "設定"]);
    await expect(page.getByRole("img", { name: "H&A" }).first()).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("ダークテーマでもコントラスト基準を満たし、設定がサーバーに保存される", async ({ page }) => {
    await loginAs(page, "teacher");
    await page.getByRole("button", { name: "アカウントメニュー" }).click();
    const saved = page.waitForResponse((r) => r.url().includes("/api/v1/me/preferences") && r.request().method() === "PATCH");
    await page.getByRole("menuitemradio", { name: "ダーク" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expectNoA11yViolations(page);
  });

  test("未ログインで保護ページを開くとログインへ戻り、ログイン後に元の画面へ遷移する", async ({ page }) => {
    await page.goto("/classrooms");
    await expect(page).toHaveURL(/\/login\?next=%2Fclassrooms/);
    await loginAs(page, "teacher");
  });

  test("ログアウトするとセッションが無効になる", async ({ page }) => {
    await loginAs(page, "teacher");
    await page.getByRole("button", { name: "アカウントメニュー" }).click();
    await page.getByRole("menuitem", { name: "ログアウト" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });
});
