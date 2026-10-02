/**
 * WEB-17 既存システムからのデータ移植 (docs/08_MIGRATION_JA.md): job history, job registration from a scanned
 * CSV upload + column mapping, mapping correction, dry run, commit, rollback, row preview and the result report.
 * Admin only (teachers/students 403; other organisations' jobs are invisible → 404).
 */
import { Hono } from "hono";
import { z } from "zod";
import { IMPORT_ENTITIES, IMPORT_ITEM_FILTERS, ImportCommitInput, ImportMapping, type ImportMappingT } from "@arms/contracts";
import type { AppContext, AppEnv } from "../context";
import { actorTx } from "../context";
import { json } from "../db/client";
import { sql } from "../db/sql";
import { requireRole } from "../auth/middleware";
import { fail } from "../http/errors";
import { idempotent } from "../http/idempotency";
import { decodeCursor, paginate, parseLimit } from "../http/pagination";
import { page } from "../http/respond";
import { pathId, readBody, readQuery, requireIfMatch } from "../http/validation";
import { audit, optionalQuery } from "../domain/admin/common";
import { commitImport } from "../domain/imports/commit";
import { csvLine } from "../domain/imports/csv";
import { ErrorCursor, JobListCursor, findJob, listItems, listJobs, loadJobDto, reportLines, reverseMapping, type ImportJobDto } from "../domain/imports/jobs";
import { checkMapping, loadImportUpload } from "../domain/imports/mapping";
import { fieldLabel } from "../domain/imports/model";
import { rollbackImport } from "../domain/imports/rollback";
import { validateImport } from "../domain/imports/validate";

export const importsRoutes = new Hono<AppEnv>();

function normalize(input: ImportMappingT): ImportMappingT {
  const columns: Record<string, string> = {};
  for (const [header, field] of Object.entries(input.columns)) columns[header.trim()] = field;
  return { ...input, source_system: input.source_system.trim(), upload_id: input.upload_id.toLowerCase(), columns };
}

async function respondJob(c: AppContext, id: string, opts: { errorsAfter?: { r: number; o: number } | null; errorsLimit?: number } = {}) {
  const actor = c.get("actor");
  const dto = await actorTx(c, (tx) => loadJobDto(tx, actor.orgId, id, opts));
  if (!dto) fail("NOT_FOUND");
  c.header("ETag", `"${dto.row_version}"`);
  return c.json({ data: dto, checked_at: c.get("deps").now().toISOString() });
}

const ListQuery = z.object({
  cursor: optionalQuery(z.string().max(1000)),
  limit: optionalQuery(z.string()),
  entity: optionalQuery(z.enum(IMPORT_ENTITIES)),
});

importsRoutes.get("/imports", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const query = readQuery(c, ListQuery);
  const limit = parseLimit(query.limit);
  const after = decodeCursor(query.cursor, JobListCursor);
  const { items, rows } = await actorTx(c, (tx) => listJobs(tx, actor.orgId, { entity: query.entity, after, limit }));
  const { nextCursor } = paginate(rows, limit, (r) => ({ t: new Date(r.created_at).toISOString(), id: r.id }));
  return page(c, items.slice(0, limit), nextCursor);
});

/** Registers a job for a scanned (clean) import upload. The raw file stays private under the upload's key. */
importsRoutes.post("/imports", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const input = normalize(await readBody(c, ImportMapping));
  checkMapping(input.entity, input.columns);
  const scannerConfigured = c.get("deps").integrations.scanner !== null;
  const stored = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      const upload = await loadImportUpload(tx, actor.orgId, actor.userId, input.upload_id, scannerConfigured);
      const created = await tx.one<{ id: string }>(sql`
        INSERT INTO app.import_jobs(org_id, created_by, source_system, object_key, mapping, state, upload_id, entity, encoding, filename)
        VALUES (${actor.orgId}, ${actor.userId}, ${input.source_system}, ${upload.object_key}, ${json(input.columns)}::jsonb, 'uploaded',
          ${upload.id}, ${input.entity}, ${input.encoding}, ${upload.filename})
        RETURNING id`);
      await audit(tx, actor, "import.created", created.id, {
        entity: input.entity,
        source_system: input.source_system,
        encoding: input.encoding,
        upload_id: upload.id,
        mapped_fields: Object.values(input.columns),
      });
      const dto = (await loadJobDto(tx, actor.orgId, created.id)) as ImportJobDto;
      return { status: 200, body: { data: dto, checked_at: c.get("deps").now().toISOString() } };
    }),
  );
  c.header("ETag", `"${stored.body.data.row_version}"`);
  return c.json(stored.body);
});

const JobQuery = z.object({
  errors_cursor: optionalQuery(z.string().max(1000)),
  errors_limit: optionalQuery(z.string()),
});

importsRoutes.get("/imports/:id", requireRole("admin"), async (c) => {
  const id = pathId(c);
  const query = readQuery(c, JobQuery);
  const errorsLimit = parseLimit(query.errors_limit, 50);
  const errorsAfter = decodeCursor(query.errors_cursor, ErrorCursor);
  return respondJob(c, id, { errorsAfter, errorsLimit });
});

/** 「項目の対応を修正」: new mapping / encoding / entity / source system for the same upload; discards the dry run. */
importsRoutes.patch("/imports/:id", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const input = normalize(await readBody(c, ImportMapping));
  checkMapping(input.entity, input.columns);
  await actorTx(c, async (tx) => {
    const job = await findJob(tx, actor.orgId, id, { lock: true });
    if (!job) fail("NOT_FOUND");
    if (job.row_version !== expected) fail("VERSION_CONFLICT");
    if (job.upload_id !== input.upload_id) {
      fail("VALIDATION_FAILED", { field_errors: { upload_id: "ファイルは変更できません。別のファイルは新しい移行ジョブとして登録してください。" } });
    }
    if (job.state !== "uploaded" && job.state !== "validated") {
      fail("INVALID_STATE", { message_ja: "確定を開始した移行ジョブの対応付けは変更できません。新しい移行ジョブを作成してください。" });
    }
    if (job.leased) fail("IMPORT_IN_PROGRESS");
    await tx.exec(sql`DELETE FROM app.import_items WHERE org_id = ${actor.orgId} AND job_id = ${id}`);
    await tx.exec(sql`
      UPDATE app.import_jobs SET mapping = ${json(input.columns)}::jsonb, encoding = ${input.encoding}, entity = ${input.entity},
        source_system = ${input.source_system}, state = 'uploaded', summary = '{}'::jsonb, validated_at = NULL, failure = NULL,
        updated_at = now(), row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${id} AND row_version = ${expected}`);
    await audit(tx, actor, "import.mapping_updated", id, {
      before: { entity: job.entity, encoding: job.encoding, source_system: job.source_system, mapping: job.mapping },
      after: { entity: input.entity, encoding: input.encoding, source_system: input.source_system, mapping: input.columns },
    });
  });
  return respondJob(c, id);
});

importsRoutes.post("/imports/:id/validate", requireRole("admin"), async (c) => {
  const id = pathId(c);
  await validateImport(c, id);
  return respondJob(c, id);
});

importsRoutes.post("/imports/:id/commit", requireRole("admin"), async (c) => {
  const id = pathId(c);
  const input = await readBody(c, ImportCommitInput);
  await commitImport(c, id, input);
  return respondJob(c, id);
});

importsRoutes.post("/imports/:id/rollback", requireRole("admin"), async (c) => {
  const id = pathId(c);
  await rollbackImport(c, id);
  return respondJob(c, id);
});

const ItemsQuery = z.object({
  cursor: optionalQuery(z.string().max(1000)),
  limit: optionalQuery(z.string()),
  status: optionalQuery(z.enum(IMPORT_ITEM_FILTERS)),
});

importsRoutes.get("/imports/:id/items", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const query = readQuery(c, ItemsQuery);
  const limit = parseLimit(query.limit, 50);
  const after = decodeCursor(query.cursor, z.object({ r: z.int() }));
  const result = await actorTx(c, async (tx) => {
    const job = await findJob(tx, actor.orgId, id);
    if (!job) fail("NOT_FOUND");
    return listItems(tx, actor.orgId, job, { status: query.status ?? "all", afterRow: after?.r ?? null, limit });
  });
  return page(c, result.items, result.next);
});

const KIND_LABELS = { error: "エラー", warning: "警告", conflict: "確定時の競合", manual: "手動照合が必要" } as const;

/** Result report (errors / warnings / conflicts / manual reconciliation) as CSV with formula-injection escaping. */
importsRoutes.get("/imports/:id/errors.csv", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const { job, lines } = await actorTx(c, async (tx) => {
    const found = await findJob(tx, actor.orgId, id);
    if (!found) fail("NOT_FOUND");
    return { job: found, lines: await reportLines(tx, actor.orgId, id) };
  });
  const headerOf = reverseMapping(job.mapping);
  let body = "\uFEFF" + csvLine(["行番号", "種別", "照合キー", "項目", "元の見出し", "内容"]);
  for (const l of lines) {
    body += csvLine([l.row, KIND_LABELS[l.kind], l.key, fieldLabel(job.entity, l.field), headerOf.get(l.field) ?? "", l.message_ja]);
  }
  await actorTx(c, (tx) => audit(tx, actor, "import.report_downloaded", id, { lines: lines.length }));
  const filename = `import-${job.entity}-${id.slice(0, 8)}-errors.csv`;
  return c.body(body, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
});
