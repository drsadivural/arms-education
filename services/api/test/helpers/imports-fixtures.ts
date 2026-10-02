/**
 * Fixtures for the data-migration tests: an organisation with in-memory ObjectStorage (+ scanner double), CSV byte
 * builders (UTF-8, UTF-8 BOM, CP932 via encoding-japanese) and import upload rows written with the owner pool.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as EncodingModule from "encoding-japanese";
import { expect } from "vitest";
import { call, cookieCaller, bearerCaller, createTestContext, type Caller, type TestContext } from "./app";
import { seedOrg, type OrgScenario } from "./fixtures";
import { FakeScanner, MemoryObjectStorage } from "./learning-fakes";

const Encoding = ((EncodingModule as unknown as { default?: typeof EncodingModule }).default ?? EncodingModule) as typeof EncodingModule;

export interface ImportWorld {
  ctx: TestContext;
  storage: MemoryObjectStorage;
  scanner: FakeScanner;
  org: OrgScenario;
  admin: Caller;
  teacher: Caller;
  student: Caller;
}

export async function importWorld(opts: { scanner?: boolean; storage?: boolean } = {}): Promise<ImportWorld> {
  const storage = new MemoryObjectStorage();
  const scanner = new FakeScanner(storage);
  const ctx = createTestContext({ storage: opts.storage === false ? null : storage, scanner: opts.scanner === false ? null : scanner });
  const org = await seedOrg(ctx.admin);
  return {
    ctx,
    storage,
    scanner,
    org,
    admin: await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" }),
    teacher: await bearerCaller(org.teacher.userId, org.orgId),
    student: await bearerCaller(org.student.userId, org.orgId),
  };
}

let seq = 0;
/** Unique token for numbers / e-mails (users.email is unique across all organisations of the test database). */
export const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1e4)}`;

export const utf8 = (text: string) => new TextEncoder().encode(text);
export const withBom = (text: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(text)]);
export function cp932(text: string): Uint8Array {
  return new Uint8Array(Encoding.convert(Encoding.stringToCode(text), { to: "SJIS", from: "UNICODE", type: "array" }));
}

/** CSV text from rows (cells quoted when needed, CRLF). */
export function csv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n") + "\r\n";
}

/** Sample legacy exports shipped in migration/ (UTF-8 with BOM, Japanese headers). */
export function sampleFile(name: "teachers" | "classrooms" | "students" | "progress"): Uint8Array {
  return new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), `../../../../migration/${name}.csv`)));
}

export type UploadState = "awaiting_upload" | "scanning" | "clean" | "blocked" | "rejected" | "expired";

/** Writes an import upload row (and the object for clean uploads) as the learning upload pipeline would. */
export async function insertUpload(
  w: Pick<ImportWorld, "ctx" | "storage">,
  orgId: string,
  userId: string,
  bytes: Uint8Array,
  opts: { state?: UploadState; purpose?: "import" | "material"; filename?: string; expired?: boolean; rejectCode?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const state = opts.state ?? "clean";
  const finalKey = `imports/${orgId}/${id}`;
  const quarantineKey = `quarantine/${orgId}/${crypto.randomUUID()}`;
  const objectKey = state === "clean" ? finalKey : quarantineKey;
  const scanState = state === "clean" ? "clean" : state === "blocked" ? "blocked" : "pending";
  // A scanning upload is recorded as already submitted (scan_reference) so the learning area's background scan poller,
  // which runs across all organisations of the shared test database, only polls it instead of re-submitting a file
  // that exists in this test's in-memory storage only.
  await w.ctx.admin.query(
    `INSERT INTO app.upload_jobs(org_id, id, user_id, purpose, object_key, quarantine_key, filename, content_type, expected_size, scan_state, state,
       expires_at, size_bytes, reject_code, scan_reference, scan_submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'text/csv', $8, $9, $10, now() + ($11 || ' minutes')::interval, $8, $12,
       CASE WHEN $10 = 'scanning' THEN 'import-test-pending-scan' END, CASE WHEN $10 = 'scanning' THEN now() END)`,
    [orgId, id, userId, opts.purpose ?? "import", objectKey, quarantineKey, opts.filename ?? "legacy.csv", Math.max(bytes.length, 1), scanState, state, opts.expired ? "-5" : "60", opts.rejectCode ?? null],
  );
  if (state === "clean") w.storage.clientPut(finalKey, bytes, "text/csv");
  return id;
}

export interface JobInput {
  entity: "teachers" | "classrooms" | "students" | "progress";
  columns: Record<string, string>;
  encoding?: "utf-8" | "utf-8-bom" | "cp932";
  source_system?: string;
}

export const SAMPLE_COLUMNS: Record<JobInput["entity"], Record<string, string>> = {
  teachers: { 講師番号: "teacher_number", 氏名: "display_name", ふりがな: "kana", メール: "email", 部署: "department_name", 状態: "active" },
  classrooms: { クラス番号: "classroom_code", 名称: "name", 定員: "capacity", 開始日: "starts_on", 終了日: "ends_on", 主担当講師番号: "primary_teacher_number" },
  students: {
    社員番号: "employee_number",
    氏名: "display_name",
    ふりがな: "kana",
    メール: "email",
    部署: "department_name",
    入社日: "joined_on",
    クラス番号: "classroom_code",
    担当講師番号: "teacher_number",
  },
  progress: {
    source_record_id: "source_record_id",
    社員番号: "employee_number",
    終了予定日: "due_date",
    教育担当部署: "department_name",
    教育担当講師番号: "teacher_number",
    教育担当者: "teacher_name",
    内容: "content",
    状態: "state",
  },
};

/** Upload (clean) + POST /imports; returns the job id. */
export async function createJob(w: ImportWorld, bytes: Uint8Array, input: JobInput, caller: Caller = w.admin): Promise<string> {
  const uploadId = await insertUpload(w, caller.orgId, caller.userId, bytes);
  const res = await call(w.ctx, caller, "POST", "/imports", {
    body: { source_system: input.source_system ?? "旧社員教育進捗管理", encoding: input.encoding ?? "utf-8-bom", entity: input.entity, columns: input.columns, upload_id: uploadId },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.id as string;
}

export async function validateJob(w: ImportWorld, jobId: string, caller: Caller = w.admin) {
  const res = await call(w.ctx, caller, "POST", `/imports/${jobId}/validate`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
}

export async function commitJob(w: ImportWorld, jobId: string, opts: { sendInvitations?: boolean; key?: string; caller?: Caller } = {}) {
  return call(w.ctx, opts.caller ?? w.admin, "POST", `/imports/${jobId}/commit`, {
    body: { backup_confirmed: true, ...(opts.sendInvitations !== undefined ? { send_invitations: opts.sendInvitations } : {}) },
    idempotencyKey: opts.key,
  });
}

/** Upload → job → dry run → commit; asserts the job completed. */
export async function importAll(w: ImportWorld, bytes: Uint8Array, input: JobInput, opts: { sendInvitations?: boolean } = {}) {
  const jobId = await createJob(w, bytes, input);
  const validated = await validateJob(w, jobId);
  expect(validated.body.data.error_rows, JSON.stringify(validated.body.data.errors)).toBe(0);
  const committed = await commitJob(w, jobId, opts);
  expect(committed.status, JSON.stringify(committed.body)).toBe(200);
  expect(committed.body.data.state).toBe("completed");
  return { jobId, validated, committed };
}

export async function items(w: ImportWorld, jobId: string, query = "") {
  const res = await call(w.ctx, w.admin, "GET", `/imports/${jobId}/items${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.items as any[];
}
