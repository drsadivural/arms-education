import { Hono } from "hono";
import { VoiceToolInput, zonedDayRange, zonedDateString } from "@arms/contracts";
import type { AppContext, AppEnv } from "../context";
import { actorTx } from "../context";
import { requireRole } from "../auth/middleware";
import { sha256Hex } from "../auth/crypto";
import { json } from "../db/client";
import { sql } from "../db/sql";
import type { Tx } from "../db/client";
import { ApiError, fail } from "../http/errors";
import { pathId, readBody, zodFieldErrors } from "../http/validation";
import { action, ok } from "../http/respond";
import { rateLimit } from "../http/rate-limit";
import { requireIdempotencyKey } from "../http/idempotency";
import { enqueueAfterCommit } from "../domain/notifications/outbox";
import { buildInstructions } from "../domain/voice/instructions";
import { ROLE_TOOLS, TOOL_ARGUMENTS, isToolName, toolDefinitionsFor } from "../domain/voice/tools";
import { executeTool } from "../domain/voice/executor";

/** OpenAI Realtime voice sessions and server-enforced tool calls (IOS-13/14, docs/05). Teachers and students only. */
export const voiceRoutes = new Hono<AppEnv>();

const MIN_SESSION_SECONDS = 30;
/** Tool calls are accepted briefly after the client-secret expiry so an in-flight answer can complete. */
const TOOL_GRACE_SECONDS = 60;

interface QuotaInfo {
  daily_quota_seconds: number;
  max_session_seconds: number;
  used_seconds: number;
  remaining_seconds: number;
}

/**
 * Today's (organisation timezone) usage. Open sessions count their full reservation until they end, and sessions
 * that expired without an end call are charged the full reservation — usage is never under-counted (docs/05).
 */
async function quotaFor(tx: Tx, c: AppContext): Promise<QuotaInfo> {
  const actor = c.get("actor");
  const deps = c.get("deps");
  const settings = await tx.one<{ settings: Record<string, unknown> }>(sql`SELECT settings FROM app.organizations WHERE id = ${actor.orgId}`);
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  const daily = num(settings.settings.voice_daily_quota_seconds, deps.config.voice.dailyQuotaSeconds);
  const maxSession = Math.max(60, num(settings.settings.voice_max_session_seconds, deps.config.voice.maxSessionSeconds));
  const day = zonedDayRange(zonedDateString(deps.now(), actor.timezone), actor.timezone);
  const used = await tx.one<{ used: number }>(sql`
    SELECT coalesce(sum(CASE WHEN ended_at IS NOT NULL THEN coalesce(consumed_seconds, reserved_seconds) ELSE reserved_seconds END), 0)::int AS used
    FROM app.voice_sessions
    WHERE org_id = ${actor.orgId} AND user_id = ${actor.userId} AND created_at >= ${day.start} AND created_at < ${day.end}`);
  return { daily_quota_seconds: daily, max_session_seconds: maxSession, used_seconds: used.used, remaining_seconds: Math.max(0, daily - used.used) };
}

/** Ends the caller's open sessions (a new session replaces them; quota is settled at the elapsed time). */
async function closeOpenSessions(tx: Tx, orgId: string, userId: string, reason: "replaced" | "client"): Promise<void> {
  await tx.exec(sql`
    UPDATE app.voice_sessions
    SET ended_at = least(now(), expires_at),
        consumed_seconds = least(reserved_seconds, greatest(0, ceil(extract(epoch FROM least(now(), expires_at) - created_at))::int)),
        end_reason = ${reason}
    WHERE org_id = ${orgId} AND user_id = ${userId} AND ended_at IS NULL`);
}

voiceRoutes.get("/voice/quota", requireRole("teacher", "student"), async (c) => {
  const quota = await actorTx(c, (tx) => quotaFor(tx, c));
  return ok(c, quota);
});

/**
 * POST /voice/sessions — mints a short-lived OpenAI client secret for this user's role and tools.
 * The client secret is returned once and never stored (so the response is not kept in the idempotency store:
 * a repeated request creates a fresh session and ends the previous one).
 */
voiceRoutes.post("/voice/sessions", requireRole("teacher", "student"), async (c) => {
  requireIdempotencyKey(c);
  const actor = c.get("actor");
  const deps = c.get("deps");
  await rateLimit(c, "api", `voice-session:${actor.userId}`);
  const provider = deps.integrations.realtime;
  if (!provider) fail("VOICE_UNAVAILABLE");
  const role = actor.role as "teacher" | "student";

  const reserved = await actorTx(c, async (tx) => {
    // Serialise session creation per user so two parallel requests cannot both pass the quota check.
    await tx.query(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`voice:${actor.orgId}:${actor.userId}`}, 0))`);
    await closeOpenSessions(tx, actor.orgId, actor.userId, "replaced");
    const quota = await quotaFor(tx, c);
    if (quota.remaining_seconds < MIN_SESSION_SECONDS) fail("VOICE_QUOTA_EXCEEDED", { details: { ...quota } });
    const seconds = Math.min(quota.max_session_seconds, quota.remaining_seconds);
    const session = await tx.one<{ id: string; created_at: Date }>(sql`
      INSERT INTO app.voice_sessions(org_id, user_id, role, model, expires_at, reserved_seconds)
      VALUES (${actor.orgId}, ${actor.userId}, ${role}, ${provider.model}, now() + make_interval(secs => ${seconds}), ${seconds})
      RETURNING id, created_at`);
    await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
      VALUES (${actor.orgId}, ${actor.userId}, 'voice.session_started', ${session.id}, ${json({ reserved_seconds: seconds, model: provider.model, request_id: c.get("requestId") })}::jsonb)`);
    return { id: session.id, seconds, quota };
  });

  let secret;
  try {
    secret = await provider.createClientSecret({
      instructions: buildInstructions(actor, deps.now()),
      tools: toolDefinitionsFor(role),
      expiresAfterSeconds: Math.min(reserved.seconds, 600),
      safetyIdentifier: await sha256Hex(`arms:${actor.orgId}:${actor.userId}`),
    });
  } catch (e) {
    // Release the reservation: the provider never issued a session.
    await actorTx(c, (tx) =>
      tx.exec(sql`UPDATE app.voice_sessions SET ended_at = now(), consumed_seconds = 0, end_reason = 'provider_error'
        WHERE org_id = ${actor.orgId} AND id = ${reserved.id} AND ended_at IS NULL`),
    );
    throw e instanceof ApiError ? e : new ApiError("VOICE_UNAVAILABLE", { cause: e });
  }
  await actorTx(c, (tx) => tx.exec(sql`UPDATE app.voice_sessions SET provider_session_id = ${secret.providerSessionId} WHERE org_id = ${actor.orgId} AND id = ${reserved.id}`));
  const sessionExpires = new Date(deps.now().getTime() + reserved.seconds * 1000);
  return c.json({
    session_id: reserved.id,
    client_secret: secret.value,
    expires_at: sessionExpires.toISOString(),
    client_secret_expires_at: secret.expiresAt.toISOString(),
    model: provider.model,
    voice: provider.voice,
    max_seconds: reserved.seconds,
    tools: ROLE_TOOLS[role],
    quota_remaining_seconds: Math.max(0, reserved.quota.remaining_seconds - reserved.seconds),
  });
});

/** POST /voice/sessions/{id}/end — settles quota at the elapsed time (idempotent). */
voiceRoutes.post("/voice/sessions/:id/end", requireRole("teacher", "student"), async (c) => {
  const id = pathId(c);
  const actor = c.get("actor");
  const result = await actorTx(c, async (tx) => {
    const s = await tx.maybeOne<{ id: string; ended_at: Date | null }>(sql`
      SELECT id, ended_at FROM app.voice_sessions WHERE org_id = ${actor.orgId} AND id = ${id} AND user_id = ${actor.userId} FOR UPDATE`);
    if (!s) fail("NOT_FOUND");
    if (!s.ended_at) {
      await tx.exec(sql`
        UPDATE app.voice_sessions
        SET ended_at = least(now(), expires_at),
            consumed_seconds = least(reserved_seconds, greatest(0, ceil(extract(epoch FROM least(now(), expires_at) - created_at))::int)),
            end_reason = CASE WHEN now() >= expires_at THEN 'expired' ELSE 'client' END
        WHERE org_id = ${actor.orgId} AND id = ${id}`);
      await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
        VALUES (${actor.orgId}, ${actor.userId}, 'voice.session_ended', ${id}, ${json({ request_id: c.get("requestId") })}::jsonb)`);
    }
    return tx.one<{ consumed_seconds: number }>(sql`SELECT consumed_seconds FROM app.voice_sessions WHERE org_id = ${actor.orgId} AND id = ${id}`);
  });
  return action(c, { session_id: id, consumed_seconds: result.consumed_seconds });
});

/**
 * POST /voice/tool-calls — the client forwards a completed function call; the server re-validates everything:
 * session ownership and liveness, the role's tool allowlist, the JSON arguments, call_id idempotency, and then runs
 * the same domain services as the REST API. Business failures return success:false with message_ja for the model.
 */
voiceRoutes.post("/voice/tool-calls", requireRole("teacher", "student"), async (c) => {
  requireIdempotencyKey(c);
  const actor = c.get("actor");
  const deps = c.get("deps");
  const input = await readBody(c, VoiceToolInput);
  await rateLimit(c, "api", `voice-tool:${actor.userId}`);

  const session = await actorTx(c, (tx) =>
    tx.maybeOne<{ id: string; ended_at: Date | null; expires_at: Date }>(sql`
      SELECT id, ended_at, expires_at FROM app.voice_sessions WHERE org_id = ${actor.orgId} AND id = ${input.session_id} AND user_id = ${actor.userId}`),
  );
  if (!session) fail("NOT_FOUND");
  if (session.ended_at || new Date(session.expires_at).getTime() + TOOL_GRACE_SECONDS * 1000 < deps.now().getTime()) fail("VOICE_SESSION_ENDED");

  const requestHash = await sha256Hex(JSON.stringify({ tool: input.tool_name, args: input.arguments }));
  const previous = await actorTx(c, (tx) =>
    tx.maybeOne<{ request_hash: string; result: { success: boolean; data: Record<string, unknown> } }>(sql`
      SELECT request_hash, result FROM app.voice_tool_executions WHERE org_id = ${actor.orgId} AND session_id = ${session.id} AND call_id = ${input.call_id}`),
  );
  if (previous) {
    if (previous.request_hash !== requestHash) fail("IDEMPOTENCY_CONFLICT");
    return c.json({ success: previous.result.success, checked_at: deps.now().toISOString(), data: previous.result.data });
  }

  const role = actor.role as "teacher" | "student";
  let outcome: { success: boolean; data: Record<string, unknown> };
  if (!isToolName(input.tool_name) || !ROLE_TOOLS[role].includes(input.tool_name)) {
    outcome = { success: false, data: { error_code: "TOOL_NOT_ALLOWED", message_ja: "その操作は音声では行えません。画面から操作してください。" } };
  } else {
    const parsed = TOOL_ARGUMENTS[input.tool_name].safeParse(input.arguments);
    if (!parsed.success) {
      outcome = { success: false, data: { error_code: "INVALID_ARGUMENTS", message_ja: "指定内容を確認できませんでした。もう一度言い直してください。", field_errors: zodFieldErrors(parsed.error) } };
    } else {
      outcome = await executeTool(
        { b: { db: c.get("db"), deps, actor, afterCommit: (ids) => enqueueAfterCommit(c, deps, actor.orgId, ids) }, sessionId: session.id },
        input.tool_name,
        parsed.data as Record<string, unknown>,
      );
    }
  }

  // Record the result for call_id idempotency, plus a minimal audit entry (tool, outcome, target, request id — no
  // transcript or free text).
  const stored = await actorTx(c, async (tx) => {
    const inserted = await tx.maybeOne<{ call_id: string }>(sql`
      INSERT INTO app.voice_tool_executions(org_id, session_id, call_id, request_hash, result, tool_name)
      VALUES (${actor.orgId}, ${session.id}, ${input.call_id}, ${requestHash}, ${json(outcome)}::jsonb, ${input.tool_name})
      ON CONFLICT DO NOTHING RETURNING call_id`);
    if (!inserted) {
      // A concurrent duplicate of the same call won the race: answer with its recorded result.
      return tx.one<{ result: typeof outcome }>(sql`SELECT result FROM app.voice_tool_executions WHERE org_id = ${actor.orgId} AND session_id = ${session.id} AND call_id = ${input.call_id}`)
        .then((r) => r.result);
    }
    const target = (outcome.data.reservation as { reservation_id?: string } | undefined)?.reservation_id ?? (input.arguments.slot_id as string | undefined) ?? (input.arguments.reservation_id as string | undefined) ?? null;
    await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
      VALUES (${actor.orgId}, ${actor.userId}, 'voice.tool_call', ${session.id},
        ${json({ tool: input.tool_name, success: outcome.success, error_code: outcome.success ? null : outcome.data.error_code, target_id: target, call_id: input.call_id, request_id: c.get("requestId") })}::jsonb)`);
    return outcome;
  });
  return c.json({ success: stored.success, checked_at: deps.now().toISOString(), data: stored.data });
});
