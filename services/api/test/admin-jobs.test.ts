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
  it("deletes stale web sessions and expired idempotency records only", async () => {
    await ctx.admin.query(
      `INSERT INTO app.web_sessions(id, user_id, org_id, role, encrypted_provider_tokens, csrf_hash, expires_at)
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
    await runAdminJobs(ctx.deps);
    const sessions = await ctx.admin.query("SELECT id FROM app.web_sessions WHERE id IN ('old-session','live-session')");
    expect(sessions.rows.map((r) => r.id)).toEqual(["live-session"]);
    const keys = await ctx.admin.query("SELECT route FROM app.idempotency_requests WHERE org_id = $1", [org.orgId]);
    expect(keys.rows.map((r) => r.route)).toEqual(["POST /y"]);
  });
});
