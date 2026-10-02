import Foundation

/// The eight voice tools of `contracts/voice-tools.json`. Anything else the model emits is refused
/// locally and never forwarded to the API. The API re-validates everything (allowlist, JSON schema,
/// membership, RBAC, call-id idempotency, action tokens); this client check only avoids sending
/// obviously invalid calls.
public enum VoiceTool: String, CaseIterable, Sendable {
  case todayLessons = "today_lessons"
  case getProgress = "get_progress"
  case searchSlots = "search_slots"
  case getReservations = "get_reservations"
  case prepareReservation = "prepare_reservation"
  case commitReservation = "commit_reservation"
  case prepareCancellation = "prepare_cancellation"
  case commitCancellation = "commit_cancellation"

  enum FieldType {
    case uuid
    case date
    case enumeration([String])
    case token(minLength: Int)
  }

  struct Field {
    let name: String
    let type: FieldType
    let required: Bool
  }

  var fields: [Field] {
    switch self {
    case .todayLessons: return []
    case .getProgress: return [Field(name: "student_id", type: .uuid, required: false)]
    case .searchSlots:
      return [
        Field(name: "date", type: .date, required: true),
        Field(name: "time_band", type: .enumeration(["morning", "afternoon", "evening", "any"]), required: true),
      ]
    case .getReservations: return [Field(name: "reservation_id", type: .uuid, required: false)]
    case .prepareReservation: return [Field(name: "slot_id", type: .uuid, required: true)]
    case .commitReservation, .commitCancellation:
      return [Field(name: "action_token", type: .token(minLength: 32), required: true)]
    case .prepareCancellation: return [Field(name: "reservation_id", type: .uuid, required: true)]
    }
  }

  /// Write intent behind prepare/commit pairs.
  public var intent: VoiceIntent? {
    switch self {
    case .prepareReservation, .commitReservation: return .reserve
    case .prepareCancellation, .commitCancellation: return .cancel
    default: return nil
    }
  }

  public var isPrepare: Bool { self == .prepareReservation || self == .prepareCancellation }
  public var isCommit: Bool { self == .commitReservation || self == .commitCancellation }

  /// Validates the model's argument JSON against the tool schema (types, required, enum, format,
  /// `additionalProperties: false`). Returns the parsed object or a Japanese reason.
  public func validate(argumentsJSON: String) -> Result<JSONValue, VoiceToolRejection> {
    let trimmed = argumentsJSON.trimmingCharacters(in: .whitespacesAndNewlines)
    let parsed: JSONValue
    if trimmed.isEmpty {
      parsed = .object([:])
    } else {
      guard let value = try? JSONValue(jsonString: trimmed) else {
        return .failure(.invalidArguments("引数の形式が正しくありません。"))
      }
      parsed = value
    }
    guard let object = parsed.objectValue else {
      return .failure(.invalidArguments("引数の形式が正しくありません。"))
    }
    let known = Set(fields.map(\.name))
    if let extra = object.keys.first(where: { !known.contains($0) }) {
      return .failure(.invalidArguments("不明な引数 \(extra) が含まれています。"))
    }
    for field in fields {
      guard let value = object[field.name], !value.isNull else {
        if field.required { return .failure(.invalidArguments("\(field.name) が指定されていません。")) }
        continue
      }
      guard let s = value.stringValue else {
        return .failure(.invalidArguments("\(field.name) の形式が正しくありません。"))
      }
      switch field.type {
      case .uuid:
        if UUID(uuidString: s) == nil { return .failure(.invalidArguments("\(field.name) の形式が正しくありません。")) }
      case .date:
        if LocalDate(s) == nil { return .failure(.invalidArguments("日付は YYYY-MM-DD で指定してください。")) }
      case .enumeration(let allowed):
        if !allowed.contains(s) { return .failure(.invalidArguments("\(field.name) の値が正しくありません。")) }
      case .token(let minLength):
        if s.count < minLength { return .failure(.invalidArguments("確認トークンが正しくありません。")) }
      }
    }
    return .success(parsed)
  }
}

public enum VoiceIntent: String, Sendable, Equatable {
  case reserve
  case cancel
}

/// Why a tool call was not forwarded to the API (reported back to the model as a tool error).
public enum VoiceToolRejection: Error, Sendable, Equatable {
  case unknownTool(String)
  case invalidArguments(String)
  case confirmationRequired
  case confirmationExpired
  case confirmationMismatch
  case notAllowedForRole

  public var code: String {
    switch self {
    case .unknownTool: return "UNKNOWN_TOOL"
    case .invalidArguments: return "VALIDATION_FAILED"
    case .confirmationRequired: return "CONFIRMATION_REQUIRED"
    case .confirmationExpired: return "ACTION_TOKEN_INVALID"
    case .confirmationMismatch: return "ACTION_TOKEN_INVALID"
    case .notAllowedForRole: return "FORBIDDEN"
    }
  }

  public var messageJa: String {
    switch self {
    case .unknownTool: return "この操作は音声では実行できません。画面から操作してください。"
    case .invalidArguments(let detail): return detail
    case .confirmationRequired:
      return "まだ送信していません。画面のボタンを押すか、「はい、申請して」のようにはっきりお答えください。"
    case .confirmationExpired: return "確認の有効期限が切れました。もう一度内容を確認してください。"
    case .confirmationMismatch: return "確認した内容と一致しません。もう一度内容を確認してください。"
    case .notAllowedForRole: return "この操作は音声では実行できません。画面から操作してください。"
    }
  }
}
