import { expectNoA11yViolations, fixture } from "./helpers";
import { expect, seedFailedDelivery, test, toast, uniq } from "./admin-support";

test.describe("設定（WEB-16/18/19）", () => {
  test("システム設定を保存すると再読み込み後も反映され、同時更新は競合として案内される", async ({ page, context }) => {
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/settings\/system$/);
    await expect(page.getByRole("tab", { name: "システム設定", selected: true })).toBeVisible();
    await expect(page.getByLabel("タイムゾーン")).toHaveValue("日本標準時（Asia/Tokyo）");
    await expectNoA11yViolations(page);

    const dept = `E2E部 ${uniq()}`;
    const departments = page.getByLabel("部署");
    await departments.fill(dept);
    await departments.press("Enter");
    await page.getByLabel("追加する日付").fill("2026-12-29");
    await page.getByRole("button", { name: "休日を追加" }).click();
    await page.getByLabel("取消期限").fill("12");
    await page.getByLabel("1回の最大利用時間").fill("8");
    await page.getByRole("button", { name: "設定を保存" }).click();
    await expect(toast(page, "設定を保存しました")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("button", { name: `${dept}を削除` })).toBeVisible();
    await expect(page.getByRole("list", { name: "登録済みの休日" })).toContainText("2026年12月29日（火）");
    await expect(page.getByLabel("取消期限")).toHaveValue("12");
    await expect(page.getByLabel("1回の最大利用時間")).toHaveValue("8");

    // Another administrator saves first → this tab is told to reload (If-Match).
    const other = await context.newPage();
    await other.goto("/settings/system");
    await other.getByLabel("取消期限").fill("24");
    await other.getByRole("button", { name: "設定を保存" }).click();
    await expect(toast(other, "設定を保存しました")).toBeVisible();
    await other.close();
    await page.getByLabel("1回の最大利用時間").fill("10");
    await page.getByRole("button", { name: "設定を保存" }).click();
    await expect(page.getByText(/情報が更新されました。再読み込みしてください。/)).toBeVisible();
    await page.getByRole("button", { name: "最新の情報を読み込む" }).click();
    await expect(page.getByLabel("取消期限")).toHaveValue("24");

    // Restore the organisation (no configured departments, no holiday) for the other specs.
    await page.getByRole("button", { name: `${dept}を削除` }).click();
    await page.getByRole("button", { name: "2026年12月29日（火）を休日から削除" }).click();
    await page.getByLabel("1回の最大利用時間").fill("10");
    await page.getByRole("button", { name: "設定を保存" }).click();
    await expect(toast(page, "設定を保存しました")).toBeVisible();
    await expect(page.getByText("登録された休日はありません。")).toBeVisible();
  });

  test("範囲外の値は日本語のエラーになり保存されない", async ({ page }) => {
    await page.goto("/settings/system");
    await page.getByLabel("1回の最大利用時間").fill("90");
    await page.getByRole("button", { name: "設定を保存" }).click();
    await expect(page.getByText("60以下の値を入力してください。")).toBeVisible();
    await expect(page.getByLabel("1回の最大利用時間")).toHaveAttribute("aria-invalid", "true");
  });

  test("管理者を招待し、二段階認証のリセット・停止・再開ができ、重複メールは入力欄に表示される", async ({ page }) => {
    await page.goto("/settings/users");
    await expect(page.getByRole("heading", { name: "ユーザー管理", level: 1 })).toBeVisible();
    await expect(page.getByRole("row", { name: /山田 太郎/ })).toContainText("（自分）");
    await expect(page.getByRole("row", { name: /山田 太郎/ }).getByRole("button", { name: /停止/ })).toHaveCount(0);
    await expectNoA11yViolations(page);

    const n = uniq();
    const email = `e2e-admin2-${n}@example.invalid`;
    await page.getByRole("button", { name: "管理者を招待" }).click();
    const dialog = page.getByRole("dialog", { name: "管理者を招待" });
    await dialog.getByLabel("氏名").fill(`副管理者 ${n}`);
    await dialog.getByLabel("メールアドレス").fill(email);
    await dialog.getByRole("button", { name: "招待を送信" }).click();
    await expect(dialog.getByText(/^(送信済み|送信失敗（再送可能）|送信待ち)$/)).toBeVisible();
    await dialog.getByRole("button", { name: "続けて招待" }).click();
    await dialog.getByLabel("氏名").fill(`重複 ${n}`);
    await dialog.getByLabel("メールアドレス").fill(email);
    await dialog.getByRole("button", { name: "招待を送信" }).click();
    await expect(dialog.getByLabel("メールアドレス")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByText("このメールアドレスは既に登録されています。")).toBeVisible();
    await dialog.getByRole("button", { name: "キャンセル" }).click();

    await page.getByRole("searchbox", { name: "検索" }).fill(email);
    await page.getByRole("searchbox", { name: "検索" }).press("Enter");
    const row = page.getByRole("row", { name: new RegExp(`副管理者 ${n}`) });
    await expect(row).toContainText("管理者");
    // 認証アプリを紛失した管理者の二段階認証リセット（自分の行には表示されない）。
    await expect(page.getByRole("button", { name: "山田 太郎さんの二段階認証をリセット" })).toHaveCount(0);
    await row.getByRole("button", { name: `副管理者 ${n}さんの二段階認証をリセット` }).click();
    const reset = page.getByRole("alertdialog", { name: "二段階認証をリセットしますか？" });
    await expect(reset).toContainText(email);
    await reset.getByRole("button", { name: "リセットする" }).click();
    await expect(toast(page, `副管理者 ${n}さんの二段階認証をリセットしました`)).toBeVisible();
    await row.getByRole("button", { name: `副管理者 ${n}さんを停止` }).click();
    const confirm = page.getByRole("alertdialog", { name: "アカウントを停止しますか？" });
    await expect(confirm).toContainText(email);
    await confirm.getByRole("button", { name: "停止する" }).click();
    await expect(toast(page, `副管理者 ${n}さんのアカウントを停止しました`)).toBeVisible();

    await page.getByLabel("状態").selectOption("inactive");
    const stopped = page.getByRole("row", { name: new RegExp(`副管理者 ${n}`) });
    await expect(stopped).toContainText("停止中");
    await stopped.getByRole("button", { name: `副管理者 ${n}さんを再開` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "再開する" }).click();
    await expect(toast(page, `副管理者 ${n}さんのアカウントを再開しました`)).toBeVisible();
  });

  test("ログ・イベントは日本語のイベント名で絞り込め、詳細を秘密情報なしで確認しCSVで出力できる", async ({ page }) => {
    await page.goto("/settings/events?type=settings.");
    await expect(page.getByRole("heading", { name: "ログ・イベント", level: 1 })).toBeVisible();
    await expect(page.getByLabel("イベント", { exact: true })).toHaveValue("settings.");
    const table = page.getByRole("table", { name: "操作・処理履歴" });
    await expect(table.getByRole("row").nth(1)).toContainText("設定の変更");
    await expect(table.getByRole("row").nth(1)).toContainText("成功");
    await expectNoA11yViolations(page);

    await table.getByRole("row").nth(1).getByRole("button", { name: /の詳細を見る$/ }).click();
    const drawer = page.getByRole("dialog", { name: "設定の変更" });
    await expect(drawer).toContainText("settings.updated");
    await expect(drawer).toContainText("山田 太郎");
    await expect(drawer.locator("pre")).toContainText('"changes"');
    await expect(drawer).toContainText("秘密情報（パスワード・トークン・会議URLなど）は除去して表示しています。");
    await expectNoA11yViolations(page);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "CSV出力" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^arms-audit-\d{8}\.csv$/);
    await expect(toast(page, "CSVを出力しました")).toBeVisible();
    const content = await (await import("node:fs/promises")).readFile((await file.path()) as string, "utf8");
    expect(content.replace(/^\uFEFF/, "").split("\r\n")[0]?.replace(/"/g, "")).toBe("日時,実行者,イベント種別,対象ID,詳細");
    expect(content).toContain("settings.updated");

    // Invalid date range is explained and blocks the export.
    await page.getByLabel("期間（開始日）").fill("2026-10-10");
    await page.getByLabel("期間（終了日）").fill("2026-10-01");
    await expect(page.getByText("終了日は開始日以降にしてください。").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "CSV出力" })).toBeDisabled();
  });

  test("送信に失敗した通知を再送できる", async ({ page }) => {
    await seedFailedDelivery(fixture().classroomId);
    await page.goto("/settings/events");
    const deliveries = page.getByRole("table", { name: "通知配信" });
    const failed = deliveries.getByRole("row").filter({ hasText: "送信失敗" });
    await expect(failed.first()).toContainText("予約の承認");
    const before = await failed.count();
    await failed.first().getByRole("button", { name: "予約の承認の通知を再送" }).click();
    await expect(toast(page, "通知の再送を受け付けました")).toBeVisible();
    await expect(deliveries.getByRole("row").filter({ hasText: "送信失敗" })).toHaveCount(before - 1);
    await page.getByLabel("配信状態").selectOption("pending");
    await expect(page).toHaveURL(/delivery=pending/);
    await expect(page.getByRole("table", { name: "通知配信" }).getByRole("row").filter({ hasText: "予約の承認" }).first()).toContainText("送信待ち");
  });

  test.describe("講師ロール", () => {
    test.use({ role: "teacher" });

    test("講師は個人設定だけを使え、ダークテーマでもアクセシブル", async ({ page }) => {
      await page.goto("/settings/users");
      await expect(page).toHaveURL(/\/settings\/personal$/);
      await expect(page.getByRole("tab")).toHaveText(["個人設定"]);
      await page.getByRole("radio", { name: "ダーク" }).check();
      const saved = page.waitForResponse((r) => r.url().includes("/api/v1/me/preferences") && r.request().method() === "PATCH");
      await page.getByRole("button", { name: "設定を保存" }).click();
      expect((await saved).status()).toBe(200);
      await expect(toast(page, "個人設定を保存しました")).toBeVisible();
      await expect(page.locator("html")).toHaveClass(/dark/);
      await expectNoA11yViolations(page);

      // Back to the default so later specs start from the system theme.
      await page.getByRole("radio", { name: "端末の設定に合わせる" }).check();
      await page.getByRole("button", { name: "設定を保存" }).click();
      await expect(page.locator("html")).not.toHaveClass(/dark/);
    });
  });
});
