/**
 * Invitation saga (contracts/API_NOTES_JA.md: 管理者inviteはAuth provider作成とDB profileのsagaをinvitation_jobsで追跡).
 *
 *   1. adminCreateUser at the Auth provider            pending → auth_created (auth_user_id stored)
 *   2. app.users + app.memberships + profile in one tx  auth_created → profile_created
 *   3. adminSendInvite                                   profile_created → sent | failed (resend possible)
 *
 * External calls run outside DB transactions. Each step is guarded by the job state, so a retry resumes where the
 * previous attempt stopped and never creates a second provider user:
 *   - the same admin + Idempotency-Key + identical request finds the same job (different request → IDEMPOTENCY_CONFLICT);
 *   - an unfinished (pre-profile) job for the same e-mail is adopted by a later request, reusing its provider user;
 *   - a short lease (locked_until) serialises concurrent work on one job (→ IDEMPOTENCY_IN_PROGRESS / INVITATION_IN_PROGRESS).
 * When step 3 fails the profile stays created and the job is `failed` with an error code (「送信失敗（再送可能）」).
 */
import type { InviteResult } from "@arms/contracts";
import type { AppContext, Role } from "../../context";
import { actorTx } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { ApiError, fail } from "../../http/errors";
import { requireIdempotencyKey } from "../../http/idempotency";
import { sha256Hex } from "../../auth/crypto";
import type { InvitationState } from "../../repositories/admin/teachers";
import { audit, stableStringify } from "./common";

/** Lease held while one request works on a job (two provider calls with a 10 s timeout each + DB work). */
const LEASE_SECONDS = 60;

export interface InvitationJob {
  id: string;
  email: string;
  role: Role;
  profile_payload: Record<string, unknown>;
  state: InvitationState;
  auth_user_id: string | null;
  attempts: number;
  error_code: string | null;
  row_version: number;
  request_hash: string | null;
  resend_key: string | null;
  leased: boolean;
}

const JOB_COLUMNS = sql`id, email, role, profile_payload, state, auth_user_id, attempts, error_code, row_version, request_hash, resend_key,
  (locked_until IS NOT NULL AND locked_until > now()) AS leased`;

export interface InvitationSpec {
  email: string;
  role: Role;
  displayName: string;
  /** Validated input stored on the job and replayed by createProfile (also the idempotency request body). */
  payload: Record<string, unknown>;
  /**
   * DB validations before any external call (e-mail/number uniqueness, classroom/teacher rules, seat availability).
   * Runs in the transaction that creates or resumes the job; `jobId` is the job being resumed, if any.
   */
  precheck(tx: Tx, jobId: string | null): Promise<void>;
  /** Inserts app.users / app.memberships / the role profile and the audit event for `userId` (provider user id). */
  createProfile(tx: Tx, payload: Record<string, unknown>, userId: string): Promise<void>;
}

export interface InvitationOutcome {
  job: InvitationJob;
  userId: string;
  result: InviteResult;
}

function codeOf(e: unknown): string {
  return e instanceof ApiError ? e.code : "INTERNAL";
}

/** Japanese status message for the UI (「送信失敗（再送可能）」 etc.). */
export function inviteResult(job: InvitationJob, membershipActive: boolean): InviteResult {
  const state: InviteResult["state"] = job.state === "sent" ? "sent" : job.state === "failed" ? "failed" : "pending";
  let message_ja: string;
  if (job.state === "sent") message_ja = "招待メールを送信しました。";
  else if (job.state === "failed") message_ja = "招待メールを送信できませんでした（送信失敗・再送可能）。ユーザー管理から招待を再送してください。";
  else if (job.state === "profile_created" && !membershipActive) message_ja = "無効の状態で登録したため、招待メールは送信していません。有効にしてから招待を再送してください。";
  else message_ja = "招待を処理中です。しばらくしてから状態を確認してください。";
  return { id: job.id, user_id: job.auth_user_id ?? "", state, message_ja, row_version: job.row_version };
}

async function takeLease(tx: Tx, jobId: string): Promise<InvitationJob | null> {
  return tx.maybeOne<InvitationJob>(sql`
    UPDATE app.invitation_jobs SET locked_until = now() + make_interval(secs => ${LEASE_SECONDS}), updated_at = now()
    WHERE id = ${jobId} AND (locked_until IS NULL OR locked_until <= now()) RETURNING ${JOB_COLUMNS}`);
}

/** Records a step failure (state unchanged unless given) and releases the lease, in its own transaction. */
async function recordFailure(c: AppContext, jobId: string, code: string): Promise<void> {
  try {
    await actorTx(c, (tx) =>
      tx.exec(sql`UPDATE app.invitation_jobs SET error_code = ${code}, locked_until = NULL, updated_at = now(), row_version = row_version + 1
        WHERE id = ${jobId}`),
    );
  } catch (e) {
    // The lease expires by itself; the original error is what the caller must see.
    c.get("deps").log({ level: "error", msg: "invitation_record_failed", request_id: c.get("requestId"), job_id: jobId, code: codeOf(e) });
  }
}

async function membershipActive(tx: Tx, orgId: string, userId: string): Promise<boolean> {
  const m = await tx.maybeOne<{ active: boolean }>(sql`SELECT active FROM app.memberships WHERE org_id = ${orgId} AND id = ${userId}`);
  return m?.active ?? false;
}

/**
 * Step 3: sends the invitation e-mail for a job whose profile exists and whose lease the caller holds.
 * Provider failures are recorded on the job (`failed`, error_code) instead of being thrown, except
 * "already registered" (INVALID_STATE), which leaves the job unchanged and is re-thrown.
 */
export async function sendInvitation(c: AppContext, job: InvitationJob, metadata: Record<string, unknown>): Promise<InvitationJob> {
  const deps = c.get("deps");
  const actor = c.get("actor");
  let errorCode: string | null = null;
  try {
    await deps.auth.adminSendInvite(job.email, metadata);
  } catch (e) {
    errorCode = codeOf(e);
    if (errorCode === "INVALID_STATE") {
      await recordFailure(c, job.id, errorCode);
      throw e;
    }
    deps.log({ level: "warn", msg: "invitation_send_failed", request_id: c.get("requestId"), job_id: job.id, code: errorCode });
  }
  return actorTx(c, async (tx) => {
    const updated = await tx.one<InvitationJob>(sql`
      UPDATE app.invitation_jobs SET
        state = ${errorCode ? "failed" : "sent"}, error_code = ${errorCode},
        sent_at = CASE WHEN ${errorCode === null}::boolean THEN now() ELSE sent_at END,
        attempts = attempts + 1, locked_until = NULL, updated_at = now(), row_version = row_version + 1
      WHERE id = ${job.id} RETURNING ${JOB_COLUMNS}`);
    await audit(tx, actor, errorCode ? "invitation.failed" : "invitation.sent", job.auth_user_id, {
      invitation_job_id: job.id,
      role: job.role,
      attempts: updated.attempts,
      ...(errorCode ? { error_code: errorCode } : {}),
    });
    return updated;
  });
}

/** Runs (or resumes) the saga for one create request. Throws business errors (409/422/503) from steps 1–2. */
export async function runInvitation(c: AppContext, spec: InvitationSpec): Promise<InvitationOutcome> {
  const actor = c.get("actor");
  const deps = c.get("deps");
  const key = requireIdempotencyKey(c);
  const requestHash = await sha256Hex(stableStringify({ route: `${c.req.method} ${c.req.path}`, request: spec.payload }));
  const metadata = { display_name: spec.displayName, role: spec.role };

  // Tx A: find (same key) or adopt (same e-mail, unfinished) or create the job, and take its lease.
  let job = await actorTx(c, async (tx) => {
    const existing = await tx.maybeOne<InvitationJob>(sql`
      SELECT ${JOB_COLUMNS} FROM app.invitation_jobs
      WHERE org_id = ${actor.orgId} AND created_by = ${actor.userId} AND idempotency_key = ${key} FOR UPDATE`);
    if (existing) {
      if (existing.request_hash !== requestHash) fail("IDEMPOTENCY_CONFLICT");
      // Completed from this request's point of view: replay the current state without new side effects.
      if (existing.state === "sent") return { ...existing, leased: false };
      if (existing.state === "profile_created" && !(await membershipActive(tx, actor.orgId, existing.auth_user_id as string))) {
        return { ...existing, leased: false };
      }
      const leased = await takeLease(tx, existing.id);
      if (!leased) fail("IDEMPOTENCY_IN_PROGRESS");
      if (leased.state === "pending" || leased.state === "auth_created") await spec.precheck(tx, leased.id);
      return { ...leased, leased: true };
    }
    await spec.precheck(tx, null);
    const open = await tx.maybeOne<InvitationJob>(sql`
      SELECT ${JOB_COLUMNS} FROM app.invitation_jobs
      WHERE org_id = ${actor.orgId} AND lower(email) = lower(${spec.email}) AND state IN ('pending', 'auth_created') FOR UPDATE`);
    if (open) {
      if (open.leased) fail("INVITATION_IN_PROGRESS");
      const adopted = await tx.one<InvitationJob>(sql`
        UPDATE app.invitation_jobs SET role = ${spec.role}, profile_payload = ${json(spec.payload)}::jsonb, created_by = ${actor.userId},
          idempotency_key = ${key}, request_hash = ${requestHash}, error_code = NULL,
          locked_until = now() + make_interval(secs => ${LEASE_SECONDS}), updated_at = now(), row_version = row_version + 1
        WHERE id = ${open.id} RETURNING ${JOB_COLUMNS}`);
      return { ...adopted, leased: true };
    }
    const created = await tx.maybeOne<InvitationJob>(sql`
      INSERT INTO app.invitation_jobs(org_id, email, role, profile_payload, state, created_by, idempotency_key, request_hash, locked_until)
      VALUES (${actor.orgId}, ${spec.email}, ${spec.role}, ${json(spec.payload)}::jsonb, 'pending', ${actor.userId}, ${key}, ${requestHash},
        now() + make_interval(secs => ${LEASE_SECONDS}))
      ON CONFLICT DO NOTHING RETURNING ${JOB_COLUMNS}`);
    // A concurrent request inserted a job for the same e-mail (or the same key) between our checks.
    if (!created) fail("INVITATION_IN_PROGRESS");
    return { ...created, leased: true };
  });

  if (job.leased) {
    // Step 1: Auth provider user.
    if (job.state === "pending") {
      let providerUserId: string;
      try {
        providerUserId = (await deps.auth.adminCreateUser(job.email, metadata)).userId;
      } catch (e) {
        await recordFailure(c, job.id, codeOf(e));
        throw e;
      }
      const pendingJob = job;
      job = await actorTx(c, async (tx) => {
        const advanced = await tx.maybeOne<InvitationJob>(sql`
          UPDATE app.invitation_jobs SET state = 'auth_created', auth_user_id = ${providerUserId}, error_code = NULL,
            attempts = attempts + 1, updated_at = now(), row_version = row_version + 1
          WHERE id = ${pendingJob.id} AND state = 'pending' RETURNING ${JOB_COLUMNS}`);
        // Only possible when this request outlived its lease and another request advanced the job.
        if (!advanced) fail("IDEMPOTENCY_IN_PROGRESS");
        return { ...advanced, leased: true };
      });
    }
    // Step 2: DB user + membership + profile (one transaction).
    if (job.state === "auth_created") {
      const current = job;
      try {
        job = await actorTx(c, async (tx) => {
          const advanced = await tx.maybeOne<InvitationJob>(sql`
            UPDATE app.invitation_jobs SET state = 'profile_created', profile_created_at = now(), error_code = NULL,
              updated_at = now(), row_version = row_version + 1
            WHERE id = ${current.id} AND state = 'auth_created' RETURNING ${JOB_COLUMNS}`);
          if (!advanced) fail("IDEMPOTENCY_IN_PROGRESS");
          await spec.createProfile(tx, current.profile_payload, current.auth_user_id as string);
          return { ...advanced, leased: true };
        });
      } catch (e) {
        await recordFailure(c, current.id, codeOf(e));
        throw e;
      }
    }
  }

  const userId = job.auth_user_id as string;
  const active = await actorTx(c, (tx) => membershipActive(tx, actor.orgId, userId));
  // Step 3: invitation e-mail (only for active accounts; inactive registrations are invited when re-enabled).
  if (job.leased && (job.state === "profile_created" || job.state === "failed")) {
    if (active) job = await sendInvitation(c, job, metadata);
    else {
      const leasedJob = job;
      job = await actorTx(c, (tx) =>
        tx.one<InvitationJob>(sql`UPDATE app.invitation_jobs SET locked_until = NULL, updated_at = now() WHERE id = ${leasedJob.id} RETURNING ${JOB_COLUMNS}`),
      );
    }
  }
  return { job, userId, result: inviteResult(job, active) };
}

/**
 * Resend for an existing account (POST /settings/users/{id}/resend-invite). The Idempotency-Key is stored as
 * resend_key on the job: a replay of the same key returns the recorded outcome without sending again.
 */
export async function resendInvitation(c: AppContext, userId: string): Promise<InviteResult> {
  const actor = c.get("actor");
  const key = requireIdempotencyKey(c);
  const prepared = await actorTx(c, async (tx) => {
    const target = await tx.maybeOne<{ role: Role; active: boolean; email: string; display_name: string }>(sql`
      SELECT m.role, m.active, u.email, u.display_name FROM app.memberships m JOIN app.users u ON u.id = m.id
      WHERE m.org_id = ${actor.orgId} AND m.id = ${userId}`);
    if (!target) fail("NOT_FOUND");
    let job = await tx.maybeOne<InvitationJob>(sql`
      SELECT ${JOB_COLUMNS} FROM app.invitation_jobs WHERE org_id = ${actor.orgId} AND auth_user_id = ${userId}
      ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`);
    if (job && job.resend_key === key) return { target, job, replay: true };
    if (!target.active) fail("INVALID_STATE", { message_ja: "停止中のアカウントには招待を送信できません。先にアカウントを再開してください。" });
    if (!job) {
      // Accounts created before invitation tracking (e.g. data migration) get a job at the "profile exists" step.
      job = await tx.one<InvitationJob>(sql`
        INSERT INTO app.invitation_jobs(org_id, email, role, profile_payload, state, auth_user_id, profile_created_at, created_by, resend_key, locked_until)
        VALUES (${actor.orgId}, ${target.email}, ${target.role}, '{}'::jsonb, 'profile_created', ${userId}, now(), ${actor.userId}, ${key},
          now() + make_interval(secs => ${LEASE_SECONDS}))
        RETURNING ${JOB_COLUMNS}`);
      return { target, job: { ...job, leased: true }, replay: false };
    }
    if (job.state === "pending" || job.state === "auth_created") fail("INVALID_STATE");
    const leased = await tx.maybeOne<InvitationJob>(sql`
      UPDATE app.invitation_jobs SET resend_key = ${key}, locked_until = now() + make_interval(secs => ${LEASE_SECONDS}), updated_at = now()
      WHERE id = ${job.id} AND (locked_until IS NULL OR locked_until <= now()) RETURNING ${JOB_COLUMNS}`);
    if (!leased) fail("IDEMPOTENCY_IN_PROGRESS");
    return { target, job: { ...leased, leased: true }, replay: false };
  });
  if (prepared.replay) return inviteResult(prepared.job, prepared.target.active);
  const sent = await sendInvitation(c, prepared.job, { display_name: prepared.target.display_name, role: prepared.target.role });
  return inviteResult(sent, true);
}
