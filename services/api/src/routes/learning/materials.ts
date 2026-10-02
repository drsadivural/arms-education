/**
 * Materials, downloads, confirmations, quizzes and assignment submissions (WEB-10, IOS-12).
 * Material privacy: students only ever reach published, scanned materials of a version they are enrolled in;
 * quiz answers are never returned to students; file downloads are 5-minute presigned URLs issued after the check.
 */
import { Hono } from "hono";
import { z } from "zod";
import { MaterialInput, QuizDefinitionInput, QuizInput, SubmissionInput } from "@arms/contracts";
import type { Actor, AppEnv } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { and, sql } from "../../db/sql";
import { requireRole } from "../../auth/middleware";
import { ApiError, fail } from "../../http/errors";
import { idempotent } from "../../http/idempotency";
import { decodeCursor, paginate, parseLimit } from "../../http/pagination";
import { action, ok, page } from "../../http/respond";
import { pathId, readBody, readQuery, requireIfMatch } from "../../http/validation";
import { audit, iso, likePattern, lockKey, num, numOrNull, outbox, teacherTeachesProgram } from "../../domain/learning/common";
import {
  assertStudentMaterialAccess,
  isEnrolled,
  loadMaterialRow,
  materialDto,
  materialSelect,
  type MaterialRow,
} from "../../domain/learning/catalog";
import { CONTENT_TYPES, FILE_MATERIAL_FAMILY, displayFilename } from "../../domain/learning/files";
import { scoreQuiz, type QuizQuestionRow } from "../../domain/learning/quiz";
import { assertAttachable, findUploadByKey, type UploadRow } from "../../domain/learning/uploads";
import { checkMaterial, raiseProblems } from "../../domain/learning/versions";
import { effectivePassScore, effectiveQuizScore, parsePolicy, recomputeStudentProgress } from "../../domain/progress";
import { submissionDto, SUBMISSION_SELECT, type SubmissionRow } from "../../domain/learning/submissions";

export const materialRoutes = new Hono<AppEnv>();

const DOWNLOAD_SECONDS = 5 * 60;
const VIEWABLE = new Set(["pdf", "video", "image", "link"]);

/** Admin, or a teacher of a classroom that uses the material's program. */
async function assertMaterialWriter(tx: Tx, actor: Actor, programId: string): Promise<void> {
  if (actor.role === "admin") return;
  if (actor.role === "teacher" && (await teacherTeachesProgram(tx, actor.orgId, actor.userId, programId))) return;
  fail("FORBIDDEN");
}

interface UnitContext {
  id: string;
  program_version_id: string;
  version_state: string;
  program_id: string;
  archived: boolean;
}

async function lockUnitContext(tx: Tx, orgId: string, unitId: string): Promise<UnitContext> {
  const u = await tx.maybeOne<UnitContext>(sql`
    SELECT u.id, u.program_version_id, v.state AS version_state, v.program_id, p.archived
    FROM app.units u
    JOIN app.program_versions v ON v.org_id = u.org_id AND v.id = u.program_version_id
    JOIN app.programs p ON p.org_id = v.org_id AND p.id = v.program_id
    WHERE u.org_id = ${orgId} AND u.id = ${unitId} FOR SHARE OF v`);
  if (!u) fail("NOT_FOUND");
  return u;
}

function assertEditable(versionState: string, archived: boolean): void {
  if (versionState !== "draft") fail("PUBLISHED_VERSION_IMMUTABLE");
  if (archived) fail("PROGRAM_ARCHIVED");
}

/** Resolves and validates the file of a pdf/video/image material. */
async function resolveMaterialUpload(tx: Tx, actor: Actor, kind: string, objectKey: string | undefined): Promise<UploadRow | null> {
  const family = FILE_MATERIAL_FAMILY[kind];
  if (!family) {
    if (objectKey) throw new ApiError("VALIDATION_FAILED", { field_errors: { object_key: "この種類の教材にはファイルを添付できません。" } });
    return null;
  }
  if (!objectKey) throw new ApiError("VALIDATION_FAILED", { field_errors: { object_key: "ファイルをアップロードしてください。" } });
  const upload = await findUploadByKey(tx, actor.orgId, objectKey);
  assertAttachable(upload, "material", "object_key");
  if (actor.role !== "admin" && upload.user_id !== actor.userId) {
    throw new ApiError("VALIDATION_FAILED", { field_errors: { object_key: "アップロードしたファイルを選択してください。" } });
  }
  if (CONTENT_TYPES[upload.detected_type ?? upload.content_type]?.family !== family) {
    throw new ApiError("VALIDATION_FAILED", { field_errors: { object_key: "ファイル形式が教材の種類と一致しません。" } });
  }
  return upload;
}

// ---- create / list / read / edit / publish --------------------------------------------------------

materialRoutes.post("/units/:id/materials", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const unitId = pathId(c);
  const input = await readBody(c, MaterialInput);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      const unit = await lockUnitContext(tx, actor.orgId, unitId);
      await assertMaterialWriter(tx, actor, unit.program_id);
      assertEditable(unit.version_state, unit.archived);
      const upload = await resolveMaterialUpload(tx, actor, input.kind, input.object_key);
      const scanState = upload ? upload.scan_state : "not_applicable";
      const created = await tx.one<{ id: string }>(sql`
        INSERT INTO app.materials(org_id, unit_id, title, kind, object_key, external_url, scan_state, published, required, size_bytes, description, upload_id)
        VALUES (${actor.orgId}, ${unitId}, ${input.title}, ${input.kind}, ${upload && upload.state === "clean" ? upload.object_key : null},
                ${input.kind === "link" ? (input.external_url ?? null) : null}, ${scanState}, false, ${input.required},
                ${upload ? num(upload.size_bytes ?? upload.expected_size) : null}, ${input.description ?? ""}, ${upload?.id ?? null})
        RETURNING id`);
      await audit(tx, actor.orgId, actor.userId, "material.created", created.id, {
        unit_id: unitId,
        title: input.title,
        kind: input.kind,
        required: input.required,
        upload_id: upload?.id ?? null,
      });
      return { status: 200, body: materialDto(await loadMaterialRow(tx, actor.orgId, created.id)) };
    }),
  );
  return ok(c, result.body, { version: result.body.row_version as number });
});

const MaterialCursor = z.object({ t: z.string(), i: z.guid() });

/** GET /units/{id}/materials — admin/teacher see all; students only published materials of an enrolled version. */
materialRoutes.get("/units/:id/materials", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const unitId = pathId(c);
  const q = readQuery(c, z.object({ cursor: z.string().optional(), limit: z.string().optional(), q: z.string().trim().max(100).optional() }));
  const limit = parseLimit(q.limit);
  const cursor = decodeCursor(q.cursor, MaterialCursor);
  const learner = actor.role === "student";
  const rows = await actorTx(c, async (tx) => {
    const unit = await tx.maybeOne<{ program_version_id: string; state: string }>(sql`
      SELECT u.program_version_id, v.state FROM app.units u JOIN app.program_versions v ON v.org_id = u.org_id AND v.id = u.program_version_id
      WHERE u.org_id = ${actor.orgId} AND u.id = ${unitId}`);
    if (!unit) fail("NOT_FOUND");
    if (learner && (unit.state === "draft" || !(await isEnrolled(tx, actor.orgId, actor.userId, unit.program_version_id)))) fail("NOT_FOUND");
    return tx.query<MaterialRow>(sql`${materialSelect(learner ? actor.userId : null)}
      WHERE ${and([
        sql`m.org_id = ${actor.orgId} AND m.unit_id = ${unitId}`,
        learner && sql`m.published AND m.scan_state IN ('clean', 'not_applicable')`,
        !!q.q && sql`m.title ILIKE ${likePattern(q.q)}`,
        cursor && sql`(m.created_at, m.id) > (${cursor.t}::timestamptz, ${cursor.i}::uuid)`,
      ])}
      ORDER BY m.created_at, m.id LIMIT ${limit + 1}`);
  });
  const { items, nextCursor } = paginate(rows, limit, (r) => ({ t: iso(r.created_at), i: r.id }));
  return page(c, items.map((r) => materialDto(r, { learner })), nextCursor);
});

materialRoutes.get("/materials/:id", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const learner = actor.role === "student";
  const row = await actorTx(c, async (tx) => {
    const m = await loadMaterialRow(tx, actor.orgId, id, learner ? actor.userId : null);
    if (learner) await assertStudentMaterialAccess(tx, actor.orgId, actor.userId, m);
    return m;
  });
  return ok(c, materialDto(row, { learner }), { version: row.row_version });
});

/** PATCH /materials/{id} — draft only; kind is fixed; omitting object_key keeps the current file. */
materialRoutes.patch("/materials/:id", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const expected = requireIfMatch(c);
  const input = await readBody(c, MaterialInput);
  const dto = await actorTx(c, async (tx) => {
    const before = await loadMaterialRow(tx, actor.orgId, id);
    await assertMaterialWriter(tx, actor, before.program_id);
    const unit = await lockUnitContext(tx, actor.orgId, before.unit_id);
    assertEditable(unit.version_state, unit.archived);
    if (before.row_version !== expected) fail("VERSION_CONFLICT");
    if (input.kind !== before.kind) {
      throw new ApiError("VALIDATION_FAILED", { field_errors: { kind: "教材の種類は変更できません。新しい教材として追加してください。" } });
    }
    let upload: UploadRow | null = null;
    const replacingFile = FILE_MATERIAL_FAMILY[before.kind] && input.object_key !== undefined;
    if (replacingFile) upload = await resolveMaterialUpload(tx, actor, before.kind, input.object_key);
    else if (!FILE_MATERIAL_FAMILY[before.kind] && input.object_key) await resolveMaterialUpload(tx, actor, before.kind, input.object_key);
    const updated = await tx.exec(sql`
      UPDATE app.materials SET title = ${input.title}, required = ${input.required}, description = ${input.description ?? ""},
        external_url = ${before.kind === "link" ? (input.external_url ?? null) : null},
        ${
          upload
            ? sql`upload_id = ${upload.id}, scan_state = ${upload.scan_state}, object_key = ${upload.state === "clean" ? upload.object_key : null},
                  size_bytes = ${num(upload.size_bytes ?? upload.expected_size)},`
            : sql``
        }
        published = false, row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${id} AND row_version = ${expected}`);
    if (updated === 0) fail("VERSION_CONFLICT");
    await audit(tx, actor.orgId, actor.userId, "material.updated", id, {
      before: { title: before.title, required: before.required, upload_id: before.upload_id, external_url: before.external_url },
      after: { title: input.title, required: input.required, upload_id: upload?.id ?? before.upload_id, external_url: input.external_url ?? null },
    });
    return materialDto(await loadMaterialRow(tx, actor.orgId, id));
  });
  return ok(c, dto, { version: dto.row_version as number });
});

/**
 * POST /materials/{id}/publish — checks that the material is publishable (scanned clean / https link / quiz
 * questions) and marks it ready. Students still see it only once its version is published.
 */
materialRoutes.post("/materials/:id/publish", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const scannerConfigured = c.get("deps").integrations.scanner !== null;
  const dto = await actorTx(c, async (tx) => {
    const m = await loadMaterialRow(tx, actor.orgId, id);
    await assertMaterialWriter(tx, actor, m.program_id);
    if (m.version_state !== "draft") {
      if (m.published) return materialDto(m);
      fail("PUBLISHED_VERSION_IMMUTABLE");
    }
    const problems = await checkMaterial(tx, actor.orgId, id);
    if (problems.length) raiseProblems(problems, scannerConfigured, "MATERIAL_NOT_PUBLISHABLE");
    if (!m.published) {
      await tx.exec(sql`UPDATE app.materials SET published = true, row_version = row_version + 1 WHERE org_id = ${actor.orgId} AND id = ${id}`);
      await audit(tx, actor.orgId, actor.userId, "material.published", id, { unit_id: m.unit_id });
    }
    return materialDto(await loadMaterialRow(tx, actor.orgId, id));
  });
  return action(c, { material: dto });
});

// ---- download / confirmation ------------------------------------------------------------------

/** GET /materials/{id}/download — 5-minute presigned URL after authorisation; links return their https URL. */
materialRoutes.get("/materials/:id/download", requireRole("admin", "teacher", "student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const m = await actorTx(c, async (tx) => {
    const row = await loadMaterialRow(tx, actor.orgId, id);
    if (actor.role === "student") await assertStudentMaterialAccess(tx, actor.orgId, actor.userId, row);
    return row;
  });
  const now = c.get("deps").now();
  const expiresAt = new Date(now.getTime() + DOWNLOAD_SECONDS * 1000).toISOString();
  if (m.kind === "link") {
    if (!m.external_url) fail("NOT_FOUND");
    return ok(c, { url: m.external_url, expires_at: expiresAt, content_type: "text/html" });
  }
  if (!FILE_MATERIAL_FAMILY[m.kind]) fail("MATERIAL_KIND_MISMATCH");
  if (m.scan_state === "pending") fail("SCAN_PENDING");
  if (m.scan_state !== "clean" || !m.object_key) fail("FILE_REJECTED");
  const storage = c.get("deps").integrations.storage;
  if (!storage) fail("NOT_CONFIGURED");
  const contentType = m.content_type ?? "application/octet-stream";
  const url = await storage.presignGet(m.object_key, DOWNLOAD_SECONDS, {
    contentType,
    filename: m.filename ? displayFilename(m.filename) : undefined,
    disposition: "inline",
  });
  return ok(c, { url, expires_at: expiresAt, content_type: contentType });
});

async function studentMaterial(tx: Tx, actor: Actor, id: string): Promise<MaterialRow> {
  const m = await loadMaterialRow(tx, actor.orgId, id, actor.userId);
  await assertStudentMaterialAccess(tx, actor.orgId, actor.userId, m);
  return m;
}

async function unitStateOf(tx: Tx, orgId: string, studentId: string, unitId: string): Promise<string | null> {
  const row = await tx.maybeOne<{ state: string }>(sql`
    SELECT up.state FROM app.unit_progress up JOIN app.enrollments e ON e.org_id = up.org_id AND e.id = up.enrollment_id
    WHERE up.org_id = ${orgId} AND e.student_id = ${studentId} AND up.unit_id = ${unitId}`);
  return row?.state ?? null;
}

/** POST /materials/{id}/receipt — the student confirms a PDF/動画/画像/リンク material (教材確認). */
materialRoutes.post("/materials/:id/receipt", requireRole("student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, { material_id: id }, async () => {
      const m = await studentMaterial(tx, actor, id);
      if (!VIEWABLE.has(m.kind)) fail("MATERIAL_KIND_MISMATCH");
      const inserted = await tx.maybeOne<{ confirmed_at: Date }>(sql`
        INSERT INTO app.material_receipts(org_id, student_id, material_id) VALUES (${actor.orgId}, ${actor.userId}, ${id})
        ON CONFLICT DO NOTHING RETURNING confirmed_at`);
      const confirmed =
        inserted ??
        (await tx.one<{ confirmed_at: Date }>(sql`SELECT confirmed_at FROM app.material_receipts
          WHERE org_id = ${actor.orgId} AND student_id = ${actor.userId} AND material_id = ${id}`));
      if (inserted) {
        await audit(tx, actor.orgId, actor.userId, "material.confirmed", id, { unit_id: m.unit_id, kind: m.kind });
        await recomputeStudentProgress(tx, actor.orgId, actor.userId);
      }
      return {
        status: 200,
        body: { material_id: id, confirmed_at: iso(confirmed.confirmed_at), unit_state: await unitStateOf(tx, actor.orgId, actor.userId, m.unit_id) },
      };
    }),
  );
  return action(c, result.body);
});

// ---- quizzes ----------------------------------------------------------------------------------

async function loadQuestions(tx: Tx, orgId: string, materialId: string): Promise<QuizQuestionRow[]> {
  const rows = await tx.query<{ id: string; prompt: string; choices: { id: string; label: string }[]; answer_key: string[]; points: string }>(sql`
    SELECT id, prompt, choices, answer_key, points FROM app.quiz_questions WHERE org_id = ${orgId} AND material_id = ${materialId}
    ORDER BY position, id`);
  return rows.map((r) => ({ ...r, points: num(r.points) }));
}

function quizDto(m: MaterialRow, questions: QuizQuestionRow[], attemptsUsed: number) {
  const policy = parsePolicy(m.policy);
  const passScore = effectivePassScore(numOrNull(m.pass_score));
  const score = effectiveQuizScore(policy, numOrNull(m.my_max_score ?? null), numOrNull(m.my_latest_score ?? null));
  return {
    id: m.id,
    title: m.title,
    // Answer keys are never part of this DTO.
    questions: questions.map((q) => ({ id: q.id, prompt: q.prompt, choices: q.choices.map((ch) => ({ id: ch.id, label: ch.label })) })),
    attempts_used: attemptsUsed,
    attempts_remaining: Math.max(0, policy.max_quiz_attempts - attemptsUsed),
    pass_score: passScore,
    max_attempts: policy.max_quiz_attempts,
    score_policy: policy.quiz_score_policy,
    total_points: questions.reduce((s, q) => s + q.points, 0),
    effective_score: score,
    passed: score !== null && score >= passScore,
  };
}

/** PUT /materials/{id}/quiz-definition — replaces all questions of a draft quiz (admin / program teacher). */
materialRoutes.put("/materials/:id/quiz-definition", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const input = await readBody(c, QuizDefinitionInput);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      const m = await loadMaterialRow(tx, actor.orgId, id);
      await assertMaterialWriter(tx, actor, m.program_id);
      if (m.kind !== "quiz") fail("MATERIAL_KIND_MISMATCH");
      const unit = await lockUnitContext(tx, actor.orgId, m.unit_id);
      assertEditable(unit.version_state, unit.archived);
      await tx.exec(sql`DELETE FROM app.quiz_questions WHERE org_id = ${actor.orgId} AND material_id = ${id}`);
      for (const [i, q] of input.questions.entries()) {
        await tx.exec(sql`INSERT INTO app.quiz_questions(org_id, material_id, prompt, choices, answer_key, points, position)
          VALUES (${actor.orgId}, ${id}, ${q.prompt}, ${json(q.choices)}::jsonb, ${json([...new Set(q.correct_option_ids)])}::jsonb, ${q.points}, ${i})`);
      }
      await tx.exec(sql`UPDATE app.materials SET title = ${input.title}, published = false, row_version = row_version + 1
        WHERE org_id = ${actor.orgId} AND id = ${id}`);
      const total = input.questions.reduce((s, q) => s + q.points, 0);
      await audit(tx, actor.orgId, actor.userId, "quiz.defined", id, { question_count: input.questions.length, total_points: total });
      const fresh = await loadMaterialRow(tx, actor.orgId, id);
      return { status: 200, body: quizDto(fresh, await loadQuestions(tx, actor.orgId, id), 0) };
    }),
  );
  return ok(c, result.body);
});

/** GET /materials/{id}/quiz-definition — admin/teacher only (contains the answer keys). */
materialRoutes.get("/materials/:id/quiz-definition", requireRole("admin", "teacher"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const dto = await actorTx(c, async (tx) => {
    const m = await loadMaterialRow(tx, actor.orgId, id);
    if (m.kind !== "quiz") fail("MATERIAL_KIND_MISMATCH");
    const questions = await loadQuestions(tx, actor.orgId, id);
    return {
      material_id: id,
      title: m.title,
      questions: questions.map((q) => ({ id: q.id, prompt: q.prompt, choices: q.choices, correct_option_ids: q.answer_key, points: q.points })),
      total_points: questions.reduce((s, q) => s + q.points, 0),
      pass_score: effectivePassScore(numOrNull(m.pass_score)),
      editable: m.version_state === "draft",
      row_version: m.row_version,
    };
  });
  return ok(c, dto, { version: dto.row_version });
});

/** GET /materials/{id}/quiz — student view without answers, with attempts used/remaining and the pass score. */
materialRoutes.get("/materials/:id/quiz", requireRole("student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const dto = await actorTx(c, async (tx) => {
    const m = await studentMaterial(tx, actor, id);
    if (m.kind !== "quiz") fail("MATERIAL_KIND_MISMATCH");
    const questions = await loadQuestions(tx, actor.orgId, id);
    if (questions.length === 0) fail("QUIZ_NOT_DEFINED");
    return quizDto(m, questions, num(m.my_attempts));
  });
  return ok(c, dto);
});

/** POST /materials/{id}/quiz-attempts — server-side scoring within the version's attempt limit. */
materialRoutes.post("/materials/:id/quiz-attempts", requireRole("student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const input = await readBody(c, QuizInput);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      await lockKey(tx, `quiz:${actor.orgId}:${actor.userId}:${id}`);
      const m = await studentMaterial(tx, actor, id);
      if (m.kind !== "quiz") fail("MATERIAL_KIND_MISMATCH");
      const questions = await loadQuestions(tx, actor.orgId, id);
      if (questions.length === 0) fail("QUIZ_NOT_DEFINED");
      const policy = parsePolicy(m.policy);
      const used = num(m.my_attempts);
      if (used >= policy.max_quiz_attempts) fail("QUIZ_ATTEMPTS_EXCEEDED", { details: { attempts_used: used, max_attempts: policy.max_quiz_attempts } });
      const scored = scoreQuiz(questions, input.answers);
      const passScore = effectivePassScore(numOrNull(m.pass_score));
      const attempt = await tx.one<{ id: string; submitted_at: Date }>(sql`
        INSERT INTO app.quiz_attempts(org_id, material_id, student_id, answers, score, submitted_at, earned_points, total_points, correct_count, question_count)
        VALUES (${actor.orgId}, ${id}, ${actor.userId}, ${json(input.answers)}::jsonb, ${scored.score}, clock_timestamp(),
                ${scored.earned}, ${scored.total}, ${scored.correct}, ${scored.questionCount})
        RETURNING id, submitted_at`);
      const stats = await tx.one<{ max_score: string; latest_score: string }>(sql`
        SELECT max(score) AS max_score,
               (SELECT score FROM app.quiz_attempts WHERE org_id = ${actor.orgId} AND student_id = ${actor.userId} AND material_id = ${id}
                ORDER BY submitted_at DESC, id DESC LIMIT 1) AS latest_score
        FROM app.quiz_attempts WHERE org_id = ${actor.orgId} AND student_id = ${actor.userId} AND material_id = ${id}`);
      const effective = effectiveQuizScore(policy, num(stats.max_score), num(stats.latest_score)) ?? scored.score;
      await audit(tx, actor.orgId, actor.userId, "quiz.attempted", id, {
        attempt_id: attempt.id,
        attempt_number: used + 1,
        score: scored.score,
        passed: scored.score >= passScore,
        unit_id: m.unit_id,
      });
      await recomputeStudentProgress(tx, actor.orgId, actor.userId);
      return {
        status: 200,
        body: {
          id: attempt.id,
          score: scored.score,
          passed: scored.score >= passScore,
          submitted_at: iso(attempt.submitted_at),
          attempts_used: used + 1,
          attempts_remaining: Math.max(0, policy.max_quiz_attempts - used - 1),
          pass_score: passScore,
          effective_score: effective,
          correct_count: scored.correct,
          question_count: scored.questionCount,
        },
      };
    }),
  );
  return ok(c, result.body);
});

// ---- assignment submissions -----------------------------------------------------------------

/** POST /materials/{id}/submissions — student submits an assignment (text and/or a scanned upload). */
materialRoutes.post("/materials/:id/submissions", requireRole("student"), async (c) => {
  const actor = c.get("actor");
  const id = pathId(c);
  const input = await readBody(c, SubmissionInput);
  const result = await actorTx(c, (tx) =>
    idempotent(c, tx, input, async () => {
      await lockKey(tx, `submission:${actor.orgId}:${actor.userId}:${id}`);
      const m = await studentMaterial(tx, actor, id);
      if (m.kind !== "assignment") fail("MATERIAL_KIND_MISMATCH");
      if (!input.body.trim() && !input.object_key) {
        throw new ApiError("VALIDATION_FAILED", { field_errors: { body: "課題の内容を入力するか、ファイルを添付してください。" } });
      }
      const latest = m.my_submission_state;
      if (latest === "submitted") fail("SUBMISSION_AWAITING_REVIEW");
      if (latest === "accepted") fail("SUBMISSION_ALREADY_ACCEPTED");
      let upload: UploadRow | null = null;
      if (input.object_key) {
        upload = await findUploadByKey(tx, actor.orgId, input.object_key);
        assertAttachable(upload, "assignment", "object_key");
        if (upload.user_id !== actor.userId) {
          throw new ApiError("VALIDATION_FAILED", { field_errors: { object_key: "アップロードしたファイルを選択してください。" } });
        }
      }
      const created = await tx.one<{ id: string }>(sql`
        INSERT INTO app.submissions(org_id, material_id, student_id, body, object_key, scan_state, state, submitted_at, upload_id)
        VALUES (${actor.orgId}, ${id}, ${actor.userId}, ${input.body}, ${upload && upload.state === "clean" ? upload.object_key : null},
                ${upload ? upload.scan_state : "not_applicable"}, 'submitted', clock_timestamp(), ${upload?.id ?? null})
        RETURNING id`);
      const teacher = await tx.one<{ teacher_id: string }>(sql`SELECT teacher_id FROM app.student_profiles WHERE org_id = ${actor.orgId} AND id = ${actor.userId}`);
      await audit(tx, actor.orgId, actor.userId, "submission.created", created.id, { material_id: id, unit_id: m.unit_id, has_file: !!upload });
      await outbox(tx, actor.orgId, "submission.created", created.id, {
        submission_id: created.id,
        material_id: id,
        student_id: actor.userId,
        teacher_id: teacher.teacher_id,
      });
      await recomputeStudentProgress(tx, actor.orgId, actor.userId);
      const row = await tx.one<SubmissionRow>(sql`${SUBMISSION_SELECT} WHERE s.org_id = ${actor.orgId} AND s.id = ${created.id}`);
      return { status: 200, body: submissionDto(row) };
    }),
  );
  return ok(c, result.body, { version: result.body.row_version });
});

