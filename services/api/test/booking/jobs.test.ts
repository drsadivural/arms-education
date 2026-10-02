/** Minute cron: pending expiry under the slot lock and outbox fallback dispatch. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createTestContext, type TestContext } from "../helpers/app";
import { expireDuePendings } from "../../src/domain/booking/expiry";
import { listOrganizationIds, runBookingJobs } from "../../src/jobs/booking";
import { FakeMailer, auditTypes, bookingWorld, createSlotViaApi, outboxRows, reserve, slotBody, type BookingWorld } from "../helpers/booking-fixtures";

let ctx: TestContext;
let w: BookingWorld;
const mail = new FakeMailer();

beforeAll(async () => {
  ctx = createTestContext({ mail });
  w = await bookingWorld(ctx);
});
afterAll(async () => ctx.close());

describe("pending expiry cron", () => {
  it("expires every due pending of the organisation (audit + outbox) and releases the seats", async () => {
    const a = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { capacity: 1 }));
    const b = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { capacity: 1 }));
    const ra = await reserve(ctx, w.student, a.id);
    const rb = await reserve(ctx, w.student2, b.id);
    const keep = await reserve(ctx, w.student, b.id).catch((e) => e);
    expect(String(keep)).toContain("SLOT_FULL");
    await ctx.admin.query("UPDATE app.reservations SET expires_at = now() - interval '5 seconds' WHERE id = ANY($1::uuid[])", [[ra.id, rb.id]]);

    const result = await expireDuePendings(ctx.deps, w.org.orgId);
    expect(result).toEqual({ slots: 2, reservations: 2 });
    const { rows } = await ctx.admin.query("SELECT id, status, row_version FROM app.reservations WHERE id = ANY($1::uuid[]) ORDER BY id", [[ra.id, rb.id]]);
    expect(rows.map((r) => r.status)).toEqual(["expired", "expired"]);
    for (const id of [ra.id, rb.id]) {
      expect(await auditTypes(ctx.admin, w.org.orgId, id)).toEqual(["reservation.created", "reservation.expired"]);
      const audit = await ctx.admin.query("SELECT actor_id FROM app.audit_events WHERE entity_id = $1 AND event_type = 'reservation.expired'", [id]);
      expect(audit.rows[0].actor_id).toBeNull(); // system action
    }
    expect((await call(ctx, w.student, "GET", `/lesson-slots/${a.id}`)).body.data.remaining).toBe(1);
    // Nothing left to do on the next run.
    expect(await expireDuePendings(ctx.deps, w.org.orgId)).toEqual({ slots: 0, reservations: 0 });
  });

  it("runs safely alongside booking on the same slot (slot row lock, no deadlock)", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { capacity: 1 }));
    const r = await reserve(ctx, w.student, slot.id);
    await ctx.admin.query("UPDATE app.reservations SET expires_at = now() - interval '1 second' WHERE id = $1", [r.id]);
    const [, booked] = await Promise.all([expireDuePendings(ctx.deps, w.org.orgId), call(ctx, w.student2, "POST", "/reservations", { body: { slot_id: slot.id } })]);
    // Either order is valid: the booking itself expires the stale hold under the same lock.
    expect(booked.status).toBe(201);
    const { rows } = await ctx.admin.query("SELECT status FROM app.reservations WHERE slot_id = $1 ORDER BY created_at", [slot.id]);
    expect(rows.map((x) => x.status)).toEqual(["expired", "pending"]);
    expect((await outboxRows(ctx.admin, w.org.orgId, r.id)).filter((o) => o.event_type === "reservation.expired")).toHaveLength(1);
  });

  it("runBookingJobs expires and dispatches per organisation; the organisation list comes from the DB", async () => {
    expect(await listOrganizationIds(ctx.deps)).toContain(w.org.orgId);
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student2, slot.id);
    await ctx.admin.query("UPDATE app.reservations SET expires_at = now() - interval '1 second' WHERE id = $1", [r.id]);
    await runBookingJobs(ctx.deps, { orgIds: [w.org.orgId] });
    const outbox = await outboxRows(ctx.admin, w.org.orgId, r.id);
    expect(outbox.map((o) => [o.event_type, o.state])).toEqual([
      ["reservation.created", "delivered"],
      ["reservation.expired", "delivered"],
    ]);
    expect(mail.sent.some((m) => m.to === w.org.student2.email && m.subject === "【ARMS】予約申請の期限が切れました")).toBe(true);
  });
});
