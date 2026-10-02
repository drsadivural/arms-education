import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "./helpers/app";
import { seedOrg, type OrgScenario } from "./helpers/fixtures";
import { runAdminJobs } from "../src/jobs/admin";

let ctx: TestContext;
let org: OrgScenario;
beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
});
afterAll(async () => ctx.close());

describe("admin housekeeping job", () => {
  it("deletes stale Web/iOS sessions, expired e-mail links and expired idempotency records only", async () => {
    await ctx.admin.query(
      `INSERT INTO app.web_sessions(id, user_id, org_id, role, encrypted_secrets, csrf_hash, expires_at)
       VALUES ('old-session', $1, $2, 'teacher', 'v1.x.y', 'h', now() - interval '8 days'),
              ('live-session', $1, $2, 'teacher', 'v1.x.y', 'h', now() + interval '1 hour')`,
      [org.teacher.userId, org.orgId],
    );
    await ctx.admin.query(
      `INSERT INTO app.idempotency_requests(org_id, user_id, route, key, request_hash, expires_at)
       VALUES ($1, $2, 'POST /x', gen_random_uuid(), 'h', now() - interval '2 days'),
              ($1, $2, 'POST /y', gen_random_uuid(), 'h', now() + interval '1 hour')`,
      [org.orgId, org.teacher.userId],
    );
    const u = org.teacher.userId;
    await ctx.admin.query(
      `INSERT INTO app.bearer_sessions(user_id, access_hash, access_expires_at, refresh_hash, expires_at, revoked_at)
       VALUES ($1, 'a-old', now() - interval '9 days', 'r-old', now() + interval '30 days', now() - interval '8 days'),
              ($1, 'a-live', now() + interval '1 hour', 'r-live', now() + interval '30 days', NULL)`,
      [u],
    );
    await ctx.admin.query(
      `INSERT INTO app.auth_link_tokens(user_id, purpose, token_hash, expires_at)
       VALUES ($1, 'invite', 'l-old', now() - interval '2 days'), ($1, 'password_reset', 'l-live', now() + interval '1 hour')`,
      [u],
    );
    await runAdminJobs(ctx.deps);
    const sessions = await ctx.admin.query("SELECT id FROM app.web_sessions WHERE id IN ('old-session','live-session')");
    expect(sessions.rows.map((r) => r.id)).toEqual(["live-session"]);
    const bearer = await ctx.admin.query("SELECT access_hash FROM app.bearer_sessions WHERE access_hash IN ('a-old','a-live')");
    expect(bearer.rows.map((r) => r.access_hash)).toEqual(["a-live"]);
    const links = await ctx.admin.query("SELECT token_hash FROM app.auth_link_tokens WHERE token_hash IN ('l-old','l-live')");
    expect(links.rows.map((r) => r.token_hash)).toEqual(["l-live"]);
    const keys = await ctx.admin.query("SELECT route FROM app.idempotency_requests WHERE org_id = $1", [org.orgId]);
    expect(keys.rows.map((r) => r.route)).toEqual(["POST /y"]);
  });
});
