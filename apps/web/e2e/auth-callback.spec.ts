import { apiCall, expect, test, uniq } from "./admin-support";
import { mailLink } from "./accounts";
import { expectNoA11yViolations } from "./helpers";

/**
 * Invitation and password reset through the real e-mails: the administrator registers a teacher (POST /teachers →
 * invitation e-mail in Mailpit), the teacher opens the link, sets a password and signs in; later the teacher uses
 * 「パスワードをお忘れですか？」 and the reset link. A dedicated teacher is used so the shared fixture accounts keep
 * their sessions.
 */
test.describe("招待・再設定リンクからのパスワード設定", () => {
  test("招待メールのリンクでパスワードを設定してログインし、再設定メールでも変更できる", async ({ page, browser }) => {
    await page.goto("/teachers");
    const n = uniq();
    const email = `e2e-invited-${n}@example.invalid`;
    const created = await apiCall<{ invitation: { state: string } }>(page, "POST", "/teachers", {
      display_name: `招待 講師${n}`,
      kana: "しょうたい こうし",
      email,
      teacher_number: `T-INV-${n}`,
      department_name: "開発部",
      specialties: [],
      active: true,
    });
    expect(created.invitation.state).toBe("sent");

    const invitee = await browser.newContext({ storageState: { cookies: [], origins: [] }, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
    const p = await invitee.newPage();
    const token = await mailLink(email, "invite");
    await p.goto(`/auth/callback#token=${encodeURIComponent(token)}&type=invite`);
    await expect(p.getByRole("heading", { name: "ARMSへようこそ" })).toBeVisible();
    // The one-time token is removed from the address bar and history at once.
    expect(p.url()).not.toContain("token=");
    await expectNoA11yViolations(p);
    await p.getByLabel("新しいパスワード", { exact: false }).first().fill("short");
    await p.getByLabel("新しいパスワード（確認）").fill("short");
    await p.getByRole("button", { name: "パスワードを設定" }).click();
    await expect(p.getByText("10文字以上で入力してください。")).toBeVisible();
    const password = `Invited-${n}-2026`;
    await p.getByLabel("新しいパスワード", { exact: false }).first().fill(password);
    await p.getByLabel("新しいパスワード（確認）").fill(password);
    await p.getByRole("button", { name: "パスワードを設定" }).click();
    await expect(p.getByRole("status")).toContainText("パスワードを設定しました。ログイン画面からログインしてください。");

    // Sign in with the new password.
    await p.goto("/login");
    await p.getByLabel("利用区分").selectOption("講師");
    await p.getByLabel("メールアドレス").fill(email);
    await p.getByLabel("パスワード").fill(password);
    await p.getByRole("button", { name: "ログイン" }).click();
    await expect(p.getByRole("navigation", { name: "メインメニュー" })).toBeVisible();
    // The invitation link cannot be used a second time.
    const reused = await p.request.post("/api/v1/auth/password", { data: { token, password: `Another-${n}-2026` } });
    expect(reused.status()).toBe(401);
    await invitee.close();

    // 「パスワードをお忘れですか？」 → reset e-mail → new password (signed-out browser).
    const forgetful = await browser.newContext({ storageState: { cookies: [], origins: [] }, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
    const r = await forgetful.newPage();
    await r.goto("/login");
    await r.getByRole("button", { name: "パスワードをお忘れですか？" }).click();
    await r.getByLabel("メールアドレス").fill(email);
    await r.getByRole("button", { name: "再設定メールを送信" }).click();
    await expect(r.getByRole("status")).toContainText("再設定の案内を送信しました");
    const resetToken = await mailLink(email, "recovery");
    await r.goto(`/auth/callback#token=${encodeURIComponent(resetToken)}&type=recovery`);
    await expect(r.getByRole("heading", { name: "パスワードの再設定" })).toBeVisible();
    const next = `Reset-${n}-2026`;
    await r.getByLabel("新しいパスワード", { exact: false }).first().fill(next);
    await r.getByLabel("新しいパスワード（確認）").fill(next);
    await r.getByRole("button", { name: "パスワードを設定" }).click();
    await expect(r.getByRole("status")).toContainText("パスワードを設定しました");
    const oldLogin = await r.request.post("/api/v1/auth/login", { data: { email, password, selected_role: "teacher" } });
    expect(oldLogin.status()).toBe(401);
    await forgetful.close();
  });

  test("トークンなしで開くと再送を案内する", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const p = await ctx.newPage();
    await p.goto("/auth/callback");
    await expect(p.getByRole("alert")).toContainText("メールのリンクから開いてください");
    await ctx.close();
  });
});
