import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { totp } from "./totp";

export interface Fixture {
  orgId: string;
  classroomId: string;
  password: string;
  admin: { id: string; email: string; totpSecret: string };
  teacher: { id: string; email: string };
}

export const fixture = (): Fixture => JSON.parse(readFileSync(join(import.meta.dirname, ".fixture.json"), "utf8")) as Fixture;

export async function loginAs(page: Page, role: "admin" | "teacher"): Promise<void> {
  const f = fixture();
  await page.goto("/login");
  await page.getByLabel("利用区分").selectOption(role === "admin" ? "管理者" : "講師");
  await page.getByLabel("メールアドレス").fill(role === "admin" ? f.admin.email : f.teacher.email);
  await page.getByLabel("パスワード").fill(f.password);
  await page.getByRole("button", { name: "ログイン" }).click();
  if (role === "admin") {
    await expect(page.getByRole("heading", { name: "二段階認証" })).toBeVisible();
    // A TOTP code is accepted once per 30-second step (replay protection). When another sign-in of the same
    // administrator already used the current code, wait for the next step and enter the new code.
    for (let attempt = 0; ; attempt++) {
      await page.getByLabel("認証コード（6桁）").fill(totp(f.admin.totpSecret));
      await page.getByRole("button", { name: "認証して続ける" }).click();
      const menu = page.getByRole("navigation", { name: "メインメニュー" });
      const rejected = page.getByText("認証コードが正しくありません。").first();
      await expect(menu.or(rejected)).toBeVisible();
      if (await menu.isVisible()) break;
      if (attempt >= 2) throw new Error("TOTP code rejected three times");
      await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
    }
  }
  await expect(page.getByRole("navigation", { name: "メインメニュー" })).toBeVisible();
}

/** WCAG 2.x A/AA automated checks (axe). Manual checks are still required for full conformance. */
export async function expectNoA11yViolations(page: Page): Promise<void> {
  // Measure settled colours: CSS transitions (e.g. right after a theme switch) would otherwise be sampled mid-way.
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.help} — ${v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary?.split("\n").slice(1).join(" ") ?? ""}`).join(" | ")}`,
  );
  expect(summary, summary.join("\n")).toEqual([]);
}
