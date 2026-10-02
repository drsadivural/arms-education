import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerCaller, call, cookieCaller, createTestContext, type TestContext } from "./helpers/app";
import { createUser, seedOrg, type OrgScenario } from "./helpers/fixtures";
import { expectContract } from "./helpers/contract";

let ctx: TestContext;
let org: OrgScenario;
beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  await ctx.auth.register(org.teacher.email, "Old-password-1", org.teacher.userId);
  await ctx.auth.register(org.student.email, "Old-password-1", org.student.userId);
});
afterAll(async () => ctx.close());

/** Requests a reset e-mail and returns the one-time token from the link in it. */
async function resetToken(email: string): Promise<string> {
  const res = await call(ctx, null, "POST", "/auth/password-reset", { body: { email } });
  expect(res.status).toBe(200);
  const link = ctx.mailer.lastLink(email);
  expect(link?.type).toBe("recovery");
  return link?.token as string;
}

describe("POST /auth/password-reset", () => {
  it("e-mails a one-hour link in Japanese to registered users and answers identically for unknown addresses", async () => {
    const before = ctx.mailer.sent.length;
    const known = await call(ctx, null, "POST", "/auth/password-reset", { body: { email: org.teacher.email.toUpperCase() } });
    const unknown = await call(ctx, null, "POST", "/auth/password-reset", { body: { email: "nobody@example.invalid" } });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body.data).toEqual(known.body.data);
    expectContract(known, "post", "/auth/password-reset");
    expect(ctx.mailer.sent.length).toBe(before + 1);
    const mail = ctx.mailer.sent.at(-1);
    expect(mail?.to).toBe(org.teacher.email);
    expect(mail?.subject).toBe("【ARMS】パスワード再設定のご案内");
    expect(mail?.text).toContain("https://arms.test.invalid/auth/callback#token=arms_lt_");
    expect(mail?.text).toContain("（1時間）");
    // Only the hash is stored.
    const token = ctx.mailer.lastLink(org.teacher.email)?.token as string;
    const { rows } = await ctx.admin.query("SELECT count(*)::int AS n FROM app.auth_link_tokens WHERE token_hash = $1", [token]);
    expect(rows[0].n).toBe(0);
  });

  it("does not e-mail disabled accounts (same answer) and reports a missing mail service as 503", async () => {
    const disabled = await createUser(ctx.admin, org.orgId, "teacher", { active: false });
    const before = ctx.mailer.sent.length;
    const res = await call(ctx, null, "POST", "/auth/password-reset", { body: { email: disabled.email } });
    expect(res.status).toBe(200);
    expect(ctx.mailer.sent.length).toBe(before);
    const noMail = createTestContext({ mail: null });
    const down = await call(noMail, null, "POST", "/auth/password-reset", { body: { email: org.teacher.email } });
    expect(down.status).toBe(503);
    expect(down.body.code).toBe("NOT_CONFIGURED");
    expectContract(down, "post", "/auth/password-reset");
    await noMail.close();
  });
});

describe("POST /auth/password (invitation / reset link)", () => {
  it("sets the password, signs the user out everywhere, and the link works only once", async () => {
    const web = await cookieCaller(ctx, { userId: org.teacher.userId, orgId: org.orgId, role: "teacher" });
    const ios = await bearerCaller(org.teacher.userId, org.orgId);
    const token = await resetToken(org.teacher.email);
    const res = await call(ctx, null, "POST", "/auth/password", { body: { token, password: "Newpassword2026" } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/auth/password");
    expect(res.body.data).toMatchObject({ sign_in: "web", message_ja: "パスワードを設定しました。ログイン画面からログインしてください。" });
    expect((await call(ctx, web, "GET", "/me")).status).toBe(401);
    expect((await call(ctx, ios, "GET", "/me")).status).toBe(401);
    const again = await call(ctx, null, "POST", "/auth/password", { body: { token, password: "Otherpassword2026" } });
    expect(again.status).toBe(401);
    expect(again.body.message_ja).toContain("既に使用");
    const oldPw = await call(ctx, null, "POST", "/auth/login", { body: { email: org.teacher.email, password: "Old-password-1", selected_role: "teacher" } });
    expect(oldPw.status).toBe(401);
    const newPw = await call(ctx, null, "POST", "/auth/login", { body: { email: org.teacher.email, password: "Newpassword2026", selected_role: "teacher" } });
    expect(newPw.status).toBe(200);
    const audit = await ctx.admin.query("SELECT payload FROM app.audit_events WHERE actor_id = $1 AND event_type = 'auth.password_set'", [org.teacher.userId]);
    expect(audit.rows.at(-1)?.payload).toEqual({ via: "password_reset" });
  });

  it("tells students to sign in from the iOS app", async () => {
    const token = await resetToken(org.student.email);
    const res = await call(ctx, null, "POST", "/auth/password", { body: { token, password: "Studentpass2026" } });
    expect(res.body.data).toMatchObject({ sign_in: "ios", message_ja: "パスワードを設定しました。iOSアプリからログインしてください。" });
    const tokens = await call(ctx, null, "POST", "/auth/tokens", { body: { email: org.student.email, password: "Studentpass2026" } });
    expect(tokens.status).toBe(200);
  });

  it("accepts the invitation link of a new account (24 hours) and enforces the password policy in Japanese", async () => {
    const admin = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" });
    const invited = await createUser(ctx.admin, org.orgId, "teacher");
    expect((await call(ctx, admin, "POST", `/settings/users/${invited.userId}/resend-invite`)).body.data.invitation.state).toBe("sent");
    const link = ctx.mailer.lastLink(invited.email);
    expect(link?.type).toBe("invite");
    expect(ctx.mailer.sent.at(-1)?.text).toContain("（24時間）");
    const weak = await call(ctx, null, "POST", "/auth/password", { body: { token: link?.token, password: "onlyletters" } });
    expect(weak.status).toBe(422);
    expect(weak.body.field_errors.password).toBe("英字と数字を両方含めてください。");
    const short = await call(ctx, null, "POST", "/auth/password", { body: { token: link?.token, password: "a1" } });
    expect(short.body.field_errors.password).toBe("10文字以上で入力してください。");
    // Validation failures do not use up the link.
    const ok = await call(ctx, null, "POST", "/auth/password", { body: { token: link?.token, password: "Welcome2026b" } });
    expect(ok.status).toBe(200);
    expect((await call(ctx, null, "POST", "/auth/login", { body: { email: invited.email, password: "Welcome2026b", selected_role: "teacher" } })).status).toBe(200);
  });

  it("rejects unknown and expired links; a disabled account keeps its link until it is re-enabled", async () => {
    const unknown = await call(ctx, null, "POST", "/auth/password", { body: { token: "arms_lt_" + "x".repeat(43), password: "Newpassword2026" } });
    expect(unknown.status).toBe(401);
    expect(unknown.body.message_ja).toContain("リンクの有効期限");
    const expiring = await createUser(ctx.admin, org.orgId, "teacher");
    await ctx.auth.register(expiring.email, "Old-password-1", expiring.userId);
    const token = await resetToken(expiring.email);
    ctx.clock.now = new Date(Date.now() + 61 * 60 * 1000);
    try {
      expect((await call(ctx, null, "POST", "/auth/password", { body: { token, password: "Newpassword2026" } })).status).toBe(401);
    } finally {
      ctx.clock.now = null;
    }

    const paused = await createUser(ctx.admin, org.orgId, "teacher");
    await ctx.auth.register(paused.email, "Old-password-1", paused.userId);
    const pausedToken = await resetToken(paused.email);
    await ctx.admin.query("UPDATE app.memberships SET active = false WHERE id = $1", [paused.userId]);
    const refused = await call(ctx, null, "POST", "/auth/password", { body: { token: pausedToken, password: "Newpassword2026" } });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("ACCOUNT_DISABLED");
    await ctx.admin.query("UPDATE app.memberships SET active = true WHERE id = $1", [paused.userId]);
    expect((await call(ctx, null, "POST", "/auth/password", { body: { token: pausedToken, password: "Newpassword2026" } })).status).toBe(200);
  });
});
