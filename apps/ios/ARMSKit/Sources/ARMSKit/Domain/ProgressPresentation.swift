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
  /// Nearest due date of an unfinished program, e.g. 「次の期限：12月25日（金）（新入社員基礎研修）」
  /// or 「期限超過：…」 (server-computed `overdue`); nil when every program is complete / none assigned.
  public let dueText: String?

  public init(progress: StudentProgress) {
    let open = progress.enrollments.filter { !EnrollmentPresentation.isCompleted($0) }
      .sorted { ($0.overdue ? 0 : 1, $0.dueOn) < ($1.overdue ? 0 : 1, $1.dueOn) }
    dueText = open.first.map { e in
      "\(e.overdue ? "期限超過" : "次の期限")：\(JaFormat.date(e.dueOn))（\(e.programName)）"
    }
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
    if progress.enrollments.contains(where: \.overdue) {
      return "期限を過ぎている研修プログラムがあります"
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

/// Per-unit detail line built only from the server's completion-condition breakdown, e.g.
/// 「教材確認 3/3・テスト92点（合格）・課題 講師評価済み」.
public enum UnitPresentation {
  public static func detail(_ unit: UnitProgress) -> String {
    var parts: [String] = []
    if unit.materialsTotal > 0 {
      parts.append("教材確認 \(unit.materialsConfirmed)/\(unit.materialsTotal)")
    }
    if let passed = unit.quizPassed {
      if let score = unit.score {
        parts.append("テスト\(formatScore(score))点（\(passed ? "合格" : "不合格")）")
      } else {
        parts.append("テスト未受験")
      }
    } else if let score = unit.score {
      parts.append("テスト\(formatScore(score))点")
    }
    switch unit.submissionState {
    case .submitted?: parts.append("課題提出済み・講師の評価待ち")
    case .accepted?: parts.append(unit.requiresReview ? "課題 講師評価済み" : "課題提出済み")
    case .revisionRequested?: parts.append("課題 再提出の依頼あり")
    case nil: break
    }
    if unit.attendanceRequired {
      parts.append(unit.attendanceSatisfied ? "出席済み" : "授業への出席が必要")
    }
    if !parts.isEmpty { return parts.joined(separator: "・") }
    switch unit.state {
    case .notStarted: return "まだ始めていません"
    case .inProgress: return "受講中"
    case .reviewPending: return "講師の評価を待っています"
    case .completed: return "完了条件を満たしました"
    }
  }

  /// 「完了日：10月2日（金）」.
  public static func completedLabel(_ unit: UnitProgress, calendar: OrgCalendar) -> String? {
    unit.completedAt.map { "完了日：\(JaFormat.instantDate($0, calendar: calendar, withYear: false))" }
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

/// Display rules for one assigned program (`Progress.enrollments`): program, published version,
/// due date and the server's overdue flag.
public enum EnrollmentPresentation {
  /// 「ビジネス基礎研修（第2版）」.
  public static func title(_ e: EnrollmentProgress) -> String { "\(e.programName)（第\(e.versionNumber)版）" }

  /// 「期限：2026年12月31日（木）」.
  public static func dueText(_ e: EnrollmentProgress) -> String { "期限：\(JaFormat.date(e.dueOn, withYear: true))" }

  /// 「必須単元 3 / 5 完了」.
  public static func requiredText(_ e: EnrollmentProgress) -> String {
    e.requiredTotal > 0 ? "必須単元 \(e.requiredCompleted) / \(e.requiredTotal) 完了" : "必須単元はありません"
  }

  public static func isCompleted(_ e: EnrollmentProgress) -> Bool {
    e.requiredTotal > 0 && e.requiredCompleted >= e.requiredTotal
  }

  /// 完了 / 期限超過 / 受講中 / 未設定 (colour is never the only signal).
  public static func status(_ e: EnrollmentProgress) -> (label: String, tone: StatusTone) {
    if isCompleted(e) { return ("完了", .success) }
    if e.overdue { return ("期限超過", .danger) }
    if e.progressPercent == nil { return ("未設定", .neutral) }
    return ("受講中", .info)
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
