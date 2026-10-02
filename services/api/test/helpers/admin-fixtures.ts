/**
 * Extra fixtures for the admin-area tests (programs, enrollments, unit progress, lesson slots, reservations,
 * outbox rows). Written through the owner pool like helpers/fixtures.ts.
 */
import type pg from "pg";

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1e4)}`;

export interface ProgramFixture {
  programId: string;
  versionId: string;
  unitIds: string[];
}

/** Program with one version holding required units of the given weights; published unless `state` says otherwise. */
export async function createProgramVersion(
  admin: pg.Pool,
  orgId: string,
  opts: { weights?: number[]; state?: "draft" | "published" | "archived"; name?: string } = {},
): Promise<ProgramFixture> {
  const { rows: p } = await admin.query("INSERT INTO app.programs(org_id, name) VALUES ($1, $2) RETURNING id", [orgId, opts.name ?? `基礎研修-${uniq()}`]);
  const programId = p[0].id as string;
  const { rows: v } = await admin.query("INSERT INTO app.program_versions(org_id, program_id, version_number, state) VALUES ($1, $2, 1, 'draft') RETURNING id", [
    orgId,
    programId,
  ]);
  const versionId = v[0].id as string;
  const unitIds: string[] = [];
  for (const [i, w] of (opts.weights ?? [1, 1]).entries()) {
    const { rows } = await admin.query("INSERT INTO app.units(org_id, program_version_id, title, position, weight) VALUES ($1, $2, $3, $4, $5) RETURNING id", [
      orgId,
      versionId,
      `単元${i + 1}`,
      i,
      w,
    ]);
    unitIds.push(rows[0].id as string);
  }
  const state = opts.state ?? "published";
  if (state !== "draft") {
    await admin.query("UPDATE app.program_versions SET state = $3, published_at = now() WHERE org_id = $1 AND id = $2", [orgId, versionId, state]);
  }
  return { programId, versionId, unitIds };
}

export async function enroll(admin: pg.Pool, orgId: string, studentId: string, versionId: string, createdAt?: string): Promise<string> {
  const { rows } = await admin.query(
    "INSERT INTO app.enrollments(org_id, student_id, program_version_id, due_on, created_at) VALUES ($1, $2, $3, '2026-12-31', coalesce($4::timestamptz, now())) RETURNING id",
    [orgId, studentId, versionId, createdAt ?? null],
  );
  return rows[0].id as string;
}

export async function completeUnit(admin: pg.Pool, orgId: string, enrollmentId: string, versionId: string, unitId: string, completedAt?: string): Promise<void> {
  await admin.query(
    `INSERT INTO app.unit_progress(org_id, enrollment_id, program_version_id, unit_id, state, completed_at)
     VALUES ($1, $2, $3, $4, 'completed', coalesce($5::timestamptz, now()))`,
    [orgId, enrollmentId, versionId, unitId, completedAt ?? null],
  );
}

export async function createSlot(
  admin: pg.Pool,
  orgId: string,
  opts: { classroomId: string; teacherId: string; startsAt: Date; minutes?: number; capacity?: number; state?: "open" | "closed" | "cancelled"; meetingUrl?: string | null },
): Promise<string> {
  const ends = new Date(opts.startsAt.getTime() + (opts.minutes ?? 60) * 60_000);
  const { rows } = await admin.query(
    `INSERT INTO app.lesson_slots(org_id, classroom_id, teacher_id, title, starts_at, ends_at, capacity, booking_closes_at, state, meeting_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $5, $8, $9) RETURNING id`,
    [orgId, opts.classroomId, opts.teacherId, `授業-${uniq()}`, opts.startsAt, ends, opts.capacity ?? 5, opts.state ?? "open", opts.meetingUrl === undefined ? "https://meet.example.invalid/room" : opts.meetingUrl],
  );
  return rows[0].id as string;
}

export async function createReservation(
  admin: pg.Pool,
  orgId: string,
  opts: { slotId: string; studentId: string; status?: "pending" | "approved" | "rejected" | "cancelled" | "expired" | "removed"; expiresAt?: Date },
): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO app.reservations(org_id, slot_id, student_id, starts_at, ends_at, status, expires_at, idempotency_key)
     SELECT org_id, id, $3, starts_at, ends_at, $4, coalesce($5::timestamptz, starts_at), gen_random_uuid() FROM app.lesson_slots WHERE org_id = $1 AND id = $2
     RETURNING id`,
    [orgId, opts.slotId, opts.studentId, opts.status ?? "pending", opts.expiresAt ?? null],
  );
  return rows[0].id as string;
}

export async function createOutbox(admin: pg.Pool, orgId: string, opts: { state?: "pending" | "processing" | "delivered" | "failed"; eventType?: string; attempts?: number } = {}): Promise<string> {
  const { rows } = await admin.query(
    "INSERT INTO app.outbox(org_id, event_type, entity_id, payload, state, attempts, next_attempt_at) VALUES ($1, $2, gen_random_uuid(), '{}'::jsonb, $3, $4, now() + interval '1 hour') RETURNING id",
    [orgId, opts.eventType ?? "reservation.approved", opts.state ?? "failed", opts.attempts ?? 5],
  );
  return rows[0].id as string;
}

export const futureDate = (days: number, hourUtc = 1) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
};
