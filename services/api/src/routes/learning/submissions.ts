/** Assignment review queue, teacher review and submission file access (IOS-06, WEB-12). */
import { Hono } from "hono";
import { z } from "zod";
import { ReviewInput } from "@arms/contracts";
import type { Actor, AppEnv } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { and, sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { ApiError, fail } from "../../http/errors";
import { idempotent } from "../../http/idempotency";
import { decodeCursor, paginate, parseLimit } from "../../http/pagination";
import { ok, page } from "../../http/respond";
import { pathId, readBody, readQuery } from "../../http/validation";
import { audit, iso, outbox, teacherStudentScope } from "../../domain/learning/common";
import { displayFilename } from "../../domain/learning/files";
import { SUBMISSION_SELECT, submissionDto, type SubmissionRow } from "../../domain/learning/submissions";
import { recomputeStudentProgress } from "../../domain/progress";

export const submissionRoutes = new Hono<AppEnv>();

const LATEST_ONLY = sql`NOT EXISTS (SELECT 1 FROM app.submissions s2
  WHERE s2.org_id = s.org_id AND s2.student_id = s.student_id AND s2.material_id = s.material_id
    AND (s2.submitted_at, s2.id) > (s.submitted_at, s.id))`;

const ListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.string().optional(),
  state: z.enum(["submitted", "accepted", "revision_requested"]).optional(),
  student_id: z.guid().optional(),
  classroom_id: z.guid().optional(),
  material_id: z.guid().optional(),
});
const Cursor = z.object({ t: z.string(), i: z.guid() });

/** GET /submissions — latest submission per student × assignment; teachers see only their students. */
submissionRoutes.get("/submissions", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const q = readQuery(c, ListQuery);
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor, Cursor);
  const rows = await actorTx(c, (tx) =>
    tx.query<SubmissionRow>(sql`${SUBMISSION_SELECT}
      WHERE ${and([
        sql`s.org_id = ${actor.orgId}`,
        LATEST_ONLY,
        actor.role === "teacher" && teacherStudentScope("sp", actor.userId),
        !!q.state && sql`s.state = ${q.state}`,
        !!q.student_id && sql`s.student_id = ${q.student_id}`,
        !!q.classroom_id && sql`sp.classroom_id = ${q.classroom_id}`,
        !!q.material_id && sql`s.material_id = ${q.material_id}`,
        cursor && sql`(s.submitted_at, s.id) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)`,
      ])}
      ORDER BY s.submitted_at DESC, s.id DESC LIMIT ${limit + 1}`),
  );
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ t: iso(r.submitted_at), i: r.id }));
  return page(c, items.map(submissionDto), nextCursor);
});

async function loadScoped(tx: Tx, actor: Actor, id: string, lock = false): Promise<SubmissionRow> {
  const row = await tx.maybeOne<SubmissionRow & { in_scope: boolean }>(sql`
    SELECT x.*, ${actor.role === "teacher" ? teacherStudentScope("sp", actor.userId) : sql`TRUE`} AS in_scope
    FROM (${SUBMISSION_SELECT} WHERE s.org_id = ${actor.orgId} AND s.id = ${id}) x
    JOIN app.student_profiles sp ON sp.org_id = ${actor.orgId} AND sp.id = x.student_id`);
  if (!row) fail("NOT_FOUND");
  if (actor.role === "student" && row.student_id !== actor.userId) fail("NOT_FOUND");
  // 講師の担当外受講者は403 (docs/01).
  if (actor.role === "teacher" && !row.in_scope) fail("FORBIDDEN");
  if (lock) await tx.query(sql`SELECT 1 FROM app.submissions WHERE org_id = ${actor.orgId} AND id = ${id} FOR UPDATE`);
  return row;
}

/** POST /submissions/{id}/review — accepted / revision_requested (feedback required) on the latest submission. */
submissionRoutes.post("/submissions/:id/review", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const input = await readBody(c, ReviewInput);
  if (input.state === "revision_requested" && !input.feedback) {
    throw new ApiError("VALIDATION_FAILED", { field_errors: { feedback: "再提出を依頼する理由を入力してください。" } });
  }
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      await loadScoped(tx, actor, id, true);
      const current = await tx.one<SubmissionRow>(sql`${SUBMISSION_SELECT} WHERE s.org_id = ${actor.orgId} AND s.id = ${id}`);
      if (input.expected_version !== undefined && input.expected_version !== current.row_version) fail("VERSION_CONFLICT");
      const latest = await tx.maybeOne(sql`SELECT 1 FROM app.submissions s WHERE s.org_id = ${actor.orgId} AND s.id = ${id} AND ${LATEST_ONLY}`);
      if (!latest || current.state !== "submitted") fail("INVALID_STATE");
      if (input.state === "accepted") {
        if (current.scan_state === "pending") fail("SCAN_PENDING");
        if (current.scan_state === "blocked") fail("FILE_REJECTED");
      }
      await tx.exec(sql`UPDATE app.submissions SET state = ${input.state}, feedback = ${input.feedback}, reviewer_id = ${actor.userId},
        reviewed_at = clock_timestamp(), row_version = row_version + 1 WHERE org_id = ${actor.orgId} AND id = ${id}`);
      await audit(tx, actor.orgId, actor.userId, "submission.reviewed", id, {
        student_id: current.student_id,
        material_id: current.material_id,
        unit_id: current.unit_id,
        before: current.state,
        after: input.state,
        feedback: input.feedback,
      });
      await outbox(tx, actor.orgId, "submission.reviewed", id, {
        submission_id: id,
        student_id: current.student_id,
        material_id: current.material_id,
        state: input.state,
      });
      await recomputeStudentProgress(tx, actor.orgId, current.student_id);
      const row = await tx.one<SubmissionRow>(sql`${SUBMISSION_SELECT} WHERE s.org_id = ${actor.orgId} AND s.id = ${id}`);
      return { status: 200, body: submissionDto(row) };
    }),
  );
  return ok(c, result.body, { version: result.body.row_version });
});

/** GET /submissions/{id}/file — 5-minute URL for the scanned submission file (admin / teacher in scope / the student). */
submissionRoutes.get("/submissions/:id/file", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const row = await actorTx(c, (tx) => loadScoped(tx, actor, id));
  if (!row.upload_id) fail("NOT_FOUND");
  if (row.scan_state === "pending") fail("SCAN_PENDING");
  if (row.scan_state !== "clean" || !row.object_key) fail("FILE_REJECTED");
  const storage = c.get("deps").integrations.storage;
  if (!storage) fail("NOT_CONFIGURED");
  const seconds = 5 * 60;
  const contentType = row.content_type ?? "application/octet-stream";
  const url = await storage.presignGet(row.object_key, seconds, {
    contentType,
    filename: row.filename ? displayFilename(row.filename) : undefined,
    disposition: "attachment",
  });
  return ok(c, { url, expires_at: new Date(c.get("deps").now().getTime() + seconds * 1000).toISOString(), content_type: contentType });
});
