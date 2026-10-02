/** Japanese display labels for enum values. Colour is never the only state signal: always render the label text. */

export const ROLE_LABELS = { admin: "管理者", teacher: "講師", student: "受講者" } as const;
export type Role = keyof typeof ROLE_LABELS;

export const RESERVATION_STATUS_LABELS = {
  pending: "承認待ち",
  approved: "承認済み",
  rejected: "却下",
  cancelled: "取消済み",
  expired: "申請期限切れ",
  removed: "削除済み",
} as const;
export type ReservationStatus = keyof typeof RESERVATION_STATUS_LABELS;

/** Statuses that hold a seat (pending holds it until expires_at). */
export const SEAT_HOLDING_STATUSES: readonly ReservationStatus[] = ["pending", "approved"];

export const UNIT_STATE_LABELS = {
  not_started: "未着手",
  in_progress: "受講中",
  review_pending: "確認待ち",
  completed: "完了",
} as const;
export type UnitState = keyof typeof UNIT_STATE_LABELS;

export const PROGRESS_RECORD_STATE_LABELS = {
  unverified: "未確認",
  not_started: "未着手",
  in_progress: "受講中",
  review_pending: "確認待ち",
  completed: "完了",
} as const;
export type ProgressRecordState = keyof typeof PROGRESS_RECORD_STATE_LABELS;

/** Derived (not stored) label shown when the due date passed and the record is not completed. */
export const OVERDUE_LABEL = "期限超過";

export const MATERIAL_KIND_LABELS = {
  pdf: "PDF",
  video: "動画",
  image: "画像",
  link: "外部リンク",
  quiz: "確認テスト",
  assignment: "課題",
} as const;
export type MaterialKind = keyof typeof MATERIAL_KIND_LABELS;

export const SCAN_STATE_LABELS = {
  pending: "検査待ち",
  clean: "検査済み",
  blocked: "公開不可（検出）",
  not_applicable: "検査対象外",
} as const;
export type ScanState = keyof typeof SCAN_STATE_LABELS;

export const VERSION_STATE_LABELS = { draft: "下書き", published: "公開中", archived: "公開終了" } as const;

export const SLOT_STATE_LABELS = { open: "受付中", closed: "受付終了", cancelled: "取消" } as const;

export const ATTENDANCE_LABELS = { present: "出席", absent: "欠席", late: "遅刻", excused: "公欠" } as const;
export type AttendanceState = keyof typeof ATTENDANCE_LABELS;

export const SUBMISSION_STATE_LABELS = { submitted: "提出済み（確認待ち）", accepted: "承認", revision_requested: "再提出依頼" } as const;

export const INVITATION_STATE_LABELS = {
  pending: "招待準備中",
  auth_created: "アカウント作成済み",
  profile_created: "招待メール送信待ち",
  sent: "招待済み",
  failed: "送信失敗（再送可能）",
} as const;

export const IMPORT_STATE_LABELS = {
  uploaded: "アップロード済み",
  validated: "検証済み（未確定）",
  committing: "確定処理中",
  completed: "確定済み",
  failed: "失敗",
  rolled_back: "取り消し済み",
} as const;

export const OUTBOX_STATE_LABELS = { pending: "送信待ち", processing: "送信中", delivered: "送信済み", failed: "送信失敗" } as const;

export const VOICE_STATE_LABELS = {
  idle: "待機中",
  connecting: "接続中",
  listening: "聞いています",
  confirming: "確認中",
  speaking: "話しています",
  reconnecting: "再接続中",
  error: "エラー",
} as const;
export type VoiceUiState = keyof typeof VOICE_STATE_LABELS;

export const THEME_LABELS = { light: "ライト", dark: "ダーク", system: "端末の設定に合わせる" } as const;

// ---- area: admin (append below) ----

// ---- area: learning (append below) ----

// ---- area: booking & notifications (append below) ----

/** External notification channels (in-app notifications are always created). */
export const NOTIFICATION_CHANNEL_LABELS = { in_app: "アプリ内", email: "メール", push: "プッシュ通知" } as const;
export type NotificationChannel = keyof typeof NOTIFICATION_CHANNEL_LABELS;

export const NOTIFICATION_DELIVERY_STATE_LABELS = {
  pending: "送信待ち（再試行あり）",
  sent: "送信済み",
  failed: "送信失敗",
  skipped: "送信対象外",
  invalid_token: "無効な端末",
} as const;
export type NotificationDeliveryState = keyof typeof NOTIFICATION_DELIVERY_STATE_LABELS;

/** Reasons recorded (as codes) when an external delivery is skipped or fails; shown on WEB-19. */
export const NOTIFICATION_DELIVERY_ERROR_LABELS = {
  NOT_CONFIGURED: "送信サービス未設定",
  OPTED_OUT: "利用者が通知を停止",
  ORG_DISABLED: "組織で通知を停止",
  NO_ADDRESS: "宛先なし",
  MAIL_RATE_LIMITED: "メール送信の流量制限",
  MAIL_PROVIDER_UNAVAILABLE: "メール送信サービス障害",
  MAIL_REJECTED: "メール送信を拒否されました",
  APNS_RETRY: "APNs一時障害",
  APNS_REJECTED: "APNsが通知を拒否",
  APNS_INVALID_TOKEN: "端末トークン無効",
  TOKEN_UNREADABLE: "端末トークンを復号できません",
  NO_NOTIFICATION_RULE: "通知対象外のイベント",
  DISPATCH_ERROR: "通知処理エラー",
} as const;

/** Reservation decision actions as shown on confirmation dialogs (docs/04). */
export const RESERVATION_ACTION_LABELS = {
  approve: "承認",
  reject: "却下",
  cancel: "取消",
  remove: "削除（履歴を保持）",
} as const;
export type ReservationAction = keyof typeof RESERVATION_ACTION_LABELS;

/** Confirmation text for soft deletion (docs/04 「予約を削除し、履歴を保持します」). */
export const RESERVATION_REMOVE_CONFIRM_JA = "予約を削除し、履歴を保持します";

/** Attendance may be recorded from this many seconds before the lesson starts. */
export const ATTENDANCE_OPENS_BEFORE_SECONDS = 30 * 60;

// ---- area: voice (append below) ----

// ---- area: imports & exports (append below) ----
