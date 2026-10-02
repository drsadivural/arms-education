/**
 * API error codes shared by the API, Web and (mirrored) iOS clients.
 * message_ja is the default user-facing text; the API may add field_errors.
 * Internal SQL messages are never returned — DB exceptions are mapped onto these codes.
 */
export const ERROR_CATALOG = {
  BAD_REQUEST: { status: 400, message_ja: "リクエストの形式が正しくありません。" },
  VALIDATION_FAILED: { status: 422, message_ja: "入力内容を確認してください。" },
  IF_MATCH_REQUIRED: { status: 400, message_ja: "最新の情報を読み込んでから操作してください。" },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, message_ja: "操作キーがありません。画面を再読み込みしてから操作してください。" },
  AMBIGUOUS_AUTH: { status: 400, message_ja: "認証方式が重複しています。アプリを再起動してください。" },

  UNAUTHENTICATED: { status: 401, message_ja: "ログインが必要です。再度ログインしてください。" },
  INVALID_CREDENTIALS: { status: 401, message_ja: "メールアドレスまたはパスワードが正しくありません。" },
  SESSION_EXPIRED: { status: 401, message_ja: "セッションの有効期限が切れました。再度ログインしてください。" },

  FORBIDDEN: { status: 403, message_ja: "この操作を行う権限がありません。" },
  ROLE_MISMATCH: { status: 403, message_ja: "このアカウントでは選択した利用区分にログインできません。" },
  ACCOUNT_DISABLED: { status: 403, message_ja: "このアカウントは利用できません。管理者にお問い合わせください。" },
  MFA_REQUIRED: { status: 403, message_ja: "管理者は二段階認証を完了してください。" },
  CSRF_FAILED: { status: 403, message_ja: "画面の有効期限が切れました。再読み込みしてから操作してください。" },
  ORIGIN_REJECTED: { status: 403, message_ja: "許可されていない画面からの操作です。" },
  ADMIN_USE_WEB: { status: 403, message_ja: "管理者の操作はWeb管理画面をご利用ください。" },

  NOT_FOUND: { status: 404, message_ja: "対象が見つかりません。削除されたか、閲覧権限がありません。" },

  ORG_SELECTION_REQUIRED: { status: 409, message_ja: "利用する組織を選択してください。" },
  VERSION_CONFLICT: { status: 409, message_ja: "情報が更新されました。再読み込みしてください。" },
  IDEMPOTENCY_CONFLICT: { status: 409, message_ja: "同じ操作キーで異なる内容が送信されました。画面を再読み込みしてください。" },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, message_ja: "同じ操作を処理中です。しばらくしてから状態を確認してください。" },
  DUPLICATE: { status: 409, message_ja: "既に登録されています。" },
  EMAIL_TAKEN: { status: 409, message_ja: "このメールアドレスは既に登録されています。" },
  EMPLOYEE_NUMBER_TAKEN: { status: 409, message_ja: "この社員番号は既に登録されています。" },
  TEACHER_NUMBER_TAKEN: { status: 409, message_ja: "この講師番号は既に登録されています。" },
  INVALID_STATE: { status: 409, message_ja: "現在の状態ではこの操作はできません。再読み込みしてください。" },

  SLOT_FULL: { status: 409, message_ja: "この授業は満席です。" },
  TIME_CONFLICT: { status: 409, message_ja: "同じ時間に別の予約があります。" },
  SLOT_TIME_CONFLICT: { status: 409, message_ja: "同じ講師またはクラスで時間が重なる授業枠があります。" },
  BOOKING_CLOSED: { status: 409, message_ja: "予約受付を終了しました。" },
  CANCELLATION_CLOSED: { status: 409, message_ja: "取消期限を過ぎているため取消できません。" },
  RESERVATION_EXPIRED: { status: 409, message_ja: "申請の保持期限が切れたため、この操作はできません。" },
  ACTIVE_RESERVATIONS: { status: 409, message_ja: "有効な予約があるため変更できません。先に予約の取消・通知を行ってください。" },
  REASON_REQUIRED: { status: 422, message_ja: "理由を入力してください（1〜1,000文字）。" },

  CLASSROOM_FULL: { status: 409, message_ja: "クラスの定員に達しています。" },
  CAPACITY_BELOW_ENROLLMENT: { status: 409, message_ja: "在籍人数より少ない定員には変更できません。" },
  CLASSROOM_HAS_STUDENTS: { status: 409, message_ja: "在籍者がいるクラスは削除できません。" },
  CLASSROOM_TRANSFER_REQUIRES_SERVICE: { status: 409, message_ja: "クラスの変更は「クラス移動」から理由を付けて行ってください。" },
  TEACHER_CLASSROOM_MISMATCH: { status: 422, message_ja: "選択した講師はこのクラスの担当ではありません。" },
  TEACHER_INACTIVE: { status: 422, message_ja: "停止中の講師は選択できません。" },
  PROFILE_ROLE_MISMATCH: { status: 409, message_ja: "利用区分とプロフィールが一致しません。" },

  PUBLISHED_VERSION_IMMUTABLE: { status: 409, message_ja: "公開済みのバージョンは変更できません。新しいバージョンを作成してください。" },
  VERSION_NOT_PUBLISHABLE: { status: 409, message_ja: "公開条件を満たしていません。単元・教材・検査状態を確認してください。" },
  SCAN_PENDING: { status: 409, message_ja: "ファイル検査が完了していないため公開できません。" },
  FILE_REJECTED: { status: 422, message_ja: "ファイルの形式または内容が許可されていません。" },
  FILE_TOO_LARGE: { status: 422, message_ja: "ファイルサイズが上限を超えています。" },
  QUIZ_ATTEMPTS_EXCEEDED: { status: 409, message_ja: "受験回数の上限に達しました。" },

  ACTION_TOKEN_INVALID: { status: 409, message_ja: "確認の有効期限が切れたか、無効です。もう一度内容を確認してください。" },
  VOICE_QUOTA_EXCEEDED: { status: 429, message_ja: "本日の音声利用上限に達しました。画面から操作してください。" },

  RATE_LIMITED: { status: 429, message_ja: "操作が多すぎます。しばらくしてから再度お試しください。" },

  INTERNAL: { status: 500, message_ja: "予期しないエラーが発生しました。時間をおいて再度お試しください。" },
  SERVICE_UNAVAILABLE: { status: 503, message_ja: "現在サービスを利用できません。しばらくしてから再度お試しください。" },
  DB_UNAVAILABLE: { status: 503, message_ja: "データベースに接続できません。変更は保存されていません。" },
  AUTH_PROVIDER_UNAVAILABLE: { status: 503, message_ja: "認証サービスに接続できません。しばらくしてから再度お試しください。" },
  SCANNER_UNAVAILABLE: { status: 503, message_ja: "ファイル検査サービスに接続できないため、教材の公開を停止しています。" },
  STORAGE_UNAVAILABLE: { status: 503, message_ja: "ファイル保管サービスに接続できません。" },
  VOICE_UNAVAILABLE: { status: 503, message_ja: "現在、音声機能を利用できません。画面から操作してください。" },
  NOT_CONFIGURED: { status: 503, message_ja: "この機能は必要な外部サービスが未設定のため利用できません。管理者にお問い合わせください。" },

  CLASSROOM_ARCHIVED: { status: 422, message_ja: "アーカイブ済みのクラスには登録できません。" },
  RELATED_IN_USE: { status: 409, message_ja: "関連するデータがあるため、削除・変更できません。" },

  // ---- area: admin (append new codes directly below this line) ----
  TEACHER_IS_PRIMARY: { status: 409, message_ja: "主担当のクラスがあるため停止できません。先にクラスの主担当講師を変更してください。" },
  TEACHER_HAS_FUTURE_SLOTS: { status: 409, message_ja: "今後の授業枠があるため停止できません。先に授業枠の講師変更または取消を行ってください。" },
  CLASSROOM_TEACHER_IN_USE: { status: 409, message_ja: "担当受講者または授業枠（過去分を含む）があるため、この講師をクラスから外せません。" },
  CLASSROOM_NAME_TAKEN: { status: 409, message_ja: "同じ名称・開始日のクラスが既に登録されています。" },
  INVITATION_IN_PROGRESS: { status: 409, message_ja: "このメールアドレスの招待を処理中です。しばらくしてから一覧で状態を確認してください。" },
  CANNOT_DISABLE_SELF: { status: 409, message_ja: "自分自身のアカウントは停止できません。" },
  LAST_ADMIN: { status: 409, message_ja: "有効な管理者が1人だけのため停止できません。先に別の管理者を追加してください。" },

  // ---- area: learning (append new codes directly below this line) ----

  // ---- area: booking & notifications (append new codes directly below this line) ----
  ALREADY_RESERVED: { status: 409, message_ja: "この授業は既に申請済みです。" },
  ATTENDANCE_NOT_OPEN: { status: 409, message_ja: "出欠は授業開始の30分前から記録できます。" },
  SLOT_CANCELLED: { status: 409, message_ja: "この授業枠は取り消されています。" },
  PROGRAM_NOT_ASSIGNED: { status: 403, message_ja: "この授業の教育プログラムが割り当てられていないため申請できません。" },

  // ---- area: voice (append new codes directly below this line) ----
  VOICE_SESSION_ENDED: { status: 409, message_ja: "音声セッションは終了しました。もう一度開始してください。" },

  // ---- area: imports & exports (append new codes directly below this line) ----
} as const satisfies Record<string, { status: number; message_ja: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface ApiErrorBody {
  code: string;
  message_ja: string;
  request_id: string;
  field_errors?: Record<string, string>;
  details?: Record<string, unknown>;
}

export function isErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code);
}

export function errorMessageJa(code: string): string {
  return isErrorCode(code) ? ERROR_CATALOG[code].message_ja : ERROR_CATALOG.INTERNAL.message_ja;
}
