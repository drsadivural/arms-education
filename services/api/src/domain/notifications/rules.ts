/**
 * Notification rules: which users an outbox event notifies and the Japanese text + deep link they receive.
 * Rules read the current data in the organisation's tenant context; texts never include private lesson URLs
 * (lock screens and mailboxes are not the place for them — the app shows the URL to the approved student).
 *
 * Deep links (iOS app routes; the Web maps the same paths):
 *   arms://reservations/<id>   予約の詳細（IOS-10 / WEB-14）
 *   arms://lessons/today       本日の授業（IOS-11）
 *   arms://lesson-slots/<id>   授業枠（WEB-15）
 *   arms://settings/users      設定 > ユーザー管理（WEB-18）
 * Other areas add their event types here (one entry per event_type); events without a rule are marked
 * delivered with last_error NO_NOTIFICATION_RULE so they are visible on the event log.
 */
import { formatSlotRangeJa } from "@arms/contracts";
import type { Tx } from "../../db/client";
import { sql } from "../../db/sql";

export interface OutboxEvent {
  id: string;
  event_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export interface NotificationDraft {
  userId: string;
  title: string;
  body: string;
  deepLink: string;
}

export interface RuleContext {
  tx: Tx;
  orgId: string;
  timezone: string;
  event: OutboxEvent;
}

export type NotificationRule = (ctx: RuleContext) => Promise<NotificationDraft[]>;

export const DEEP_LINKS = {
  reservation: (id: string) => `arms://reservations/${id}`,
  todayLessons: () => "arms://lessons/today",
  lessonSlot: (id: string) => `arms://lesson-slots/${id}`,
  settingsUsers: () => "arms://settings/users",
} as const;

interface ReservationContext {
  id: string;
  student_id: string;
  student_name: string;
  slot_id: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
  teacher_id: string;
}

async function reservationContext(tx: Tx, orgId: string, id: string): Promise<ReservationContext | null> {
  return tx.maybeOne<ReservationContext>(sql`
    SELECT r.id, r.student_id, su.display_name AS student_name, s.id AS slot_id, s.title, s.starts_at, s.ends_at, s.teacher_id
    FROM app.reservations r
    JOIN app.lesson_slots s ON s.org_id = r.org_id AND s.id = r.slot_id
    JOIN app.users su ON su.id = r.student_id
    WHERE r.org_id = ${orgId} AND r.id = ${id}`);
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 「IT基礎」10/5（月）14:00–15:30 */
const lessonLabel = (r: { title: string; starts_at: Date; ends_at: Date }, tz: string) => `「${r.title}」${formatSlotRangeJa(r.starts_at, r.ends_at, tz)}`;

function reservationRule(build: (r: ReservationContext, ctx: RuleContext) => NotificationDraft[]): NotificationRule {
  return async (ctx) => {
    const r = await reservationContext(ctx.tx, ctx.orgId, ctx.event.entity_id);
    return r ? build(r, ctx) : [];
  };
}

export const NOTIFICATION_RULES: Record<string, NotificationRule> = {
  "reservation.created": reservationRule((r, { timezone }) => [
    {
      userId: r.teacher_id,
      title: "予約申請が届きました",
      body: `${r.student_name}さんから${lessonLabel(r, timezone)}の予約申請がありました。承認または却下してください。`,
      deepLink: DEEP_LINKS.reservation(r.id),
    },
  ]),

  "reservation.approved": reservationRule((r, { timezone }) => [
    {
      userId: r.student_id,
      title: "予約が承認されました",
      body: `${lessonLabel(r, timezone)}の予約が承認されました。参加方法は予約の詳細でご確認ください。`,
      deepLink: DEEP_LINKS.reservation(r.id),
    },
  ]),

  "reservation.rejected": reservationRule((r, { timezone, event }) => [
    {
      userId: r.student_id,
      title: "予約が却下されました",
      body: `${lessonLabel(r, timezone)}の予約申請は却下されました。理由: ${text(event.payload.reason) ?? "（理由の記載なし）"}`,
      deepLink: DEEP_LINKS.reservation(r.id),
    },
  ]),

  "reservation.cancelled": reservationRule((r, { timezone, event }) =>
    event.payload.source === "slot_cancel"
      ? [
          {
            userId: r.student_id,
            title: "授業が取り消されました",
            body: `${lessonLabel(r, timezone)}は取り消されたため、予約は取消済みになりました。理由: ${text(event.payload.reason) ?? "（理由の記載なし）"}`,
            deepLink: DEEP_LINKS.reservation(r.id),
          },
        ]
      : [
          {
            userId: r.teacher_id,
            title: "予約が取り消されました",
            body: `${r.student_name}さんが${lessonLabel(r, timezone)}の予約を取り消しました。`,
            deepLink: DEEP_LINKS.reservation(r.id),
          },
        ],
  ),

  "reservation.expired": reservationRule((r, { timezone }) => [
    {
      userId: r.student_id,
      title: "予約申請の期限が切れました",
      body: `${lessonLabel(r, timezone)}の申請は承認されないまま保持期限を過ぎたため、申請期限切れになりました。必要な場合は再度申請してください。`,
      deepLink: DEEP_LINKS.reservation(r.id),
    },
  ]),

  "reservation.removed": reservationRule((r, { timezone, event }) => [
    {
      userId: r.student_id,
      title: "予約が削除されました",
      body: `${lessonLabel(r, timezone)}の予約は削除されました（履歴は保持されます）。理由: ${text(event.payload.reason) ?? "（理由の記載なし）"}`,
      deepLink: DEEP_LINKS.reservation(r.id),
    },
  ]),

  /** The slot's teacher is told when someone else (an admin) cancelled their lesson. */
  "lesson_slot.cancelled": async ({ tx, orgId, timezone, event }) => {
    const slot = await tx.maybeOne<{ id: string; title: string; starts_at: Date; ends_at: Date; teacher_id: string; actor_id: string | null }>(sql`
      SELECT s.id, s.title, s.starts_at, s.ends_at, s.teacher_id,
             (SELECT a.actor_id FROM app.audit_events a WHERE a.org_id = s.org_id AND a.entity_id = s.id AND a.event_type = 'lesson_slot.cancelled'
              ORDER BY a.created_at DESC LIMIT 1) AS actor_id
      FROM app.lesson_slots s WHERE s.org_id = ${orgId} AND s.id = ${event.entity_id}`);
    if (!slot || slot.actor_id === slot.teacher_id) return [];
    return [
      {
        userId: slot.teacher_id,
        title: "担当授業が取り消されました",
        body: `管理者が${lessonLabel(slot, timezone)}を取り消しました。予約していた受講者には通知済みです。理由: ${text(event.payload.reason) ?? "（理由の記載なし）"}`,
        deepLink: DEEP_LINKS.lessonSlot(slot.id),
      },
    ];
  },

  /** App Store account deletion requests (POST /me/account-deletion) go to every active admin. */
  "account.deletion_requested": async ({ tx, orgId, event }) => {
    const requester = text(event.payload.user_id)
      ? await tx.maybeOne<{ display_name: string }>(sql`SELECT display_name FROM app.users WHERE id = ${text(event.payload.user_id)}`)
      : null;
    const admins = await tx.query<{ id: string }>(sql`
      SELECT id FROM app.memberships WHERE org_id = ${orgId} AND role = 'admin' AND active ORDER BY id`);
    return admins.map((a) => ({
      userId: a.id,
      title: "アカウント削除の申請があります",
      body: `${requester?.display_name ?? "利用者"}さんからアカウント削除の申請がありました。設定 > ユーザー管理で内容を確認してください。`,
      deepLink: DEEP_LINKS.settingsUsers(),
    }));
  },
};
