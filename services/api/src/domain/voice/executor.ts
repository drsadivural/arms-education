/**
 * Server-side execution of voice tool calls. Every tool reuses the same domain services (and therefore the same
 * authorisation and DB rules) as the REST API. Writes use a two-step prepare → commit with a 256-bit action token
 * whose SHA-256 is bound to the organisation, user, voice session and intent and expires after 120 seconds;
 * the commit consumes the token in the same transaction that creates/cancels the reservation.
 */
import {
  RESERVATION_STATUS_LABELS,
  UNIT_STATE_LABELS,
  addDays,
  formatDateJa,
  formatTimeJa,
  zonedDateString,
  zonedParts,
  type LessonSlot,
  type Reservation,
} from "@arms/contracts";
import { json } from "../../db/client";
import { sql } from "../../db/sql";
import { ApiError } from "../../http/errors";
import { randomToken, sha256Hex } from "../../auth/crypto";
import type { BookingScope, TxWrapper } from "../booking/common";
import { bookingTx } from "../booking/common";
import { findSlot, listSlots, listTodayLessons, toSlotDto } from "../booking/slots";
import { createReservation, decideReservation, getReservation, listReservations } from "../booking/reservations";
import type { ToolName } from "./tools";
import { readStudentProgress } from "../progress";
import { canSeeStudent } from "../learning/common";

export const ACTION_TTL_SECONDS = 120;

export interface ToolContext {
  b: BookingScope;
  sessionId: string;
}

export type ToolOutcome = { success: true; data: Record<string, unknown> } | { success: false; data: { error_code: string; message_ja: string } & Record<string, unknown> };

const fail = (code: string, message_ja: string, extra: Record<string, unknown> = {}): ToolOutcome => ({ success: false, data: { error_code: code, message_ja, ...extra } });

function hourJa(d: Date | string, tz: string): string {
  const p = zonedParts(d, tz);
  return p.minute === 0 ? `${p.hour}時` : `${p.hour}時${p.minute}分`;
}

function teacherHonorific(name: string): string {
  const family = name.trim().split(/[\s\u3000]+/)[0] ?? name;
  return `${family}講師`;
}

function slotSummary(s: LessonSlot, tz: string) {
  const date = zonedDateString(s.starts_at, tz);
  return {
    slot_id: s.id,
    title: s.title,
    date,
    date_ja: formatDateJa(date),
    start: formatTimeJa(s.starts_at, tz),
    end: formatTimeJa(s.ends_at, tz),
    teacher_name: s.teacher_name,
    classroom_name: s.classroom_name,
    remaining: s.remaining,
    state: s.state,
    ...(s.my_reservation ? { my_reservation_status: s.my_reservation.status, my_reservation_status_ja: RESERVATION_STATUS_LABELS[s.my_reservation.status] } : {}),
  };
}

function reservationSummary(r: Reservation, tz: string) {
  const date = zonedDateString(r.starts_at, tz);
  return {
    reservation_id: r.id,
    title: r.slot_title ?? "",
    date,
    date_ja: formatDateJa(date),
    start: formatTimeJa(r.starts_at, tz),
    end: formatTimeJa(r.ends_at, tz),
    status: r.status,
    status_ja: RESERVATION_STATUS_LABELS[r.status],
    teacher_name: r.teacher_name ?? "",
    ...(r.student_name ? { student_name: r.student_name } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    ...(r.status === "pending" ? { hold_expires_at: r.expires_at } : {}),
    ...(r.cancel_deadline ? { cancel_deadline: r.cancel_deadline } : {}),
  };
}

const BANDS: Record<string, (hour: number) => boolean> = {
  morning: (h) => h < 12,
  afternoon: (h) => h >= 12 && h < 17,
  evening: (h) => h >= 17,
  any: () => true,
};

interface ActionRow {
  id: string;
  session_id: string;
  user_id: string;
  intent: "reserve" | "cancel";
  payload: Record<string, unknown>;
  expires_at: Date;
  consumed_at: Date | null;
  result: { status: number; body: unknown } | null;
}

async function createAction(ctx: ToolContext, intent: "reserve" | "cancel", payload: Record<string, unknown>) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const { actor } = ctx.b;
  const expiresAt = new Date(ctx.b.deps.now().getTime() + ACTION_TTL_SECONDS * 1000);
  await bookingTx(ctx.b, (tx) =>
    tx.exec(sql`INSERT INTO app.voice_actions(org_id, session_id, user_id, token_hash, intent, payload, expires_at)
      VALUES (${actor.orgId}, ${ctx.sessionId}, ${actor.userId}, ${tokenHash}, ${intent}, ${json(payload)}::jsonb, ${expiresAt})`),
  );
  return { token, expiresAt };
}

/** Reads the action for the caller's session without locking (to learn the target); the commit re-validates under lock. */
async function peekAction(ctx: ToolContext, token: string, intent: "reserve" | "cancel"): Promise<ActionRow | null> {
  const tokenHash = await sha256Hex(token);
  const { actor } = ctx.b;
  return bookingTx(ctx.b, (tx) =>
    tx.maybeOne<ActionRow>(sql`SELECT * FROM app.voice_actions
      WHERE org_id = ${actor.orgId} AND token_hash = ${tokenHash} AND user_id = ${actor.userId} AND session_id = ${ctx.sessionId} AND intent = ${intent}`),
  );
}

/** Consumes the token atomically with the reservation write; a consumed token replays its recorded result. */
function consumingWrap(ctx: ToolContext, token: string, intent: "reserve" | "cancel"): TxWrapper {
  return async (tx, work) => {
    const tokenHash = await sha256Hex(token);
    const { actor } = ctx.b;
    const row = await tx.maybeOne<ActionRow>(sql`SELECT * FROM app.voice_actions
      WHERE org_id = ${actor.orgId} AND token_hash = ${tokenHash} AND user_id = ${actor.userId} AND session_id = ${ctx.sessionId} AND intent = ${intent}
      FOR UPDATE`);
    if (!row) throw new ApiError("ACTION_TOKEN_INVALID");
    if (row.consumed_at && row.result) return row.result as never;
    if (new Date(row.expires_at) <= ctx.b.deps.now()) throw new ApiError("ACTION_TOKEN_INVALID");
    const result = await work();
    await tx.exec(sql`UPDATE app.voice_actions SET consumed_at = now(), result = ${json(result)}::jsonb WHERE org_id = ${actor.orgId} AND id = ${row.id}`);
    return result;
  };
}

export async function executeTool(ctx: ToolContext, name: ToolName, args: Record<string, unknown>): Promise<ToolOutcome> {
  const { b } = ctx;
  const tz = b.actor.timezone;
  const now = b.deps.now();
  const checkedAt = now.toISOString();
  try {
    switch (name) {
      case "today_lessons": {
        const today = zonedDateString(now, tz);
        const rows = await bookingTx(b, (tx) => listTodayLessons(tx, b.actor, today, null, 50));
        const lessons = rows.slice(0, 50).map((r) => slotSummary(toSlotDto(r, b.actor), tz));
        return { success: true, data: { date: today, date_ja: formatDateJa(today, { withYear: true }), lessons, count: lessons.length, checked_at: checkedAt } };
      }
      case "search_slots": {
        const { date, time_band } = args as { date: string; time_band: string };
        const today = zonedDateString(now, tz);
        if (date < today) return fail("PAST_DATE", "過去の日付は検索できません。日付を確認してください。");
        if (date > addDays(today, 90)) return fail("TOO_FAR", "90日より先の空き枠は検索できません。");
        const rows = await bookingTx(b, (tx) => listSlots(tx, b.actor, { from: date, to: date, states: ["open"], cursor: null, limit: 100 }));
        const all = rows.map((r) => toSlotDto(r, b.actor)).filter((s) => BANDS[time_band]?.(zonedParts(s.starts_at, tz).hour) ?? false);
        const bookable = all.filter((s) => s.remaining > 0 && new Date(s.booking_closes_at) > now && new Date(s.starts_at) > now);
        return {
          success: true,
          data: { date, date_ja: formatDateJa(date), time_band, slots: bookable.map((s) => slotSummary(s, tz)), full_or_closed_count: all.length - bookable.length, checked_at: checkedAt },
        };
      }
      case "get_reservations": {
        const { reservation_id } = args as { reservation_id?: string };
        if (reservation_id) {
          const r = await bookingTx(b, (tx) => getReservation(tx, b.actor, reservation_id, checkedAt));
          return { success: true, data: { reservation: reservationSummary(r, tz), checked_at: checkedAt } };
        }
        const from = addDays(zonedDateString(now, tz), -7);
        const page = await bookingTx(b, (tx) => listReservations(tx, b.actor, { statuses: null, from, sort: "starts_at", cursor: null, limit: 20 }, checkedAt));
        return { success: true, data: { reservations: page.items.map((r) => reservationSummary(r, tz)), from, checked_at: checkedAt } };
      }
      case "prepare_reservation": {
        const { slot_id } = args as { slot_id: string };
        const row = await bookingTx(b, (tx) => findSlot(tx, b.actor, slot_id));
        if (!row) return fail("NOT_FOUND", "指定の授業が見つかりません。空き枠をもう一度検索してください。");
        const s = toSlotDto(row, b.actor);
        if (s.state !== "open" || new Date(s.booking_closes_at) <= now || new Date(s.starts_at) <= now) return fail("BOOKING_CLOSED", "この授業は予約受付を終了しています。");
        if (s.my_reservation && (s.my_reservation.status === "pending" || s.my_reservation.status === "approved")) {
          return fail("ALREADY_RESERVED", `この授業は既に申請済みです（${RESERVATION_STATUS_LABELS[s.my_reservation.status]}）。`);
        }
        if (s.remaining <= 0) return fail("SLOT_FULL", "この授業は満席です。");
        const overlap = await bookingTx(b, (tx) =>
          tx.maybeOne(sql`SELECT 1 FROM app.reservations WHERE org_id = ${b.actor.orgId} AND student_id = ${b.actor.userId}
            AND (status = 'approved' OR (status = 'pending' AND expires_at > now()))
            AND tstzrange(starts_at, ends_at, '[)') && tstzrange(${s.starts_at}::timestamptz, ${s.ends_at}::timestamptz, '[)')`),
        );
        if (overlap) return fail("TIME_CONFLICT", "同じ時間に別の予約があります。");
        const summary = slotSummary(s, tz);
        const confirmation = `${summary.date_ja}${hourJa(s.starts_at, tz)}から、${teacherHonorific(s.teacher_name)}の${s.title}を予約申請します。申請してよろしいですか？`;
        const { token, expiresAt } = await createAction(ctx, "reserve", {
          slot_id: s.id,
          idempotency_key: crypto.randomUUID(),
          confirmation_ja: confirmation,
          summary,
        });
        return { success: true, data: { action_token: token, expires_at: expiresAt.toISOString(), confirmation_ja: confirmation, card: summary, checked_at: checkedAt } };
      }
      case "commit_reservation": {
        const { action_token } = args as { action_token: string };
        const action = await peekAction(ctx, action_token, "reserve");
        if (!action) return fail("ACTION_TOKEN_INVALID", "確認の有効期限が切れたか、無効です。もう一度内容を確認してください。");
        const p = action.payload as { slot_id: string; idempotency_key: string };
        const result = await createReservation(b, p.slot_id, p.idempotency_key, consumingWrap(ctx, action_token, "reserve"));
        const r = result.body;
        return {
          success: true,
          data: {
            reservation: reservationSummary(r, tz),
            message_ja: r.status === "approved" ? "予約は承認済みです。" : "予約を申請しました。現在は承認待ちです。",
            checked_at: r.checked_at,
          },
        };
      }
      case "prepare_cancellation": {
        const { reservation_id } = args as { reservation_id: string };
        const r = await bookingTx(b, (tx) => getReservation(tx, b.actor, reservation_id, checkedAt));
        if (r.status !== "pending" && r.status !== "approved") return fail("INVALID_STATE", `この予約は${RESERVATION_STATUS_LABELS[r.status]}のため取消できません。`);
        if (r.cancel_deadline && new Date(r.cancel_deadline) <= now) return fail("CANCELLATION_CLOSED", "取消期限を過ぎているため取消できません。");
        const summary = reservationSummary(r, tz);
        const confirmation = `${summary.date_ja}${hourJa(r.starts_at, tz)}からの${summary.title}の予約を取り消します。よろしいですか？`;
        const { token, expiresAt } = await createAction(ctx, "cancel", {
          reservation_id: r.id,
          expected_version: r.row_version,
          confirmation_ja: confirmation,
          summary,
        });
        return { success: true, data: { action_token: token, expires_at: expiresAt.toISOString(), confirmation_ja: confirmation, card: summary, checked_at: checkedAt } };
      }
      case "commit_cancellation": {
        const { action_token } = args as { action_token: string };
        const action = await peekAction(ctx, action_token, "cancel");
        if (!action) return fail("ACTION_TOKEN_INVALID", "確認の有効期限が切れたか、無効です。もう一度内容を確認してください。");
        const p = action.payload as { reservation_id: string; expected_version: number };
        const result = await decideReservation(b, p.reservation_id, "cancel", { expected_version: p.expected_version }, consumingWrap(ctx, action_token, "cancel"));
        return { success: true, data: { reservation: reservationSummary(result.body, tz), message_ja: "予約を取り消しました。", checked_at: result.body.checked_at } };
      }
      case "get_progress":
        return await executeGetProgress(ctx, args as { student_id?: string });
    }
  } catch (e) {
    if (e instanceof ApiError) return fail(e.code, e.message_ja);
    throw e;
  }
}

/** get_progress is served by the shared progress service (docs/04 「Web/iOS/AIは同じprogress serviceを呼ぶ」). */
async function executeGetProgress(ctx: ToolContext, args: { student_id?: string }): Promise<ToolOutcome> {
  const { b } = ctx;
  const actor = b.actor;
  const now = b.deps.now();
  const today = zonedDateString(now, actor.timezone);
  let studentId: string;
  if (actor.role === "student") {
    if (args.student_id && args.student_id !== actor.userId) return fail("FORBIDDEN", "ご本人以外の進捗は確認できません。");
    studentId = actor.userId;
  } else {
    if (!args.student_id) return fail("STUDENT_REQUIRED", "どの受講者の進捗かを確認してください。");
    studentId = args.student_id;
  }
  const result = await bookingTx(b, async (tx) => {
    if (actor.role !== "student") {
      const access = await canSeeStudent(tx, actor, studentId);
      if (access !== "ok") return null;
    }
    return readStudentProgress(tx, actor.orgId, studentId, today);
  });
  if (!result) return fail("NOT_FOUND", "担当の受講者が見つかりません。");
  const units = result.units as { title: string; state: keyof typeof UNIT_STATE_LABELS; score: number | null; required: boolean; program_name: string }[];
  return {
    success: true,
    data: {
      student_name: result.student_name,
      progress_percent: result.progress_percent,
      progress_ja: result.progress_percent === null ? "未設定（必須の単元が割り当てられていません）" : `${result.progress_percent}%`,
      required_total: result.required_total,
      required_completed: result.required_completed,
      programs: (result.enrollments as { program_name: string; due_on: string; overdue: boolean; progress_percent: number | null }[]).map((e) => ({
        program_name: e.program_name,
        due_on: e.due_on,
        due_ja: formatDateJa(e.due_on),
        overdue: e.overdue,
        progress_percent: e.progress_percent,
      })),
      units: units.map((u) => ({ title: u.title, program_name: u.program_name, required: u.required, state_ja: UNIT_STATE_LABELS[u.state] ?? u.state, score: u.score })),
      checked_at: now.toISOString(),
    },
  };
}
