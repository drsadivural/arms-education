import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestContext, type TestContext } from "./helpers/app";
import { issueToken } from "./helpers/auth";
import { createUser, seedOrg, type OrgScenario } from "./helpers/fixtures";
import { expectContract } from "./helpers/contract";

let ctx: TestContext;
let org: OrgScenario;
beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  ctx.auth.register(org.teacher.email, "Old-password-1", org.teacher.userId);
  ctx.auth.register(org.student.email, "Old-password-1", org.student.userId);
});
afterAll(async () => ctx.close());

describe("POST /auth/password (invitation / recovery link)", () => {
  it("sets the password with the link token and tells staff to use the Web login", async () => {
    const res = await call(ctx, null, "POST", "/auth/password", { body: { access_token: await issueToken(org.teacher.userId), password: "Newpassword2026" } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/auth/password");
    expect(res.body.data.sign_in).toBe("web");
    expect(ctx.auth.passwordUpdates.at(-1)).toEqual({ userId: org.teacher.userId, password: "Newpassword2026" });
    const { rows } = await ctx.admin.query("SELECT 1 FROM app.audit_events WHERE actor_id = $1 AND event_type = 'auth.password_set'", [org.teacher.userId]);
    expect(rows.length).toBe(1);
  });

  it("tells students to sign in from the iOS app", async () => {
    const res = await call(ctx, null, "POST", "/auth/password", { body: { access_token: await issueToken(org.student.userId), password: "Studentpass2026" } });
    expect(res.body.data).toMatchObject({ sign_in: "ios", message_ja: "パスワードを設定しました。iOSアプリからログインしてください。" });
  });

  it("enforces the password policy with Japanese messages", async () => {
    const res = await call(ctx, null, "POST", "/auth/password", { body: { access_token: await issueToken(org.teacher.userId), password: "onlyletters" } });
    expect(res.status).toBe(422);
    expect(res.body.field_errors.password).toBe("英字と数字を両方含めてください。");
    const short = await call(ctx, null, "POST", "/auth/password", { body: { access_token: await issueToken(org.teacher.userId), password: "a1" } });
    expect(short.body.field_errors.password).toBe("10文字以上で入力してください。");
  });

  it("rejects forged/expired link tokens and accounts without an active membership", async () => {
    const forged = await call(ctx, null, "POST", "/auth/password", { body: { access_token: await issueToken(org.teacher.userId, { forged: true }), password: "Newpassword2026" } });
    expect(forged.status).toBe(401);
    expect(forged.body.message_ja).toContain("リンクの有効期限");
    const expired = await call(ctx, null, "POST", "/auth/password", { body: { access_token: await issueToken(org.teacher.userId, { expiresInSeconds: -60 }), password: "Newpassword2026" } });
    expect(expired.status).toBe(401);
    const disabled = await createUser(ctx.admin, org.orgId, "teacher", { active: false });
    ctx.auth.register(disabled.email, "x", disabled.userId);
    const res = await call(ctx, null, "POST", "/auth/password", { body: { access_token: await issueToken(disabled.userId), password: "Newpassword2026" } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_DISABLED");
  });
});
