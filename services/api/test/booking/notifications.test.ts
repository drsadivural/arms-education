/**
 * Outbox → notifications → e-mail / APNs, notification and device endpoints (docs/07 scenario 11, IOS-15).
 * External services are test fakes implementing the production integration interfaces.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, cookieCaller, createTestContext, type TestContext } from "../helpers/app";
import { expectContract } from "../helpers/contract";
import { createUser } from "../helpers/fixtures";
import { sha256Hex } from "../../src/auth/crypto";
import { MailDeliveryError } from "../../src/integrations/mail";
import { OUTBOX_MAX_ATTEMPTS, backoffSeconds, dispatchDueOutbox, dispatchOutboxMessage } from "../../src/domain/notifications/dispatch";
import { runBookingJobs } from "../../src/jobs/booking";
import { handleNotificationBatch } from "../../src/jobs/queue";
import {
  FakeMailer,
  FakePush,
  FakeQueue,
  bookingWorld,
  createSlotViaApi,
  decide,
  outboxRows,
  reserve,
  retryableMailError,
  slotBody,
  type BookingWorld,
} from "../helpers/booking-fixtures";

let ctx: TestContext;
let w: BookingWorld;
const mail = new FakeMailer();
const push = new FakePush();
const queue = new FakeQueue();

beforeAll(async () => {
  ctx = createTestContext({ mail, push, queue });
  w = await bookingWorld(ctx);
});
afterAll(async () => ctx.close());
beforeEach(() => {
  mail.failWith = null;
  queue.fail = false;
  push.results.clear();
});

async function notificationsOf(userId: string, eventId: string) {
  const { rows } = await ctx.admin.query("SELECT id, title, body, deep_link FROM app.notifications WHERE user_id = $1 AND event_id = $2", [userId, eventId]);
  return rows as { id: string; title: string; body: string; deep_link: string }[];
}

async function lastOutbox(entityId: string, eventType: string) {
  const rows = await outboxRows(ctx.admin, w.org.orgId, entityId);
  const row = rows.filter((r) => r.event_type === eventType).at(-1);
  if (!row) throw new Error(`no outbox ${eventType}`);
  return row;
}

describe("after-commit queue wake-up", () => {
  it("enqueues {org_id, outbox_id} after the reservation commits", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const before = queue.messages.length;
    const r = await reserve(ctx, w.student, slot.id);
    const created = await lastOutbox(r.id, "reservation.created");
    expect(queue.messages.slice(before)).toEqual([{ org_id: w.org.orgId, outbox_id: created.id }]);
    expect(created.state).toBe("pending");
  });

  it("a failing queue never fails the request; the cron dispatches the row", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    queue.fail = true;
    const res = await call(ctx, w.student2, "POST", "/reservations", { body: { slot_id: slot.id } });
    expect(res.status).toBe(201);
    expect(ctx.logs.some((l) => l.msg === "outbox_enqueue_failed")).toBe(true);
    const row = await lastOutbox(res.body.id, "reservation.created");
    expect(row.state).toBe("pending");
    await runBookingJobs(ctx.deps, { orgIds: [w.org.orgId] });
    expect((await lastOutbox(res.body.id, "reservation.created")).state).toBe("delivered");
    expect(await notificationsOf(w.org.teacher.userId, row.id)).toHaveLength(1);
  });
});

describe("dispatch", () => {
  it("creates one Japanese in-app notification per recipient and sends one e-mail, even when processed twice", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { title: "ビジネスマナー" }));
    const r = await reserve(ctx, w.student, slot.id);
    const row = await lastOutbox(r.id, "reservation.created");
    const sentBefore = mail.sent.length;

    expect(await dispatchOutboxMessage(ctx.deps, w.org.orgId, row.id)).toBe("delivered");
    const n = await notificationsOf(w.org.teacher.userId, row.id);
    expect(n).toHaveLength(1);
    expect(n[0]!.title).toBe("予約申請が届きました");
    expect(n[0]!.body).toContain("和田 一夫さんから「ビジネスマナー」");
    expect(n[0]!.body).toMatch(/\d+\/\d+（[日月火水木金土]）\d{2}:\d{2}–\d{2}:\d{2}/);
    expect(n[0]!.deep_link).toBe(`arms://reservations/${r.id}`);
    const mails = mail.sent.slice(sentBefore);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: w.org.teacher.email, subject: "【ARMS】予約申請が届きました", idempotencyKey: `arms-notification-${n[0]!.id}-email` });
    expect(mails[0]!.text).toContain("自動送信");
    const done = await lastOutbox(r.id, "reservation.created");
    expect(done.state).toBe("delivered");
    expect(done.delivered_at).not.toBeNull();

    // The same queue message delivered again is a no-op (already delivered).
    expect(await dispatchOutboxMessage(ctx.deps, w.org.orgId, row.id)).toBe("skipped");
    // Even if the row is forced back to pending (lost ack, operator re-drive), nothing is duplicated.
    await ctx.admin.query("UPDATE app.outbox SET state = 'pending', next_attempt_at = now() WHERE id = $1", [row.id]);
    expect(await dispatchOutboxMessage(ctx.deps, w.org.orgId, row.id)).toBe("delivered");
    expect(await notificationsOf(w.org.teacher.userId, row.id)).toHaveLength(1);
    expect(mail.sent.length - sentBefore).toBe(1);
    const deliveries = await ctx.admin.query("SELECT channel, state, attempts FROM app.notification_deliveries WHERE notification_id = $1", [n[0]!.id]);
    expect(deliveries.rows).toEqual([{ channel: "email", state: "sent", attempts: 1 }]);
  });

  it("a failing mailer keeps the reservation committed and the outbox retried later with backoff", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student, slot.id);
    await dispatchDueOutbox(ctx.deps, w.org.orgId, 500); // drain earlier events of this organisation
    mail.failWith = retryableMailError();
    const approved = await decide(ctx, w.teacher, r.id, "approve", { expected_version: r.row_version });
    expect(approved.status).toBe(200);
    const row = await lastOutbox(r.id, "reservation.approved");

    expect(await dispatchOutboxMessage(ctx.deps, w.org.orgId, row.id)).toBe("retry");
    const { rows } = await ctx.admin.query("SELECT status FROM app.reservations WHERE id = $1", [r.id]);
    expect(rows[0].status).toBe("approved");
    const retrying = await lastOutbox(r.id, "reservation.approved");
    expect(retrying).toMatchObject({ state: "pending", attempts: 1, last_error: "MAIL_PROVIDER_UNAVAILABLE" });
    expect(retrying.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 10_000);
    // The in-app notification exists regardless of the e-mail failure (APNs/e-mail are only wake-ups).
    const n = await notificationsOf(w.org.student.userId, row.id);
    expect(n).toHaveLength(1);
    expect(n[0]!.title).toBe("予約が承認されました");
    expect(n[0]!.body).not.toContain("https://");

    // Not due yet: the cron leaves it alone.
    expect(await dispatchDueOutbox(ctx.deps, w.org.orgId)).toBe(0);
    // Provider recovers and the backoff elapses: delivered exactly once.
    mail.failWith = null;
    const sentBefore = mail.sent.length;
    await ctx.admin.query("UPDATE app.outbox SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [row.id]);
    await dispatchDueOutbox(ctx.deps, w.org.orgId);
    expect(await lastOutbox(r.id, "reservation.approved")).toMatchObject({ state: "delivered", attempts: 2, last_error: null });
    expect(mail.sent.length - sentBefore).toBe(1);
    expect(await notificationsOf(w.org.student.userId, row.id)).toHaveLength(1);
  });

  it("a permanent rejection is recorded without retrying; repeated transient failures end as failed", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student2, slot.id);
    const created = await lastOutbox(r.id, "reservation.created");
    mail.failWith = new MailDeliveryError("MAIL_REJECTED", false, 422);
    expect(await dispatchOutboxMessage(ctx.deps, w.org.orgId, created.id)).toBe("delivered");
    const d = await ctx.admin.query(
      "SELECT d.state, d.last_error FROM app.notification_deliveries d JOIN app.notifications n ON n.id = d.notification_id WHERE n.event_id = $1",
      [created.id],
    );
    expect(d.rows).toEqual([{ state: "failed", last_error: "MAIL_REJECTED" }]);

    const approved = await decide(ctx, w.teacher, r.id, "approve", { expected_version: r.row_version });
    const row = await lastOutbox(r.id, "reservation.approved");
    expect(approved.status).toBe(200);
    mail.failWith = retryableMailError();
    await ctx.admin.query("UPDATE app.outbox SET attempts = $2 WHERE id = $1", [row.id, OUTBOX_MAX_ATTEMPTS - 1]);
    expect(await dispatchOutboxMessage(ctx.deps, w.org.orgId, row.id)).toBe("failed");
    expect(await lastOutbox(r.id, "reservation.approved")).toMatchObject({ state: "failed", attempts: OUTBOX_MAX_ATTEMPTS, last_error: "MAIL_PROVIDER_UNAVAILABLE" });
  });

  it("rejection and slot cancellation notify the student with the reason; an admin's cancellation also tells the teacher", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { title: "安全衛生" }));
    const r = await reserve(ctx, w.student, slot.id);
    await decide(ctx, w.teacher, r.id, "reject", { expected_version: r.row_version, reason: "別日程で受講してください" });
    const rejected = await lastOutbox(r.id, "reservation.rejected");
    await dispatchOutboxMessage(ctx.deps, w.org.orgId, rejected.id);
    const rn = await notificationsOf(w.org.student.userId, rejected.id);
    expect(rn[0]).toMatchObject({ title: "予約が却下されました", deep_link: `arms://reservations/${r.id}` });
    expect(rn[0]!.body).toContain("理由: 別日程で受講してください");

    const slot2 = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { title: "情報セキュリティ" }));
    const r2 = await reserve(ctx, w.student2, slot2.id);
    const cancel = await call(ctx, w.admin, "POST", `/lesson-slots/${slot2.id}/cancel`, { body: { reason: "会場都合のため", expected_version: slot2.row_version } });
    expect(cancel.status).toBe(200);
    await dispatchDueOutbox(ctx.deps, w.org.orgId, 100);
    const cancelled = await lastOutbox(r2.id, "reservation.cancelled");
    const cn = await notificationsOf(w.org.student2.userId, cancelled.id);
    expect(cn[0]!.title).toBe("授業が取り消されました");
    expect(cn[0]!.body).toContain("「情報セキュリティ」");
    expect(cn[0]!.body).toContain("理由: 会場都合のため");
    const slotEvent = await lastOutbox(slot2.id, "lesson_slot.cancelled");
    const tn = await notificationsOf(w.org.teacher.userId, slotEvent.id);
    expect(tn[0]!.title).toBe("担当授業が取り消されました");
    expect(tn[0]!.deep_link).toBe(`arms://lesson-slots/${slot2.id}`);
  });

  it("student cancellation notifies the teacher; expiry notifies the student", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student, slot.id);
    await decide(ctx, w.student, r.id, "cancel", { expected_version: r.row_version });
    const cancelled = await lastOutbox(r.id, "reservation.cancelled");
    await dispatchOutboxMessage(ctx.deps, w.org.orgId, cancelled.id);
    expect((await notificationsOf(w.org.teacher.userId, cancelled.id))[0]!.body).toContain("和田 一夫さんが");
    expect(await notificationsOf(w.org.student.userId, cancelled.id)).toHaveLength(0);

    const r2 = await reserve(ctx, w.student2, slot.id);
    await ctx.admin.query("UPDATE app.reservations SET expires_at = now() - interval '1 minute' WHERE id = $1", [r2.id]);
    await runBookingJobs(ctx.deps, { orgIds: [w.org.orgId] });
    const expired = await lastOutbox(r2.id, "reservation.expired");
    expect(expired.state).toBe("delivered");
    const en = await notificationsOf(w.org.student2.userId, expired.id);
    expect(en[0]!.title).toBe("予約申請の期限が切れました");
  });

  it("users who turned notifications off still get the in-app notification but no e-mail/push", async () => {
    await ctx.admin.query(
      "INSERT INTO app.user_preferences(org_id, user_id, notifications_enabled) VALUES ($1, $2, false) ON CONFLICT (org_id, user_id) DO UPDATE SET notifications_enabled = false",
      [w.org.orgId, w.org.otherTeacher.userId],
    );
    try {
      const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org, { classroomId: w.org.otherClassroomId, teacherId: w.org.otherTeacher.userId }));
      const r = await reserve(ctx, w.otherStudent, slot.id);
      const row = await lastOutbox(r.id, "reservation.created");
      const sentBefore = mail.sent.length;
      await dispatchOutboxMessage(ctx.deps, w.org.orgId, row.id);
      const n = await notificationsOf(w.org.otherTeacher.userId, row.id);
      expect(n).toHaveLength(1);
      expect(mail.sent.length).toBe(sentBefore);
      const d = await ctx.admin.query("SELECT state, last_error FROM app.notification_deliveries WHERE notification_id = $1", [n[0]!.id]);
      expect(d.rows).toEqual([{ state: "skipped", last_error: "OPTED_OUT" }]);
    } finally {
      await ctx.admin.query("DELETE FROM app.user_preferences WHERE org_id = $1 AND user_id = $2", [w.org.orgId, w.org.otherTeacher.userId]);
    }
  });

  it("account deletion requests notify every active admin", async () => {
    const second = await createUser(ctx.admin, w.org.orgId, "admin");
    const res = await call(ctx, w.student, "POST", "/me/account-deletion", { body: { reason: "退職のため" } });
    expect(res.status).toBe(200);
    const row = await lastOutbox(res.body.data.request_id, "account.deletion_requested");
    await dispatchOutboxMessage(ctx.deps, w.org.orgId, row.id);
    for (const adminId of [w.org.admin.userId, second.userId]) {
      const n = await notificationsOf(adminId, row.id);
      expect(n).toHaveLength(1);
      expect(n[0]!.title).toBe("アカウント削除の申請があります");
      expect(n[0]!.body).toContain("和田 一夫さん");
      expect(n[0]!.deep_link).toBe("arms://settings/users");
    }
  });

  it("events without a rule are closed with NO_NOTIFICATION_RULE", async () => {
    const { rows } = await ctx.admin.query("INSERT INTO app.outbox(org_id, event_type, entity_id, payload) VALUES ($1, 'unknown.event', gen_random_uuid(), '{}') RETURNING id", [w.org.orgId]);
    expect(await dispatchOutboxMessage(ctx.deps, w.org.orgId, rows[0].id)).toBe("delivered");
    const after = await ctx.admin.query("SELECT state, last_error FROM app.outbox WHERE id = $1", [rows[0].id]);
    expect(after.rows[0]).toEqual({ state: "delivered", last_error: "NO_NOTIFICATION_RULE" });
  });

  it("backoff grows exponentially with jitter and is capped", () => {
    expect(backoffSeconds(1, () => 0.5)).toBe(30);
    expect(backoffSeconds(2, () => 0.5)).toBe(60);
    expect(backoffSeconds(3, () => 0)).toBe(96);
    expect(backoffSeconds(20, () => 1)).toBe(4320);
  });
});

describe("devices and APNs delivery", () => {
  const token = "a1b2c3d4".repeat(8);

  it("POST /devices stores a hash and an encrypted token; pushes carry the deep link; invalid tokens are removed", async () => {
    const res = await call(ctx, w.student, "POST", "/devices", { body: { token, environment: "sandbox" } });
    expect(res.status).toBe(200);
    expectContract(res, "post", "/devices");
    const hash = await sha256Hex(token);
    expect(res.body.data).toEqual({ token_hash: hash, environment: "sandbox" });
    const stored = await ctx.admin.query("SELECT token_hash, encrypted_token, environment FROM app.device_tokens WHERE user_id = $1", [w.org.student.userId]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].token_hash).toBe(hash);
    expect(stored.rows[0].encrypted_token).not.toContain(token);
    // Re-registration (app relaunch) is an upsert, not a second row.
    expect((await call(ctx, w.student, "POST", "/devices", { body: { token: token.toUpperCase(), environment: "sandbox" } })).status).toBe(200);
    expect((await ctx.admin.query("SELECT count(*)::int AS n FROM app.device_tokens WHERE user_id = $1", [w.org.student.userId])).rows[0].n).toBe(1);

    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student, slot.id);
    await decide(ctx, w.teacher, r.id, "approve", { expected_version: r.row_version });
    const row = await lastOutbox(r.id, "reservation.approved");
    const pushedBefore = push.sent.length;
    await dispatchOutboxMessage(ctx.deps, w.org.orgId, row.id);
    const pushed = push.sent.slice(pushedBefore);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ token, environment: "sandbox", payload: { title: "予約が承認されました", deepLink: `arms://reservations/${r.id}` } });

    // APNs reports the token as unregistered → delivery recorded, device deleted, no retry.
    push.results.set(token, "invalid_token");
    await decide(ctx, w.student, r.id, "cancel", { expected_version: r.row_version + 1 });
    await reserve(ctx, w.student, slot.id).then((again) => decide(ctx, w.admin, again.id, "reject", { expected_version: again.row_version, reason: "テスト" }));
    const rejected = (await ctx.admin.query("SELECT id FROM app.outbox WHERE org_id = $1 AND event_type = 'reservation.rejected' ORDER BY created_at DESC LIMIT 1", [w.org.orgId])).rows[0].id;
    expect(await dispatchOutboxMessage(ctx.deps, w.org.orgId, rejected)).toBe("delivered");
    expect((await ctx.admin.query("SELECT count(*)::int AS n FROM app.device_tokens WHERE user_id = $1", [w.org.student.userId])).rows[0].n).toBe(0);
    const d = await ctx.admin.query(
      "SELECT d.state, d.last_error FROM app.notification_deliveries d JOIN app.notifications n ON n.id = d.notification_id WHERE n.event_id = $1 AND d.channel = 'push'",
      [rejected],
    );
    expect(d.rows).toEqual([{ state: "invalid_token", last_error: "APNS_INVALID_TOKEN" }]);
  });

  it("a transient APNs failure retries the outbox row without re-sending the e-mail", async () => {
    await call(ctx, w.student2, "POST", "/devices", { body: { token: "ff".repeat(32), environment: "production" } });
    push.results.set("ff".repeat(32), "retry");
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student2, slot.id);
    await decide(ctx, w.teacher, r.id, "approve", { expected_version: r.row_version });
    const row = await lastOutbox(r.id, "reservation.approved");
    const mailsBefore = mail.sent.length;
    expect(await dispatchOutboxMessage(ctx.deps, w.org.orgId, row.id)).toBe("retry");
    expect((await lastOutbox(r.id, "reservation.approved")).last_error).toBe("APNS_RETRY");
    push.results.clear();
    await ctx.admin.query("UPDATE app.outbox SET next_attempt_at = now() WHERE id = $1", [row.id]);
    expect(await dispatchOutboxMessage(ctx.deps, w.org.orgId, row.id)).toBe("delivered");
    expect(mail.sent.length - mailsBefore).toBe(1);
  });

  it("a token moves to the latest user who registers it; DELETE /devices/{hash} unregisters (logout)", async () => {
    const shared = "0123456789abcdef".repeat(4);
    await call(ctx, w.student, "POST", "/devices", { body: { token: shared, environment: "sandbox" } });
    await call(ctx, w.student2, "POST", "/devices", { body: { token: shared, environment: "sandbox" } });
    const hash = await sha256Hex(shared);
    const owners = await ctx.admin.query("SELECT user_id FROM app.device_tokens WHERE token_hash = $1", [hash]);
    expect(owners.rows.map((r) => r.user_id)).toEqual([w.org.student2.userId]);

    const del = await call(ctx, w.student2, "DELETE", `/devices/${hash}`);
    expect(del.status).toBe(200);
    expectContract(del, "delete", "/devices/{token_hash}");
    expect(del.body.data.removed).toBe(1);
    expect((await call(ctx, w.student2, "DELETE", `/devices/${hash}`)).body.data.removed).toBe(0);
    expect((await call(ctx, w.student2, "DELETE", "/devices/not-a-hash")).status).toBe(404);
  });

  it("validation, roles and NOT_CONFIGURED", async () => {
    const bad = await call(ctx, w.student, "POST", "/devices", { body: { token: "xyz", environment: "beta" } });
    expect(bad.status).toBe(422);
    expectContract(bad, "post", "/devices");
    expect(bad.body.field_errors.token).toBe("デバイストークンの形式が正しくありません。");
    expect(bad.body.field_errors.environment).toBe("選択肢から選んでください。");
    expect((await call(ctx, w.admin, "POST", "/devices", { body: { token, environment: "sandbox" } })).status).toBe(403);
    expect((await call(ctx, null, "POST", "/devices", { body: { token, environment: "sandbox" } })).status).toBe(401);

    const bare = createTestContext({ mail: null, push: null, queue: null });
    try {
      const res = await call(bare, w.student, "POST", "/devices", { body: { token, environment: "sandbox" } });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("NOT_CONFIGURED");
      expectContract(res, "post", "/devices");
    } finally {
      await bare.close();
    }
  });
});

describe("GET /notifications and read state", () => {
  it("lists own notifications newest first with unread filter, cursor, read and read-all", async () => {
    const user = w.org.teacher.userId;
    await ctx.admin.query("DELETE FROM app.notifications WHERE org_id = $1 AND user_id = $2", [w.org.orgId, user]);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { rows } = await ctx.admin.query(
        "INSERT INTO app.notifications(org_id, user_id, event_id, title, body, deep_link, created_at) VALUES ($1, $2, gen_random_uuid(), $3, '本文', 'arms://lessons/today', now() - make_interval(mins => $4)) RETURNING id",
        [w.org.orgId, user, `お知らせ${i}`, 10 - i],
      );
      ids.push(rows[0].id);
    }
    const all = await call(ctx, w.teacher, "GET", "/notifications?limit=2");
    expect(all.status).toBe(200);
    expectContract(all, "get", "/notifications");
    expect(all.body.items.map((n: { id: string }) => n.id)).toEqual([ids[2], ids[1]]);
    const rest = await call(ctx, w.teacher, "GET", `/notifications?limit=2&cursor=${all.body.next_cursor}`);
    expect(rest.body.items.map((n: { id: string }) => n.id)).toEqual([ids[0]]);
    expect(rest.body.next_cursor).toBeNull();

    const read = await call(ctx, w.teacher, "POST", `/notifications/${ids[1]}/read`);
    expect(read.status).toBe(200);
    expectContract(read, "post", "/notifications/{id}/read");
    expect(read.body.data.read_at).toBeTruthy();
    const unread = await call(ctx, w.teacher, "GET", "/notifications?status=unread");
    expect(unread.body.items.map((n: { id: string }) => n.id)).toEqual([ids[2], ids[0]]);
    expect((await call(ctx, w.teacher, "GET", "/notifications?status=read")).body.items.map((n: { id: string }) => n.id)).toEqual([ids[1]]);

    // Someone else's notification is indistinguishable from a missing one.
    const foreign = await call(ctx, w.student, "POST", `/notifications/${ids[0]}/read`);
    expect(foreign.status).toBe(404);
    expect((await call(ctx, w.student, "GET", "/notifications")).body.items.map((n: { id: string }) => n.id)).not.toContain(ids[0]);

    const readAll = await call(ctx, w.teacher, "POST", "/notifications/read-all");
    expect(readAll.status).toBe(200);
    expectContract(readAll, "post", "/notifications/read-all");
    expect(readAll.body.data.updated).toBe(2);
    expect((await call(ctx, w.teacher, "GET", "/notifications?status=unread")).body.items).toEqual([]);

    expect((await call(ctx, w.teacher, "GET", "/notifications?status=bogus")).status).toBe(422);
    expect((await call(ctx, null, "GET", "/notifications")).status).toBe(401);
    // Web users (cookie) use the same endpoint; state-changing calls need the CSRF token.
    const web = await cookieCaller(ctx, { userId: w.org.teacher.userId, orgId: w.org.orgId, role: "teacher" });
    expect((await call(ctx, web, "GET", "/notifications")).status).toBe(200);
    const noCsrf = await call(ctx, { ...web, headers: () => ({ Cookie: web.headers("GET").Cookie! }) }, "POST", "/notifications/read-all");
    expect(noCsrf.status).toBe(403);
  });
});

describe("queue consumer", () => {
  it("acks processed and malformed messages; asks for redelivery on infrastructure errors", async () => {
    const slot = await createSlotViaApi(ctx, w.admin, slotBody(w.org));
    const r = await reserve(ctx, w.student, slot.id);
    const row = await lastOutbox(r.id, "reservation.created");
    const outcomes: string[] = [];
    const msg = (body: unknown) => ({ body, ack: () => outcomes.push("ack"), retry: () => outcomes.push("retry") });
    await handleNotificationBatch(ctx.deps, [msg({ org_id: w.org.orgId, outbox_id: row.id }), msg({ nope: true }), msg("garbage")]);
    expect(outcomes).toEqual(["ack", "ack", "ack"]);
    expect((await lastOutbox(r.id, "reservation.created")).state).toBe("delivered");

    const broken = { ...ctx.deps, connections: { acquire: async () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:1")) } };
    outcomes.length = 0;
    await handleNotificationBatch(broken, [msg({ org_id: w.org.orgId, outbox_id: row.id })]);
    expect(outcomes).toEqual(["retry"]);
  });
});
