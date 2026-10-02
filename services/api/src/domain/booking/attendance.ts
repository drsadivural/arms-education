/**
 * Attendance (出欠, IOS-16). Recorded by an admin or the slot's teacher.
 *
 * Roster rule: students holding an APPROVED reservation for the slot, plus students that already have an
 * attendance record for it (so a record stays correctable after the reservation changed). Classroom members
 * without an approved booking are not on the roster — booking is how a student joins a lesson, and capacity
 * is enforced through reservations. Attendance opens 30 minutes before the lesson starts and is closed for
 * cancelled slots. After each change the shared progress service recomputes the affected students.
 */
import { ATTENDANCE_OPENS_BEFORE_SECONDS } from "@arms/contracts";
import type { Actor } from "../../context";
import type { Tx } from "../../db/client";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { fail, validationError } from "../../http/errors";
import { recomputeStudentProgress } from "../progress";
import { iso, isoOrNull } from "./common";
import { findSlot, type SlotRow } from "./slots";

export type AttendanceState = "present" | "absent" | "late" | "excused";

interface RosterRow {
  student_id: string;
  student_name: string;
  employee_number: string;
  reservation_id: string | null;
  reservation_status: "pending" | "approved" | "rejected" | "cancelled" | "expired" | "removed" | null;
  attendance_state: AttendanceState | null;
  note: string;
  recorded_by_name: string | null;
  recorded_at: Date | null;
}

/** The slot if the actor may take its attendance: 404 when not visible, 403 when visible but not theirs. */
async function attendanceSlot(tx: Tx, actor: Actor, slotId: string): Promise<SlotRow> {
  const slot = await findSlot(tx, actor, slotId);
  if (!slot) fail("NOT_FOUND");
  if (actor.role === "student") fail("FORBIDDEN");
  if (actor.role === "teacher" && slot.teacher_id !== actor.userId) fail("FORBIDDEN", { message_ja: "担当している授業の出欠のみ記録できます。" });
  return slot;
}

const isEditable = (slot: SlotRow, now: Date) =>
  slot.state !== "cancelled" && now.getTime() >= slot.starts_at.getTime() - ATTENDANCE_OPENS_BEFORE_SECONDS * 1000;

async function rosterRows(tx: Tx, orgId: string, slotId: string): Promise<RosterRow[]> {
  return tx.query<RosterRow>(sql`
    WITH roster AS (
      SELECT r.student_id FROM app.reservations r WHERE r.org_id = ${orgId} AND r.slot_id = ${slotId} AND r.status = 'approved'
      UNION
      SELECT a.student_id FROM app.attendance a WHERE a.org_id = ${orgId} AND a.slot_id = ${slotId}
    )
    SELECT ro.student_id, u.display_name AS student_name, sp.employee_number,
           lr.id AS reservation_id, lr.status AS reservation_status,
           a.state AS attendance_state, coalesce(a.note, '') AS note, ru.display_name AS recorded_by_name, a.updated_at AS recorded_at
    FROM roster ro
    JOIN app.users u ON u.id = ro.student_id
    JOIN app.student_profiles sp ON sp.org_id = ${orgId} AND sp.id = ro.student_id
    LEFT JOIN LATERAL (
      SELECT r.id, r.status FROM app.reservations r
      WHERE r.org_id = ${orgId} AND r.slot_id = ${slotId} AND r.student_id = ro.student_id
      ORDER BY (r.status = 'approved') DESC, r.created_at DESC LIMIT 1
    ) lr ON TRUE
    LEFT JOIN app.attendance a ON a.org_id = ${orgId} AND a.slot_id = ${slotId} AND a.student_id = ro.student_id
    LEFT JOIN app.users ru ON ru.id = a.recorded_by
    ORDER BY sp.employee_number, ro.student_id`);
}

export async function getAttendanceRoster(tx: Tx, actor: Actor, slotId: string, now: Date) {
  const slot = await attendanceSlot(tx, actor, slotId);
  const rows = await rosterRows(tx, actor.orgId, slotId);
  return {
    slot_id: slot.id,
    slot_title: slot.title,
    starts_at: iso(slot.starts_at),
    ends_at: iso(slot.ends_at),
    state: slot.state,
    editable: isEditable(slot, now),
    items: rows.map((r) => ({
      student_id: r.student_id,
      student_name: r.student_name,
      employee_number: r.employee_number,
      reservation_id: r.reservation_id,
      reservation_status: r.reservation_status,
      attendance_state: r.attendance_state,
      note: r.note,
      recorded_by_name: r.recorded_by_name,
      recorded_at: isoOrNull(r.recorded_at),
    })),
  };
}

export async function recordAttendance(
  tx: Tx,
  actor: Actor,
  slotId: string,
  now: Date,
  records: { student_id: string; state: AttendanceState; note?: string }[],
): Promise<{ slot_id: string; records: { student_id: string; state: AttendanceState; note: string }[] }> {
  await attendanceSlot(tx, actor, slotId);
  // Serialise with reservation changes on the same slot.
  await tx.query(sql`SELECT id FROM app.lesson_slots WHERE org_id = ${actor.orgId} AND id = ${slotId} FOR UPDATE`);
  const slot = await findSlot(tx, actor, slotId);
  if (!slot) fail("NOT_FOUND");
  if (slot.state === "cancelled") fail("SLOT_CANCELLED");
  if (!isEditable(slot, now)) fail("ATTENDANCE_NOT_OPEN");

  const fieldErrors: Record<string, string> = {};
  const seen = new Map<string, number>();
  records.forEach((r, i) => {
    const id = r.student_id.toLowerCase();
    if (seen.has(id)) fieldErrors[`records.${i}.student_id`] = "同じ受講者が複数回指定されています。";
    seen.set(id, i);
  });
  const roster = new Set((await rosterRows(tx, actor.orgId, slotId)).map((r) => r.student_id));
  records.forEach((r, i) => {
    if (!roster.has(r.student_id.toLowerCase())) fieldErrors[`records.${i}.student_id`] ??= "この授業の承認済み受講者ではありません。";
  });
  if (Object.keys(fieldErrors).length) throw validationError(fieldErrors);

  const saved: { student_id: string; state: AttendanceState; note: string }[] = [];
  for (const r of records) {
    const studentId = r.student_id.toLowerCase();
    const note = r.note ?? "";
    const before = await tx.maybeOne<{ state: AttendanceState; note: string }>(sql`
      SELECT state, note FROM app.attendance WHERE org_id = ${actor.orgId} AND slot_id = ${slotId} AND student_id = ${studentId}`);
    await tx.exec(sql`
      INSERT INTO app.attendance(org_id, slot_id, student_id, state, recorded_by, note, updated_at)
      VALUES (${actor.orgId}, ${slotId}, ${studentId}, ${r.state}, ${actor.userId}, ${note}, now())
      ON CONFLICT (org_id, slot_id, student_id) DO UPDATE SET state = EXCLUDED.state, note = EXCLUDED.note,
        recorded_by = EXCLUDED.recorded_by, updated_at = now()`);
    if (!before || before.state !== r.state || before.note !== note) {
      await tx.exec(sql`INSERT INTO app.audit_events(org_id, actor_id, event_type, entity_id, payload)
        VALUES (${actor.orgId}, ${actor.userId}, 'attendance.recorded', ${slotId}, ${json({
          slot_id: slotId,
          student_id: studentId,
          before: before?.state ?? null,
          after: r.state,
          note_changed: (before?.note ?? "") !== note,
        })}::jsonb)`);
    }
    saved.push({ student_id: studentId, state: r.state, note });
  }
  // Attendance is completion evidence for units with required_attendance (shared progress service).
  for (const studentId of new Set(saved.map((s) => s.student_id))) {
    await recomputeStudentProgress(tx, actor.orgId, studentId);
  }
  return { slot_id: slotId, records: saved };
}
