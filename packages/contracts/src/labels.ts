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

/** Account (membership) state in user management, teacher and student lists. */
export const ACCOUNT_STATUS_LABELS = { active: "有効", inactive: "停止中" } as const;

/** Student enrolment state (Student.active). */
export const STUDENT_STATUS_LABELS = { active: "在籍", inactive: "在籍終了" } as const;

export const CLASSROOM_STATUS_LABELS = { active: "開講中", archived: "アーカイブ済み" } as const;

export const ACCOUNT_DELETION_STATE_LABELS = { requested: "申請中", reviewing: "確認中", completed: "対応完了" } as const;

export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** Japanese names of audit event types written by authentication and the admin area (WEB-19). */
export const ADMIN_EVENT_LABELS = {
  "auth.login": "ログイン",
  "auth.logout": "ログアウト",
  "auth.mfa_verified": "二段階認証",
  "teacher.created": "講師の登録",
  "teacher.updated": "講師情報の変更",
  "teacher.archived": "講師の停止",
  "student.created": "新入社員の登録",
  "student.updated": "新入社員情報の変更",
  "student.archived": "新入社員の在籍終了",
  "student.transferred": "クラス・担当講師の変更",
  "classroom.created": "クラスの作成",
  "classroom.updated": "クラスの変更",
  "classroom.archived": "クラスのアーカイブ",
  "settings.updated": "設定の変更",
  "invitation.sent": "招待メール送信",
  "invitation.failed": "招待メール送信失敗",
  "user.disabled": "アカウント停止",
  "user.enabled": "アカウント再開",
  "account.deletion_requested": "本人削除申請",
  "account.deletion_completed": "本人削除申請の対応完了",
  "notification.retry_requested": "通知の手動再送",
} as const;

// ---- area: learning (append below) ----

// ---- area: booking & notifications (append below) ----

// ---- area: voice (append below) ----

// ---- area: imports & exports (append below) ----
