/**
 * POST /imports/{id}/validate — dry run (docs/08 「文字コード判定/プレビュー→列mapping→…→dry run→行ごとの日本語エラー→
 * 合計/新規/更新/skip確認」). Reads the private file through ObjectStorage, decodes it, parses the CSV, applies the
 * mapping and plans every row without touching business tables. The plan replaces the previous dry run.
 */
import { IMPORT_LIMITS, type ImportEntity } from "@arms/contracts";
import type { AppContext } from "../../context";
import { actorTx } from "../../context";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { ApiError, fail } from "../../http/errors";
import type { ObjectStorage } from "../../integrations/storage";
import { audit } from "../admin/common";
import { CsvSyntaxError, isBlankRecord, parseCsv } from "./csv";
import { decodeImportFile, type DecodedFile } from "./encoding";
import { findJob, replaceItems } from "./jobs";
import { checkMapping } from "./mapping";
import { fieldDefs, type ColumnSummary, type JobRow, type JobSummary, type PlannedItem, type SourceRow } from "./model";
import { planRows } from "./plan";

/** Reads at most `limit` + 1 bytes of the object (a larger file is rejected without buffering it whole). */
export async function readObject(storage: ObjectStorage, key: string, limit: number): Promise<Uint8Array> {
  const head = await storage.head(key);
  if (!head) fail("IMPORT_FILE_MISSING");
  if (head.size > limit) fail("FILE_TOO_LARGE", { message_ja: "ファイルサイズが上限（10MB）を超えています。ファイルを分割してください。" });
  const stream = await storage.get(key);
  if (!stream) fail("IMPORT_FILE_MISSING");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      fail("FILE_TOO_LARGE", { message_ja: "ファイルサイズが上限（10MB）を超えています。ファイルを分割してください。" });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export interface ParsedFile {
  decoded: DecodedFile;
  headers: string[];
  rows: SourceRow[];
  blankRows: number;
}

/** Decodes and parses the file and maps every non-blank data record (row numbers as in a spreadsheet, header = 1). */
export function parseImportFile(bytes: Uint8Array, job: Pick<JobRow, "encoding" | "entity" | "mapping">): ParsedFile {
  const decoded = decodeImportFile(bytes, job.encoding);
  let parsed;
  try {
    // Blank rows (",,,," exported by spreadsheets) do not count against the limit but are bounded as well.
    parsed = parseCsv(decoded.text, IMPORT_LIMITS.maxRows * 2 + 1);
  } catch (e) {
    if (e instanceof CsvSyntaxError) {
      throw new ApiError("IMPORT_CSV_INVALID", {
        message_ja:
          e.reason === "unterminated_quote"
            ? `${e.line}行目から始まる値の引用符（"）が閉じられていません。`
            : `${e.line}行目の引用符（"）で囲んだ値の後に余分な文字があります。値の中の " は "" と書いてください。`,
        details: { line: e.line },
      });
    }
    throw e;
  }
  const [header, ...records] = parsed.records;
  if (!header || isBlankRecord(header.cells)) fail("IMPORT_EMPTY", { message_ja: "1行目に見出し（列名）がありません。" });
  const headers = header.cells.map((h) => h.trim());
  checkMapping(job.entity, job.mapping, headers);
  const fieldOf = new Map(Object.entries(job.mapping).map(([h, f]) => [h, f]));
  const rows: SourceRow[] = [];
  let blankRows = 0;
  records.forEach((record, index) => {
    if (isBlankRecord(record.cells)) {
      blankRows++;
      return;
    }
    const values = new Map<string, string>();
    const source: Record<string, string> = {};
    headers.forEach((h, i) => {
      const cell = record.cells[i] ?? "";
      if (h !== "") source[h] = cell;
      const field = fieldOf.get(h);
      if (field !== undefined) values.set(field, cell);
    });
    const extraCells = record.cells.slice(headers.length).filter((c) => c.trim() !== "").length;
    rows.push({ row: index + 2, values, source, extraCells });
  });
  if (parsed.truncated || rows.length > IMPORT_LIMITS.maxRows) {
    fail("IMPORT_TOO_MANY_ROWS", { details: { max_rows: IMPORT_LIMITS.maxRows } });
  }
  if (rows.length === 0) fail("IMPORT_EMPTY");
  return { decoded, headers, rows, blankRows };
}

function columnSummary(entity: ImportEntity, mapping: Record<string, string>, rows: SourceRow[], items: PlannedItem[]): ColumnSummary[] {
  const headerOf = new Map(Object.entries(mapping).map(([h, f]) => [f, h]));
  return fieldDefs(entity).map((d) => {
    const header = headerOf.get(d.field) ?? null;
    return {
      field: d.field,
      label_ja: d.label,
      required: d.required,
      source_header: header,
      empty_meaning_ja: d.empty,
      empty_count: header === null ? null : rows.filter((r) => (r.values.get(d.field) ?? "").trim() === "").length,
      error_count: items.filter((i) => i.errors.some((e) => e.field === d.field)).length,
    };
  });
}

export async function validateImport(c: AppContext, jobId: string): Promise<void> {
  const actor = c.get("actor");
  const storage = c.get("deps").integrations.storage;
  if (!storage) fail("NOT_CONFIGURED");
  const job = await actorTx(c, async (tx) => {
    const found = await findJob(tx, actor.orgId, jobId);
    if (!found) fail("NOT_FOUND");
    return found;
  });
  assertValidatable(job);
  const bytes = await readObject(storage, job.object_key, IMPORT_LIMITS.maxBytes);
  const file = parseImportFile(bytes, job);
  await actorTx(c, async (tx) => {
    const current = await findJob(tx, actor.orgId, jobId, { lock: true });
    if (!current) fail("NOT_FOUND");
    assertValidatable(current);
    // The mapping/encoding changed (PATCH) or another dry run finished while this one read the file.
    if (current.row_version !== job.row_version) fail("VERSION_CONFLICT");
    const items = await planRows(job.entity, { tx, orgId: actor.orgId, sourceSystem: job.source_system, jobId }, file.rows);
    await replaceItems(tx, actor.orgId, jobId, job.entity, items);
    const summary: JobSummary = {
      headers: file.headers,
      columns: columnSummary(job.entity, job.mapping, file.rows, items),
      detected_encoding: file.decoded.detected,
      encoding_mismatch: file.decoded.mismatch,
      blank_rows: file.blankRows,
    };
    await tx.exec(sql`
      UPDATE app.import_jobs SET state = 'validated', summary = ${json(summary)}::jsonb, validated_at = now(), failure = NULL, updated_at = now(),
        row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${jobId}`);
    const count = (a: string) => items.filter((i) => i.action === a).length;
    await audit(tx, actor, "import.validated", jobId, {
      entity: job.entity,
      source_system: job.source_system,
      total: items.length,
      create: count("create"),
      update: count("update"),
      skip: count("skip"),
      error: count("error"),
      detected_encoding: file.decoded.detected,
    });
  });
}

function assertValidatable(job: JobRow): void {
  if (job.state !== "uploaded" && job.state !== "validated") {
    fail("INVALID_STATE", { message_ja: "確定を開始した移行ジョブはドライランをやり直せません。新しい移行ジョブを作成してください。" });
  }
  if (job.leased) fail("IMPORT_IN_PROGRESS");
}
