/**
 * Booking test fixtures and test-only fakes of the notification integrations (same interfaces as production).
 */
import type pg from "pg";
import type { Mailer, MailMessage } from "../../src/integrations/mail";
import { MailDeliveryError } from "../../src/integrations/mail";
import type { PushPayload, PushResult, PushSender } from "../../src/integrations/push";
import { createDeviceTokenCipher } from "../../src/integrations/push";
import type { NotificationQueue, OutboxMessage } from "../../src/integrations/queue";
import { bearerCaller, call, cookieCaller, type Caller, type TestContext } from "./app";
import { seedOrg, type OrgScenario } from "./fixtures";

export const TEST_DEVICE_KEY = Buffer.alloc(32, 9).toString("base64");

export class FakeMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  failWith: MailDeliveryError | Error | null = null;
  async send(message: MailMessage) {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
    return { providerMessageId: `fake-${this.sent.length}` };
  }
}

export class FakePush implements PushSender {
  readonly sent: { token: string; environment: "sandbox" | "production"; payload: PushPayload }[] = [];
  /** Result per device token (default "sent"). */
  readonly results = new Map<string, PushResult>();
  private readonly cipher = createDeviceTokenCipher(TEST_DEVICE_KEY);
  async send(token: string, environment: "sandbox" | "production", payload: PushPayload): Promise<PushResult> {
    const result = this.results.get(token) ?? "sent";
    if (result === "sent") this.sent.push({ token, environment, payload });
    return result;
  }
  sealToken(token: string, aad: string) {
    return this.cipher.seal(token, aad);
  }
  openToken(sealed: string, aad: string) {
    return this.cipher.open(sealed, aad);
  }
}

export class FakeQueue implements NotificationQueue {
  readonly messages: OutboxMessage[] = [];
  fail = false;
  async enqueue(message: OutboxMessage) {
    if (this.fail) throw new Error("queue unavailable");
    this.messages.push(message);
  }
  async enqueueBatch(messages: readonly OutboxMessage[]) {
    if (this.fail) throw new Error("queue unavailable");
    this.messages.push(...messages);
  }
}

export const retryableMailError = () => new MailDeliveryError("MAIL_PROVIDER_UNAVAILABLE", true, 503);

export interface BookingWorld {
  org: OrgScenario;
  admin: Caller;
  teacher: Caller;
  otherTeacher: Caller;
  student: Caller;
  student2: Caller;
  otherStudent: Caller;
}

/** seedOrg + callers: admin via the Web BFF cookie (MFA done), teachers/students via iOS Bearer tokens. */
export async function bookingWorld(ctx: TestContext, settings: Record<string, unknown> = {}): Promise<BookingWorld> {
  const org = await seedOrg(ctx.admin, settings);
  return {
    org,
    admin: await cookieCaller(ctx, { userId: org.admin.userId, orgId: org.orgId, role: "admin" }),
    teacher: await bearerCaller(org.teacher.userId, org.orgId),
    otherTeacher: await bearerCaller(org.otherTeacher.userId, org.orgId),
    student: await bearerCaller(org.student.userId, org.orgId),
    student2: await bearerCaller(org.student2.userId, org.orgId),
    otherStudent: await bearerCaller(org.otherStudent.userId, org.orgId),
  };
}

let lastWindowStart = 0;
/**
 * Strictly increasing, non-overlapping future windows (teacher/classroom exclusion constraints): at least
 * `daysAhead` days from now and 2 hours after the previous window of this test file.
 */
export function nextWindow(opts: { daysAhead?: number; minutes?: number } = {}): { startsAt: Date; endsAt: Date } {
  const base = Math.ceil((Date.now() + (opts.daysAhead ?? 3) * 86_400_000) / 3_600_000) * 3_600_000;
  const start = Math.max(base, lastWindowStart + 2 * 3_600_000);
  lastWindowStart = start;
  return { startsAt: new Date(start), endsAt: new Date(start + (opts.minutes ?? 60) * 60_000) };
}

export function slotBody(
  org: OrgScenario,
  opts: { classroomId?: string; teacherId?: string; startsAt?: Date; endsAt?: Date; capacity?: number; closesAt?: Date; meetingUrl?: string | null; title?: string; daysAhead?: number } = {},
): Record<string, unknown> {
  const w = opts.startsAt ? { startsAt: opts.startsAt, endsAt: opts.endsAt ?? new Date(opts.startsAt.getTime() + 3_600_000) } : nextWindow({ daysAhead: opts.daysAhead });
  // Booking closes one hour before the start, or one minute before it for lessons starting soon.
  const hourBefore = w.startsAt.getTime() - 3_600_000;
  const closesAt = opts.closesAt ?? new Date(hourBefore > Date.now() + 120_000 ? hourBefore : w.startsAt.getTime() - 60_000);
  const body: Record<string, unknown> = {
    classroom_id: opts.classroomId ?? org.classroomId,
    teacher_id: opts.teacherId ?? org.teacher.userId,
    title: opts.title ?? "IT基礎",
    starts_at: w.startsAt.toISOString(),
    ends_at: w.endsAt.toISOString(),
    capacity: opts.capacity ?? 5,
    booking_closes_at: closesAt.toISOString(),
  };
  if (opts.meetingUrl !== null) body.meeting_url = opts.meetingUrl ?? "https://meet.example.invalid/room-1";
  return body;
}

/** Creates a slot through the API as the given caller; returns the LessonSlot DTO. */
export async function createSlotViaApi(ctx: TestContext, caller: Caller, body: Record<string, unknown>) {
  const res = await call(ctx, caller, "POST", "/lesson-slots", { body });
  if (res.status !== 200) throw new Error(`slot creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; row_version: number; starts_at: string; remaining: number };
}

/** Inserts a slot directly (owner pool) for states the API refuses to create (past, closed booking…). */
export async function insertSlot(
  admin: pg.Pool,
  orgId: string,
  opts: { classroomId: string; teacherId: string; startsAt: Date; endsAt: Date; closesAt: Date; capacity?: number; cancelBeforeSeconds?: number; meetingUrl?: string | null; title?: string },
): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO app.lesson_slots(org_id, classroom_id, teacher_id, title, starts_at, ends_at, capacity, booking_closes_at, cancel_before_seconds, pending_ttl_seconds, state, meeting_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 86400, 'open', $10) RETURNING id`,
    [orgId, opts.classroomId, opts.teacherId, opts.title ?? "fixture", opts.startsAt, opts.endsAt, opts.capacity ?? 5, opts.closesAt, opts.cancelBeforeSeconds ?? 86400, opts.meetingUrl ?? null],
  );
  return rows[0].id as string;
}

/** Student books the slot; returns the Reservation body. */
export async function reserve(ctx: TestContext, student: Caller, slotId: string, key: string = crypto.randomUUID()) {
  const res = await call(ctx, student, "POST", "/reservations", { body: { slot_id: slotId }, idempotencyKey: key });
  if (res.status !== 201) throw new Error(`reservation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; row_version: number; status: string; expires_at: string };
}

export async function decide(ctx: TestContext, caller: Caller, id: string, action: "approve" | "reject" | "cancel" | "remove", body: Record<string, unknown>, key?: string) {
  return call(ctx, caller, "POST", `/reservations/${id}/${action}`, { body, idempotencyKey: key });
}

export async function outboxRows(admin: pg.Pool, orgId: string, entityId: string) {
  const { rows } = await admin.query("SELECT id, event_type, state, attempts, last_error, next_attempt_at, delivered_at, payload FROM app.outbox WHERE org_id = $1 AND entity_id = $2 ORDER BY created_at, id", [orgId, entityId]);
  return rows as { id: string; event_type: string; state: string; attempts: number; last_error: string | null; next_attempt_at: Date; delivered_at: Date | null; payload: Record<string, unknown> }[];
}

export async function auditTypes(admin: pg.Pool, orgId: string, entityId: string): Promise<string[]> {
  const { rows } = await admin.query("SELECT event_type FROM app.audit_events WHERE org_id = $1 AND entity_id = $2 ORDER BY created_at, id", [orgId, entityId]);
  return rows.map((r) => r.event_type as string);
}
