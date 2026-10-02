import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerCaller, call, cookieCaller, createTestContext, type Caller, type TestContext } from "../helpers/app";
import { createTeacher, seedOrg, type OrgScenario } from "../helpers/fixtures";
import { expectContract } from "../helpers/contract";
import { createSlot, futureDate } from "../helpers/admin-fixtures";

let ctx: TestContext;
let org: OrgScenario;
let other: OrgScenario;
let admin: Caller;
let teacher: Caller;
let student: Caller;

const teacherBody = (n: string, extra: Record<string, unknown> = {}) => ({
  display_name: `新任 講師${n}`,
  kana: "しんにん こうし",
  email: `new-teacher-${n}-${Date.now()}@example.invalid`,
  teacher_number: `NT-${n}-${Date.now()}`,
  department_name: "開発部",
  specialties: ["IT基礎", "セキュリティ"],
  availability: { weekdays: [1, 3, 5], start_time: "09:00", end_time: "17:00" },
  active: true,
  ...extra,
});

beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  other = await seedOrg(ctx.admin);
  admin = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" });
  teacher = await bearerCaller(org.teacher.userId, org.orgId);
  student = await bearerCaller(org.student.userId, org.orgId);
});
afterAll(async () => ctx.close());

describe("GET /teachers", () => {
  it("lists teachers with classroom ids and student counts computed in SQL", async () => {
    const res = await call(ctx, admin, "GET", "/teachers");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/teachers");
    const t = res.body.items.find((x: any) => x.id === org.teacher.userId);
    expect(t.classroom_ids).toEqual([org.classroomId]);
    expect(t.classrooms[0]).toMatchObject({ id: org.classroomId, is_primary: true });
    expect(t.student_count).toBe(2);
    expect(t.active).toBe(true);
    expect(t.invitation_state).toBeNull();
    // Other organisations are never visible.
    expect(res.body.items.some((x: any) => x.id === other.teacher.userId)).toBe(false);
  });

  it("filters by q, department, status and classroom and paginates with a cursor", async () => {
    const byName = await call(ctx, admin, "GET", `/teachers?q=${encodeURIComponent("別府")}`);
    expect(byName.body.items.map((x: any) => x.id)).toEqual([org.otherTeacher.userId]);
    const byDept = await call(ctx, admin, "GET", `/teachers?department=${encodeURIComponent("営業部")}`);
    expect(byDept.body.items.map((x: any) => x.id)).toEqual([org.otherTeacher.userId]);
    const byClass = await call(ctx, admin, "GET", `/teachers?classroom_id=${org.classroomId}`);
    expect(byClass.body.items.map((x: any) => x.id)).toEqual([org.teacher.userId]);
    const inactive = await call(ctx, admin, "GET", "/teachers?status=inactive");
    expect(inactive.body.items).toEqual([]);
    const wildcard = await call(ctx, admin, "GET", `/teachers?q=${encodeURIComponent("%")}`);
    expect(wildcard.body.items).toEqual([]);

    const first = await call(ctx, admin, "GET", "/teachers?limit=1");
    expect(first.body.items).toHaveLength(1);
    expect(first.body.next_cursor).toBeTruthy();
    const second = await call(ctx, admin, "GET", `/teachers?limit=1&cursor=${first.body.next_cursor}`);
    expectContract(second, "get", "/teachers");
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);
  });

  it("lets teachers read (read-only) and rejects students and anonymous callers", async () => {
    const asTeacher = await call(ctx, teacher, "GET", "/teachers");
    expect(asTeacher.status).toBe(200);
    expect((await call(ctx, student, "GET", "/teachers")).status).toBe(403);
    const anon = await call(ctx, null, "GET", "/teachers");
    expect(anon.status).toBe(401);
    expectContract(anon, "get", "/teachers");
  });

  it("validates query parameters with Japanese messages", async () => {
    const res = await call(ctx, admin, "GET", "/teachers?status=retired&limit=500");
    expect(res.status).toBe(422);
    expect(res.body.field_errors.status).toBe("選択肢から選んでください。");
    expectContract(res, "get", "/teachers");
  });
});

describe("GET /teachers/{id}", () => {
  it("returns the teacher with an ETag; other organisations and malformed ids are 404", async () => {
    const res = await call(ctx, teacher, "GET", `/teachers/${org.otherTeacher.userId}`);
    expect(res.status).toBe(200);
    expectContract(res, "get", "/teachers/{id}");
    expect(res.headers.get("etag")).toBe(`"${res.body.data.row_version}"`);
    expect((await call(ctx, admin, "GET", `/teachers/${other.teacher.userId}`)).status).toBe(404);
    expect((await call(ctx, admin, "GET", "/teachers/not-a-uuid")).status).toBe(404);
    expect((await call(ctx, admin, "GET", `/teachers/${org.student.userId}`)).status).toBe(404);
  });
});

describe("POST /teachers (invitation saga)", () => {
  it("creates the auth user, profile and sends the invitation", async () => {
    const body = teacherBody("a");
    const res = await call(ctx, admin, "POST", "/teachers", { body });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/teachers");
    expect(res.body.data).toMatchObject({ display_name: body.display_name, email: body.email, teacher_number: body.teacher_number, active: true, invitation_state: "sent" });
    expect(res.body.data.availability).toEqual(body.availability);
    expect(res.body.invitation).toMatchObject({ state: "sent", user_id: res.body.data.id });
    expect(res.body.invitation.message_ja).toContain("送信しました");
    expect(ctx.auth.invitesSent.some((i) => i.email === body.email)).toBe(true);
    const { rows } = await ctx.admin.query("SELECT state, attempts, auth_user_id FROM app.invitation_jobs WHERE id = $1", [res.body.invitation.id]);
    expect(rows[0]).toMatchObject({ state: "sent", auth_user_id: res.body.data.id });
    const audit = await ctx.admin.query("SELECT event_type FROM app.audit_events WHERE org_id = $1 AND entity_id = $2 ORDER BY created_at", [org.orgId, res.body.data.id]);
    expect(audit.rows.map((r) => r.event_type)).toEqual(["teacher.created", "invitation.sent"]);
  });

  it("replays the same Idempotency-Key without creating a second account or e-mail", async () => {
    const body = teacherBody("b");
    const key = crypto.randomUUID();
    const first = await call(ctx, admin, "POST", "/teachers", { body, idempotencyKey: key });
    expect(first.status).toBe(200);
    const invitesBefore = ctx.auth.invitesSent.length;
    const replay = await call(ctx, admin, "POST", "/teachers", { body, idempotencyKey: key });
    expect(replay.status).toBe(200);
    expectContract(replay, "post", "/teachers");
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.body.invitation.id).toBe(first.body.invitation.id);
    const users = await ctx.admin.query("SELECT count(*)::int AS n FROM app.users WHERE lower(email) = lower($1)", [body.email]);
    expect(users.rows[0].n).toBe(1);
    expect(ctx.auth.invitesSent.length).toBe(invitesBefore);
    const changed = await call(ctx, admin, "POST", "/teachers", { body: { ...body, department_name: "営業部" }, idempotencyKey: key });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("keeps the profile and reports 送信失敗（再送可能） when the invitation e-mail fails; resend succeeds", async () => {
    const body = teacherBody("c");
    ctx.auth.failNextInvite = true;
    const res = await call(ctx, admin, "POST", "/teachers", { body });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/teachers");
    expect(res.body.invitation.state).toBe("failed");
    expect(res.body.invitation.message_ja).toContain("再送");
    expect(res.body.data.invitation_state).toBe("failed");
    const { rows } = await ctx.admin.query("SELECT state, error_code FROM app.invitation_jobs WHERE id = $1", [res.body.invitation.id]);
    expect(rows[0]).toEqual({ state: "failed", error_code: "MAIL_PROVIDER_UNAVAILABLE" });

    const resend = await call(ctx, admin, "POST", `/settings/users/${res.body.data.id}/resend-invite`);
    expect(resend.status).toBe(200);
    expectContract(resend, "post", "/settings/users/{id}/resend-invite");
    expect(resend.body.data.invitation.state).toBe("sent");
  });

  it("resumes after a database outage at the profile step with the same key (no second account)", async () => {
    const body = teacherBody("d");
    const key = crypto.randomUUID();
    await ctx.admin.query("SELECT public.arms_test_arm_fault($1)", [body.email]);
    const down = await call(ctx, admin, "POST", "/teachers", { body, idempotencyKey: key });
    expect(down.status).toBe(503);
    expect(down.body.message_ja).toContain("保存されていません");
    expectContract(down, "post", "/teachers");
    const { rows } = await ctx.admin.query("SELECT state, error_code, locked_until, auth_user_id FROM app.invitation_jobs WHERE org_id = $1 AND lower(email) = lower($2)", [org.orgId, body.email]);
    expect(rows[0]).toMatchObject({ state: "auth_created", error_code: "DB_UNAVAILABLE", locked_until: null });
    const retry = await call(ctx, admin, "POST", "/teachers", { body, idempotencyKey: key });
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(rows[0].auth_user_id);
    expect(retry.body.invitation.state).toBe("sent");
  });

  it("refuses an e-mail that is already registered (case-insensitive) before allocating an account", async () => {
    const existing = await createTeacher(ctx.admin, org.orgId);
    const res = await call(ctx, admin, "POST", "/teachers", { body: { ...teacherBody("x"), email: existing.email.toUpperCase() } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("EMAIL_TAKEN");
    expectContract(res, "post", "/teachers");
  });

  it("adopts an interrupted job for the same e-mail instead of allocating a second account", async () => {
    const body = teacherBody("e");
    // An earlier attempt allocated the user id but stopped before the profile (e.g. a conflict at step 2).
    const userId = crypto.randomUUID();
    await ctx.admin.query(
      `INSERT INTO app.invitation_jobs(org_id, email, role, profile_payload, state, auth_user_id, created_by, idempotency_key, request_hash, error_code)
       VALUES ($1, $2, 'teacher', $3::jsonb, 'auth_created', $4, $5, gen_random_uuid(), 'earlier', 'TEACHER_NUMBER_TAKEN')`,
      [org.orgId, body.email, JSON.stringify({ ...body, teacher_number: "OLD" }), userId, org.admin.userId],
    );
    const res = await call(ctx, admin, "POST", "/teachers", { body });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(userId);
    expect(res.body.data.teacher_number).toBe(body.teacher_number);
    const users = await ctx.admin.query("SELECT id FROM app.users WHERE lower(email) = lower($1)", [body.email]);
    expect(users.rows).toEqual([{ id: userId }]);
    const jobs = await ctx.admin.query("SELECT state FROM app.invitation_jobs WHERE org_id = $1 AND lower(email) = lower($2)", [org.orgId, body.email]);
    expect(jobs.rows).toEqual([{ state: "sent" }]);
  });

  it("refuses a second request for an e-mail whose invitation is being processed", async () => {
    const body = teacherBody("e3");
    await ctx.admin.query(
      `INSERT INTO app.invitation_jobs(org_id, email, role, profile_payload, state, created_by, idempotency_key, request_hash, locked_until)
       VALUES ($1, $2, 'teacher', '{}'::jsonb, 'pending', $3, gen_random_uuid(), 'other', now() + interval '1 minute')`,
      [org.orgId, body.email, org.admin.userId],
    );
    const res = await call(ctx, admin, "POST", "/teachers", { body });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INVITATION_IN_PROGRESS");
    expectContract(res, "post", "/teachers");
  });

  it("registers an inactive teacher without sending the invitation", async () => {
    const res = await call(ctx, admin, "POST", "/teachers", { body: teacherBody("f", { active: false }) });
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);
    expect(res.body.invitation.state).toBe("pending");
    expect(res.body.invitation.message_ja).toContain("無効");
  });

  it("rejects duplicate e-mail and teacher number", async () => {
    const email = await call(ctx, admin, "POST", "/teachers", { body: teacherBody("g", { email: org.teacher.email }) });
    expect(email.status).toBe(409);
    expect(email.body.code).toBe("EMAIL_TAKEN");
    expect(email.body.field_errors.email).toContain("既に登録");
    expectContract(email, "post", "/teachers");
    const existing = await ctx.admin.query("SELECT teacher_number FROM app.teacher_profiles WHERE id = $1", [org.teacher.userId]);
    const number = await call(ctx, admin, "POST", "/teachers", { body: teacherBody("h", { teacher_number: existing.rows[0].teacher_number }) });
    expect(number.status).toBe(409);
    expect(number.body.code).toBe("TEACHER_NUMBER_TAKEN");
  });

  it("validates input with Japanese field errors", async () => {
    const res = await call(ctx, admin, "POST", "/teachers", {
      body: { display_name: "", email: "bad", teacher_number: "", department_name: "開発部", active: "yes", availability: { weekdays: [], start_time: "25:00", end_time: "08:00" } },
    });
    expect(res.status).toBe(422);
    expectContract(res, "post", "/teachers");
    expect(res.body.field_errors.display_name).toBe("必須項目です。");
    expect(res.body.field_errors.email).toContain("メールアドレス");
    expect(res.body.field_errors["availability.weekdays"]).toBeTruthy();
    expect(res.body.field_errors["availability.start_time"]).toContain("HH:MM");
  });

  it("requires admin and an Idempotency-Key", async () => {
    expect((await call(ctx, teacher, "POST", "/teachers", { body: teacherBody("i") })).status).toBe(403);
    expect((await call(ctx, null, "POST", "/teachers", { body: teacherBody("i") })).status).toBe(401);
    const noKey = await call(ctx, admin, "POST", "/teachers", { body: teacherBody("i"), idempotencyKey: false });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

describe("PATCH /teachers/{id}", () => {
  it("updates the profile with If-Match and audits before/after", async () => {
    const t = await createTeacher(ctx.admin, org.orgId, { displayName: "編集 対象" });
    const current = await call(ctx, admin, "GET", `/teachers/${t.userId}`);
    const body = { ...teacherBody("p"), email: t.email, display_name: "編集 済み", department_name: "サポート部" };
    const res = await call(ctx, admin, "PATCH", `/teachers/${t.userId}`, { body, ifMatch: current.body.data.row_version });
    expect(res.status).toBe(200);
    expectContract(res, "patch", "/teachers/{id}");
    expect(res.body.data).toMatchObject({ display_name: "編集 済み", department_name: "サポート部" });
    expect(res.body.data.row_version).toBe(current.body.data.row_version + 1);
    const audit = await ctx.admin.query("SELECT payload FROM app.audit_events WHERE entity_id = $1 AND event_type = 'teacher.updated'", [t.userId]);
    expect(audit.rows[0].payload.changes.department_name).toEqual({ before: "開発部", after: "サポート部" });

    const stale = await call(ctx, admin, "PATCH", `/teachers/${t.userId}`, { body, ifMatch: current.body.data.row_version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    expectContract(stale, "patch", "/teachers/{id}");
    const noIfMatch = await call(ctx, admin, "PATCH", `/teachers/${t.userId}`, { body });
    expect(noIfMatch.status).toBe(400);
    expect(noIfMatch.body.code).toBe("IF_MATCH_REQUIRED");
  });

  it("refuses e-mail changes and duplicate teacher numbers; teachers cannot edit", async () => {
    const t = await createTeacher(ctx.admin, org.orgId);
    const v = (await call(ctx, admin, "GET", `/teachers/${t.userId}`)).body.data.row_version;
    const email = await call(ctx, admin, "PATCH", `/teachers/${t.userId}`, { body: teacherBody("q"), ifMatch: v });
    expect(email.status).toBe(422);
    expect(email.body.field_errors.email).toContain("変更できません");
    const existing = await ctx.admin.query("SELECT teacher_number FROM app.teacher_profiles WHERE id = $1", [org.teacher.userId]);
    const dup = await call(ctx, admin, "PATCH", `/teachers/${t.userId}`, { body: teacherBody("q", { email: t.email, teacher_number: existing.rows[0].teacher_number }), ifMatch: v });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("TEACHER_NUMBER_TAKEN");
    expect((await call(ctx, teacher, "PATCH", `/teachers/${t.userId}`, { body: teacherBody("q", { email: t.email }), ifMatch: v })).status).toBe(403);
    const foreign = await call(ctx, admin, "PATCH", `/teachers/${other.teacher.userId}`, { body: teacherBody("q", { email: other.teacher.email }), ifMatch: 1 });
    expect(foreign.status).toBe(404);
    expectContract(foreign, "patch", "/teachers/{id}");
  });
});

describe("DELETE /teachers/{id} (archive)", () => {
  it("refuses while the teacher is a primary teacher of an open classroom", async () => {
    const v = (await call(ctx, admin, "GET", `/teachers/${org.teacher.userId}`)).body.data.row_version;
    const res = await call(ctx, admin, "DELETE", `/teachers/${org.teacher.userId}`, { ifMatch: v });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TEACHER_IS_PRIMARY");
    expect(res.body.message_ja).toContain("主担当");
    expectContract(res, "delete", "/teachers/{id}");
  });

  it("refuses while the teacher has upcoming lesson slots", async () => {
    const t = await createTeacher(ctx.admin, org.orgId);
    await ctx.admin.query("INSERT INTO app.classroom_teachers(org_id, classroom_id, teacher_id, is_primary) VALUES ($1, $2, $3, false)", [org.orgId, org.otherClassroomId, t.userId]);
    await createSlot(ctx.admin, org.orgId, { classroomId: org.otherClassroomId, teacherId: t.userId, startsAt: futureDate(30) });
    const v = (await call(ctx, admin, "GET", `/teachers/${t.userId}`)).body.data.row_version;
    const res = await call(ctx, admin, "DELETE", `/teachers/${t.userId}`, { ifMatch: v });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TEACHER_HAS_FUTURE_SLOTS");
  });

  it("archives: membership inactive, Web and iOS sessions revoked, audited", async () => {
    const t = await createTeacher(ctx.admin, org.orgId);
    await ctx.auth.register(t.email, "pw", t.userId);
    const web = await cookieCaller(ctx, { userId: t.userId, orgId: org.orgId, role: "teacher" });
    const ios = await bearerCaller(t.userId, org.orgId);
    expect((await call(ctx, web, "GET", "/teachers")).status).toBe(200);
    const v = (await call(ctx, admin, "GET", `/teachers/${t.userId}`)).body.data.row_version;
    const stale = await call(ctx, admin, "DELETE", `/teachers/${t.userId}`, { ifMatch: v + 5 });
    expect(stale.status).toBe(409);
    const res = await call(ctx, admin, "DELETE", `/teachers/${t.userId}`, { ifMatch: v });
    expect(res.status).toBe(200);
    expectContract(res, "delete", "/teachers/{id}");
    expect(res.body.data).toMatchObject({ active: false });
    const after = await call(ctx, web, "GET", "/teachers");
    expect(after.status).toBe(401);
    const sessions = await ctx.admin.query("SELECT count(*)::int AS n FROM app.web_sessions WHERE user_id = $1 AND revoked_at IS NULL", [t.userId]);
    expect(sessions.rows[0].n).toBe(0);
    expect((await call(ctx, ios, "GET", "/me")).status).toBe(401);
    expect(await ctx.auth.openBearerSessions(t.userId)).toBe(0);
    const read = await call(ctx, admin, "GET", `/teachers/${t.userId}`);
    expect(read.body.data.active).toBe(false);
    const audit = await ctx.admin.query("SELECT count(*)::int AS n FROM app.audit_events WHERE entity_id = $1 AND event_type = 'teacher.archived'", [t.userId]);
    expect(audit.rows[0].n).toBe(1);
    expect((await call(ctx, teacher, "DELETE", `/teachers/${t.userId}`, { ifMatch: 1 })).status).toBe(403);
  });
});
