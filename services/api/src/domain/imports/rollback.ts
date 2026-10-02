/**
 * POST /imports/{id}/rollback (docs/08 「rollbackはimport_itemsのbefore/after/versionを比較し、移行後のユーザー編集を
 * 上書きしない。変更済み行はmanual reconciliationへ」).
 *
 * For every applied row (newest row first, ≤200 rows per transaction):
 *   - the target's current row_version must equal the committed_version recorded at commit; otherwise the row was
 *     edited after the import and is left as is → rollback_state = manual (「手動照合が必要」)
 *   - progress records / classrooms created by the import are deleted (a classroom that has students, lesson
 *     slots or programs attached is left for manual reconciliation); updated rows get their before_data back
 *   - people (teachers / new employees): accounts are never deleted — the person may already have signed in and
 *     the Auth provider account is shared across organisations. An account the import created is stopped
 *     (membership inactive, web sessions revoked, student profile out of enrolment, provider sign-in blocked
 *     after commit) with the same guards as 講師管理/新入社員管理 (primary classroom, future lesson slots,
 *     active reservations → manual). Updated people get their previous name/kana/department/dates back.
 * The job keeps its state while rolling back (rollback_key set) and becomes rolled_back when every applied row is
 * reverted or marked manual. Retries continue with the remaining rows.
 */
import type { AppContext } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { ApiError, fail } from "../../http/errors";
import { requireIdempotencyKey } from "../../http/idempotency";
import { activeReservationCount } from "../../repositories/admin/students";
import { assertCanDeactivate, lockMembership, setMembershipActive, syncProviderBan } from "../admin/accounts";
import { audit } from "../admin/common";
import { insertAudits, underSavepoint, type AuditEvent } from "./apply";
import { findJob } from "./jobs";
import { BATCH_SIZE, BatchFailure, LEASE_SECONDS, LeaseLost, REQUEST_BUDGET_MS, recordBatchFailure, releaseLease, renewLease, requestHash, toApiError } from "./lease";
import type { JobRow, JobState } from "./model";

const ROLLBACK_STATES: readonly JobState[] = ["completed", "failed", "committing"];

const EDITED = "移行後に編集されているため元に戻していません。現在の内容と移行前の値を確認して手動で照合してください。";
const GONE = "移行後に削除されていたため、取り消す内容はありません。";

interface RollbackItem {
  row_number: number;
  action: "create" | "update";
  entity_id: string;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown>;
  committed_version: number;
}

interface RowOutcome {
  row_number: number;
  state: "reverted" | "manual";
  message: string | null;
  /** row_version the rollback left on a restored / stopped record (null when deleted or untouched). */
  version?: number | null;
}

type Claim = { kind: "replay" } | { kind: "run"; job: JobRow; token: string };

async function claim(c: AppContext, jobId: string): Promise<Claim> {
  const actor = c.get("actor");
  const key = requireIdempotencyKey(c);
  const hash = await requestHash(c, {});
  return actorTx(c, async (tx) => {
    const job = await findJob(tx, actor.orgId, jobId, { lock: true });
    if (!job) fail("NOT_FOUND");
    if (job.rollback_key === key) {
      if (job.rollback_hash !== hash) fail("IDEMPOTENCY_CONFLICT");
      if (job.state === "rolled_back") return { kind: "replay" } as const;
    }
    if (job.state === "rolled_back") fail("INVALID_STATE", { message_ja: "この移行は既に取り消し済みです。" });
    if (job.state === "uploaded" || job.state === "validated") {
      fail("INVALID_STATE", { message_ja: "まだ確定していない移行は取り消す必要がありません。" });
    }
    if (job.leased) fail("IMPORT_IN_PROGRESS");
    const token = crypto.randomUUID();
    await tx.exec(sql`
      UPDATE app.import_jobs SET rollback_key = ${key}, rollback_hash = ${hash}, rolled_back_by = coalesce(rolled_back_by, ${actor.userId}::uuid),
        lease_token = ${token}, locked_until = now() + make_interval(secs => ${LEASE_SECONDS}), failure = NULL, updated_at = now(),
        row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${jobId}`);
    await audit(tx, actor, job.rollback_key === null ? "import.rollback_started" : "import.rollback_resumed", jobId, {
      entity: job.entity,
      source_system: job.source_system,
      previous_state: job.state,
    });
    return { kind: "run", job, token } as const;
  });
}

const meta = (jobId: string, row: number) => ({ source: "import_rollback", import_job_id: jobId, row });

// ---- 教育進捗 (set-based) -------------------------------------------------------------------------

const PROGRESS_RESTORE = ["student_id", "teacher_id", "department_name", "teacher_name_snapshot", "due_date", "content", "notes", "state"] as const;

async function revertProgress(tx: Tx, orgId: string, jobId: string, items: RollbackItem[], audits: AuditEvent[]): Promise<RowOutcome[]> {
  const created = items.filter((i) => i.action === "create");
  const updated = items.filter((i) => i.action === "update");
  const done = new Map<string, number | null>();
  if (created.length > 0) {
    const deleted = await tx.query<{ id: string }>(sql`
      DELETE FROM app.progress_records p USING jsonb_to_recordset(${json(created.map((i) => ({ id: i.entity_id, v: i.committed_version })))}::jsonb) AS x(id uuid, v int)
      WHERE p.org_id = ${orgId} AND p.id = x.id AND p.row_version = x.v RETURNING p.id`);
    for (const d of deleted) done.set(d.id, null);
  }
  if (updated.length > 0) {
    const rows = updated.map((i) => {
      const b = i.before_data ?? {};
      const r: Record<string, unknown> = { id: i.entity_id, v: i.committed_version };
      for (const f of PROGRESS_RESTORE) r[f] = b[f] ?? (f === "notes" ? "" : null);
      return r;
    });
    const restored = await tx.query<{ id: string; row_version: number }>(sql`
      UPDATE app.progress_records p SET student_id = x.student_id, teacher_id = x.teacher_id, department_name = x.department_name,
        teacher_name_snapshot = x.teacher_name_snapshot, due_date = x.due_date, content = x.content, notes = x.notes, state = x.state,
        row_version = p.row_version + 1, updated_at = now()
      FROM jsonb_to_recordset(${json(rows)}::jsonb) AS x(id uuid, v int, student_id uuid, teacher_id uuid, department_name text,
        teacher_name_snapshot text, due_date date, content text, notes text, state text)
      WHERE p.org_id = ${orgId} AND p.id = x.id AND p.row_version = x.v RETURNING p.id, p.row_version`);
    for (const r of restored) done.set(r.id, r.row_version);
  }
  const missing = items.filter((i) => !done.has(i.entity_id)).map((i) => i.entity_id);
  const exists = new Set(
    missing.length
      ? (await tx.query<{ id: string }>(sql`SELECT id FROM app.progress_records WHERE org_id = ${orgId} AND id = ANY(${missing}::uuid[])`)).map((r) => r.id)
      : [],
  );
  return items.map((i) => {
    if (done.has(i.entity_id)) {
      audits.push(
        i.action === "create"
          ? { event_type: "progress_record.deleted", entity_id: i.entity_id, payload: { ...meta(jobId, i.row_number), source_record_id: i.after_data.source_record_id } }
          : { event_type: "progress_record.updated", entity_id: i.entity_id, payload: { ...meta(jobId, i.row_number), restored: true } },
      );
      return { row_number: i.row_number, state: "reverted", message: null, version: done.get(i.entity_id) ?? null };
    }
    if (!exists.has(i.entity_id)) return { row_number: i.row_number, state: "reverted", message: GONE };
    return { row_number: i.row_number, state: "manual", message: EDITED };
  });
}

// ---- クラス -------------------------------------------------------------------------------------

async function revertClassroom(tx: Tx, orgId: string, jobId: string, item: RollbackItem, audits: AuditEvent[]): Promise<RowOutcome> {
  const id = item.entity_id;
  const current = await tx.maybeOne<{ row_version: number }>(sql`SELECT row_version FROM app.classrooms WHERE org_id = ${orgId} AND id = ${id} FOR UPDATE`);
  if (!current) return { row_number: item.row_number, state: "reverted", message: GONE };
  if (current.row_version !== item.committed_version) return { row_number: item.row_number, state: "manual", message: EDITED };
  const outcome = await underSavepoint(tx, async () => {
    if (item.action === "create") {
      const usage = await tx.one<{ students: number; slots: number; programs: number; teachers: number }>(sql`
        SELECT (SELECT count(*)::int FROM app.student_profiles WHERE org_id = ${orgId} AND classroom_id = ${id}) AS students,
          (SELECT count(*)::int FROM app.lesson_slots WHERE org_id = ${orgId} AND classroom_id = ${id}) AS slots,
          (SELECT count(*)::int FROM app.classroom_programs WHERE org_id = ${orgId} AND classroom_id = ${id}) AS programs,
          (SELECT count(*)::int FROM app.classroom_teachers WHERE org_id = ${orgId} AND classroom_id = ${id} AND NOT is_primary) AS teachers`);
      if (usage.students + usage.slots + usage.programs + usage.teachers > 0) {
        throw new ApiError("RELATED_IN_USE", {
          message_ja: "移行後にこのクラスへ新入社員・授業枠・教育プログラム・補助講師が登録されたため削除していません。先に関連する移行を取り消すか、手動で照合してください。",
        });
      }
      await tx.exec(sql`DELETE FROM app.import_classroom_keys WHERE org_id = ${orgId} AND classroom_id = ${id}`);
      await tx.exec(sql`DELETE FROM app.classroom_teachers WHERE org_id = ${orgId} AND classroom_id = ${id}`);
      await tx.exec(sql`DELETE FROM app.classrooms WHERE org_id = ${orgId} AND id = ${id}`);
      return { event_type: "classroom.deleted", entity_id: id, payload: { ...meta(jobId, item.row_number), name: item.after_data.name } };
    }
    const b = item.before_data ?? {};
    const restored = await tx.one<{ row_version: number }>(sql`
      UPDATE app.classrooms SET name = ${String(b.name)}, capacity = ${Number(b.capacity)}, starts_on = ${String(b.starts_on)}::date,
        ends_on = ${String(b.ends_on)}::date, row_version = row_version + 1
      WHERE org_id = ${orgId} AND id = ${id} RETURNING row_version`);
    return { event_type: "classroom.updated", entity_id: id, payload: { ...meta(jobId, item.row_number), restored: true }, version: restored.row_version };
  });
  if (!outcome.ok) return { row_number: item.row_number, state: "manual", message: outcome.error.message_ja };
  const { version, ...event } = outcome.value as AuditEvent & { version?: number };
  audits.push(event);
  return { row_number: item.row_number, state: "reverted", message: null, version: version ?? null };
}

// ---- 講師・新入社員 ------------------------------------------------------------------------------

async function revertPerson(
  c: AppContext,
  tx: Tx,
  entity: "teachers" | "students",
  jobId: string,
  item: RollbackItem,
  audits: AuditEvent[],
  banned: string[],
): Promise<RowOutcome> {
  const actor = c.get("actor");
  const orgId = actor.orgId;
  const id = item.entity_id;
  const table = entity === "teachers" ? sql`app.teacher_profiles` : sql`app.student_profiles`;
  const current = await tx.maybeOne<{ row_version: number }>(sql`SELECT row_version FROM ${table} WHERE org_id = ${orgId} AND id = ${id} FOR NO KEY UPDATE`);
  if (!current) return { row_number: item.row_number, state: "reverted", message: GONE };
  if (current.row_version !== item.committed_version) return { row_number: item.row_number, state: "manual", message: EDITED };
  const outcome = await underSavepoint(tx, async () => {
    if (item.action === "create") {
      const target = await lockMembership(tx, orgId, id);
      if (entity === "students" && (await activeReservationCount(tx, orgId, id)) > 0) {
        throw new ApiError("ACTIVE_RESERVATIONS", { message_ja: "有効な予約があるためアカウントを停止していません。予約の取消後に手動で照合してください。" });
      }
      if (target.active) await assertCanDeactivate(tx, actor, target);
      if (entity === "students") {
        await tx.exec(sql`UPDATE app.student_profiles SET active = false, row_version = row_version + 1 WHERE org_id = ${orgId} AND id = ${id}`);
      } else {
        await tx.exec(sql`UPDATE app.teacher_profiles SET row_version = row_version + 1 WHERE org_id = ${orgId} AND id = ${id}`);
      }
      if (target.active) await setMembershipActive(tx, orgId, id, false);
      return {
        version: current.row_version + 1,
        event: { event_type: entity === "teachers" ? "teacher.archived" : "student.archived", entity_id: id, payload: { ...meta(jobId, item.row_number), account_kept: true } },
        ban: target.active,
      };
    }
    const b = item.before_data ?? {};
    await tx.exec(sql`UPDATE app.users SET display_name = ${String(b.display_name ?? "")} WHERE id = ${id}`);
    if (entity === "teachers") {
      await tx.exec(sql`UPDATE app.teacher_profiles SET kana = ${String(b.kana ?? "")}, department_name = ${String(b.department_name ?? "")}, row_version = row_version + 1
        WHERE org_id = ${orgId} AND id = ${id}`);
    } else {
      await tx.exec(sql`
        UPDATE app.student_profiles SET kana = ${String(b.kana ?? "")}, company_name = ${String(b.company_name ?? "")},
          department_name = ${String(b.department_name ?? "")}, joined_on = ${String(b.joined_on)}::date,
          training_starts_on = ${String(b.training_starts_on)}::date, training_due_on = ${String(b.training_due_on)}::date, row_version = row_version + 1
        WHERE org_id = ${orgId} AND id = ${id}`);
    }
    return {
      version: current.row_version + 1,
      event: { event_type: entity === "teachers" ? "teacher.updated" : "student.updated", entity_id: id, payload: { ...meta(jobId, item.row_number), restored: true } },
      ban: false,
    };
  });
  if (!outcome.ok) {
    const reason =
      outcome.error.code === "TEACHER_IS_PRIMARY" || outcome.error.code === "TEACHER_HAS_FUTURE_SLOTS"
        ? `${outcome.error.message_ja}（クラスの移行を先に取り消すか、手動で照合してください）`
        : outcome.error.message_ja;
    return { row_number: item.row_number, state: "manual", message: reason };
  }
  audits.push(outcome.value.event);
  if (outcome.value.ban) banned.push(id);
  return {
    row_number: item.row_number,
    state: "reverted",
    message: item.action === "create" ? "アカウントは削除せず停止しました（ログイン済みの可能性があるため）。" : null,
    version: outcome.value.version,
  };
}

async function writeRollbackResults(tx: Tx, orgId: string, jobId: string, results: RowOutcome[]): Promise<void> {
  if (results.length === 0) return;
  await tx.exec(sql`
    UPDATE app.import_items i SET rollback_state = x.state, rollback_message = x.message, reverted_version = x.version
    FROM jsonb_to_recordset(${json(results.map((r) => ({ ...r, version: r.version ?? null })))}::jsonb) AS x(row_number int, state text, message text, version int)
    WHERE i.org_id = ${orgId} AND i.job_id = ${jobId} AND i.row_number = x.row_number`);
}

/** One rollback batch (≤200 rows, newest first). Returns the rows processed and the accounts to block at the provider. */
async function runBatch(c: AppContext, job: JobRow, token: string): Promise<{ n: number; banned: string[] }> {
  const actor = c.get("actor");
  let range: { from: number; to: number } | null = null;
  try {
    return await actorTx(c, async (tx) => {
      await renewLease(tx, actor.orgId, job.id, token, ROLLBACK_STATES);
      const items = await tx.query<RollbackItem>(sql`
        SELECT row_number, action, entity_id, before_data, after_data, committed_version FROM app.import_items
        WHERE org_id = ${actor.orgId} AND job_id = ${job.id} AND commit_state = 'applied' AND rollback_state IS NULL
        ORDER BY row_number DESC LIMIT ${BATCH_SIZE} FOR UPDATE`);
      if (items.length === 0) return { n: 0, banned: [] };
      range = { from: Math.min(...items.map((i) => i.row_number)), to: Math.max(...items.map((i) => i.row_number)) };
      const audits: AuditEvent[] = [];
      const banned: string[] = [];
      let results: RowOutcome[];
      if (job.entity === "progress") results = await revertProgress(tx, actor.orgId, job.id, items, audits);
      else {
        results = [];
        for (const item of items) {
          results.push(
            job.entity === "classrooms"
              ? await revertClassroom(tx, actor.orgId, job.id, item, audits)
              : await revertPerson(c, tx, job.entity, job.id, item, audits, banned),
          );
        }
      }
      await writeRollbackResults(tx, actor.orgId, job.id, results);
      await insertAudits(tx, actor, audits);
      return { n: items.length, banned };
    });
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    const r = range as { from: number; to: number } | null;
    throw new BatchFailure(toApiError(e), r?.from ?? null, r?.to ?? null, null);
  }
}

async function finish(c: AppContext, job: JobRow, token: string): Promise<boolean> {
  const actor = c.get("actor");
  return actorTx(c, async (tx) => {
    await renewLease(tx, actor.orgId, job.id, token, ROLLBACK_STATES);
    const counts = await tx.one<{ left: number; reverted: number; manual: number }>(sql`
      SELECT count(*) FILTER (WHERE commit_state = 'applied' AND rollback_state IS NULL)::int AS left,
        count(*) FILTER (WHERE rollback_state = 'reverted')::int AS reverted, count(*) FILTER (WHERE rollback_state = 'manual')::int AS manual
      FROM app.import_items WHERE org_id = ${actor.orgId} AND job_id = ${job.id}`);
    if (counts.left > 0) return false;
    await tx.exec(sql`
      UPDATE app.import_jobs SET state = 'rolled_back', rolled_back_at = now(), lease_token = NULL, locked_until = NULL, updated_at = now(),
        row_version = row_version + 1
      WHERE org_id = ${actor.orgId} AND id = ${job.id}`);
    await audit(tx, actor, "import.rolled_back", job.id, { entity: job.entity, reverted: counts.reverted, manual: counts.manual });
    return true;
  });
}

/** Rolls back (or resumes rolling back) a committed import. */
export async function rollbackImport(c: AppContext, jobId: string): Promise<void> {
  const claimed = await claim(c, jobId);
  if (claimed.kind === "replay") return;
  const { job, token } = claimed;
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        await releaseLease(c, job.id, token);
        return;
      }
      const { n, banned } = await runBatch(c, job, token);
      // Sign-in is blocked at the provider after the deactivation committed (the DB membership is authoritative).
      for (const userId of banned) await syncProviderBan(c, userId, true);
      if (n > 0) continue;
      if (await finish(c, job, token)) return;
    }
  } catch (e) {
    if (e instanceof LeaseLost) fail("IMPORT_IN_PROGRESS");
    if (e instanceof BatchFailure) {
      await recordBatchFailure(c, job, token, e, "import.rollback_failed", null);
      return;
    }
    throw e;
  }
}
