import Foundation

/// Contract `VoiceSession` (`POST /voice/sessions`).
///
/// `clientSecret` is a short-lived OpenAI credential. It lives only in memory: this type is not
/// `Encodable`, and its textual/debug/reflection representations redact the secret so it can never
/// reach logs, crash reports or caches by accident.
public struct VoiceSessionGrant: Decodable, Sendable, Equatable {
  public let sessionId: String
  public let clientSecret: String
  /// End of the reserved session time (the session must end by then).
  public let expiresAt: Date
  /// Expiry of the client secret itself (connect before it; at most 10 minutes).
  public let clientSecretExpiresAt: Date?
  public let model: String
  public let voice: String
  /// Seconds reserved for this session (≤ the organisation's per-session maximum).
  public let maxSeconds: Int?
  /// Tool names the server allows for this role (the server re-checks every call).
  public let tools: [String]?
  /// Remaining daily voice seconds after this session's reservation.
  public let quotaRemainingSeconds: Int?

  public init(
    sessionId: String, clientSecret: String, expiresAt: Date, clientSecretExpiresAt: Date? = nil, model: String,
    voice: String, maxSeconds: Int? = nil, tools: [String]? = nil, quotaRemainingSeconds: Int? = nil
  ) {
    self.sessionId = sessionId
    self.clientSecret = clientSecret
    self.expiresAt = expiresAt
    self.clientSecretExpiresAt = clientSecretExpiresAt
    self.model = model
    self.voice = voice
    self.maxSeconds = maxSeconds
    self.tools = tools
    self.quotaRemainingSeconds = quotaRemainingSeconds
  }

  enum CodingKeys: String, CodingKey {
    case sessionId = "session_id"
    case clientSecret = "client_secret"
    case expiresAt = "expires_at"
    case clientSecretExpiresAt = "client_secret_expires_at"
    case model
    case voice
    case maxSeconds = "max_seconds"
    case tools
    case quotaRemainingSeconds = "quota_remaining_seconds"
  }
}

extension VoiceSessionGrant: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "VoiceSessionGrant(sessionId: \(sessionId), clientSecret: <redacted>, expiresAt: \(expiresAt), model: \(model), voice: \(voice), maxSeconds: \(maxSeconds.map(String.init) ?? "nil"), tools: \(tools ?? []))"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(
      self,
      children: [
        "sessionId": sessionId, "clientSecret": "<redacted>", "expiresAt": expiresAt, "model": model, "voice": voice,
        "maxSeconds": maxSeconds as Any, "tools": tools as Any, "quotaRemainingSeconds": quotaRemainingSeconds as Any,
      ])
  }
}

/// Contract `VoiceQuota` (`GET /voice/quota`): today's usage in the organisation timezone. Open
/// sessions count their full reservation until they end.
public struct VoiceQuota: Codable, Sendable, Equatable {
  public let dailyQuotaSeconds: Int
  public let maxSessionSeconds: Int
  public let usedSeconds: Int
  public let remainingSeconds: Int

  public init(dailyQuotaSeconds: Int, maxSessionSeconds: Int, usedSeconds: Int, remainingSeconds: Int) {
    self.dailyQuotaSeconds = dailyQuotaSeconds
    self.maxSessionSeconds = maxSessionSeconds
    self.usedSeconds = usedSeconds
    self.remainingSeconds = remainingSeconds
  }

  enum CodingKeys: String, CodingKey {
    case dailyQuotaSeconds = "daily_quota_seconds"
    case maxSessionSeconds = "max_session_seconds"
    case usedSeconds = "used_seconds"
    case remainingSeconds = "remaining_seconds"
  }

  /// 「3分 / 15分」 (used / daily limit).
  public var labelJa: String {
    "\(JaFormat.minutes(seconds: usedSeconds)) / \(JaFormat.minutes(seconds: dailyQuotaSeconds))"
  }

  /// 「本日の残り：12分」 (rounded down; 「1分未満」 below a minute — never overstated).
  public var remainingLabelJa: String {
    remainingSeconds < 60 ? "本日の残り：1分未満" : "本日の残り：\(remainingSeconds / 60)分"
  }

  /// Below the server's minimum session length (30 s) a new session is refused with 429.
  public var isExhausted: Bool { remainingSeconds < 30 }
}

/// Contract `VoiceToolInput` (`POST /voice/tool-calls`).
public struct VoiceToolInput: Codable, Sendable, Equatable {
  public let sessionId: String
  public let callId: String
  public let toolName: String
  public let arguments: JSONValue

  public init(sessionId: String, callId: String, toolName: String, arguments: JSONValue) {
    self.sessionId = sessionId
    self.callId = callId
    self.toolName = toolName
    self.arguments = arguments
  }

  enum CodingKeys: String, CodingKey {
    case sessionId = "session_id"
    case callId = "call_id"
    case toolName = "tool_name"
    case arguments
  }
}

// MARK: - Tool results (`ActionResult.data` of /voice/tool-calls; services/api/src/domain/voice/executor.ts)

/// Business failure of a tool call: HTTP 200 with `success:false, data:{error_code, message_ja}`.
public struct VoiceToolFailure: Codable, Sendable, Equatable {
  public let errorCode: String
  public let messageJa: String
  public let fieldErrors: [String: String]?

  public init(errorCode: String, messageJa: String, fieldErrors: [String: String]? = nil) {
    self.errorCode = errorCode
    self.messageJa = messageJa
    self.fieldErrors = fieldErrors
  }

  enum CodingKeys: String, CodingKey {
    case errorCode = "error_code"
    case messageJa = "message_ja"
    case fieldErrors = "field_errors"
  }
}

extension ActionResult {
  /// The business failure carried by `success:false` (nil for successful results). A malformed
  /// failure body still yields a generic Japanese message, never a silent success.
  public var toolFailure: VoiceToolFailure? {
    guard !success else { return nil }
    if let data, let failure = try? data.decode(VoiceToolFailure.self) { return failure }
    return VoiceToolFailure(errorCode: "TOOL_FAILED", messageJa: ErrorCatalog.message(for: "INTERNAL"))
  }
}

/// `slotSummary` (today_lessons / search_slots / prepare_reservation card).
public struct VoiceSlotSummary: Codable, Sendable, Hashable, Identifiable {
  public let slotId: String
  public let title: String
  public let date: LocalDate
  /// 「10月5日（月）」.
  public let dateJa: String
  /// 「14:00」 in the organisation timezone.
  public let start: String
  public let end: String
  public let teacherName: String
  public let classroomName: String
  public let remaining: Int
  public let state: SlotState
  public let myReservationStatus: ReservationStatus?
  public let myReservationStatusJa: String?

  public var id: String { slotId }

  enum CodingKeys: String, CodingKey {
    case slotId = "slot_id"
    case title
    case date
    case dateJa = "date_ja"
    case start
    case end
    case teacherName = "teacher_name"
    case classroomName = "classroom_name"
    case remaining
    case state
    case myReservationStatus = "my_reservation_status"
    case myReservationStatusJa = "my_reservation_status_ja"
  }
}

/// `reservationSummary` (get_reservations / prepare_cancellation card / commit results).
public struct VoiceReservationSummary: Codable, Sendable, Hashable, Identifiable {
  public let reservationId: String
  public let title: String
  public let date: LocalDate
  public let dateJa: String
  public let start: String
  public let end: String
  public let status: ReservationStatus
  public let statusJa: String
  public let teacherName: String
  public let studentName: String?
  public let reason: String?
  /// Seat-hold deadline of a pending request.
  public let holdExpiresAt: Date?
  public let cancelDeadline: Date?

  public var id: String { reservationId }

  enum CodingKeys: String, CodingKey {
    case reservationId = "reservation_id"
    case title
    case date
    case dateJa = "date_ja"
    case start
    case end
    case status
    case statusJa = "status_ja"
    case teacherName = "teacher_name"
    case studentName = "student_name"
    case reason
    case holdExpiresAt = "hold_expires_at"
    case cancelDeadline = "cancel_deadline"
  }
}

/// `get_progress` result (the shared progress service, summarised for speech).
public struct VoiceProgressSummary: Codable, Sendable, Hashable {
  public struct Program: Codable, Sendable, Hashable {
    public let programName: String
    public let dueOn: LocalDate
    public let dueJa: String
    public let overdue: Bool
    public let progressPercent: Int?

    enum CodingKeys: String, CodingKey {
      case programName = "program_name"
      case dueOn = "due_on"
      case dueJa = "due_ja"
      case overdue
      case progressPercent = "progress_percent"
    }
  }

  public struct Unit: Codable, Sendable, Hashable {
    public let title: String
    public let programName: String
    public let required: Bool
    public let stateJa: String
    public let score: Double?

    enum CodingKeys: String, CodingKey {
      case title
      case programName = "program_name"
      case required
      case stateJa = "state_ja"
      case score
    }
  }

  public let studentName: String
  public let progressPercent: Int?
  /// 「76%」 or 「未設定（必須の単元が割り当てられていません）」.
  public let progressJa: String
  public let requiredTotal: Int
  public let requiredCompleted: Int
  public let programs: [Program]
  public let units: [Unit]
  public let checkedAt: Date

  enum CodingKeys: String, CodingKey {
    case studentName = "student_name"
    case progressPercent = "progress_percent"
    case progressJa = "progress_ja"
    case requiredTotal = "required_total"
    case requiredCompleted = "required_completed"
    case programs
    case units
    case checkedAt = "checked_at"
  }
}

/// `prepare_reservation` / `prepare_cancellation` success data. Nothing is written yet: the
/// `action_token` (120 s, bound to user/session/intent) is consumed by the matching commit.
public struct VoicePrepareResult: Decodable, Sendable, Equatable {
  public let actionToken: String
  public let expiresAt: Date
  public let confirmationJa: String
  /// `VoiceSlotSummary` (reserve) or `VoiceReservationSummary` (cancel).
  public let card: JSONValue
  public let checkedAt: Date

  enum CodingKeys: String, CodingKey {
    case actionToken = "action_token"
    case expiresAt = "expires_at"
    case confirmationJa = "confirmation_ja"
    case card
    case checkedAt = "checked_at"
  }
}

/// `commit_reservation` / `commit_cancellation` success data.
public struct VoiceCommitResult: Decodable, Sendable, Equatable {
  public let reservation: VoiceReservationSummary
  public let messageJa: String
  public let checkedAt: Date

  enum CodingKeys: String, CodingKey {
    case reservation
    case messageJa = "message_ja"
    case checkedAt = "checked_at"
  }
}
