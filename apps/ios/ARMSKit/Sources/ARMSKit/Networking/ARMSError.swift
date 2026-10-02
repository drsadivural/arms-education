import Foundation

/// Contract `Error` body: `{ code, message_ja, request_id, field_errors?, details? }`.
public struct APIErrorBody: Codable, Sendable, Equatable {
  public let code: String
  public let messageJa: String
  public let requestId: String
  public let fieldErrors: [String: String]?
  public let details: JSONValue?

  public init(
    code: String, messageJa: String, requestId: String, fieldErrors: [String: String]? = nil,
    details: JSONValue? = nil
  ) {
    self.code = code
    self.messageJa = messageJa
    self.requestId = requestId
    self.fieldErrors = fieldErrors
    self.details = details
  }

  enum CodingKeys: String, CodingKey {
    case code
    case messageJa = "message_ja"
    case requestId = "request_id"
    case fieldErrors = "field_errors"
    case details
  }
}

/// Every failure surfaced by ARMSKit. `messageJa` is what the UI shows.
public enum ARMSError: Error, Sendable, Equatable {
  /// A JSON error from the ARMS API (`message_ja` is shown verbatim).
  case api(APIErrorBody, status: Int)
  /// No network path (or the request could not reach the server).
  case offline
  /// The request timed out. For mutations the outcome is unknown; callers verify via the
  /// idempotency key before reporting failure.
  case timedOut
  /// The response could not be understood (unexpected status/body).
  case invalidResponse(status: Int, requestId: String?)
  /// The response body did not match the contract.
  case decoding(String)
  /// Local validation before sending (field → Japanese message).
  case validation([String: String])
  /// Authentication with the identity provider failed.
  case auth(AuthFailure)
  /// Not signed in / session could not be refreshed.
  case notSignedIn
  /// Local configuration (build settings) missing.
  case notConfigured(String)
  /// A business precondition checked on the client (e.g. offline mutation, expired confirmation).
  case local(code: String, messageJa: String)
  case cancelled

  public var code: String {
    switch self {
    case .api(let body, _): return body.code
    case .offline: return "OFFLINE"
    case .timedOut: return "TIMEOUT"
    case .invalidResponse: return "INVALID_RESPONSE"
    case .decoding: return "DECODING_FAILED"
    case .validation: return "VALIDATION_FAILED"
    case .auth(let failure): return failure.code
    case .notSignedIn: return "UNAUTHENTICATED"
    case .notConfigured: return "NOT_CONFIGURED"
    case .local(let code, _): return code
    case .cancelled: return "CANCELLED"
    }
  }

  /// Japanese user-facing message.
  public var messageJa: String {
    switch self {
    case .api(let body, _):
      return body.messageJa.isEmpty ? ErrorCatalog.message(for: body.code) : body.messageJa
    case .offline:
      return "ネットワークに接続できません。通信環境を確認してから再度お試しください。"
    case .timedOut:
      return "通信がタイムアウトしました。状態を確認してから再度お試しください。"
    case .invalidResponse:
      return ErrorCatalog.message(for: "INTERNAL")
    case .decoding:
      return "サーバーからの応答を読み取れませんでした。アプリを最新版に更新してください。"
    case .validation(let fields):
      return fields.count == 1 ? fields.values.first! : "入力内容を確認してください。"
    case .auth(let failure):
      return failure.messageJa
    case .notSignedIn:
      return ErrorCatalog.message(for: "UNAUTHENTICATED")
    case .notConfigured:
      return "アプリの接続設定が不足しています。管理者にお問い合わせください。"
    case .local(_, let message):
      return message
    case .cancelled:
      return "操作を中止しました。"
    }
  }

  public var requestId: String? {
    switch self {
    case .api(let body, _): return body.requestId
    case .invalidResponse(_, let id): return id
    default: return nil
    }
  }

  public var fieldErrors: [String: String] {
    switch self {
    case .api(let body, _): return body.fieldErrors ?? [:]
    case .validation(let fields): return fields
    default: return [:]
    }
  }

  public var httpStatus: Int? {
    switch self {
    case .api(_, let status): return status
    case .invalidResponse(let status, _): return status
    default: return nil
    }
  }

  /// Connectivity problems: the server may be reachable later; cached data may be shown.
  public var isConnectivity: Bool {
    switch self {
    case .offline, .timedOut: return true
    default: return false
    }
  }

  /// The session is no longer valid and the user must sign in again.
  public var requiresSignIn: Bool {
    switch self {
    case .notSignedIn: return true
    case .api(let body, let status):
      return status == 401 || body.code == "ACCOUNT_DISABLED"
    default: return false
    }
  }

  public func hasCode(_ code: String) -> Bool { self.code == code }

  /// Message plus the request id for support, e.g. 「…（問い合わせ番号: abc）」.
  public var messageWithRequestId: String {
    guard let id = requestId, !id.isEmpty else { return messageJa }
    return "\(messageJa)（問い合わせ番号: \(id)）"
  }
}

/// Identity-provider (Supabase Auth) failures, mapped to Japanese.
public enum AuthFailure: Error, Sendable, Equatable {
  case invalidCredentials
  case emailNotConfirmed
  case rateLimited
  case accountDisabled
  case network
  case sessionMissing
  case provider(code: String)

  public var code: String {
    switch self {
    case .invalidCredentials: return "INVALID_CREDENTIALS"
    case .emailNotConfirmed: return "EMAIL_NOT_CONFIRMED"
    case .rateLimited: return "RATE_LIMITED"
    case .accountDisabled: return "ACCOUNT_DISABLED"
    case .network: return "OFFLINE"
    case .sessionMissing: return "SESSION_EXPIRED"
    case .provider: return "AUTH_PROVIDER_UNAVAILABLE"
    }
  }

  public var messageJa: String {
    switch self {
    case .invalidCredentials: return ErrorCatalog.message(for: "INVALID_CREDENTIALS")
    case .emailNotConfirmed:
      return "メールアドレスの確認が完了していません。招待メールのリンクから設定を完了してください。"
    case .rateLimited: return ErrorCatalog.message(for: "RATE_LIMITED")
    case .accountDisabled: return ErrorCatalog.message(for: "ACCOUNT_DISABLED")
    case .network: return "ネットワークに接続できません。通信環境を確認してから再度お試しください。"
    case .sessionMissing: return ErrorCatalog.message(for: "SESSION_EXPIRED")
    case .provider: return ErrorCatalog.message(for: "AUTH_PROVIDER_UNAVAILABLE")
    }
  }
}

/// Mirror of `packages/contracts/src/errors.ts`. Used only when an error response carries no
/// parsable body (e.g. a proxy error page) or a locally synthesised code needs a message.
public enum ErrorCatalog {
  public static let messages: [String: String] = [
    "BAD_REQUEST": "リクエストの形式が正しくありません。",
    "VALIDATION_FAILED": "入力内容を確認してください。",
    "IF_MATCH_REQUIRED": "最新の情報を読み込んでから操作してください。",
    "IDEMPOTENCY_KEY_REQUIRED": "操作キーがありません。画面を再読み込みしてから操作してください。",
    "AMBIGUOUS_AUTH": "認証方式が重複しています。アプリを再起動してください。",
    "UNAUTHENTICATED": "ログインが必要です。再度ログインしてください。",
    "INVALID_CREDENTIALS": "メールアドレスまたはパスワードが正しくありません。",
    "SESSION_EXPIRED": "セッションの有効期限が切れました。再度ログインしてください。",
    "FORBIDDEN": "この操作を行う権限がありません。",
    "ROLE_MISMATCH": "このアカウントでは選択した利用区分にログインできません。",
    "ACCOUNT_DISABLED": "このアカウントは利用できません。管理者にお問い合わせください。",
    "MFA_REQUIRED": "管理者は二段階認証を完了してください。",
    "CSRF_FAILED": "画面の有効期限が切れました。再読み込みしてから操作してください。",
    "ORIGIN_REJECTED": "許可されていない画面からの操作です。",
    "ADMIN_USE_WEB": "管理者の操作はWeb管理画面をご利用ください。",
    "NOT_FOUND": "対象が見つかりません。削除されたか、閲覧権限がありません。",
    "ORG_SELECTION_REQUIRED": "利用する組織を選択してください。",
    "VERSION_CONFLICT": "情報が更新されました。再読み込みしてください。",
    "IDEMPOTENCY_CONFLICT": "同じ操作キーで異なる内容が送信されました。画面を再読み込みしてください。",
    "IDEMPOTENCY_IN_PROGRESS": "同じ操作を処理中です。しばらくしてから状態を確認してください。",
    "DUPLICATE": "既に登録されています。",
    "INVALID_STATE": "現在の状態ではこの操作はできません。再読み込みしてください。",
    "SLOT_FULL": "この授業は満席です。",
    "TIME_CONFLICT": "同じ時間に別の予約があります。",
    "SLOT_TIME_CONFLICT": "同じ講師またはクラスで時間が重なる授業枠があります。",
    "BOOKING_CLOSED": "予約受付を終了しました。",
    "CANCELLATION_CLOSED": "取消期限を過ぎているため取消できません。",
    "RESERVATION_EXPIRED": "申請の保持期限が切れたため、この操作はできません。",
    "ACTIVE_RESERVATIONS": "有効な予約があるため変更できません。先に予約の取消・通知を行ってください。",
    "REASON_REQUIRED": "理由を入力してください（1〜1,000文字）。",
    "QUIZ_ATTEMPTS_EXCEEDED": "受験回数の上限に達しました。",
    "FILE_REJECTED": "ファイルの形式または内容が許可されていません。",
    "FILE_TOO_LARGE": "ファイルサイズが上限を超えています。",
    "SCAN_PENDING": "ファイル検査が完了していないため公開できません。",
    "ACTION_TOKEN_INVALID": "確認の有効期限が切れたか、無効です。もう一度内容を確認してください。",
    "VOICE_QUOTA_EXCEEDED": "本日の音声利用上限に達しました。画面から操作してください。",
    "RATE_LIMITED": "操作が多すぎます。しばらくしてから再度お試しください。",
    "INTERNAL": "予期しないエラーが発生しました。時間をおいて再度お試しください。",
    "SERVICE_UNAVAILABLE": "現在サービスを利用できません。しばらくしてから再度お試しください。",
    "DB_UNAVAILABLE": "データベースに接続できません。変更は保存されていません。",
    "AUTH_PROVIDER_UNAVAILABLE": "認証サービスに接続できません。しばらくしてから再度お試しください。",
    "STORAGE_UNAVAILABLE": "ファイル保管サービスに接続できません。",
    "VOICE_UNAVAILABLE": "現在、音声機能を利用できません。画面から操作してください。",
    "NOT_CONFIGURED": "この機能は必要な外部サービスが未設定のため利用できません。管理者にお問い合わせください。",
  ]

  public static func message(for code: String) -> String {
    messages[code] ?? messages["INTERNAL"]!
  }

  /// Code synthesised from an HTTP status when the body is not a contract error.
  public static func code(forStatus status: Int) -> String {
    switch status {
    case 400: return "BAD_REQUEST"
    case 401: return "UNAUTHENTICATED"
    case 403: return "FORBIDDEN"
    case 404: return "NOT_FOUND"
    case 409: return "INVALID_STATE"
    case 422: return "VALIDATION_FAILED"
    case 429: return "RATE_LIMITED"
    case 503: return "SERVICE_UNAVAILABLE"
    default: return "INTERNAL"
    }
  }
}
