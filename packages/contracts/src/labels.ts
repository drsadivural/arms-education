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
  "user.invited": "管理者の招待",
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
  MAIL_AUTH_FAILED: "メール送信サービスの認証エラー（設定を確認）",
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

/** WEB-17 データ移植: entities in the recommended order (講師 → クラス → 新入社員 → 教育進捗). */
export const IMPORT_ENTITIES = ["teachers", "classrooms", "students", "progress"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export const IMPORT_ENTITY_LABELS: Record<ImportEntity, string> = {
  teachers: "講師",
  classrooms: "クラス",
  students: "新入社員",
  progress: "社員教育進捗（旧システム）",
};

export const IMPORT_ENCODINGS = ["utf-8", "utf-8-bom", "cp932"] as const;
export type ImportEncoding = (typeof IMPORT_ENCODINGS)[number];
export const IMPORT_ENCODING_LABELS: Record<ImportEncoding | "ascii", string> = {
  "utf-8": "UTF-8",
  "utf-8-bom": "UTF-8（BOM付き）",
  cp932: "Shift_JIS（CP932）",
  ascii: "英数字のみ（どの文字コードでも同じ）",
};

/** docs/08 初期上限: CSV 10MB / 10,000 data rows. */
export const IMPORT_LIMITS = { maxBytes: 10 * 1024 * 1024, maxRows: 10_000 } as const;

/** Default 移行元システム名. Re-imports must use the same name (progress records are unique per source system + ID). */
export const IMPORT_DEFAULT_SOURCE_SYSTEM = "旧社員教育進捗管理";

export const IMPORT_ACTION_LABELS = { create: "新規", update: "更新", skip: "変更なし", error: "エラー" } as const;
export type ImportAction = keyof typeof IMPORT_ACTION_LABELS;
export const IMPORT_COMMIT_STATE_LABELS = { applied: "反映済み", pending_activation: "反映中", conflict: "競合のため未反映" } as const;
export const IMPORT_ROLLBACK_STATE_LABELS = { reverted: "取り消し済み", manual: "手動照合が必要" } as const;

export interface ImportFieldDef {
  field: string;
  label: string;
  required: boolean;
  /** Meaning of an empty cell, shown on the mapping screen (docs/08 「空値/NULLの意味をmapping画面で表示」). */
  empty: string;
  /** Header names suggested automatically on the mapping screen (compared after NFKC + trim + lower-case). */
  aliases: readonly string[];
  /** Matching key of the record (people are matched by number only, never by name). */
  key?: boolean;
}

/**
 * Target fields per entity. Unmapped optional fields use the default for new records and leave existing records
 * unchanged. Required fields must be mapped and filled in every row.
 */
export const IMPORT_FIELDS: Record<ImportEntity, readonly ImportFieldDef[]> = {
  teachers: [
    { field: "teacher_number", label: "講師番号", required: true, key: true, empty: "空欄不可（照合キー。同姓同名でも講師番号で区別）", aliases: ["講師番号", "講師ID", "講師コード"] },
    { field: "display_name", label: "氏名", required: true, empty: "空欄不可", aliases: ["氏名", "講師名", "名前"] },
    { field: "kana", label: "ふりがな", required: false, empty: "空欄＝ふりがななし", aliases: ["ふりがな", "フリガナ", "よみがな", "カナ"] },
    { field: "email", label: "メール", required: true, empty: "空欄不可（ログインID・招待先。登録済み講師は変更不可）", aliases: ["メール", "メールアドレス", "email", "e-mail", "Eメール"] },
    { field: "department_name", label: "部署", required: false, empty: "空欄＝部署なし", aliases: ["部署", "所属部署", "所属"] },
    { field: "active", label: "状態", required: false, empty: "空欄＝有効（有効／無効で指定。登録済み講師の状態は変更しない）", aliases: ["状態", "ステータス", "有効"] },
  ],
  classrooms: [
    { field: "classroom_code", label: "クラス番号", required: true, key: true, empty: "空欄不可（照合キー。新入社員のクラス番号と対応）", aliases: ["クラス番号", "クラスID", "クラスコード"] },
    { field: "name", label: "名称", required: true, empty: "空欄不可", aliases: ["名称", "クラス名", "クラス名称"] },
    { field: "capacity", label: "定員", required: true, empty: "空欄不可（1〜10,000の整数）", aliases: ["定員", "定員数"] },
    { field: "starts_on", label: "開始日", required: true, empty: "空欄不可", aliases: ["開始日", "研修開始日", "期間開始"] },
    { field: "ends_on", label: "終了日", required: true, empty: "空欄不可", aliases: ["終了日", "研修終了日", "期間終了"] },
    { field: "primary_teacher_number", label: "主担当講師番号", required: true, empty: "空欄不可（講師管理の講師番号）", aliases: ["主担当講師番号", "主担当講師", "担当講師番号", "講師番号"] },
  ],
  students: [
    { field: "employee_number", label: "社員番号", required: true, key: true, empty: "空欄不可（照合キー。同姓同名でも社員番号で区別）", aliases: ["社員番号", "社員ID", "従業員番号"] },
    { field: "display_name", label: "氏名", required: true, empty: "空欄不可", aliases: ["氏名", "社員名", "名前"] },
    { field: "kana", label: "ふりがな", required: false, empty: "空欄＝ふりがななし", aliases: ["ふりがな", "フリガナ", "よみがな", "カナ"] },
    { field: "email", label: "メール", required: true, empty: "空欄不可（ログインID・招待先。登録済み社員は変更不可）", aliases: ["メール", "メールアドレス", "email", "e-mail", "Eメール"] },
    { field: "company_name", label: "会社名", required: false, empty: "空欄＝会社名なし", aliases: ["会社名", "所属会社"] },
    { field: "department_name", label: "部署", required: true, empty: "空欄不可", aliases: ["部署", "所属部署", "配属部署"] },
    { field: "joined_on", label: "入社日", required: true, empty: "空欄不可", aliases: ["入社日", "入社年月日"] },
    { field: "classroom_code", label: "クラス番号", required: true, empty: "空欄不可（クラスの移行で登録したクラス番号）", aliases: ["クラス番号", "クラスID", "クラスコード"] },
    { field: "teacher_number", label: "担当講師番号", required: true, empty: "空欄不可（クラスの担当講師の講師番号）", aliases: ["担当講師番号", "講師番号", "担当講師"] },
    { field: "training_starts_on", label: "研修開始日", required: false, empty: "空欄＝クラスの開始日", aliases: ["研修開始日"] },
    { field: "training_due_on", label: "研修終了予定日", required: false, empty: "空欄＝クラスの終了日", aliases: ["研修終了予定日", "研修終了日"] },
    { field: "active", label: "在籍状態", required: false, empty: "空欄＝在籍（在籍／在籍終了で指定。登録済み社員の状態は変更しない）", aliases: ["在籍状態", "状態", "在籍"] },
  ],
  progress: [
    { field: "source_record_id", label: "旧システムのレコードID", required: true, key: true, empty: "空欄不可（再移行時の照合キー）", aliases: ["source_record_id", "レコードID", "旧システムID", "レコード番号", "ID"] },
    { field: "employee_number", label: "社員番号", required: true, empty: "空欄不可（社員名ではなく社員番号で照合）", aliases: ["社員番号", "社員ID", "従業員番号"] },
    { field: "student_name", label: "社員名", required: false, empty: "照合の確認にのみ使用（取り込みは社員番号で照合）", aliases: ["社員名", "氏名"] },
    { field: "due_date", label: "終了予定日", required: true, empty: "空欄不可（元の年月日をそのまま保持）", aliases: ["終了予定日", "期限", "予定日"] },
    { field: "department_name", label: "教育担当部署", required: true, empty: "空欄不可（旧名称をそのまま記録）", aliases: ["教育担当部署", "担当部署", "部署"] },
    { field: "teacher_number", label: "教育担当講師番号", required: true, empty: "空欄不可（講師管理の講師番号。未登録はエラー）", aliases: ["教育担当講師番号", "講師番号", "担当講師番号"] },
    { field: "teacher_name", label: "教育担当者", required: false, empty: "空欄＝講師管理の氏名を記録", aliases: ["教育担当者", "担当者", "講師名"] },
    { field: "content", label: "内容", required: true, empty: "空欄不可（原文のまま保持）", aliases: ["内容", "教育内容", "研修内容"] },
    { field: "notes", label: "備考", required: false, empty: "空欄＝備考なし", aliases: ["備考", "メモ"] },
    { field: "state", label: "学習完了状態", required: false, empty: "空欄＝「未確認」（完了とは推定しない）", aliases: ["状態", "学習完了状態", "進捗状態", "完了状態"] },
  ],
};

/** Header normalisation used for automatic mapping suggestions (NFKC, trimmed, lower-case). */
export function normalizeImportHeader(header: string): string {
  return header.normalize("NFKC").trim().toLowerCase();
}

/** Suggested {sourceHeader → targetField} mapping for the detected headers (each header and field used once). */
export function suggestImportMapping(entity: ImportEntity, headers: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of IMPORT_FIELDS[entity]) {
    const aliases = def.aliases.map(normalizeImportHeader);
    const header = headers.find((h) => !(h in out) && aliases.includes(normalizeImportHeader(h)));
    if (header !== undefined) out[header] = def.field;
  }
  return out;
}
