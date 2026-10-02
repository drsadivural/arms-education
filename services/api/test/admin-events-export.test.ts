import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bearerCaller, cookieCaller, createTestContext, type TestContext } from "./helpers/app";
import { seedOrg, type OrgScenario } from "./helpers/fixtures";

let ctx: TestContext;
let org: OrgScenario;
beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  await ctx.admin.query(
    `INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload) VALUES
     ($1, $2, 'teacher.created', $3, '{"display_name":"=HYPERLINK(\\"x\\")","access_token":"secret-value"}'),
     ($1, $2, 'reservation.approved', $3, '{"status":"approved"}')`,
    [org.orgId, org.admin.userId, org.teacher.userId],
  );
});
afterAll(async () => ctx.close());

async function get(path: string, headers: Record<string, string>) {
  const res = await ctx.app.request(`/api/v1${path}`, { headers });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
}

describe("GET /events/export.csv", () => {
  it("exports the filtered, redacted audit log as formula-safe CSV and audits the export", async () => {
    const admin = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" });
    const res = await get("/events/export.csv?event_type=teacher.", admin.headers("GET"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="arms-audit-\d{8}\.csv"$/);
    expect(res.text.startsWith("﻿\"日時\",\"実行者\",\"イベント種別\",\"対象ID\",\"詳細\"\r\n")).toBe(true);
    expect(res.text).toContain("teacher.created");
    expect(res.text).not.toContain("reservation.approved");
    expect(res.text).not.toContain("secret-value");
    // The details cell starts with "{" — but a leading "=" in any cell would be neutralised; check the JSON is quoted.
    expect(res.text).not.toMatch(/,=HYPERLINK/);
    const { rows } = await ctx.admin.query("SELECT payload FROM app.audit_events WHERE org_id = $1 AND event_type = 'audit.exported'", [org.orgId]);
    expect(rows.length).toBe(1);
    expect(rows[0].payload.rows).toBe(1);
  });

  it("is admin-only", async () => {
    const teacher = await bearerCaller(org.teacher.userId, org.orgId);
    expect((await get("/events/export.csv", teacher.headers("GET"))).status).toBe(403);
    expect((await get("/events/export.csv", {})).status).toBe(401);
  });
});
