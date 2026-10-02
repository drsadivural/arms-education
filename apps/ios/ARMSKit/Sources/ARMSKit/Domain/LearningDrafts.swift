import Foundation

/// Attendance form state for one lesson (IOS-16), built from the server roster
/// (`GET /lesson-slots/{id}/attendance`). Students already recorded start with their saved state
/// and note; the others default to 出席 as in the design and the teacher changes exceptions.
public struct AttendanceDraft: Sendable, Equatable {
  public struct Row: Sendable, Equatable, Identifiable {
    public let studentId: String
    public let studentName: String
    public let employeeNumber: String
    public var state: AttendanceState
    public var note: String
    /// Saved on the server (「記録済み：田中 祥司 10:05」) — nil until recorded.
    public let recordedByName: String?
    public let recordedAt: Date?
    /// The student's reservation for the slot is no longer approved (kept for correction).
    public let reservationStatus: ReservationStatus?
    public var id: String { studentId }

    public var isRecorded: Bool { recordedAt != nil }
  }

  public private(set) var rows: [Row]
  public static let maxNoteLength = 1000

  public init(attendees: [(studentId: String, name: String)]) {
    var seen = Set<String>()
    rows = attendees.compactMap { a in
      guard seen.insert(a.studentId).inserted else { return nil }
      return Row(
        studentId: a.studentId, studentName: a.name, employeeNumber: "", state: .present, note: "", recordedByName: nil,
        recordedAt: nil, reservationStatus: .approved)
    }
  }

  /// Rows in the server's roster order (社員番号).
  public init(roster: AttendanceRoster) {
    var seen = Set<String>()
    rows = roster.items.compactMap { item in
      guard seen.insert(item.studentId).inserted else { return nil }
      return Row(
        studentId: item.studentId, studentName: item.studentName, employeeNumber: item.employeeNumber,
        state: item.attendanceState ?? .present, note: item.note, recordedByName: item.recordedByName,
        recordedAt: item.recordedAt, reservationStatus: item.reservationStatus)
    }
  }

  public mutating func setState(_ state: AttendanceState, for studentId: String) {
    guard let i = rows.firstIndex(where: { $0.studentId == studentId }) else { return }
    rows[i].state = state
  }

  public mutating func setNote(_ note: String, for studentId: String) {
    guard let i = rows.firstIndex(where: { $0.studentId == studentId }) else { return }
    rows[i].note = String(note.prefix(AttendanceDraft.maxNoteLength))
  }

  public var studentIds: [String] { rows.map(\.studentId) }

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

  /// 「全5問 / 合格点80点 / 受験可能（残り2回）」 (or 「受験回数の上限に達しました」).
  public static func summary(_ quiz: Quiz) -> String {
    let availability = quiz.attemptsRemaining > 0 ? "受験可能（残り\(quiz.attemptsRemaining)回）" : "受験回数の上限に達しました"
    return "全\(quiz.questions.count)問 / 合格点\(UnitPresentation.formatScore(quiz.passScore))点 / \(availability)"
  }

  /// 「受験回数の上限：3回（最高点を採用）」.
  public static func policyText(_ quiz: Quiz) -> String {
    "受験回数の上限：\(quiz.maxAttempts)回（\(quiz.scorePolicy.labelJa)）"
  }

  /// 「現在の評価：92点・合格」 once attempted (the score counted under the version policy).
  public static func currentScoreText(_ quiz: Quiz) -> String? {
    guard let score = quiz.effectiveScore else { return nil }
    return "現在の評価：\(UnitPresentation.formatScore(score))点・\(quiz.passed ? "合格" : "不合格")"
  }
}

/// Assignment validation (contract: body ≤ 10,000 characters; text or an uploaded file is required).
public enum AssignmentRules {
  public static let maxLength = 10_000
  /// `PURPOSE_RULES.assignment` in services/api/src/domain/learning/files.ts.
  public static let allowedContentTypes: [String: [String]] = [
    "application/pdf": ["pdf"], "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"],
  ]
  public static let maxFileBytes = 20 * 1024 * 1024

  public static func validate(_ body: String) -> String? {
    validate(body, hasAttachment: false)
  }

  public static func validate(_ body: String, hasAttachment: Bool) -> String? {
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty && !hasAttachment { return "提出内容を入力してください。" }
    if body.count > maxLength { return "提出内容は10,000文字以内で入力してください。" }
    return nil
  }

  /// Checks a file before `POST /uploads` (the server re-checks type, extension, size and bytes).
  public static func validateAttachment(filename: String, contentType: String, sizeBytes: Int) -> String? {
    let type = contentType.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
    guard let extensions = allowedContentTypes[type] else { return "添付できるファイルはPDF・PNG・JPEGです。" }
    let ext = filename.split(separator: ".").last.map { $0.lowercased() } ?? ""
    guard filename.contains("."), extensions.contains(ext) else { return "ファイルの拡張子が形式と一致しません。" }
    if sizeBytes <= 0 { return "空のファイルは添付できません。" }
    if sizeBytes > maxFileBytes { return "ファイルサイズは20MB以下にしてください。" }
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
