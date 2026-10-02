import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, createTestContext, type Caller, type TestContext } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { bookingWorld, createSlotViaApi, reserve, slotBody, type BookingWorld } from "../helpers/booking-fixtures";
import type { RealtimeProvider, RealtimeSessionRequest } from "../../src/integrations/realtime";
import { ApiError } from "../../src/http/errors";
import { zonedDateString } from "@arms/contracts";

/** Test double of the OpenAI client-secret endpoint (same interface as the production provider). */
class FakeRealtime implements RealtimeProvider {
  readonly model = "gpt-realtime-2.1";
  readonly voice = "marin";
  readonly requests: RealtimeSessionRequest[] = [];
  fail = false;
  async createClientSecret(input: RealtimeSessionRequest) {
    if (this.fail) throw new ApiError("VOICE_UNAVAILABLE");
    this.requests.push(input);
    return { value: `ek_test_${crypto.randomUUID()}`, expiresAt: new Date(Date.now() + 600_000), providerSessionId: `sess_${this.requests.length}` };
  }
}

let ctx: TestContext;
let w: BookingWorld;
let realtime: FakeRealtime;

beforeAll(async () => {
  realtime = new FakeRealtime();
  ctx = createTestContext({ realtime });
  w = await bookingWorld(ctx);
});
afterAll(async () => ctx.close());
beforeEach(() => {
  realtime.fail = false;
});

async function startSession(caller: Caller) {
  const res = await call(ctx, caller, "POST", "/voice/sessions");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { session_id: string; client_secret: string; tools: string[] };
}

async function tool(caller: Caller, sessionId: string, toolName: string, args: Record<string, unknown>, callId = crypto.randomUUID()) {
  const res = await call(ctx, caller, "POST", "/voice/tool-calls", { body: { session_id: sessionId, call_id: callId, tool_name: toolName, arguments: args } });
  return res;
}

async function activeReservations(studentId: string, slotId: string): Promise<number> {
  const { rows } = await ctx.admin.query("SELECT count(*)::int AS n FROM app.reservations WHERE student_id = $1 AND slot_id = $2 AND status IN ('pending','approved')", [studentId, slotId]);
  return rows[0].n;
}

describe("voice sessions", () => {
  it("mints a client secret with role-specific tools and Japanese instructions; the permanent key never leaves", async () => {
    const res = await call(ctx, w.student, "POST", "/voice/sessions");
    expect(res.status).toBe(200);
    expectContract(res, "post", "/voice/sessions");
    expect(res.body.client_secret).toMatch(/^ek_test_/);
    expect(res.body.tools).toContain("commit_reservation");
    const req = realtime.requests.at(-1)!;
    expect(req.instructions).toContain("日本語");
    expect(req.instructions).toContain("現在の日本時間");
    expect((req.tools as { name: string }[]).map((t) => t.name)).toContain("prepare_reservation");
    expect(req.safetyIdentifier).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(res.body)).not.toContain("OPENAI_API_KEY");
    // The client secret is not persisted anywhere.
    const { rows } = await ctx.admin.query("SELECT * FROM app.voice_sessions WHERE id = $1", [res.body.session_id]);
    expect(JSON.stringify(rows[0])).not.toContain(res.body.client_secret);
  });

  it("gives teachers read-only tools", async () => {
    const s = await startSession(w.teacher);
    expect(s.tools).toEqual(["today_lessons", "get_progress", "get_reservations"]);
    const req = realtime.requests.at(-1)!;
    const names = (req.tools as { name: string }[]).map((t) => t.name);
    expect(names).not.toContain("commit_reservation");
    expect(req.instructions).toContain("承認・却下・削除");
  });

  it("refuses administrators and unauthenticated callers", async () => {
    expect((await call(ctx, w.admin, "POST", "/voice/sessions")).status).toBe(403);
    expect((await call(ctx, null, "POST", "/voice/sessions")).status).toBe(401);
  });

  it("falls back with the Japanese message when the provider fails, releasing the reservation", async () => {
    realtime.fail = true;
    const res = await call(ctx, w.student2, "POST", "/voice/sessions");
    expect(res.status).toBe(503);
    expect(res.body.message_ja).toBe("現在、音声機能を利用できません。画面から操作してください。");
    const quota = await call(ctx, w.student2, "GET", "/voice/quota");
    expectContract(quota, "get", "/voice/quota");
    expect(quota.body.data.used_seconds).toBe(0);
  });

  it("enforces the daily quota, counting open sessions at their full reservation", async () => {
    const world = await bookingWorld(ctx, { voice_daily_quota_seconds: 120, voice_max_session_seconds: 60 });
    const first = await startSession(world.student);
    let quota = await call(ctx, world.student, "GET", "/voice/quota");
    expect(quota.body.data).toMatchObject({ daily_quota_seconds: 120, max_session_seconds: 60, used_seconds: 60, remaining_seconds: 60 });
    // A new session ends the previous one (settled at elapsed time) and reserves again.
    await startSession(world.student);
    const { rows } = await ctx.admin.query("SELECT ended_at, consumed_seconds, end_reason FROM app.voice_sessions WHERE id = $1", [first.session_id]);
    expect(rows[0].end_reason).toBe("replaced");
    expect(rows[0].consumed_seconds).toBeLessThanOrEqual(1);
    quota = await call(ctx, world.student, "GET", "/voice/quota");
    expect(quota.body.data.used_seconds).toBeLessThanOrEqual(61);
    // Exhaust: mark today's sessions as fully consumed.
    await ctx.admin.query("UPDATE app.voice_sessions SET ended_at = now(), consumed_seconds = 60 WHERE user_id = $1", [world.org.student.userId]);
    const denied = await call(ctx, world.student, "POST", "/voice/sessions");
    expect(denied.status).toBe(429);
    expect(denied.body.code).toBe("VOICE_QUOTA_EXCEEDED");
  });

  it("ends a session idempotently and only for its owner", async () => {
    const s = await startSession(w.student2);
    expect((await call(ctx, w.student, "POST", `/voice/sessions/${s.session_id}/end`)).status).toBe(404);
    const end1 = await call(ctx, w.student2, "POST", `/voice/sessions/${s.session_id}/end`);
    expect(end1.status).toBe(200);
    expectContract(end1, "post", "/voice/sessions/{id}/end");
    const end2 = await call(ctx, w.student2, "POST", `/voice/sessions/${s.session_id}/end`);
    expect(end2.body.data).toEqual(end1.body.data);
    const late = await tool(w.student2, s.session_id, "today_lessons", {});
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("VOICE_SESSION_ENDED");
  });
});

describe("voice booking: search → prepare → explicit confirmation → commit (acceptance 8)", () => {
  it("creates nothing before confirmation, exactly one pending reservation after, and replays safely", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { title: "IT基礎", daysAhead: 6 }));
    const s = await startSession(w.student);
    const date = zonedDateString(slot.starts_at, "Asia/Tokyo");

    const search = await tool(w.student, s.session_id, "search_slots", { date, time_band: "any" });
    expect(search.status).toBe(200);
    expectContract(search, "post", "/voice/tool-calls");
    expect(search.body.success).toBe(true);
    expect(search.body.data.slots.map((x: { slot_id: string }) => x.slot_id)).toContain(slot.id);

    const prepare = await tool(w.student, s.session_id, "prepare_reservation", { slot_id: slot.id });
    expect(prepare.body.success).toBe(true);
    expect(prepare.body.data.confirmation_ja).toMatch(/田中講師のIT基礎を予約申請します。申請してよろしいですか？$/);
    expect(prepare.body.data.action_token.length).toBeGreaterThanOrEqual(43);
    expect(await activeReservations(w.org.student.userId, slot.id)).toBe(0);
    // Only the hash of the token is stored.
    const stored = await ctx.admin.query("SELECT token_hash FROM app.voice_actions WHERE session_id = $1", [s.session_id]);
    expect(JSON.stringify(stored.rows)).not.toContain(prepare.body.data.action_token);

    const commitCall = crypto.randomUUID();
    const commit = await tool(w.student, s.session_id, "commit_reservation", { action_token: prepare.body.data.action_token }, commitCall);
    expect(commit.body.success).toBe(true);
    expect(commit.body.data.reservation.status).toBe("pending");
    expect(commit.body.data.message_ja).toBe("予約を申請しました。現在は承認待ちです。");
    expect(await activeReservations(w.org.student.userId, slot.id)).toBe(1);

    // Same call_id → recorded result; same token in a new call → recorded reservation, still one row.
    const replayCall = await tool(w.student, s.session_id, "commit_reservation", { action_token: prepare.body.data.action_token }, commitCall);
    expect(replayCall.body.data).toEqual(commit.body.data);
    const replayToken = await tool(w.student, s.session_id, "commit_reservation", { action_token: prepare.body.data.action_token });
    expect(replayToken.body.data.reservation.reservation_id).toBe(commit.body.data.reservation.reservation_id);
    expect(await activeReservations(w.org.student.userId, slot.id)).toBe(1);

    // The same reservation is visible through the normal API (Web/iOS see the same DB state).
    const viaApi = await call(ctx, w.student, "GET", `/reservations/${commit.body.data.reservation.reservation_id}`);
    expect(viaApi.body.status).toBe("pending");
    const status = await tool(w.student, s.session_id, "get_reservations", { reservation_id: viaApi.body.id });
    expect(status.body.data.reservation.status_ja).toBe("承認待ち");
  });

  it("rejects fabricated, expired, other-user and other-session tokens", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { daysAhead: 7 }));
    const s = await startSession(w.student2);
    const fabricated = await tool(w.student2, s.session_id, "commit_reservation", { action_token: "x".repeat(43) });
    expect(fabricated.body).toMatchObject({ success: false, data: { error_code: "ACTION_TOKEN_INVALID" } });

    const prepare = await tool(w.student2, s.session_id, "prepare_reservation", { slot_id: slot.id });
    const token = prepare.body.data.action_token as string;

    const other = await startSession(w.student);
    const otherUser = await tool(w.student, other.session_id, "commit_reservation", { action_token: token });
    expect(otherUser.body.data.error_code).toBe("ACTION_TOKEN_INVALID");

    // Reconnect: a new session for the same user cannot use the old session's token.
    const s2 = await startSession(w.student2);
    const otherSession = await tool(w.student2, s2.session_id, "commit_reservation", { action_token: token });
    expect(otherSession.body.data.error_code).toBe("ACTION_TOKEN_INVALID");

    const prepare2 = await tool(w.student2, s2.session_id, "prepare_reservation", { slot_id: slot.id });
    await ctx.admin.query("UPDATE app.voice_actions SET expires_at = now() - interval '1 second' WHERE session_id = $1", [s2.session_id]);
    const expired = await tool(w.student2, s2.session_id, "commit_reservation", { action_token: prepare2.body.data.action_token });
    expect(expired.body.data.error_code).toBe("ACTION_TOKEN_INVALID");
    expect(await activeReservations(w.org.student2.userId, slot.id)).toBe(0);
  });

  it("re-checks availability at commit time (seat taken after prepare → SLOT_FULL, token unused)", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { capacity: 1, daysAhead: 8 }));
    const s = await startSession(w.student);
    const prepare = await tool(w.student, s.session_id, "prepare_reservation", { slot_id: slot.id });
    await reserve(ctx, w.student2, slot.id);
    const commit = await tool(w.student, s.session_id, "commit_reservation", { action_token: prepare.body.data.action_token });
    expect(commit.body).toMatchObject({ success: false, data: { error_code: "SLOT_FULL", message_ja: "この授業は満席です。" } });
    const { rows } = await ctx.admin.query("SELECT consumed_at FROM app.voice_actions WHERE session_id = $1", [s.session_id]);
    expect(rows.every((r) => r.consumed_at === null)).toBe(true);
  });

  it("cancels through prepare/commit with the same rules as the app", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { daysAhead: 9 }));
    const r = await reserve(ctx, w.student, slot.id);
    const s = await startSession(w.student);
    const prepare = await tool(w.student, s.session_id, "prepare_cancellation", { reservation_id: r.id });
    expect(prepare.body.data.confirmation_ja).toMatch(/予約を取り消します。よろしいですか？$/);
    expect(await activeReservations(w.org.student.userId, slot.id)).toBe(1);
    const commit = await tool(w.student, s.session_id, "commit_cancellation", { action_token: prepare.body.data.action_token });
    expect(commit.body.success).toBe(true);
    expect(commit.body.data.reservation.status).toBe("cancelled");
    expect(await activeReservations(w.org.student.userId, slot.id)).toBe(0);
  });
});

describe("voice tool permissions and validation", () => {
  it("refuses write tools for teachers and unknown tools, and validates arguments server-side", async () => {
    const s = await startSession(w.teacher);
    const write = await tool(w.teacher, s.session_id, "prepare_reservation", { slot_id: crypto.randomUUID() });
    expect(write.body).toMatchObject({ success: false, data: { error_code: "TOOL_NOT_ALLOWED" } });
    const unknown = await tool(w.teacher, s.session_id, "approve_reservation", { reservation_id: crypto.randomUUID() });
    expect(unknown.body.data.error_code).toBe("TOOL_NOT_ALLOWED");
    const st = await startSession(w.student);
    const bad = await tool(w.student, st.session_id, "search_slots", { date: "来週月曜", time_band: "afternoon" });
    expect(bad.body.data.error_code).toBe("INVALID_ARGUMENTS");
    const injected = await tool(w.student, st.session_id, "today_lessons", { org_id: w.org.orgId });
    expect(injected.body.data.error_code).toBe("INVALID_ARGUMENTS");
  });

  it("never lets one user drive another user's session", async () => {
    const s = await startSession(w.student);
    const res = await tool(w.student2, s.session_id, "today_lessons", {});
    expect(res.status).toBe(404);
  });

  it("rejects a reused call_id with different content", async () => {
    const s = await startSession(w.student);
    const id = crypto.randomUUID();
    await tool(w.student, s.session_id, "today_lessons", {}, id);
    const res = await tool(w.student, s.session_id, "get_reservations", {}, id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("scopes data: a student's search sees only their classroom's slots", async () => {
    const mine = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { daysAhead: 10, title: "自クラス" }));
    const theirs = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { classroomId: w.org.otherClassroomId, teacherId: w.org.otherTeacher.userId, startsAt: new Date(mine.starts_at), title: "他クラス" }));
    const s = await startSession(w.student);
    const res = await tool(w.student, s.session_id, "search_slots", { date: zonedDateString(mine.starts_at, "Asia/Tokyo"), time_band: "any" });
    const ids = res.body.data.slots.map((x: { slot_id: string }) => x.slot_id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    const prep = await tool(w.student, s.session_id, "prepare_reservation", { slot_id: theirs.id });
    expect(prep.body.data.error_code).toBe("NOT_FOUND");
  });

  it("audits tool calls without transcripts or free text", async () => {
    const s = await startSession(w.student);
    await tool(w.student, s.session_id, "today_lessons", {});
    const { rows } = await ctx.admin.query("SELECT payload FROM app.audit_events WHERE entity_id = $1 AND event_type = 'voice.tool_call'", [s.session_id]);
    expect(rows.length).toBe(1);
    expect(Object.keys(rows[0].payload).sort()).toEqual(["call_id", "error_code", "request_id", "success", "target_id", "tool"]);
  });
});

describe("voice progress uses the shared progress service", () => {
  it("returns the same percentage as GET /students/{id}/progress and enforces teacher scope", async () => {
    const s = await startSession(w.student);
    const voice = await tool(w.student, s.session_id, "get_progress", {});
    expect(voice.body.success).toBe(true);
    const rest = await call(ctx, w.student, "GET", `/students/${w.org.student.userId}/progress`);
    expect(voice.body.data.progress_percent).toBe(rest.body.progress_percent);
    if (rest.body.progress_percent === null) expect(voice.body.data.progress_ja).toMatch(/^未設定/);

    const other = await tool(w.student, s.session_id, "get_progress", { student_id: w.org.student2.userId });
    expect(other.body.data.error_code).toBe("FORBIDDEN");

    const t = await startSession(w.teacher);
    const needsId = await tool(w.teacher, t.session_id, "get_progress", {});
    expect(needsId.body.data.error_code).toBe("STUDENT_REQUIRED");
    const mine = await tool(w.teacher, t.session_id, "get_progress", { student_id: w.org.student.userId });
    expect(mine.body.success).toBe(true);
    expect(mine.body.data.student_name).toBe("和田 一夫");
    const outOfScope = await tool(w.teacher, t.session_id, "get_progress", { student_id: w.org.otherStudent.userId });
    expect(outOfScope.body.data.error_code).toBe("NOT_FOUND");
  });
});
