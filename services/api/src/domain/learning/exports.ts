/**
 * 教育進捗 exports (WEB-11 CSV/PDF). Small exports are generated in the request; larger ones by the learning cron.
 * The export always applies the creator's current role scope (a teacher's file contains only their records) and
 * the organisation-timezone "today" for 期限超過. Files live under exports/<org>/<uuid>.<ext> for 24 hours and are
 * downloaded through 5-minute presigned URLs issued to the creator only.
 */
import { PROGRESS_RECORD_STATE_LABELS, formatMonthJa, zonedDateString, zonedParts, type ExportInputT } from "@arms/contracts";
import type { Actor, Role } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import type { ObjectStorage } from "../../integrations/storage";
import { ApiError } from "../../http/errors";
import { audit, iso } from "./common";
import { RECORD_ORDER, recordSelect, recordWhere, type RecordFilters, type RecordRow } from "./progress-records";
import { buildCsv, loadPdfFont, type ExportRecord } from "./export-render";

export const EXPORT_MAX_ROWS = 10_000;
/** Exports up to this size are generated synchronously in the request. */
export const EXPORT_SYNC_ROWS = 500;
export const EXPORT_RETENTION_SECONDS = 24 * 3600;
export const EXPORT_URL_SECONDS = 5 * 60;

export interface ExportJobRow {
  id: string;
  user_id: string;
  format: "csv" | "pdf";
  filters: Record<string, unknown>;
  state: "pending" | "ready" | "failed";
  object_key: string | null;
  created_at: Date;
  completed_at: Date | null;
  row_count: number | null;
  error_code: string | null;
  filename: string | null;
  file_expires_at: Date | null;
  attempts: number;
}

export const EXPORT_COLUMNS = sql`id, user_id, format, filters, state, object_key, created_at, completed_at, row_count, error_code, filename, file_expires_at, attempts`;

export function filtersOf(input: ExportInputT): RecordFilters & { kind: "progress_records" } {
  return {
    kind: "progress_records",
    ...(input.month ? { month: input.month } : {}),
    ...(input.department ? { department: input.department } : {}),
    ...(input.classroom_id ? { classroom_id: input.classroom_id } : {}),
    ...(input.teacher_id ? { teacher_id: input.teacher_id } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.q ? { q: input.q } : {}),
  };
}

export async function countRecords(tx: Tx, actor: Actor, filters: RecordFilters, today: string): Promise<number> {
  const row = await tx.one<{ n: string }>(sql`
    SELECT count(*) AS n FROM app.progress_records pr
    JOIN app.student_profiles sp ON sp.org_id = pr.org_id AND sp.id = pr.student_id
    JOIN app.users su ON su.id = pr.student_id
    WHERE ${recordWhere(actor, filters, today)}`);
  return Number(row.n);
}

function summary(filters: RecordFilters): string {
  const parts: string[] = [];
  parts.push(filters.month ? formatMonthJa(filters.month) : "全期間");
  if (filters.department) parts.push(`部署: ${filters.department}`);
  if (filters.status) parts.push(`状態: ${filters.status === "overdue" ? "期限超過" : PROGRESS_RECORD_STATE_LABELS[filters.status]}`);
  if (filters.q) parts.push(`検索: ${filters.q}`);
  if (filters.teacher_id) parts.push("講師で絞込");
  if (filters.classroom_id) parts.push("クラスで絞込");
  return parts.join("・");
}

function jstStamp(now: Date, timeZone: string): string {
  const p = zonedParts(now, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}年${p.month}月${p.day}日 ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Re-derives the creator as an actor (current role/timezone) for background generation. */
export async function exportActor(tx: Tx, orgId: string, userId: string): Promise<Actor | null> {
  const m = await tx.maybeOne<{ role: Role; active: boolean; display_name: string; name: string; timezone: string }>(sql`
    SELECT m.role, m.active, u.display_name, o.name, o.timezone FROM app.memberships m
    JOIN app.users u ON u.id = m.id JOIN app.organizations o ON o.id = m.org_id
    WHERE m.org_id = ${orgId} AND m.id = ${userId}`);
  if (!m || !m.active || m.role === "student") return null;
  return {
    userId,
    orgId,
    role: m.role,
    orgName: m.name,
    timezone: m.timezone,
    displayName: m.display_name,
    method: "cookie",
    sessionHash: null,
    aal: "aal2",
  };
}

/**
 * Generates the file for a pending job inside `tx` (which holds the job row lock) and marks it ready.
 * Throws ApiError (e.g. PDF_FONT_UNAVAILABLE, STORAGE_UNAVAILABLE) without changing the job.
 */
export async function generateExport(tx: Tx, storage: ObjectStorage, job: ExportJobRow, actor: Actor, now: Date): Promise<ExportJobRow> {
  const filters = job.filters as RecordFilters;
  const today = zonedDateString(now, actor.timezone);
  const rows = await tx.query<RecordRow>(sql`${recordSelect(today)} WHERE ${recordWhere(actor, filters, today)} ${RECORD_ORDER} LIMIT ${EXPORT_MAX_ROWS + 1}`);
  if (rows.length > EXPORT_MAX_ROWS) throw new ApiError("EXPORT_TOO_LARGE");
  const records: ExportRecord[] = rows.map((r) => ({
    due_date: String(r.due_date).slice(0, 10),
    student_name: r.student_name,
    department_name: r.department_name,
    teacher_name: r.teacher_name,
    content: r.content,
    state: r.state,
    overdue: r.overdue,
    progress_percent: r.progress_percent === null ? null : Number(r.progress_percent),
    employee_number: r.employee_number,
    classroom_name: r.classroom_name,
    notes: r.notes,
  }));
  const stamp = zonedDateString(now, actor.timezone).replace(/-/g, "");
  const base = `社員教育進捗_${filters.month ?? stamp}`;
  let bytes: Uint8Array;
  let contentType: string;
  let filename: string;
  if (job.format === "csv") {
    bytes = buildCsv(records);
    contentType = "text/csv; charset=utf-8";
    filename = `${base}.csv`;
  } else {
    const font = await loadPdfFont(storage);
    // pdf-lib/fontkit are initialised only when a PDF is actually built (keeps Worker start-up light).
    const { buildPdf } = await import("./export-pdf");
    bytes = await buildPdf(
      records,
      { title: "社員教育進捗管理", organization: actor.orgName, filterSummary: summary(filters), generatedAt: jstStamp(now, actor.timezone) },
      font,
    );
    contentType = "application/pdf";
    filename = `${base}.pdf`;
  }
  const key = `exports/${actor.orgId}/${job.id}.${job.format}`;
  await storage.put(key, bytes, contentType);
  const updated = await tx.one<ExportJobRow>(sql`
    UPDATE app.export_jobs SET state = 'ready', object_key = ${key}, row_count = ${records.length}, filename = ${filename},
      completed_at = now(), file_expires_at = now() + make_interval(secs => ${EXPORT_RETENTION_SECONDS}), error_code = NULL,
      attempts = attempts + 1, expires_at = now() + make_interval(secs => ${EXPORT_RETENTION_SECONDS})
    WHERE org_id = ${actor.orgId} AND id = ${job.id} RETURNING ${EXPORT_COLUMNS}`);
  await audit(tx, actor.orgId, actor.userId, "export.generated", job.id, { format: job.format, row_count: records.length, filters: job.filters });
  return updated;
}

export async function markExportFailed(tx: Tx, orgId: string, jobId: string, code: string): Promise<void> {
  await tx.exec(sql`UPDATE app.export_jobs SET state = 'failed', error_code = ${code}, attempts = attempts + 1, completed_at = now()
    WHERE org_id = ${orgId} AND id = ${jobId} AND state = 'pending'`);
}

export async function insertExportJob(tx: Tx, actor: Actor, input: ExportInputT, rowCount: number): Promise<ExportJobRow> {
  const filters = filtersOf(input);
  const job = await tx.one<ExportJobRow>(sql`
    INSERT INTO app.export_jobs(org_id, user_id, format, filters, state) VALUES (${actor.orgId}, ${actor.userId}, ${input.format}, ${json(filters)}::jsonb, 'pending')
    RETURNING ${EXPORT_COLUMNS}`);
  await audit(tx, actor.orgId, actor.userId, "export.requested", job.id, { format: input.format, filters, expected_rows: rowCount });
  return job;
}

/** Export DTO; a ready file past its retention reads as `expired`. */
export async function exportDto(job: ExportJobRow, storage: ObjectStorage | null, now: Date) {
  const expired = job.state === "ready" && (!job.object_key || (job.file_expires_at !== null && new Date(job.file_expires_at) <= now));
  let downloadUrl: string | null = null;
  let expiresAt: string | null = null;
  if (job.state === "ready" && !expired && storage && job.object_key) {
    downloadUrl = await storage.presignGet(job.object_key, EXPORT_URL_SECONDS, {
      contentType: job.format === "csv" ? "text/csv; charset=utf-8" : "application/pdf",
      filename: job.filename ?? undefined,
      disposition: "attachment",
    });
    expiresAt = new Date(now.getTime() + EXPORT_URL_SECONDS * 1000).toISOString();
  }
  return {
    id: job.id,
    state: expired ? ("expired" as const) : job.state,
    download_url: downloadUrl,
    expires_at: expiresAt,
    format: job.format,
    created_at: iso(job.created_at),
    row_count: job.row_count,
    filename: job.filename,
    error_code: job.error_code,
  };
}
