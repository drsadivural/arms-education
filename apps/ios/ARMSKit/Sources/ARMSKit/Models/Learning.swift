import Foundation

public enum MaterialKind: String, Codable, Sendable, CaseIterable, Hashable {
  case pdf
  case video
  case image
  case link
  case quiz
  case assignment
}

public enum ScanState: String, Codable, Sendable, CaseIterable, Hashable {
  case pending
  case clean
  case blocked
  case notApplicable = "not_applicable"
}

/// Contract `Material`.
public struct Material: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let unitId: String
  public let title: String
  public let kind: MaterialKind
  public let required: Bool
  public let scanState: ScanState
  public let published: Bool
  public let sizeBytes: Int?
  public let rowVersion: Int

  public init(
    id: String, unitId: String, title: String, kind: MaterialKind, required: Bool, scanState: ScanState,
    published: Bool, sizeBytes: Int?, rowVersion: Int
  ) {
    self.id = id
    self.unitId = unitId
    self.title = title
    self.kind = kind
    self.required = required
    self.scanState = scanState
    self.published = published
    self.sizeBytes = sizeBytes
    self.rowVersion = rowVersion
  }

  enum CodingKeys: String, CodingKey {
    case id
    case unitId = "unit_id"
    case title
    case kind
    case required
    case scanState = "scan_state"
    case published
    case sizeBytes = "size_bytes"
    case rowVersion = "row_version"
  }
}

/// Contract `Download` (short-lived, permission-checked URL; 5 minutes on the server).
public struct MaterialDownload: Codable, Sendable, Hashable {
  public let url: String
  public let expiresAt: Date
  public let contentType: String

  public init(url: String, expiresAt: Date, contentType: String) {
    self.url = url
    self.expiresAt = expiresAt
    self.contentType = contentType
  }

  enum CodingKeys: String, CodingKey {
    case url
    case expiresAt = "expires_at"
    case contentType = "content_type"
  }
}

/// Contract `QuizQuestion`. The server never returns correct answers to students.
public struct QuizQuestion: Codable, Sendable, Hashable, Identifiable {
  public struct Choice: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
      self.id = id
      self.label = label
    }
  }

  public let id: String
  public let prompt: String
  public let choices: [Choice]

  public init(id: String, prompt: String, choices: [Choice]) {
    self.id = id
    self.prompt = prompt
    self.choices = choices
  }
}

/// Contract `Quiz`.
public struct Quiz: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let title: String
  public let questions: [QuizQuestion]
  public let attemptsUsed: Int
  public let attemptsRemaining: Int
  public let passScore: Double

  public init(
    id: String, title: String, questions: [QuizQuestion], attemptsUsed: Int, attemptsRemaining: Int,
    passScore: Double
  ) {
    self.id = id
    self.title = title
    self.questions = questions
    self.attemptsUsed = attemptsUsed
    self.attemptsRemaining = attemptsRemaining
    self.passScore = passScore
  }

  enum CodingKeys: String, CodingKey {
    case id
    case title
    case questions
    case attemptsUsed = "attempts_used"
    case attemptsRemaining = "attempts_remaining"
    case passScore = "pass_score"
  }
}

/// Contract `QuizResult` (server-scored).
public struct QuizResult: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let score: Double
  public let passed: Bool
  public let submittedAt: Date

  public init(id: String, score: Double, passed: Bool, submittedAt: Date) {
    self.id = id
    self.score = score
    self.passed = passed
    self.submittedAt = submittedAt
  }

  enum CodingKeys: String, CodingKey {
    case id
    case score
    case passed
    case submittedAt = "submitted_at"
  }
}

public enum SubmissionState: String, Codable, Sendable, CaseIterable, Hashable {
  case submitted
  case accepted
  case revisionRequested = "revision_requested"
}

/// Contract `Submission`.
public struct Submission: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let materialId: String
  public let studentId: String
  public let state: SubmissionState
  public let body: String
  public let scanState: String
  public let feedback: String?
  public let rowVersion: Int
  public let submittedAt: Date

  public init(
    id: String, materialId: String, studentId: String, state: SubmissionState, body: String, scanState: String,
    feedback: String?, rowVersion: Int, submittedAt: Date
  ) {
    self.id = id
    self.materialId = materialId
    self.studentId = studentId
    self.state = state
    self.body = body
    self.scanState = scanState
    self.feedback = feedback
    self.rowVersion = rowVersion
    self.submittedAt = submittedAt
  }

  enum CodingKeys: String, CodingKey {
    case id
    case materialId = "material_id"
    case studentId = "student_id"
    case state
    case body
    case scanState = "scan_state"
    case feedback
    case rowVersion = "row_version"
    case submittedAt = "submitted_at"
  }
}

/// Contract `Notification` (in-app notification of the signed-in user).
public struct AppNotification: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let title: String
  public let body: String
  public let deepLink: String
  public let readAt: Date?
  public let createdAt: Date

  public init(id: String, title: String, body: String, deepLink: String, readAt: Date?, createdAt: Date) {
    self.id = id
    self.title = title
    self.body = body
    self.deepLink = deepLink
    self.readAt = readAt
    self.createdAt = createdAt
  }

  public var isRead: Bool { readAt != nil }

  enum CodingKeys: String, CodingKey {
    case id
    case title
    case body
    case deepLink = "deep_link"
    case readAt = "read_at"
    case createdAt = "created_at"
  }
}
