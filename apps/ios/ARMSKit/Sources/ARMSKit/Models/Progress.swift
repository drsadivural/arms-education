import Foundation

public enum UnitState: String, Codable, Sendable, CaseIterable, Hashable {
  case notStarted = "not_started"
  case inProgress = "in_progress"
  case reviewPending = "review_pending"
  case completed
}

/// Contract `UnitProgress`.
public struct UnitProgress: Codable, Sendable, Hashable, Identifiable {
  public let id: String
  public let title: String
  public let state: UnitState
  public let weight: Double
  public let score: Double?
  public let requiresReview: Bool
  public let feedback: String?

  public init(
    id: String, title: String, state: UnitState, weight: Double, score: Double?, requiresReview: Bool,
    feedback: String?
  ) {
    self.id = id
    self.title = title
    self.state = state
    self.weight = weight
    self.score = score
    self.requiresReview = requiresReview
    self.feedback = feedback
  }

  enum CodingKeys: String, CodingKey {
    case id
    case title
    case state
    case weight
    case score
    case requiresReview = "requires_review"
    case feedback
  }
}

/// Contract `Progress` (`GET /students/{id}/progress`). Computed on the server by the shared
/// progress service; `progressPercent == nil` means no units are assigned (「未設定」).
public struct StudentProgress: Codable, Sendable, Hashable {
  public let studentId: String
  public let progressPercent: Int?
  public let requiredTotal: Int
  public let requiredCompleted: Int
  public let units: [UnitProgress]
  public let checkedAt: Date

  public init(
    studentId: String, progressPercent: Int?, requiredTotal: Int, requiredCompleted: Int, units: [UnitProgress],
    checkedAt: Date
  ) {
    self.studentId = studentId
    self.progressPercent = progressPercent
    self.requiredTotal = requiredTotal
    self.requiredCompleted = requiredCompleted
    self.units = units
    self.checkedAt = checkedAt
  }

  enum CodingKeys: String, CodingKey {
    case studentId = "student_id"
    case progressPercent = "progress_percent"
    case requiredTotal = "required_total"
    case requiredCompleted = "required_completed"
    case units
    case checkedAt = "checked_at"
  }
}
