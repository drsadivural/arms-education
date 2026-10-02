import Foundation

/// Display rules for progress (IOS-02/04/05/06). Values always come from the server's progress
/// service; the app never computes or invents a percentage.
public struct ProgressSummary: Sendable, Equatable {
  /// 「76%」 or 「未設定」 when no units are assigned (progress_percent = null).
  public let percentText: String
  /// 0…1 for rings and bars; nil when not set (render an empty track with the 「未設定」 label).
  public let fraction: Double?
  /// 「必須単元 6 / 8 完了」 or 「必須単元はまだ割り当てられていません」.
  public let requiredText: String
  /// Headline sentence for the progress card.
  public let headline: String
  public let isConfigured: Bool

  public init(progress: StudentProgress) {
    let configured = progress.progressPercent != nil
    isConfigured = configured
    percentText = JaFormat.percent(progress.progressPercent)
    fraction = progress.progressPercent.map { Double(min(100, max(0, $0))) / 100 }
    if progress.requiredTotal > 0 {
      requiredText = "必須単元 \(progress.requiredCompleted) / \(progress.requiredTotal) 完了"
    } else {
      requiredText = "必須単元はまだ割り当てられていません"
    }
    headline = ProgressSummary.headline(for: progress)
  }

  static func headline(for progress: StudentProgress) -> String {
    guard progress.progressPercent != nil, !progress.units.isEmpty else {
      return "研修プログラムが未設定です"
    }
    if progress.requiredTotal > 0, progress.requiredCompleted >= progress.requiredTotal {
      return "すべての必須単元を完了しました"
    }
    if progress.units.contains(where: { $0.state == .reviewPending }) {
      return "講師の確認を待っている単元があります"
    }
    if progress.units.allSatisfy({ $0.state == .notStarted }) {
      return "研修を始めましょう"
    }
    return "研修を受講中です"
  }
}

/// Per-unit detail line, e.g. 「教材確認・テスト92点・講師評価済み」.
public enum UnitPresentation {
  public static func detail(_ unit: UnitProgress) -> String {
    var parts: [String] = []
    switch unit.state {
    case .notStarted:
      return "まだ始めていません"
    case .reviewPending:
      parts.append("提出済み・講師の評価を待っています")
    case .inProgress:
      parts.append("受講中")
    case .completed:
      parts.append("完了条件を満たしました")
    }
    if let score = unit.score {
      parts.append("テスト\(formatScore(score))点")
    }
    if unit.requiresReview, unit.state == .completed {
      parts.append("講師評価済み")
    }
    return parts.joined(separator: "・")
  }

  public static func formatScore(_ score: Double) -> String {
    score.rounded() == score ? String(Int(score)) : String(format: "%.1f", score)
  }

  /// Bar value only where the state determines it exactly (the contract has no unit percentage).
  public static func fraction(_ unit: UnitProgress) -> Double? {
    switch unit.state {
    case .completed: return 1
    case .notStarted: return 0
    case .inProgress, .reviewPending: return nil
    }
  }
}

/// Status of a student in the teacher list (IOS-05): 完了 / 期限超過 / 受講中 / 未設定 / 停止中.
public enum StudentListStatus: Sendable, Equatable {
  case completed
  case overdue
  case inProgress
  case notConfigured
  case inactive

  public init(student: Student, today: LocalDate) {
    if !student.active {
      self = .inactive
    } else if let p = student.progressPercent {
      if p >= 100 {
        self = .completed
      } else if student.trainingDueOn < today {
        // Overdue is derived from the date-only due date and the organisation's local today.
        self = .overdue
      } else {
        self = .inProgress
      }
    } else {
      self = .notConfigured
    }
  }

  public var labelJa: String {
    switch self {
    case .completed: return "完了"
    case .overdue: return "期限超過"
    case .inProgress: return "受講中"
    case .notConfigured: return "未設定"
    case .inactive: return "停止中"
    }
  }

  public var tone: StatusTone {
    switch self {
    case .completed: return .success
    case .overdue: return .danger
    case .inProgress: return .info
    case .notConfigured, .inactive: return .neutral
    }
  }
}
