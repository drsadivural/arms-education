/** import_jobs / import_items persistence and the ImportJob / ImportItem read models. */
import { z } from "zod";
import type { components, ImportEntity, ImportItemFilter } from "@arms/contracts";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { and, sql } from "../../db/sql";
import { encodeCursor } from "../../http/pagination";
import { DISPLAY_FIELDS, COMPARE_FIELDS, ENTITY_KIND, fieldDefs, fieldLabel, type ColumnSummary, type JobRow, type PlannedItem, type RowMessage } from "./model";

export type ImportJobDto = components["schemas"]["ImportJob"];
export type ImportItemDto = components["schemas"]["ImportItem"];

export const JOB_COLUMNS = sql`j.id, j.created_by, coalesce(cu.display_name, '') AS created_by_name, j.source_system, j.object_key, j.mapping, j.state, j.summary,
  j.upload_id, j.entity, j.encoding, j.filename, j.options, j.failure, j.lease_token, (j.locked_until IS NOT NULL AND j.locked_until > now()) AS leased,
  j.commit_key, j.commit_hash, j.rollback_key, j.rollback_hash, j.created_at, j.updated_at, j.validated_at, j.committed_at, j.rolled_back_at, j.row_version`;
export const JOB_FROM = sql`app.import_jobs j LEFT JOIN app.users cu ON cu.id = j.created_by`;

export async function findJob(tx: Tx, orgId: string, id: string, opts: { lock?: boolean } = {}): Promise<JobRow | null> {
  if (opts.lock) await tx.query(sql`SELECT 1 FROM app.import_jobs WHERE org_id = ${orgId} AND id = ${id} FOR UPDATE`);
  return tx.maybeOne<JobRow>(sql`SELECT ${JOB_COLUMNS} FROM ${JOB_FROM} WHERE j.org_id = ${orgId} AND j.id = ${id}`);
}

interface Counts {
  total: number;
  create: number;
  update: number;
  skip: number;
  error: number;
  warning: number;
  applied: number;
  conflict: number;
  reverted: number;
  manual: number;
}

async function itemCounts(tx: Tx, orgId: string, jobIds: string[]): Promise<Map<string, Counts>> {
  if (jobIds.length === 0) return new Map();
  const rows = await tx.query<Counts & { job_id: string }>(sql`
    SELECT job_id, count(*)::int AS total,
      count(*) FILTER (WHERE action = 'create')::int AS "create",
      count(*) FILTER (WHERE action = 'update')::int AS "update",
      count(*) FILTER (WHERE action = 'skip')::int AS skip,
      count(*) FILTER (WHERE action = 'error')::int AS error,
      count(*) FILTER (WHERE jsonb_array_length(warnings) > 0)::int AS warning,
      count(*) FILTER (WHERE commit_state IN ('applied', 'pending_activation'))::int AS applied,
      count(*) FILTER (WHERE commit_state = 'conflict')::int AS conflict,
      count(*) FILTER (WHERE rollback_state = 'reverted')::int AS reverted,
      count(*) FILTER (WHERE rollback_state = 'manual')::int AS manual
    FROM app.import_items WHERE org_id = ${orgId} AND job_id = ANY(${jobIds}::uuid[]) GROUP BY job_id`);
  return new Map(rows.map((r) => [r.job_id, r]));
}

/** Invitation outcome of the accounts a people import created (latest invitation job of each account). */
async function invitationCounts(tx: Tx, orgId: string, jobId: string): Promise<{ sent: number; failed: number; not_sent: number }> {
  const row = await tx.one<{ sent: number; failed: number; not_sent: number }>(sql`
    SELECT count(*) FILTER (WHERE s = 'sent')::int AS sent, count(*) FILTER (WHERE s = 'failed')::int AS failed,
      count(*) FILTER (WHERE s IS DISTINCT FROM 'sent' AND s IS DISTINCT FROM 'failed')::int AS not_sent
    FROM (
      SELECT (SELECT ij.state FROM app.invitation_jobs ij WHERE ij.org_id = i.org_id AND ij.auth_user_id = i.entity_id
              ORDER BY ij.created_at DESC, ij.id DESC LIMIT 1) AS s
      FROM app.import_items i
      WHERE i.org_id = ${orgId} AND i.job_id = ${jobId} AND i.action = 'create' AND i.commit_state IN ('applied', 'pending_activation')
        AND i.rollback_state IS NULL) x`);
  return row;
}

export const ErrorCursor = z.object({ r: z.int(), o: z.int() });

export async function jobErrors(
  tx: Tx,
  orgId: string,
  job: Pick<JobRow, "id" | "entity" | "mapping">,
  opts: { after: { r: number; o: number } | null; limit: number },
): Promise<{ errors: ImportJobDto["errors"]; next: string | null }> {
  const rows = await tx.query<{ row: number; ord: number; field: string; message_ja: string }>(sql`
    SELECT i.row_number AS row, e.ord::int AS ord, e.value->>'field' AS field, e.value->>'message_ja' AS message_ja
    FROM app.import_items i, jsonb_array_elements(i.errors) WITH ORDINALITY AS e(value, ord)
    WHERE ${and([
      sql`i.org_id = ${orgId}`,
      sql`i.job_id = ${job.id}`,
      sql`i.action = 'error'`,
      opts.after ? sql`(i.row_number, e.ord) > (${opts.after.r}::int, ${opts.after.o}::bigint)` : null,
    ])}
    ORDER BY i.row_number, e.ord LIMIT ${opts.limit + 1}`);
  const headerOf = reverseMapping(job.mapping);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    errors: page.map((e) => ({ row: e.row, field: e.field, label_ja: fieldLabel(job.entity, e.field), header: headerOf.get(e.field) ?? null, message_ja: e.message_ja })),
    next: rows.length > opts.limit && last ? encodeCursor({ r: last.row, o: last.ord }) : null,
  };
}

export function reverseMapping(mapping: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(mapping).map(([header, field]) => [field, header]));
}

/** Column summary for a job that has not been validated yet (counts unknown). */
export function plainColumns(entity: ImportEntity, mapping: Record<string, string>): ColumnSummary[] {
  const headerOf = reverseMapping(mapping);
  return fieldDefs(entity).map((d) => ({
    field: d.field,
    label_ja: d.label,
    required: d.required,
    source_header: headerOf.get(d.field) ?? null,
    empty_meaning_ja: d.empty,
    empty_count: null,
    error_count: null,
  }));
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

export function toJobDto(
  job: JobRow,
  counts: Counts | undefined,
  extra: { errors?: ImportJobDto["errors"]; errorsNext?: string | null; invitations?: ImportJobDto["invitations"] } = {},
): ImportJobDto {
  const c = counts ?? { total: 0, create: 0, update: 0, skip: 0, error: 0, warning: 0, applied: 0, conflict: 0, reverted: 0, manual: 0 };
  const summary = job.summary ?? {};
  return {
    id: job.id,
    state: job.state,
    entity: job.entity,
    source_system: job.source_system,
    encoding: job.encoding,
    detected_encoding: (summary.detected_encoding ?? null) as ImportJobDto["detected_encoding"],
    encoding_mismatch: summary.encoding_mismatch ?? false,
    upload_id: job.upload_id,
    filename: job.filename,
    mapping: job.mapping,
    headers: summary.headers ?? [],
    columns: summary.columns ?? plainColumns(job.entity, job.mapping),
    total_rows: c.total,
    valid_rows: c.total - c.error,
    error_rows: c.error,
    new_rows: c.create,
    update_rows: c.update,
    skip_rows: c.skip,
    warning_rows: c.warning,
    blank_rows: summary.blank_rows ?? 0,
    committed_rows: c.applied,
    conflict_rows: c.conflict,
    reverted_rows: c.reverted,
    manual_review_rows: c.manual,
    options: job.options ? { send_invitations: job.options.send_invitations === true } : null,
    invitations: extra.invitations ?? null,
    failure: job.failure ?? null,
    errors: extra.errors ?? [],
    errors_next_cursor: extra.errorsNext ?? null,
    created_by_name: job.created_by_name,
    created_at: iso(job.created_at) as string,
    updated_at: iso(job.updated_at) as string,
    validated_at: iso(job.validated_at),
    committed_at: iso(job.committed_at),
    rolled_back_at: iso(job.rolled_back_at),
    row_version: job.row_version,
  };
}

/** Full job read model: counts, first page of row errors and (people imports) invitation outcome. */
export async function loadJobDto(
  tx: Tx,
  orgId: string,
  id: string,
  opts: { errorsAfter?: { r: number; o: number } | null; errorsLimit?: number } = {},
): Promise<ImportJobDto | null> {
  const job = await findJob(tx, orgId, id);
  if (!job) return null;
  const counts = (await itemCounts(tx, orgId, [id])).get(id);
  const { errors, next } = await jobErrors(tx, orgId, job, { after: opts.errorsAfter ?? null, limit: opts.errorsLimit ?? 50 });
  const people = job.entity === "teachers" || job.entity === "students";
  const committed = job.state !== "uploaded" && job.state !== "validated";
  const invitations = people && committed ? await invitationCounts(tx, orgId, id) : null;
  return toJobDto(job, counts, { errors, errorsNext: next, invitations });
}

export const JobListCursor = z.object({ t: z.string().min(1).max(64), id: z.guid() });

export async function listJobs(
  tx: Tx,
  orgId: string,
  opts: { entity?: ImportEntity; after: { t: string; id: string } | null; limit: number },
): Promise<{ items: ImportJobDto[]; rows: JobRow[] }> {
  const rows = await tx.query<JobRow>(sql`
    SELECT ${JOB_COLUMNS} FROM ${JOB_FROM}
    WHERE ${and([
      sql`j.org_id = ${orgId}`,
      opts.entity ? sql`j.entity = ${opts.entity}` : null,
      opts.after ? sql`(j.created_at, j.id) < (${opts.after.t}::timestamptz, ${opts.after.id}::uuid)` : null,
    ])}
    ORDER BY j.created_at DESC, j.id DESC LIMIT ${opts.limit + 1}`);
  const counts = await itemCounts(
    tx,
    orgId,
    rows.map((r) => r.id),
  );
  return { rows, items: rows.map((r) => toJobDto(r, counts.get(r.id))) };
}

// ---- items ---------------------------------------------------------------------------------------

const CHUNK = 1000;

/** Replaces the dry-run items of a job (bulk insert in chunks of 1,000 rows). */
export async function replaceItems(tx: Tx, orgId: string, jobId: string, entity: ImportEntity, items: PlannedItem[]): Promise<void> {
  await tx.exec(sql`DELETE FROM app.import_items WHERE org_id = ${orgId} AND job_id = ${jobId}`);
  const kind = ENTITY_KIND[entity];
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK).map((it) => ({
      row_number: it.row,
      entity_id: it.entityId,
      before_data: it.before,
      after_data: it.after,
      error: it.errors.length ? it.errors.map((e) => e.message_ja).join(" / ").slice(0, 2000) : null,
      action: it.action,
      source_key: it.key,
      source_values: it.source,
      errors: it.errors,
      warnings: it.warnings,
    }));
    await tx.exec(sql`
      INSERT INTO app.import_items(org_id, job_id, row_number, entity_id, entity_kind, before_data, after_data, error, action, source_key, source_values, errors, warnings)
      SELECT ${orgId}, ${jobId}, x.row_number, x.entity_id, ${kind}, x.before_data, x.after_data, x.error, x.action, x.source_key,
        coalesce(x.source_values, '{}'::jsonb), x.errors, x.warnings
      FROM jsonb_to_recordset(${json(chunk)}::jsonb) AS x(row_number int, entity_id uuid, before_data jsonb, after_data jsonb, error text, action text,
        source_key text, source_values jsonb, errors jsonb, warnings jsonb)`);
  }
}

interface ItemRow {
  row_number: number;
  action: ImportItemDto["action"];
  source_key: string | null;
  entity_kind: ImportItemDto["entity_kind"];
  entity_id: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  errors: RowMessage[];
  warnings: RowMessage[];
  commit_state: ImportItemDto["commit_state"];
  commit_message: string | null;
  rollback_state: ImportItemDto["rollback_state"];
  rollback_message: string | null;
}

function displayValues(entity: ImportEntity, data: Record<string, unknown> | null): Record<string, string | number | boolean | null> | null {
  if (!data) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const f of DISPLAY_FIELDS[entity]) {
    const v = data[f];
    out[f] = v === undefined || v === null ? null : typeof v === "number" || typeof v === "boolean" ? v : String(v);
  }
  return out;
}

const ITEM_FILTERS: Record<ImportItemFilter, ReturnType<typeof sql> | null> = {
  all: null,
  create: sql`action = 'create'`,
  update: sql`action = 'update'`,
  skip: sql`action = 'skip'`,
  error: sql`action = 'error'`,
  warning: sql`jsonb_array_length(warnings) > 0`,
  conflict: sql`commit_state = 'conflict'`,
  manual: sql`rollback_state = 'manual'`,
};

export async function listItems(
  tx: Tx,
  orgId: string,
  job: Pick<JobRow, "id" | "entity">,
  opts: { status: ImportItemFilter; afterRow: number | null; limit: number },
): Promise<{ items: ImportItemDto[]; next: string | null }> {
  const rows = await tx.query<ItemRow>(sql`
    SELECT row_number, action, source_key, entity_kind, entity_id, before_data, after_data, errors, warnings, commit_state, commit_message,
      rollback_state, rollback_message
    FROM app.import_items
    WHERE ${and([sql`org_id = ${orgId}`, sql`job_id = ${job.id}`, ITEM_FILTERS[opts.status], opts.afterRow !== null ? sql`row_number > ${opts.afterRow}` : null])}
    ORDER BY row_number LIMIT ${opts.limit + 1}`);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => {
      const changed =
        r.action === "update" && r.before_data && r.after_data
          ? COMPARE_FIELDS[job.entity].filter((f) => String(r.before_data?.[f] ?? "") !== String(r.after_data?.[f] ?? ""))
          : [];
      return {
        row: r.row_number,
        action: r.action,
        key: r.source_key,
        entity_kind: r.entity_kind,
        entity_id: r.entity_id,
        values: displayValues(job.entity, r.after_data) ?? {},
        before: displayValues(job.entity, r.before_data),
        changed_fields: changed,
        errors: r.errors,
        warnings: r.warnings,
        commit_state: r.commit_state,
        commit_message_ja: r.commit_message,
        rollback_state: r.rollback_state,
        rollback_message_ja: r.rollback_message,
      };
    }),
    next: rows.length > opts.limit && last ? encodeCursor({ r: last.row_number }) : null,
  };
}

export interface ReportLine {
  kind: "error" | "warning" | "conflict" | "manual";
  row: number;
  key: string | null;
  field: string;
  message_ja: string;
}

/**
 * Lines of the result report (errors.csv): dry-run errors and warnings, rows not applied at commit (conflict) and
 * rows rollback left for manual reconciliation, in row order.
 */
export async function reportLines(tx: Tx, orgId: string, jobId: string): Promise<ReportLine[]> {
  return tx.query<ReportLine>(sql`
    SELECT kind, row, key, field, message_ja FROM (
      SELECT 1 AS k, 'error' AS kind, i.row_number AS row, i.source_key AS key, e.value->>'field' AS field, e.value->>'message_ja' AS message_ja, e.ord
      FROM app.import_items i, jsonb_array_elements(i.errors) WITH ORDINALITY AS e(value, ord)
      WHERE i.org_id = ${orgId} AND i.job_id = ${jobId}
      UNION ALL
      SELECT 2, 'warning', i.row_number, i.source_key, w.value->>'field', w.value->>'message_ja', w.ord
      FROM app.import_items i, jsonb_array_elements(i.warnings) WITH ORDINALITY AS w(value, ord)
      WHERE i.org_id = ${orgId} AND i.job_id = ${jobId}
      UNION ALL
      SELECT 3, 'conflict', i.row_number, i.source_key, '_row', coalesce(i.commit_message, ''), 1
      FROM app.import_items i WHERE i.org_id = ${orgId} AND i.job_id = ${jobId} AND i.commit_state = 'conflict'
      UNION ALL
      SELECT 4, 'manual', i.row_number, i.source_key, '_row', coalesce(i.rollback_message, ''), 1
      FROM app.import_items i WHERE i.org_id = ${orgId} AND i.job_id = ${jobId} AND i.rollback_state = 'manual'
    ) x ORDER BY row, k, ord`);
}
