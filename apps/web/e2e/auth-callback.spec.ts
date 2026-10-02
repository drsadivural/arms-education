import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectNoA11yViolations, fixture } from "./helpers";

const vars = Object.fromEntries(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "services/api/.dev.vars"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;

test.describe("招待・再設定リンクからのパスワード設定", () => {
  test("リンクのトークンでパスワードを設定し、URLからトークンを消す", async ({ page, request }) => {
    const f = fixture();
    // A real Supabase Auth session for the teacher stands in for the token GoTrue puts in the e-mail link.
    const tok = await request.post(`${vars.SUPABASE_AUTH_URL}/token?grant_type=password`, { data: { email: f.teacher.email, password: f.password } });
    const accessToken = (await tok.json()).access_token as string;
    await page.goto(`/auth/callback#access_token=${accessToken}&type=recovery&token_type=bearer`);
    await expect(page.getByRole("heading", { name: "パスワードの再設定" })).toBeVisible();
    expect(page.url()).not.toContain("access_token");
    await expectNoA11yViolations(page);
    await page.getByLabel("新しいパスワード", { exact: false }).first().fill("short");
    await page.getByLabel("新しいパスワード（確認）").fill("short");
    await page.getByRole("button", { name: "パスワードを設定" }).click();
    await expect(page.getByText("10文字以上で入力してください。")).toBeVisible();
    // Setting the same password back keeps the shared E2E fixture valid while exercising the full path.
    const next = `${f.password}9`;
    await page.getByLabel("新しいパスワード", { exact: false }).first().fill(next);
    await page.getByLabel("新しいパスワード（確認）").fill(next);
    await page.getByRole("button", { name: "パスワードを設定" }).click();
    await expect(page.getByRole("status")).toContainText("パスワードを設定しました");
    const relogin = await request.post(`${vars.SUPABASE_AUTH_URL}/token?grant_type=password`, { data: { email: f.teacher.email, password: next } });
    expect(relogin.status()).toBe(200);
    // Restore the fixture password for the other specs.
    const tok2 = (await relogin.json()).access_token as string;
    const restore = await request.put(`${vars.SUPABASE_AUTH_URL}/user`, { headers: { Authorization: `Bearer ${tok2}` }, data: { password: f.password } });
    expect(restore.status()).toBe(200);
  });

  test("トークンなしで開くと再送を案内する", async ({ page }) => {
    await page.goto("/auth/callback");
    await expect(page.getByRole("alert")).toContainText("メールのリンクから開いてください");
  });
});
