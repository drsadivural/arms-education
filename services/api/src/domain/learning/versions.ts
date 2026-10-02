/**
 * Program version lifecycle: draft creation (optionally deep-copying a previous version) and publication.
 * 「公開済み教材の更新は新バージョン。過去進捗を勝手に変更しない」: a published version is immutable (DB guards),
 * publishing archives the previous published version, and existing enrollments keep the version they were given.
 */
import type { Actor } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { ApiError, fail } from "../../http/errors";
import type { VersionPolicy } from "../progress";
import { audit } from "./common";
import { FILE_MATERIAL_FAMILY, CONTENT_TYPES } from "./files";

export interface PublishProblem {
  code: string;
  message_ja: string;
  unit_id?: string;
  material_id?: string;
}

interface ProgramLock {
  id: string;
  archived: boolean;
}

async function lockProgram(tx: Tx, orgId: string, programId: string): Promise<ProgramLock> {
  const p = await tx.maybeOne<ProgramLock>(sql`SELECT id, archived FROM app.programs WHERE org_id = ${orgId} AND id = ${programId} FOR UPDATE`);
  if (!p) fail("NOT_FOUND");
  return p;
}

/** Creates the next draft version. With `sourceVersionId`, units, materials (unpublished) and quiz questions are copied. */
export async function createDraftVersion(
  tx: Tx,
  actor: Actor,
  programId: string,
  input: { source_version_id?: string; policy: VersionPolicy },
): Promise<string> {
  const program = await lockProgram(tx, actor.orgId, programId);
  if (program.archived) fail("PROGRAM_ARCHIVED");
  const draft = await tx.maybeOne(sql`SELECT 1 FROM app.program_versions WHERE org_id = ${actor.orgId} AND program_id = ${programId} AND state = 'draft'`);
  if (draft) fail("DRAFT_VERSION_EXISTS");
  if (input.source_version_id) {
    const src = await tx.maybeOne(sql`SELECT 1 FROM app.program_versions WHERE org_id = ${actor.orgId} AND id = ${input.source_version_id} AND program_id = ${programId}`);
    if (!src) throw new ApiError("VALIDATION_FAILED", { field_errors: { source_version_id: "このプログラムのバージョンを選択してください。" } });
  }
  const created = await tx.one<{ id: string; version_number: number }>(sql`
    INSERT INTO app.program_versions(org_id, program_id, version_number, state, policy, created_by, source_version_id)
    SELECT ${actor.orgId}, ${programId}, coalesce(max(version_number), 0) + 1, 'draft', ${json(input.policy)}::jsonb, ${actor.userId}, ${input.source_version_id ?? null}
    FROM app.program_versions WHERE org_id = ${actor.orgId} AND program_id = ${programId}
    RETURNING id, version_number`);
  let copied = { units: 0, materials: 0 };
  if (input.source_version_id) copied = await copyVersionContent(tx, actor.orgId, input.source_version_id, created.id);
  await audit(tx, actor.orgId, actor.userId, "program_version.created", created.id, {
    program_id: programId,
    version_number: created.version_number,
    source_version_id: input.source_version_id ?? null,
    policy: input.policy,
    copied_units: copied.units,
    copied_materials: copied.materials,
  });
  return created.id;
}

async function copyVersionContent(tx: Tx, orgId: string, sourceId: string, targetId: string): Promise<{ units: number; materials: number }> {
  const units = await tx.exec(sql`
    INSERT INTO app.units(org_id, program_version_id, title, position, required, weight, pass_score, required_attendance, requires_review)
    SELECT org_id, ${targetId}, title, position, required, weight, pass_score, required_attendance, requires_review
    FROM app.units WHERE org_id = ${orgId} AND program_version_id = ${sourceId}`);
  // Units are matched by position (unique per version); materials keep their file reference and scan verdict.
  const map = await tx.query<{ old_id: string; new_id: string }>(sql`
    WITH src AS (
      SELECT m.*, gen_random_uuid() AS new_id, nu.id AS new_unit_id
      FROM app.materials m
      JOIN app.units ou ON ou.org_id = m.org_id AND ou.id = m.unit_id
      JOIN app.units nu ON nu.org_id = m.org_id AND nu.program_version_id = ${targetId} AND nu.position = ou.position
      WHERE m.org_id = ${orgId} AND ou.program_version_id = ${sourceId}
    ), ins AS (
      INSERT INTO app.materials(org_id, id, unit_id, title, kind, object_key, external_url, scan_state, published, required, size_bytes,
                                description, upload_id, created_at)
      SELECT org_id, new_id, new_unit_id, title, kind, object_key, external_url, scan_state, false, required, size_bytes,
             description, upload_id, created_at
      FROM src RETURNING id
    )
    SELECT src.id AS old_id, src.new_id FROM src`);
  if (map.length) {
    await tx.exec(sql`
      INSERT INTO app.quiz_questions(org_id, material_id, prompt, choices, answer_key, points, position)
      SELECT q.org_id, mp.new_id, q.prompt, q.choices, q.answer_key, q.points, q.position
      FROM app.quiz_questions q
      JOIN unnest(${map.map((m) => m.old_id)}::uuid[], ${map.map((m) => m.new_id)}::uuid[]) AS mp(old_id, new_id) ON mp.old_id = q.material_id
      WHERE q.org_id = ${orgId}`);
  }
  return { units, materials: map.length };
}

interface MaterialCheckRow {
  id: string;
  unit_id: string;
  title: string;
  kind: string;
  required: boolean;
  scan_state: string;
  external_url: string | null;
  upload_id: string | null;
  upload_type: string | null;
  upload_state: string | null;
  question_count: string;
}

/** Reasons a material cannot be published (empty = publishable). */
export function materialProblems(m: MaterialCheckRow): PublishProblem[] {
  const name = `「${m.title}」`;
  const out: PublishProblem[] = [];
  const family = FILE_MATERIAL_FAMILY[m.kind];
  if (family) {
    if (!m.upload_id) out.push({ code: "file_missing", message_ja: `${name}にファイルが添付されていません。`, material_id: m.id });
    else if (m.scan_state === "blocked") out.push({ code: "scan_blocked", message_ja: `${name}は検査で問題が検出されたため公開できません。`, material_id: m.id });
    else if (m.scan_state !== "clean") out.push({ code: "scan_pending", message_ja: `${name}のファイル検査が完了していません。`, material_id: m.id });
    else if (!m.upload_type || CONTENT_TYPES[m.upload_type]?.family !== family) {
      out.push({ code: "file_kind_mismatch", message_ja: `${name}のファイル形式が教材の種類と一致しません。`, material_id: m.id });
    }
  } else if (m.kind === "link") {
    if (!m.external_url || !m.external_url.startsWith("https://")) out.push({ code: "link_missing", message_ja: `${name}のURL（https://）が登録されていません。`, material_id: m.id });
  } else if (m.kind === "quiz") {
    if (Number(m.question_count) === 0) out.push({ code: "quiz_empty", message_ja: `${name}に問題が登録されていません。`, material_id: m.id });
  }
  return out;
}

const MATERIAL_CHECK_SELECT = sql`
  SELECT m.id, m.unit_id, m.title, m.kind, m.required, m.scan_state, m.external_url, m.upload_id,
         coalesce(up.detected_type, up.content_type) AS upload_type, up.state AS upload_state,
         (SELECT count(*) FROM app.quiz_questions q WHERE q.org_id = m.org_id AND q.material_id = m.id) AS question_count
  FROM app.materials m
  LEFT JOIN app.upload_jobs up ON up.org_id = m.org_id AND up.id = m.upload_id`;

export async function checkMaterial(tx: Tx, orgId: string, materialId: string): Promise<PublishProblem[]> {
  const m = await tx.one<MaterialCheckRow>(sql`${MATERIAL_CHECK_SELECT} WHERE m.org_id = ${orgId} AND m.id = ${materialId}`);
  return materialProblems(m);
}

/** Every publication rule for a draft version (units, completion conditions and all materials). */
export async function versionProblems(tx: Tx, orgId: string, versionId: string): Promise<PublishProblem[]> {
  const units = await tx.query<{ id: string; title: string; required: boolean; required_attendance: boolean; requires_review: boolean }>(sql`
    SELECT id, title, required, required_attendance, requires_review FROM app.units
    WHERE org_id = ${orgId} AND program_version_id = ${versionId} ORDER BY position`);
  if (units.length === 0) return [{ code: "no_units", message_ja: "単元が登録されていません。" }];
  const materials = await tx.query<MaterialCheckRow>(sql`
    ${MATERIAL_CHECK_SELECT}
    JOIN app.units u ON u.org_id = m.org_id AND u.id = m.unit_id
    WHERE m.org_id = ${orgId} AND u.program_version_id = ${versionId}
    ORDER BY u.position, m.created_at, m.id`);
  const problems: PublishProblem[] = [];
  for (const u of units) {
    const req = materials.filter((m) => m.unit_id === u.id && m.required);
    const name = `「${u.title}」`;
    if (u.required && req.length === 0 && !u.required_attendance) {
      problems.push({ code: "unit_without_condition", message_ja: `${name}に完了条件（必須教材または出席）がありません。`, unit_id: u.id });
    }
    if (u.requires_review && !req.some((m) => m.kind === "assignment")) {
      problems.push({ code: "review_without_assignment", message_ja: `${name}は講師承認が必要ですが、必須の課題がありません。`, unit_id: u.id });
    }
    const verifiable = req.some((m) => m.kind === "quiz" || m.kind === "assignment") || u.required_attendance;
    if (req.some((m) => m.kind === "video") && !verifiable) {
      problems.push({
        code: "video_self_report_only",
        message_ja: `${name}の動画は視聴の自己申告だけでは完了にできません。確認テスト・課題・出席のいずれかを必須にしてください。`,
        unit_id: u.id,
      });
    }
  }
  for (const m of materials) problems.push(...materialProblems(m));
  return problems;
}

/** Throws the right error for a list of problems: scan still pending → SCAN_PENDING / SCANNER_UNAVAILABLE. */
export function raiseProblems(problems: PublishProblem[], scannerConfigured: boolean, code: "VERSION_NOT_PUBLISHABLE" | "MATERIAL_NOT_PUBLISHABLE"): never {
  const onlyPending = problems.every((p) => p.code === "scan_pending");
  if (onlyPending) fail(scannerConfigured ? "SCAN_PENDING" : "SCANNER_UNAVAILABLE", { details: { problems } });
  fail(code, { details: { problems } });
}

/** Publishes a draft version (admin). Returns the archived previous version id, if any. */
export async function publishVersion(tx: Tx, actor: Actor, versionId: string, scannerConfigured: boolean): Promise<{ previousVersionId: string | null }> {
  const head = await tx.maybeOne<{ program_id: string }>(sql`SELECT program_id FROM app.program_versions WHERE org_id = ${actor.orgId} AND id = ${versionId}`);
  if (!head) fail("NOT_FOUND");
  // Lock order: program, then version (same order as createDraftVersion).
  const program = await lockProgram(tx, actor.orgId, head.program_id);
  const version = await tx.one<{ state: string; version_number: number }>(sql`
    SELECT state, version_number FROM app.program_versions WHERE org_id = ${actor.orgId} AND id = ${versionId} FOR UPDATE`);
  if (version.state !== "draft") fail("PUBLISHED_VERSION_IMMUTABLE");
  if (program.archived) fail("PROGRAM_ARCHIVED");
  const problems = await versionProblems(tx, actor.orgId, versionId);
  if (problems.length) raiseProblems(problems, scannerConfigured, "VERSION_NOT_PUBLISHABLE");

  // Materials first: the DB guard forbids changing materials once the version leaves draft.
  await tx.exec(sql`
    UPDATE app.materials m SET published = true, row_version = m.row_version + CASE WHEN m.published THEN 0 ELSE 1 END
    FROM app.units u
    WHERE m.org_id = ${actor.orgId} AND u.org_id = m.org_id AND u.id = m.unit_id AND u.program_version_id = ${versionId}`);
  const previous = await tx.maybeOne<{ id: string }>(sql`
    UPDATE app.program_versions SET state = 'archived', row_version = row_version + 1
    WHERE org_id = ${actor.orgId} AND program_id = ${head.program_id} AND state = 'published' RETURNING id`);
  await tx.exec(sql`
    UPDATE app.program_versions SET state = 'published', published_at = now(), published_by = ${actor.userId}, row_version = row_version + 1
    WHERE org_id = ${actor.orgId} AND id = ${versionId}`);
  await audit(tx, actor.orgId, actor.userId, "program_version.published", versionId, {
    program_id: head.program_id,
    version_number: version.version_number,
    archived_version_id: previous?.id ?? null,
  });
  return { previousVersionId: previous?.id ?? null };
}
