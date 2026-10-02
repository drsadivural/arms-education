import Foundation

/// Attendance form state for one lesson (IOS-16). Defaults every attendee to 出席 as in the design;
/// the teacher changes exceptions and may add a note per student.
public struct AttendanceDraft: Sendable, Equatable {
  public struct Row: Sendable, Equatable, Identifiable {
    public let studentId: String
    public let studentName: String
    public var state: AttendanceState
    public var note: String
    public var id: String { studentId }
  }

  public private(set) var rows: [Row]
  public static let maxNoteLength = 1000

  public init(attendees: [(studentId: String, name: String)]) {
    var seen = Set<String>()
    rows = attendees.compactMap { a in
      guard seen.insert(a.studentId).inserted else { return nil }
      return Row(studentId: a.studentId, studentName: a.name, state: .present, note: "")
    }
  }

  /// Attendees are the students with an approved reservation for the slot.
  public init(reservations: [Reservation], slotId: String) {
    let approved = reservations.filter { $0.slotId == slotId && $0.status == .approved }
      .sorted { ($0.studentName ?? "") < ($1.studentName ?? "") }
    self.init(attendees: approved.map { ($0.studentId, $0.studentName ?? "受講者") })
  }

  public mutating func setState(_ state: AttendanceState, for studentId: String) {
    guard let i = rows.firstIndex(where: { $0.studentId == studentId }) else { return }
    rows[i].state = state
  }

  public mutating func setNote(_ note: String, for studentId: String) {
    guard let i = rows.firstIndex(where: { $0.studentId == studentId }) else { return }
    rows[i].note = String(note.prefix(AttendanceDraft.maxNoteLength))
  }

  public var isEmpty: Bool { rows.isEmpty }

  public func input() -> AttendanceInput {
    AttendanceInput(
      records: rows.map { row in
        let note = row.note.trimmingCharacters(in: .whitespacesAndNewlines)
        return AttendanceInput.Record(studentId: row.studentId, state: row.state, note: note.isEmpty ? nil : note)
      })
  }

  /// Stable identity of the submitted content, used to decide whether a new idempotency key is needed.
  public var contentFingerprint: String {
    rows.map { "\($0.studentId)=\($0.state.rawValue):\($0.note.trimmingCharacters(in: .whitespacesAndNewlines))" }
      .joined(separator: "|")
  }
}

/// Client-side answer selection for a server-scored quiz (IOS-12). Correct answers are never
/// available on the client; only the selected option ids are sent.
public struct QuizSession: Sendable, Equatable {
  public let quiz: Quiz
  public private(set) var currentIndex: Int = 0
  public private(set) var selections: [String: Set<String>] = [:]

  public init(quiz: Quiz) { self.quiz = quiz }

  public var currentQuestion: QuizQuestion? {
    quiz.questions.indices.contains(currentIndex) ? quiz.questions[currentIndex] : nil
  }

  public var isLastQuestion: Bool { currentIndex >= quiz.questions.count - 1 }
  public var questionCount: Int { quiz.questions.count }

  /// Single-choice selection (the contract allows several ids; the UI uses one per question).
  public mutating func select(_ choiceId: String, for questionId: String) {
    guard let q = quiz.questions.first(where: { $0.id == questionId }), q.choices.contains(where: { $0.id == choiceId })
    else { return }
    selections[questionId] = [choiceId]
  }

  public func selected(for questionId: String) -> Set<String> { selections[questionId] ?? [] }

  public var canAdvance: Bool {
    guard let q = currentQuestion else { return false }
    return !(selections[q.id] ?? []).isEmpty
  }

  public mutating func next() {
    guard canAdvance, !isLastQuestion else { return }
    currentIndex += 1
  }

  public mutating func previous() {
    guard currentIndex > 0 else { return }
    currentIndex -= 1
  }

  public var isComplete: Bool {
    quiz.questions.allSatisfy { !(selections[$0.id] ?? []).isEmpty }
  }

  public func input() -> QuizInput {
    QuizInput(
      answers: quiz.questions.map { q in
        QuizInput.Answer(questionId: q.id, selectedOptionIds: (selections[q.id] ?? []).sorted())
      })
  }

  /// 「全5問 / 合格点80点 / 受験可能」 (or 「受験回数の上限に達しました」).
  public static func summary(_ quiz: Quiz) -> String {
    let availability = quiz.attemptsRemaining > 0 ? "受験可能（残り\(quiz.attemptsRemaining)回）" : "受験回数の上限に達しました"
    return "全\(quiz.questions.count)問 / 合格点\(UnitPresentation.formatScore(quiz.passScore))点 / \(availability)"
  }
}

/// Assignment text validation (contract: 1–10,000 characters).
public enum AssignmentRules {
  public static let maxLength = 10_000

  public static func validate(_ body: String) -> String? {
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "提出内容を入力してください。" }
    if body.count > maxLength { return "提出内容は10,000文字以内で入力してください。" }
    return nil
  }

  /// Teacher feedback is required for review (contract: max 2,000 characters).
  public static func validateFeedback(_ feedback: String) -> String? {
    let trimmed = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "講師コメントを入力してください。" }
    if feedback.count > 2000 { return "講師コメントは2,000文字以内で入力してください。" }
    return nil
  }
}
