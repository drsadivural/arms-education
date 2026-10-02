import { join } from "node:path";
import { expectNoA11yViolations } from "./helpers";
import { apiCall, expect, test, uniq } from "./admin-support";

const SAMPLE = join(import.meta.dirname, "..", "..", "..", "migration", "teachers.csv");

test.describe("データ移植（WEB-17）", () => {
  test("設定のタブから移行を始め、CSVをプレビューできる", async ({ page }) => {
    await page.goto("/settings/import");
    await expect(page.getByRole("tab", { name: "データ移植", selected: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "既存システムからのデータ移植" })).toBeVisible();
    await expect(page.getByRole("list", { name: "移行の手順" })).toBeVisible();
    await expectNoA11yViolations(page);
    await page.getByLabel("移行するデータ").selectOption("teachers");
    await page.getByLabel("移行元システム名").fill("旧社員教育システム");
    await page.getByLabel("CSVファイル").setInputFiles(SAMPLE);
    // Local preview decodes the UTF-8 BOM file before anything is uploaded.
    await expect(page.getByText("田中 祥司").first()).toBeVisible();
  });

  test("講師CSVを実スキャン→対応付け→ドライラン→確定まで移行し、講師管理に反映される", async ({ page }) => {
    test.setTimeout(120_000);
    const id = uniq();
    const csv =
      "﻿講師番号,氏名,ふりがな,メール,部署,状態\r\n" +
      `MIG-${id}-1,移行 一郎,いこう いちろう,mig1-${id}@example.invalid,開発部,有効\r\n` +
      `MIG-${id}-2,移行 花子,いこう はなこ,mig2-${id}@example.invalid,営業部,有効\r\n`;
    await page.goto("/settings/import");
    await page.getByLabel("移行するデータ").selectOption("teachers");
    await page.getByLabel("移行元システム名").fill(`旧システム-${id}`);
    await page.getByLabel("CSVファイル").setInputFiles({ name: "teachers.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf8") });
    await page.getByRole("button", { name: "アップロードして次へ" }).click();
    // The quarantined file is scanned by ClamAV (local stack) before it can be read.
    await expect(page.getByRole("heading", { name: "項目の対応（講師）" })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "ドライランを実行" }).click();
    await expect(page.getByText("新規").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "移行確定へ進む" }).click();
    await page.getByRole("button", { name: "移行を確定" }).click();
    const dialog = page.getByRole("alertdialog", { name: "移行を確定しますか？" });
    await expect(dialog).toContainText("新規 2件");
    await dialog.getByRole("button", { name: "確定する" }).click();
    await expect(dialog.getByRole("alert")).toContainText("バックアップを取得したことを確認してください");
    await dialog.getByLabel("移行前にデータベースのバックアップを取得しました").check();
    await dialog.getByRole("button", { name: "確定する" }).click();
    await expect(page.getByText("反映済み").first()).toBeVisible({ timeout: 60_000 });

    const list = await apiCall<{ items: { display_name: string; teacher_number: string }[] }>(page, "GET", `/teachers?q=${encodeURIComponent(`MIG-${id}`)}&limit=100`);
    const numbers = list.items.map((t) => t.teacher_number);
    expect(numbers).toEqual(expect.arrayContaining([`MIG-${id}-1`, `MIG-${id}-2`]));
  });
});
