import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, cookieCaller, createTestContext, type Caller, type TestContext } from "../helpers/app";
import { seedOrg, type OrgScenario } from "../helpers/fixtures";
import { expectContract } from "../helpers/contract";
import { createOutbox } from "../helpers/admin-fixtures";
import { redact } from "../../src/domain/admin/redact";

let ctx: TestContext;
let org: OrgScenario;
let other: OrgScenario;
let admin: Caller;
let teacher: Caller;

async function insertEvent(orgId: string, actorId: string | null, eventType: string, payload: unknown, createdAt?: string, entityId: string | null = crypto.randomUUID()) {
  const { rows } = await ctx.admin.query(
    "INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, coalesce($6::timestamptz, now())) RETURNING id",
    [orgId, actorId, eventType, entityId, JSON.stringify(payload), createdAt ?? null],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  ctx = createTestContext();
  org = await seedOrg(ctx.admin);
  other = await seedOrg(ctx.admin);
  admin = await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" });
  teacher = await cookieCaller(ctx, { userId: org.teacher.userId, orgId: org.orgId, role: "teacher" });
});
afterAll(async () => ctx.close());

describe("GET /events", () => {
  it("returns audit events with actor names and redacted details", async () => {
    const id = await insertEvent(org.orgId, org.teacher.userId, "reservation.approved", {
      status: "approved",
      meeting_url: "https://meet.example.invalid/secret-room",
      nested: { access_token: "eyJ...", answer_key: ["a"], note: "ok", items: [{ password: "x", label: "y" }] },
      transcript: "全文",
    });
    await insertEvent(org.orgId, null, "notification.delivered", { channel: "email" });
    await insertEvent(other.orgId, other.admin.userId, "reservation.approved", {});
    const res = await call(ctx, admin, "GET", "/events");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/events");
    const e = res.body.items.find((x: any) => x.id === id);
    expect(e.actor_name).toBe("田中 祥司");
    expect(e.details).toEqual({ status: "approved", nested: { note: "ok", items: [{ label: "y" }] } });
    expect(JSON.stringify(res.body)).not.toContain("secret-room");
    expect(res.body.items.find((x: any) => x.event_type === "notification.delivered").actor_name).toBe("システム");
    expect(res.body.items.every((x: any) => x.event_type !== "reservation.approved" || x.id === id)).toBe(true);
  });

  it("filters by q, event type prefix, actor, entity and JST date range; paginates", async () => {
    const entity = crypto.randomUUID();
    // 2026-09-30T15:30Z is 2026-10-01 00:30 JST.
    const inRange = await insertEvent(org.orgId, org.admin.userId, "classroom.updated", { name: "A" }, "2026-09-30T15:30:00Z", entity);
    const before = await insertEvent(org.orgId, org.admin.userId, "classroom.updated", { name: "B" }, "2026-09-30T14:30:00Z", entity);
    const byRange = await call(ctx, admin, "GET", `/events?from=2026-10-01&to=2026-10-01&entity_id=${entity}`);
    expect(byRange.body.items.map((x: any) => x.id)).toEqual([inRange]);
    const byEntity = await call(ctx, admin, "GET", `/events?entity_id=${entity}`);
    expect(byEntity.body.items.map((x: any) => x.id)).toEqual([inRange, before]);
    const byPrefix = await call(ctx, admin, "GET", "/events?event_type=classroom.");
    expect(byPrefix.body.items.every((x: any) => x.event_type.startsWith("classroom."))).toBe(true);
    const byQ = await call(ctx, admin, "GET", `/events?q=${encodeURIComponent("田中")}`);
    expect(byQ.body.items.length).toBeGreaterThan(0);
    expect(byQ.body.items.every((x: any) => x.actor_name === "田中 祥司" || x.event_type.includes("田中"))).toBe(true);
    const byActor = await call(ctx, admin, "GET", `/events?actor_id=${org.admin.userId}`);
    expect(byActor.body.items.every((x: any) => x.actor_id === org.admin.userId)).toBe(true);
    const p1 = await call(ctx, admin, "GET", "/events?limit=1");
    const p2 = await call(ctx, admin, "GET", `/events?limit=1&cursor=${p1.body.next_cursor}`);
    expectContract(p2, "get", "/events");
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
  });

  it("validates filters and is admin only", async () => {
    const bad = await call(ctx, admin, "GET", "/events?from=2026-10-05&to=2026-10-01");
    expect(bad.status).toBe(422);
    expect(bad.body.field_errors.to).toBe("終了日は開始日以降にしてください。");
    expectContract(bad, "get", "/events");
    expect((await call(ctx, teacher, "GET", "/events")).status).toBe(403);
    expect((await call(ctx, null, "GET", "/events")).status).toBe(401);
  });

  it("redact() drops secret-like keys at any depth", () => {
    expect(redact({ csrf_token: "x", api_key: "k", deep: [{ refresh_token: "r", ok: 1 }], encrypted_provider_tokens: "z", reason: "理由" })).toEqual({
      deep: [{ ok: 1 }],
      reason: "理由",
    });
  });
});

describe("GET /events/deliveries and retry", () => {
  it("lists outbox deliveries (failed filter) and retries a failed one", async () => {
    const failed = await createOutbox(ctx.admin, org.orgId, { state: "failed", attempts: 5 });
    await createOutbox(ctx.admin, org.orgId, { state: "delivered" });
    await createOutbox(ctx.admin, other.orgId, { state: "failed" });
    const res = await call(ctx, admin, "GET", "/events/deliveries?state=failed");
    expect(res.status).toBe(200);
    expectContract(res, "get", "/events/deliveries");
    expect(res.body.items.map((d: any) => d.id)).toEqual([failed]);
    expect(res.body.items[0]).toMatchObject({ state: "failed", attempts: 5, event_type: "reservation.approved", last_error_code: null });

    const retry = await call(ctx, admin, "POST", `/events/deliveries/${failed}/retry`);
    expect(retry.status).toBe(200);
    expectContract(retry, "post", "/events/deliveries/{id}/retry");
    const { rows } = await ctx.admin.query("SELECT state, next_attempt_at <= now() AS due, attempts FROM app.outbox WHERE id = $1", [failed]);
    expect(rows[0]).toEqual({ state: "pending", due: true, attempts: 5 });
    const audit = await ctx.admin.query("SELECT count(*)::int AS n FROM app.audit_events WHERE entity_id = $1 AND event_type = 'notification.retry_requested'", [failed]);
    expect(audit.rows[0].n).toBe(1);

    const again = await call(ctx, admin, "POST", `/events/deliveries/${failed}/retry`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("INVALID_STATE");
    expect(again.body.message_ja).toContain("送信失敗");
    expectContract(again, "post", "/events/deliveries/{id}/retry");
    const all = await call(ctx, admin, "GET", "/events/deliveries");
    expect(all.body.items.length).toBe(2);
  });

  it("is admin only and tenant scoped", async () => {
    const foreign = await createOutbox(ctx.admin, other.orgId, { state: "failed" });
    expect((await call(ctx, admin, "POST", `/events/deliveries/${foreign}/retry`)).status).toBe(404);
    expect((await call(ctx, teacher, "GET", "/events/deliveries")).status).toBe(403);
    expect((await call(ctx, teacher, "POST", `/events/deliveries/${foreign}/retry`)).status).toBe(403);
    expect((await call(ctx, null, "GET", "/events/deliveries")).status).toBe(401);
    const bad = await call(ctx, admin, "GET", "/events/deliveries?state=lost");
    expect(bad.status).toBe(422);
  });
});
