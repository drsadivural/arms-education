import { join } from "node:path";
import { expectNoA11yViolations } from "./helpers";
import { expect, test } from "./admin-support";

const SAMPLE = join(import.meta.dirname, "..", "..", "..", "migration", "teachers.csv");

test.describe("データ移植（WEB-17）", () => {
  test("設定のタブから移行を始め、CSVをプレビューしてアップロードできる（検査未設定ならその旨を案内）", async ({ page }) => {
    await page.goto("/settings/import");
    await expect(page.getByRole("tab", { name: "データ移植", selected: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "既存システムからのデータ移植" })).toBeVisible();
    await expect(page.getByRole("list", { name: "移行の手順" })).toBeVisible();
    await expectNoA11yViolations(page);

    await page.getByLabel("移行するデータ").selectOption({ index: 0 });
    await page.getByLabel("移行元システム名").fill("旧社員教育システム");
    await page.getByLabel("CSVファイル").setInputFiles(SAMPLE);
    // Local preview decodes the UTF-8 BOM file before anything is uploaded.
    await expect(page.getByText("田中 祥司").first()).toBeVisible();

    await page.getByRole("button", { name: "アップロードして次へ" }).click();
    // Without a malware scanner (local stack) the quarantined file is never treated as clean.
    await expect(page.getByText(/ファイル検査（マルウェアスキャン）サービスが設定されていない|ファイルを検査しています/).first()).toBeVisible({ timeout: 20_000 });
  });
});
