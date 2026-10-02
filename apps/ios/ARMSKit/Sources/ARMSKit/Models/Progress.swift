import Foundation

public enum UnitState: String, Codable, Sendable, CaseIterable, Hashable {
  case notStarted = "not_started"
  case inProgress = "in_progress"
  case reviewPending = "review_pending"
  case completed
}

/// Contract `UnitProgress` (one unit of one enrollment, with the completion-condition breakdown
/// computed by the shared progress service `services/api/src/domain/progress.ts`).
public struct UnitProgress: Codable, Sendable, Hashable, Identifiable {
  /// Unit id.
  public let id: String
  public let title: String
  public let state: UnitState
  public let weight: Double
  /// Quiz score counted under the version policy (nil when the unit has no attempted quiz).
  public let score: Double?
  public let requiresReview: Bool
  /// Latest teacher comment on the unit's assignment.
  public let feedback: String?
  public let enrollmentId: String
  public let programVersionId: String
  public let programName: String
  public let position: Int
  /// Optional units are excluded from the progress percentage.
  public let required: Bool
  public let completedAt: Date?
  /// Required PDF/動画/画像/リンク materials and how many the student confirmed.
  public let materialsTotal: Int
  public let materialsConfirmed: Int
  /// nil when the unit has no required quiz.
  public let quizPassed: Bool?
  /// nil when the unit has no assignment (or nothing was submitted yet).
  public let submissionState: SubmissionState?
  public let attendanceRequired: Bool
  public let attendanceSatisfied: Bool

  public init(
    id: String, title: String, state: UnitState, weight: Double, score: Double?, requiresReview: Bool,
    feedback: String?, enrollmentId: String = "", programVersionId: String = "", programName: String = "",
    position: Int = 0, required: Bool = true, completedAt: Date? = nil, materialsTotal: Int = 0,
    materialsConfirmed: Int = 0, quizPassed: Bool? = nil, submissionState: SubmissionState? = nil,
    attendanceRequired: Bool = false, attendanceSatisfied: Bool = false
  ) {
    self.id = id
    self.title = title
    self.state = state
    self.weight = weight
    self.score = score
    self.requiresReview = requiresReview
    self.feedback = feedback
    self.enrollmentId = enrollmentId
    self.programVersionId = programVersionId
    self.programName = programName
    self.position = position
    self.required = required
    self.completedAt = completedAt
    self.materialsTotal = materialsTotal
    self.materialsConfirmed = materialsConfirmed
    self.quizPassed = quizPassed
    self.submissionState = submissionState
    self.attendanceRequired = attendanceRequired
    self.attendanceSatisfied = attendanceSatisfied
  }

  enum CodingKeys: String, CodingKey {
    case id
    case title
    case state
    case weight
    case score
    case requiresReview = "requires_review"
    case feedback
    case enrollmentId = "enrollment_id"
    case programVersionId = "program_version_id"
    case programName = "program_name"
    case position
    case required
    case completedAt = "completed_at"
    case materialsTotal = "materials_total"
    case materialsConfirmed = "materials_confirmed"
    case quizPassed = "quiz_passed"
    case submissionState = "submission_state"
    case attendanceRequired = "attendance_required"
    case attendanceSatisfied = "attendance_satisfied"
  }

  /// Unique list identity (a unit id is unique per program version; enrollments pin one version).
  public var rowId: String { "\(enrollmentId)/\(id)" }
}

/// Contract `EnrollmentProgress`: one assigned program (fixed published version) with its due date.
public struct EnrollmentProgress: Codable, Sendable, Hashable, Identifiable {
  public let enrollmentId: String
  public let programId: String
  public let programName: String
  public let programVersionId: String
  public let versionNumber: Int
  /// Date-only due date in the organisation calendar.
  public let dueOn: LocalDate
  /// Not completed and the due date is before today (server-computed in the organisation timezone).
  public let overdue: Bool
  public let progressPercent: Int?
  public let requiredTotal: Int
  public let requiredCompleted: Int

  public var id: String { enrollmentId }

  public init(
    enrollmentId: String, programId: String, programName: String, programVersionId: String, versionNumber: Int,
    dueOn: LocalDate, overdue: Bool, progressPercent: Int?, requiredTotal: Int, requiredCompleted: Int
  ) {
    self.enrollmentId = enrollmentId
    self.programId = programId
    self.programName = programName
    self.programVersionId = programVersionId
    self.versionNumber = versionNumber
    self.dueOn = dueOn
    self.overdue = overdue
    self.progressPercent = progressPercent
    self.requiredTotal = requiredTotal
    self.requiredCompleted = requiredCompleted
  }

  enum CodingKeys: String, CodingKey {
    case enrollmentId = "enrollment_id"
    case programId = "program_id"
    case programName = "program_name"
    case programVersionId = "program_version_id"
    case versionNumber = "version_number"
    case dueOn = "due_on"
    case overdue
    case progressPercent = "progress_percent"
    case requiredTotal = "required_total"
    case requiredCompleted = "required_completed"
  }
}

/// Contract `Progress` (`GET /students/{id}/progress`, a bare object with `checked_at`). Computed on
/// the server by the shared progress service; `progressPercent == nil` means no required units are
/// assigned (「未設定」).
public struct StudentProgress: Codable, Sendable, Hashable {
  public let studentId: String
  public let studentName: String
  public let progressPercent: Int?
  public let requiredTotal: Int
  public let requiredCompleted: Int
  public let units: [UnitProgress]
  public let enrollments: [EnrollmentProgress]
  public let checkedAt: Date

  public init(
    studentId: String, studentName: String = "", progressPercent: Int?, requiredTotal: Int, requiredCompleted: Int,
    units: [UnitProgress], enrollments: [EnrollmentProgress] = [], checkedAt: Date
  ) {
    self.studentId = studentId
    self.studentName = studentName
    self.progressPercent = progressPercent
    self.requiredTotal = requiredTotal
    self.requiredCompleted = requiredCompleted
    self.units = units
    self.enrollments = enrollments
    self.checkedAt = checkedAt
  }

  enum CodingKeys: String, CodingKey {
    case studentId = "student_id"
    case studentName = "student_name"
    case progressPercent = "progress_percent"
    case requiredTotal = "required_total"
    case requiredCompleted = "required_completed"
    case units
    case enrollments
    case checkedAt = "checked_at"
  }

  /// Units of one enrollment in program order.
  public func units(of enrollment: EnrollmentProgress) -> [UnitProgress] {
    units.filter { $0.enrollmentId == enrollment.enrollmentId }.sorted { $0.position < $1.position }
  }
}
