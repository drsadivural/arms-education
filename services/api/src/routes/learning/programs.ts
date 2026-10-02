/** Programs, versions and units (WEB-09/10, IOS-12). Admin writes; teachers read; students read enrolled units. */
import { Hono } from "hono";
import { z } from "zod";
import { ProgramInput, UnitInput, VersionInput } from "@arms/contracts";
import type { AppEnv } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { and, sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { ApiError, fail } from "../../http/errors";
import { idempotent } from "../../http/idempotency";
import { decodeCursor, paginate, parseLimit } from "../../http/pagination";
import { action, ok, page } from "../../http/respond";
import { pathId, readBody, readQuery, requireIfMatch } from "../../http/validation";
import { audit, likePattern } from "../../domain/learning/common";
import {
  PROGRAM_SELECT,
  UNIT_SELECT,
  VERSION_SELECT,
  isEnrolled,
  loadProgram,
  loadUnit,
  loadVersion,
  programDto,
  unitDto,
  versionDto,
  type ProgramRow,
  type UnitRow,
  type VersionRow,
} from "../../domain/learning/catalog";
import { createDraftVersion, publishVersion } from "../../domain/learning/versions";

export const programRoutes = new Hono<AppEnv>();

const ProgramListQuery = z.object({
  cursor: z.string().optional(),
  limit: z.string().optional(),
  q: z.string().trim().max(100).optional(),
  department: z.string().trim().max(100).optional(),
  classroom_id: z.guid().optional(),
  status: z.enum(["active", "archived", "all", "published", "draft"]).optional(),
});
const ProgramCursor = z.object({ n: z.string(), i: z.guid() });

/** GET /programs — admin/teacher. Default excludes archived programs. */
programRoutes.get("/programs", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const q = readQuery(c, ProgramListQuery);
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor, ProgramCursor);
  const status = q.status ?? "active";
  const rows = await actorTx(c, (tx) =>
    tx.query<ProgramRow>(sql`
      SELECT * FROM (${PROGRAM_SELECT} WHERE p.org_id = ${actor.orgId}) x
      WHERE ${and([
        status === "active" && sql`NOT x.archived`,
        status === "archived" && sql`x.archived`,
        status === "published" && sql`x.published_version_id IS NOT NULL AND NOT x.archived`,
        status === "draft" && sql`x.draft_version_id IS NOT NULL AND NOT x.archived`,
        !!q.q && sql`(x.name ILIKE ${likePattern(q.q)} OR x.description ILIKE ${likePattern(q.q)})`,
        !!q.department && sql`x.department_name = ${q.department}`,
        !!q.classroom_id &&
          sql`EXISTS (SELECT 1 FROM app.classroom_programs cp JOIN app.program_versions cv ON cv.org_id = cp.org_id AND cv.id = cp.program_version_id
                      WHERE cp.org_id = ${actor.orgId} AND cp.classroom_id = ${q.classroom_id} AND cv.program_id = x.id)`,
        cursor && sql`(x.name, x.id) > (${cursor.n}, ${cursor.i}::uuid)`,
      ])}
      ORDER BY x.name, x.id LIMIT ${limit + 1}`),
  );
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ n: r.name, i: r.id }));
  return page(c, items.map(programDto), nextCursor);
});

/** POST /programs — admin. Versions (with their fixed policy) are created separately. */
programRoutes.post("/programs", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const input = await readBody(c, ProgramInput);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      const created = await tx.one<{ id: string }>(sql`
        INSERT INTO app.programs(org_id, name, description, department_name)
        VALUES (${actor.orgId}, ${input.name}, ${input.description}, ${input.department_name ?? ""}) RETURNING id`);
      await audit(tx, actor.orgId, actor.userId, "program.created", created.id, { name: input.name, department_name: input.department_name ?? "" });
      return { status: 200, body: await loadProgram(tx, actor.orgId, created.id) };
    }),
  );
  return ok(c, result.body, { version: result.body.row_version });
});

programRoutes.get("/programs/:id", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const dto = await actorTx(c, (tx) => loadProgram(tx, actor.orgId, id));
  return ok(c, dto, { version: dto.row_version });
});

programRoutes.patch("/programs/:id", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const input = await readBody(c, ProgramInput);
  const dto = await actorTx(c, async (tx) => {
    const before = await tx.maybeOne<{ name: string; description: string; department_name: string; archived: boolean; row_version: number }>(sql`
      SELECT name, description, department_name, archived, row_version FROM app.programs WHERE org_id = ${actor.orgId} AND id = ${id} FOR UPDATE`);
    if (!before) fail("NOT_FOUND");
    if (before.row_version !== expected) fail("VERSION_CONFLICT");
    if (before.archived) fail("PROGRAM_ARCHIVED");
    await tx.exec(sql`UPDATE app.programs SET name = ${input.name}, description = ${input.description},
      department_name = ${input.department_name ?? ""}, row_version = row_version + 1 WHERE org_id = ${actor.orgId} AND id = ${id}`);
    await audit(tx, actor.orgId, actor.userId, "program.updated", id, {
      before: { name: before.name, description: before.description, department_name: before.department_name },
      after: { name: input.name, description: input.description, department_name: input.department_name ?? "" },
    });
    return loadProgram(tx, actor.orgId, id);
  });
  return ok(c, dto, { version: dto.row_version });
});

/** DELETE /programs/{id} — archive (soft). Enrollments and history are kept. */
programRoutes.delete("/programs/:id", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const result = await actorTx(c, async (tx) => {
    const updated = await tx.maybeOne<{ row_version: number }>(sql`
      UPDATE app.programs SET archived = true, row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${id} AND row_version = ${expected} AND NOT archived RETURNING row_version`);
    if (!updated) {
      const exists = await tx.maybeOne<{ archived: boolean }>(sql`SELECT archived FROM app.programs WHERE org_id = ${actor.orgId} AND id = ${id}`);
      if (!exists) fail("NOT_FOUND");
      fail(exists.archived ? "PROGRAM_ARCHIVED" : "VERSION_CONFLICT");
    }
    await audit(tx, actor.orgId, actor.userId, "program.archived", id, {});
    return updated;
  });
  c.header("ETag", `"${result.row_version}"`);
  return action(c, { id, archived: true, row_version: result.row_version });
});

// ---- versions ---------------------------------------------------------------------------------

const VersionCursor = z.object({ n: z.int() });

programRoutes.get("/programs/:id/versions", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const q = readQuery(c, z.object({ cursor: z.string().optional(), limit: z.string().optional() }));
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor, VersionCursor);
  const rows = await actorTx(c, async (tx) => {
    const program = await tx.maybeOne(sql`SELECT 1 FROM app.programs WHERE org_id = ${actor.orgId} AND id = ${id}`);
    if (!program) fail("NOT_FOUND");
    return tx.query<VersionRow>(sql`${VERSION_SELECT}
      WHERE v.org_id = ${actor.orgId} AND v.program_id = ${id} ${cursor ? sql`AND v.version_number < ${cursor.n}` : sql``}
      ORDER BY v.version_number DESC LIMIT ${limit + 1}`);
  });
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ n: r.version_number }));
  return page(c, items.map(versionDto), nextCursor);
});

programRoutes.post("/programs/:id/versions", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const input = await readBody(c, VersionInput);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      const versionId = await createDraftVersion(tx, actor, id, input);
      return { status: 200, body: await loadVersion(tx, actor.orgId, versionId) };
    }),
  );
  return ok(c, result.body, { version: result.body.row_version });
});

programRoutes.get("/program-versions/:id", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const dto = await actorTx(c, (tx) => loadVersion(tx, actor.orgId, id));
  return ok(c, dto, { version: dto.row_version });
});

/** POST /program-versions/{id}/publish — validates and fixes the version; the previous published version is archived. */
programRoutes.post("/program-versions/:id/publish", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const scannerConfigured = c.get("deps").integrations.scanner !== null;
  const result = await actorTx(c, async (tx) => {
    const { previousVersionId } = await publishVersion(tx, actor, id, scannerConfigured);
    return { version: await loadVersion(tx, actor.orgId, id), previousVersionId };
  });
  return action(c, { version: result.version, archived_version_id: result.previousVersionId });
});

// ---- units ------------------------------------------------------------------------------------

const UnitCursor = z.object({ p: z.int(), i: z.guid() });

/** GET /program-versions/{id}/units — admin/teacher; students only for a version they are enrolled in. */
programRoutes.get("/program-versions/:id/units", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const q = readQuery(c, z.object({ cursor: z.string().optional(), limit: z.string().optional(), q: z.string().trim().max(100).optional() }));
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor, UnitCursor);
  const rows = await actorTx(c, async (tx) => {
    const version = await tx.maybeOne<{ state: string }>(sql`SELECT state FROM app.program_versions WHERE org_id = ${actor.orgId} AND id = ${id}`);
    if (!version) fail("NOT_FOUND");
    if (actor.role === "student" && (version.state === "draft" || !(await isEnrolled(tx, actor.orgId, actor.userId, id)))) fail("NOT_FOUND");
    return tx.query<UnitRow>(sql`${UNIT_SELECT}
      WHERE ${and([
        sql`u.org_id = ${actor.orgId} AND u.program_version_id = ${id}`,
        !!q.q && sql`u.title ILIKE ${likePattern(q.q)}`,
        cursor && sql`(u.position, u.id) > (${cursor.p}, ${cursor.i}::uuid)`,
      ])}
      ORDER BY u.position, u.id LIMIT ${limit + 1}`);
  });
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ p: r.position, i: r.id }));
  return page(c, items.map(unitDto), nextCursor);
});

async function assertDraftVersion(tx: Tx, orgId: string, versionId: string): Promise<void> {
  const v = await tx.maybeOne<{ state: string; archived: boolean }>(sql`
    SELECT v.state, p.archived FROM app.program_versions v JOIN app.programs p ON p.org_id = v.org_id AND p.id = v.program_id
    WHERE v.org_id = ${orgId} AND v.id = ${versionId} FOR UPDATE OF v`);
  if (!v) fail("NOT_FOUND");
  if (v.state !== "draft") fail("PUBLISHED_VERSION_IMMUTABLE");
  if (v.archived) fail("PROGRAM_ARCHIVED");
}

async function assertPositionFree(tx: Tx, orgId: string, versionId: string, position: number, exceptId: string | null) {
  const taken = await tx.maybeOne(sql`SELECT 1 FROM app.units WHERE org_id = ${orgId} AND program_version_id = ${versionId} AND position = ${position}
    ${exceptId ? sql`AND id <> ${exceptId}` : sql``}`);
  if (taken) throw new ApiError("UNIT_POSITION_TAKEN", { field_errors: { position: "この順番は既に使われています。" } });
}

programRoutes.post("/program-versions/:id/units", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const input = await readBody(c, UnitInput);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      await assertDraftVersion(tx, actor.orgId, id);
      await assertPositionFree(tx, actor.orgId, id, input.position, null);
      const created = await tx.one<{ id: string }>(sql`
        INSERT INTO app.units(org_id, program_version_id, title, position, required, weight, pass_score, required_attendance, requires_review)
        VALUES (${actor.orgId}, ${id}, ${input.title}, ${input.position}, ${input.required}, ${input.weight}, ${input.pass_score ?? null},
                ${input.required_attendance ?? false}, ${input.requires_review ?? false}) RETURNING id`);
      await audit(tx, actor.orgId, actor.userId, "unit.created", created.id, { program_version_id: id, ...input });
      return { status: 200, body: await loadUnit(tx, actor.orgId, created.id) };
    }),
  );
  return ok(c, result.body, { version: result.body.row_version });
});

/** PATCH /units/{id} — full replacement of the unit settings (omitted optional fields reset to their defaults). Draft only. */
programRoutes.patch("/units/:id", requireRole("admin"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const input = await readBody(c, UnitInput);
  const dto = await actorTx(c, async (tx) => {
    const before = await tx.maybeOne<UnitRow>(sql`${UNIT_SELECT} WHERE u.org_id = ${actor.orgId} AND u.id = ${id}`);
    if (!before) fail("NOT_FOUND");
    await assertDraftVersion(tx, actor.orgId, before.program_version_id);
    if (before.row_version !== expected) fail("VERSION_CONFLICT");
    await assertPositionFree(tx, actor.orgId, before.program_version_id, input.position, id);
    const updated = await tx.exec(sql`
      UPDATE app.units SET title = ${input.title}, position = ${input.position}, required = ${input.required}, weight = ${input.weight},
        pass_score = ${input.pass_score ?? null}, required_attendance = ${input.required_attendance ?? false},
        requires_review = ${input.requires_review ?? false}, row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${id} AND row_version = ${expected}`);
    if (updated === 0) fail("VERSION_CONFLICT");
    await audit(tx, actor.orgId, actor.userId, "unit.updated", id, { before: unitDto(before), after: input });
    return loadUnit(tx, actor.orgId, id);
  });
  return ok(c, dto, { version: dto.row_version });
});
