import Foundation
import Observation

/// IOS-04 研修の進捗 (student's own progress, server-computed).
@MainActor
@Observable
public final class ProgressModel {
  public private(set) var progress = Loadable<StudentProgress>()
  public let context: AppContext

  public init(context: AppContext) { self.context = context }

  public var summary: ProgressSummary? { progress.value.map(ProgressSummary.init) }

  /// 「更新：10月2日 11:20」 from the server's `checked_at`.
  public var updatedLabel: String? {
    progress.checkedAt.map { "更新：\(JaFormat.shortDateTime($0, calendar: context.calendar))" }
  }

  public func load() async {
    guard let me = context.me else { return }
    progress.beginLoading()
    let api = context.api
    progress.apply(
      await context.fetch(cacheKey: "progress/\(me.id)", checkedAt: { $0.checkedAt }) { () async throws in
        try await api.send(API.progress(studentId: me.id)).value
      })
  }
}

/// IOS-05 担当受講者の進捗 (teacher scope; the server returns only assigned students).
@MainActor
@Observable
public final class TeacherStudentsModel {
  public struct Row: Identifiable, Sendable, Equatable {
    public let student: Student
    public let status: StudentListStatus
    public let classroomName: String?
    public let teacherName: String?
    public var id: String { student.id }
  }

  public private(set) var students = Loadable<Page<Student>>()
  public private(set) var classrooms: [Classroom] = []
  public private(set) var teacherNames: [String: String] = [:]
  public private(set) var isLoadingMore = false
  public var searchText = ""
  public var classroomId: String?
  public let context: AppContext

  public init(context: AppContext) { self.context = context }

  public var selectedClassroomName: String {
    classroomId.flatMap { id in classrooms.first { $0.id == id }?.name } ?? "すべてのクラス"
  }

  public var rows: [Row] {
    let today = context.calendar.today(now: context.now())
    let classNames = Dictionary(classrooms.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
    return (students.value?.items ?? []).map { s in
      Row(
        student: s, status: StudentListStatus(student: s, today: today), classroomName: classNames[s.classroomId],
        teacherName: teacherName(for: s.teacherId))
    }
  }

  public var canLoadMore: Bool { students.value?.nextCursor != nil && !isLoadingMore }

  private func teacherName(for id: String) -> String? {
    if id == context.me?.id { return context.me?.displayName }
    return teacherNames[id]
  }

  private var cacheKey: String { "students/\(classroomId ?? "all")/\(searchText)" }

  private var query: ListQuery { ListQuery(limit: 30, q: searchText, classroomId: classroomId) }

  public func load() async {
    students.beginLoading()
    let api = context.api
    let query = self.query
    if classrooms.isEmpty {
      if let all = try? await api.collectAll(query: ListQuery(limit: 100), API.classrooms) {
        classrooms = all.items.filter { !$0.archived }.sorted { $0.name < $1.name }
      }
    }
    if teacherNames.isEmpty, let teachers = try? await api.collectAll(query: ListQuery(limit: 100), API.teachers) {
      teacherNames = Dictionary(teachers.items.map { ($0.id, $0.displayName) }, uniquingKeysWith: { a, _ in a })
    }
    students.apply(
      await context.fetch(cacheKey: cacheKey, checkedAt: { $0.checkedAt }) { () async throws in
        try await api.send(API.students(query)).value
      })
  }

  public func loadMore() async {
    guard let current = students.value, let cursor = current.nextCursor, !isLoadingMore else { return }
    isLoadingMore = true
    defer { isLoadingMore = false }
    do {
      let next = try await context.api.send(API.students(query.with(cursor: cursor))).value
      students.update(
        Page(items: current.items + next.items, nextCursor: next.nextCursor, checkedAt: current.checkedAt),
        checkedAt: current.checkedAt)
    } catch {
      students.apply(.failure(error))
    }
  }
}

/// IOS-06 受講者の詳細 (teacher): profile, unit states/scores/feedback and the review queue.
@MainActor
@Observable
public final class StudentDetailModel {
  public let studentId: String
  public private(set) var student = Loadable<DataEnvelope<Student>>()
  public private(set) var progress = Loadable<StudentProgress>()
  /// Submissions awaiting review for this student (nil until loaded / unavailable).
  public private(set) var pendingSubmissions = Loadable<[Submission]>()
  public let context: AppContext

  public init(studentId: String, context: AppContext) {
    self.studentId = studentId
    self.context = context
  }

  public var summary: ProgressSummary? { progress.value.map(ProgressSummary.init) }

  public var reviewPendingUnits: [UnitProgress] {
    progress.value?.units.filter { $0.state == .reviewPending } ?? []
  }

  public func load() async {
    student.beginLoading()
    progress.beginLoading()
    pendingSubmissions.beginLoading()
    let api = context.api
    let id = studentId
    student.apply(
      await context.fetch(cacheKey: "student/\(id)", checkedAt: { $0.checkedAt }) { () async throws in
        try await api.send(API.student(id: id)).value
      })
    progress.apply(
      await context.fetch(cacheKey: "progress/\(id)", checkedAt: { $0.checkedAt }) { () async throws in
        try await api.send(API.progress(studentId: id)).value
      })
    let checked = context.now()
    pendingSubmissions.apply(
      await context.fetch(cacheKey: nil, checkedAt: { _ in checked }) { () async throws in
        let all = try await api.collectAll(
          maxPages: 5, query: ListQuery(limit: 100, studentId: id, status: "submitted"), API.submissions)
        return all.items.filter { $0.studentId == id && $0.state == .submitted }.sorted { $0.submittedAt > $1.submittedAt }
      })
  }

  /// Removes a reviewed submission from the queue after the server confirmed the review.
  public func didReview(_ submission: Submission) {
    pendingSubmissions.updateValue { list in list.removeAll { $0.id == submission.id } }
  }
}

/// Teacher review of one submission (合格にする / 再提出を依頼 with a required comment).
@MainActor
@Observable
public final class SubmissionReviewModel {
  public let submission: Submission
  public var feedback = ""
  public private(set) var isSubmitting = false
  public private(set) var error: ARMSError?
  public private(set) var result: Submission?
  private var keys = ActionKeys()
  public let context: AppContext

  public init(submission: Submission, context: AppContext) {
    self.submission = submission
    self.feedback = submission.feedback ?? ""
    self.context = context
  }

  public var feedbackError: String? { AssignmentRules.validateFeedback(feedback) }

  /// Returns the reviewed submission confirmed by the server, or nil on failure (see `error`).
  @discardableResult
  public func review(_ decision: ReviewDecision) async -> Submission? {
    guard !isSubmitting, result == nil else { return result }
    if let blocker = context.mutationBlocker() {
      error = blocker
      return nil
    }
    if let message = feedbackError {
      error = .validation(["feedback": message])
      return nil
    }
    let trimmed = feedback.trimmingCharacters(in: .whitespacesAndNewlines)
    let action = "review:\(submission.id):\(decision.rawValue):\(trimmed)"
    let key = keys.key(for: action)
    isSubmitting = true
    error = nil
    defer { isSubmitting = false }
    do {
      let input = ReviewInput(state: decision, feedback: trimmed, expectedVersion: submission.rowVersion)
      let reviewed = try await context.api.send(API.reviewSubmission(id: submission.id, input: input, key: key)).value.data
      keys.complete(action)
      result = reviewed
      return reviewed
    } catch {
      self.error = error
      return nil
    }
  }

  public var successMessage: String? {
    guard let result else { return nil }
    switch result.state {
    case .accepted: return "合格として評価しました。"
    case .revisionRequested: return "再提出を依頼しました。"
    case .submitted: return "評価を保存しました。"
    }
  }
}
