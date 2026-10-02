import Foundation

public enum MaterialKind: String, Codable, Sendable, CaseIterable, Hashable {
  case pdf
  case video
  case image
  case link
  case quiz
  case assignment

  /// Kinds the student confirms with 「教材を確認しました」 (`POST /materials/{id}/receipt`).
  public var isViewable: Bool {
    switch self {
    case .pdf, .video, .image, .link: return true
    case .quiz, .assignment: return false
    }
  }

  /// Kinds whose content is an uploaded file served by a 5-minute presigned URL.
  public var isFile: Bool { self == .pdf || self == .video || self == .image }
}

public enum ScanState: String, Codable, Sendable, CaseIterable, Hashable {
  case pending
  case clean
  case blocked
  case notApplicable = "not_applicable"
}

public enum SubmissionState: String, Codable, Sendable, CaseIterable, Hashable {
  case submitted
  case accepted
  case revisionRequested = "revision_requested"
}

/// Contract `Material.learner_status`: the signed-in student's own evidence for the material
/// (only present in student responses).
public struct LearnerStatus: Codable, Sendable, Hashable {
  public let confirmedAt: Date?
  public let quizAttemptsUsed: Int?
  public let quizScore: Double?
  public let quizPassed: Bool?
  public let submissionState: SubmissionState?
  public let feedback: String?

  public init(
    confirmedAt: Date? = nil, quizAttemptsUsed: Int? = nil, quizScore: Double? = nil, quizPassed: Bool? = nil,
    submissionState: SubmissionState? = nil, feedback: String? = nil
  ) {
    self.confirmedAt = confirmedAt
    self.quizAttemptsUsed = quizAttemptsUsed
    self.quizScore = quizScore
    self.quizPassed = quizPassed
    self.submissionState = submissionState
    self.feedback = feedback
  }

  enum CodingKeys: String, CodingKey {
    case confirmedAt = "confirmed_at"
    case quizAttemptsUsed = "quiz_attempts_used"
    case quizScore = "quiz_score"
    case quizPassed = "quiz_passed"
    case submissionState = "submission_state"
    case feedback
  }
}

/// Contract `Material` (`GET /units/{id}/materials`, `GET /materials/{id}`).
public struct Material: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let unitId: String
  public let programVersionId: String
  public let title: String
  /// Instructions for assignments / quizzes (may be empty).
  public let description: String
  public let kind: MaterialKind
  public let required: Bool
  public let scanState: ScanState
  public let published: Bool
  public let sizeBytes: Int?
  public let rowVersion: Int
  /// Only for `link` materials (always https; enforced by the database).
  public let externalUrl: String?
  public let uploadId: String?
  public let filename: String?
  public let contentType: String?
  /// Only for `quiz` materials.
  public let questionCount: Int?
  public let learnerStatus: LearnerStatus?

  public init(
    id: String, unitId: String, programVersionId: String = "", title: String, description: String = "",
    kind: MaterialKind, required: Bool, scanState: ScanState, published: Bool, sizeBytes: Int?, rowVersion: Int,
    externalUrl: String? = nil, uploadId: String? = nil, filename: String? = nil, contentType: String? = nil,
    questionCount: Int? = nil, learnerStatus: LearnerStatus? = nil
  ) {
    self.id = id
    self.unitId = unitId
    self.programVersionId = programVersionId
    self.title = title
    self.description = description
    self.kind = kind
    self.required = required
    self.scanState = scanState
    self.published = published
    self.sizeBytes = sizeBytes
    self.rowVersion = rowVersion
    self.externalUrl = externalUrl
    self.uploadId = uploadId
    self.filename = filename
    self.contentType = contentType
    self.questionCount = questionCount
    self.learnerStatus = learnerStatus
  }

  enum CodingKeys: String, CodingKey {
    case id
    case unitId = "unit_id"
    case programVersionId = "program_version_id"
    case title
    case description
    case kind
    case required
    case scanState = "scan_state"
    case published
    case sizeBytes = "size_bytes"
    case rowVersion = "row_version"
    case externalUrl = "external_url"
    case uploadId = "upload_id"
    case filename
    case contentType = "content_type"
    case questionCount = "question_count"
    case learnerStatus = "learner_status"
  }

  /// The https URL of a link material (never anything else).
  public var secureExternalURL: URL? {
    guard kind == .link, let raw = externalUrl, let url = URL(string: raw), url.scheme?.lowercased() == "https",
      url.host?.isEmpty == false
    else { return nil }
    return url
  }

  /// The student already confirmed this material (server evidence).
  public var isConfirmedByLearner: Bool { learnerStatus?.confirmedAt != nil }
}

/// Contract `Download` (short-lived, permission-checked URL; 5 minutes on the server).
/// `GET /materials/{id}/download`: pdf/video/image → presigned GET (`inline`), link → the external
/// https URL with `text/html`; quiz/assignment → `409 MATERIAL_KIND_MISMATCH`, scanning →
/// `409 SCAN_PENDING`, blocked → `422 FILE_REJECTED`. `GET /submissions/{id}/file` uses the same shape.
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

public enum QuizScorePolicy: String, Codable, Sendable, Hashable {
  case highest
  case latest

  public var labelJa: String {
    switch self {
    case .highest: return "最高点を採用"
    case .latest: return "最新の点数を採用"
    }
  }
}

/// Contract `Quiz` (`GET /materials/{id}/quiz`).
public struct Quiz: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let title: String
  public let questions: [QuizQuestion]
  public let attemptsUsed: Int
  public let attemptsRemaining: Int
  public let passScore: Double
  public let maxAttempts: Int
  public let scorePolicy: QuizScorePolicy
  public let totalPoints: Double
  /// Score counted under the version policy (nil before the first attempt).
  public let effectiveScore: Double?
  public let passed: Bool

  public init(
    id: String, title: String, questions: [QuizQuestion], attemptsUsed: Int, attemptsRemaining: Int,
    passScore: Double, maxAttempts: Int? = nil, scorePolicy: QuizScorePolicy = .highest, totalPoints: Double? = nil,
    effectiveScore: Double? = nil, passed: Bool = false
  ) {
    self.id = id
    self.title = title
    self.questions = questions
    self.attemptsUsed = attemptsUsed
    self.attemptsRemaining = attemptsRemaining
    self.passScore = passScore
    self.maxAttempts = maxAttempts ?? (attemptsUsed + attemptsRemaining)
    self.scorePolicy = scorePolicy
    self.totalPoints = totalPoints ?? Double(questions.count)
    self.effectiveScore = effectiveScore
    self.passed = passed
  }

  enum CodingKeys: String, CodingKey {
    case id
    case title
    case questions
    case attemptsUsed = "attempts_used"
    case attemptsRemaining = "attempts_remaining"
    case passScore = "pass_score"
    case maxAttempts = "max_attempts"
    case scorePolicy = "score_policy"
    case totalPoints = "total_points"
    case effectiveScore = "effective_score"
    case passed
  }
}

/// Contract `QuizResult` (`POST /materials/{id}/quiz-attempts`, server-scored).
public struct QuizResult: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  /// Score of this attempt (0–100).
  public let score: Double
  public let passed: Bool
  public let submittedAt: Date
  public let attemptsUsed: Int
  public let attemptsRemaining: Int
  public let passScore: Double
  /// Score that counts for progress under the version policy (highest / latest).
  public let effectiveScore: Double
  public let correctCount: Int
  public let questionCount: Int

  public init(
    id: String, score: Double, passed: Bool, submittedAt: Date, attemptsUsed: Int = 1, attemptsRemaining: Int = 0,
    passScore: Double = 100, effectiveScore: Double? = nil, correctCount: Int = 0, questionCount: Int = 0
  ) {
    self.id = id
    self.score = score
    self.passed = passed
    self.submittedAt = submittedAt
    self.attemptsUsed = attemptsUsed
    self.attemptsRemaining = attemptsRemaining
    self.passScore = passScore
    self.effectiveScore = effectiveScore ?? score
    self.correctCount = correctCount
    self.questionCount = questionCount
  }

  enum CodingKeys: String, CodingKey {
    case id
    case score
    case passed
    case submittedAt = "submitted_at"
    case attemptsUsed = "attempts_used"
    case attemptsRemaining = "attempts_remaining"
    case passScore = "pass_score"
    case effectiveScore = "effective_score"
    case correctCount = "correct_count"
    case questionCount = "question_count"
  }
}

/// Contract `Submission` (student submit response, teacher review queue `GET /submissions`).
public struct Submission: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let materialId: String
  public let studentId: String
  public let state: SubmissionState
  public let body: String
  public let scanState: ScanState
  public let feedback: String?
  public let rowVersion: Int
  public let submittedAt: Date
  public let studentName: String
  public let materialTitle: String
  public let unitId: String
  public let unitTitle: String
  /// An uploaded file is attached (`GET /submissions/{id}/file` once scanned clean).
  public let hasFile: Bool
  public let filename: String?
  public let reviewedAt: Date?
  public let reviewerName: String?

  public init(
    id: String, materialId: String, studentId: String, state: SubmissionState, body: String, scanState: ScanState,
    feedback: String?, rowVersion: Int, submittedAt: Date, studentName: String = "", materialTitle: String = "",
    unitId: String = "", unitTitle: String = "", hasFile: Bool = false, filename: String? = nil,
    reviewedAt: Date? = nil, reviewerName: String? = nil
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
    self.studentName = studentName
    self.materialTitle = materialTitle
    self.unitId = unitId
    self.unitTitle = unitTitle
    self.hasFile = hasFile
    self.filename = filename
    self.reviewedAt = reviewedAt
    self.reviewerName = reviewerName
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
    case studentName = "student_name"
    case materialTitle = "material_title"
    case unitId = "unit_id"
    case unitTitle = "unit_title"
    case hasFile = "has_file"
    case filename
    case reviewedAt = "reviewed_at"
    case reviewerName = "reviewer_name"
  }
}

// MARK: - Uploads (quarantine → scan → attach)

public enum UploadPurpose: String, Codable, Sendable, Hashable {
  case material
  case assignment
  case `import`
}

/// Contract `UploadInput` (`POST /uploads`).
public struct UploadInput: Codable, Sendable, Equatable {
  public let filename: String
  public let contentType: String
  public let sizeBytes: Int
  public let purpose: UploadPurpose

  public init(filename: String, contentType: String, sizeBytes: Int, purpose: UploadPurpose) {
    self.filename = filename
    self.contentType = contentType
    self.sizeBytes = sizeBytes
    self.purpose = purpose
  }

  enum CodingKeys: String, CodingKey {
    case filename
    case contentType = "content_type"
    case sizeBytes = "size_bytes"
    case purpose
  }
}

/// Contract `Upload`: a 15-minute presigned PUT into quarantine. The client must PUT exactly the
/// declared bytes with `required_headers`, then call `POST /uploads/{id}/complete` and finally
/// attach the file by `object_key`.
public struct UploadTicket: Codable, Sendable, Equatable {
  public let id: String
  public let uploadUrl: String
  public let objectKey: String
  public let expiresAt: Date
  public let requiredHeaders: [String: String]

  public init(id: String, uploadUrl: String, objectKey: String, expiresAt: Date, requiredHeaders: [String: String]) {
    self.id = id
    self.uploadUrl = uploadUrl
    self.objectKey = objectKey
    self.expiresAt = expiresAt
    self.requiredHeaders = requiredHeaders
  }

  enum CodingKeys: String, CodingKey {
    case id
    case uploadUrl = "upload_url"
    case objectKey = "object_key"
    case expiresAt = "expires_at"
    case requiredHeaders = "required_headers"
  }
}

public enum UploadState: String, Codable, Sendable, Hashable {
  case awaitingUpload = "awaiting_upload"
  case scanning
  case clean
  case blocked
  case rejected
  case expired
}

/// Contract `UploadStatus` (`GET /uploads/{id}`, and the `data` of `POST /uploads/{id}/complete`).
public struct UploadStatus: Codable, Sendable, Equatable, Identifiable {
  public let id: String
  public let purpose: UploadPurpose
  public let filename: String
  public let contentType: String
  public let sizeBytes: Int
  public let state: UploadState
  public let scanState: ScanState
  public let objectKey: String
  public let createdAt: Date
  public let completedAt: Date?
  public let rejectCode: String?

  enum CodingKeys: String, CodingKey {
    case id
    case purpose
    case filename
    case contentType = "content_type"
    case sizeBytes = "size_bytes"
    case state
    case scanState = "scan_state"
    case objectKey = "object_key"
    case createdAt = "created_at"
    case completedAt = "completed_at"
    case rejectCode = "reject_code"
  }

  /// Verified (scanning) or clean uploads can be attached; anything else cannot.
  public var isAttachable: Bool { state == .scanning || state == .clean }
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
