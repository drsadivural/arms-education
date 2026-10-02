import Foundation

/// Contract `ReservationInput`.
public struct ReservationInput: Codable, Sendable, Equatable {
  public let slotId: String
  public init(slotId: String) { self.slotId = slotId }
  enum CodingKeys: String, CodingKey { case slotId = "slot_id" }
}

/// Contract `DecisionInput` (approve / reject / cancel / remove).
public struct DecisionInput: Codable, Sendable, Equatable {
  public let expectedVersion: Int
  public let reason: String?

  public init(expectedVersion: Int, reason: String? = nil) {
    self.expectedVersion = expectedVersion
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case expectedVersion = "expected_version"
    case reason
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(expectedVersion, forKey: .expectedVersion)
    try c.encodeIfPresent(reason, forKey: .reason)
  }
}

/// Contract `AttendanceInput`.
public struct AttendanceInput: Codable, Sendable, Equatable {
  public struct Record: Codable, Sendable, Equatable {
    public let studentId: String
    public let state: AttendanceState
    public let note: String?

    public init(studentId: String, state: AttendanceState, note: String?) {
      self.studentId = studentId
      self.state = state
      self.note = note
    }

    enum CodingKeys: String, CodingKey {
      case studentId = "student_id"
      case state
      case note
    }

    public func encode(to encoder: any Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(studentId, forKey: .studentId)
      try c.encode(state, forKey: .state)
      try c.encodeIfPresent(note, forKey: .note)
    }
  }

  public let records: [Record]
  public init(records: [Record]) { self.records = records }
}

/// Contract `PreferenceInput`.
public struct PreferenceInput: Codable, Sendable, Equatable {
  public let theme: ThemePreference
  public let notificationsEnabled: Bool

  public init(theme: ThemePreference, notificationsEnabled: Bool) {
    self.theme = theme
    self.notificationsEnabled = notificationsEnabled
  }

  enum CodingKeys: String, CodingKey {
    case theme
    case notificationsEnabled = "notifications_enabled"
  }
}

/// Contract `DeleteAccountInput`.
public struct DeleteAccountInput: Codable, Sendable, Equatable {
  public let reason: String?
  public init(reason: String?) { self.reason = reason }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(reason, forKey: .reason)
  }

  enum CodingKeys: String, CodingKey { case reason }
}

public enum APNsEnvironment: String, Codable, Sendable, Equatable {
  case sandbox
  case production
}

/// Contract `DeviceInput`.
public struct DeviceInput: Codable, Sendable, Equatable {
  public let token: String
  public let environment: APNsEnvironment

  public init(token: String, environment: APNsEnvironment) {
    self.token = token
    self.environment = environment
  }

  /// Hex encoding of the APNs device token bytes.
  public static func hexToken(_ data: Data) -> String {
    data.map { byte in
      let s = String(byte, radix: 16)
      return s.count == 1 ? "0" + s : s
    }.joined()
  }
}

/// Contract `PasswordResetInput`.
public struct PasswordResetInput: Codable, Sendable, Equatable {
  public let email: String
  public init(email: String) { self.email = email }
}

/// Contract `QuizInput`.
public struct QuizInput: Codable, Sendable, Equatable {
  public struct Answer: Codable, Sendable, Equatable {
    public let questionId: String
    public let selectedOptionIds: [String]

    public init(questionId: String, selectedOptionIds: [String]) {
      self.questionId = questionId
      self.selectedOptionIds = selectedOptionIds
    }

    enum CodingKeys: String, CodingKey {
      case questionId = "question_id"
      case selectedOptionIds = "selected_option_ids"
    }
  }

  public let answers: [Answer]
  public init(answers: [Answer]) { self.answers = answers }
}

/// Contract `SubmissionInput` (text submission; `object_key` comes from the upload flow).
public struct SubmissionInput: Codable, Sendable, Equatable {
  public let body: String
  public let objectKey: String?

  public init(body: String, objectKey: String? = nil) {
    self.body = body
    self.objectKey = objectKey
  }

  enum CodingKeys: String, CodingKey {
    case body
    case objectKey = "object_key"
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(body, forKey: .body)
    try c.encodeIfPresent(objectKey, forKey: .objectKey)
  }
}

public enum ReviewDecision: String, Codable, Sendable, Equatable, CaseIterable {
  case accepted
  case revisionRequested = "revision_requested"
}

/// Contract `ReviewInput`.
public struct ReviewInput: Codable, Sendable, Equatable {
  public let state: ReviewDecision
  public let feedback: String
  public let expectedVersion: Int?

  public init(state: ReviewDecision, feedback: String, expectedVersion: Int?) {
    self.state = state
    self.feedback = feedback
    self.expectedVersion = expectedVersion
  }

  enum CodingKeys: String, CodingKey {
    case state
    case feedback
    case expectedVersion = "expected_version"
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(state, forKey: .state)
    try c.encode(feedback, forKey: .feedback)
    try c.encodeIfPresent(expectedVersion, forKey: .expectedVersion)
  }
}
