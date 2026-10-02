import Foundation
import Observation

/// IOS-02 ホーム (student): own progress, today's approved lessons, unread notifications, voice entry.
@MainActor
@Observable
public final class StudentHomeModel {
  public private(set) var progress = Loadable<StudentProgress>()
  public private(set) var today = Loadable<Page<LessonSlot>>()
  public let context: AppContext

  public init(context: AppContext) { self.context = context }

  public var greeting: String {
    let name = JaFormat.familyName(context.me?.displayName ?? "")
    return "\(JaFormat.greeting(now: context.now(), calendar: context.calendar))、\n\(name)さん。"
  }

  public var dateLabel: String { JaFormat.instantDate(context.now(), calendar: context.calendar) }

  public var summary: ProgressSummary? { progress.value.map(ProgressSummary.init) }

  /// Today's lessons the student can attend (approved reservations, per the server).
  public var lessons: [LessonSlot] { (today.value?.items ?? []).sorted { $0.startsAt < $1.startsAt } }

  public func load() async {
    guard let me = context.me else { return }
    progress.beginLoading()
    today.beginLoading()
    let api = context.api
    async let p = context.fetch(cacheKey: "progress/\(me.id)", checkedAt: { $0.checkedAt }) { () async throws in
      try await api.send(API.progress(studentId: me.id)).value
    }
    async let t = context.fetch(cacheKey: "today-lessons", checkedAt: { $0.checkedAt }) { () async throws in
      try await api.send(API.todayLessons()).value
    }
    let (po, to) = await (p, t)
    progress.apply(po)
    today.apply(to)
    await NotificationsModel.refreshUnreadCount(context: context)
  }
}

/// IOS-03 講師ホーム: today's lessons taught, assigned students, pending approvals, reviews.
@MainActor
@Observable
public final class TeacherHomeModel {
  public struct Counts: Codable, Sendable, Equatable {
    public var students: Int
    public var studentsComplete: Bool
    public var pendingReservations: Int
    public var pendingReviews: Int?
    public var checkedAt: Date
  }

  public private(set) var today = Loadable<Page<LessonSlot>>()
  public private(set) var counts = Loadable<Counts>()
  public let context: AppContext

  public init(context: AppContext) { self.context = context }

  public var greeting: String {
    "\(JaFormat.familyName(context.me?.displayName ?? ""))先生、\n本日もよろしくお願いします。"
  }

  public var dateLabel: String { JaFormat.instantDate(context.now(), calendar: context.calendar) }
  public var lessons: [LessonSlot] { (today.value?.items ?? []).sorted { $0.startsAt < $1.startsAt } }

  nonisolated static func fetchCounts(api: APIClient, now: Date) async throws -> Counts {
    let students = try await api.collectAll(query: ListQuery(limit: 100), API.students)
    let pending = try await api.collectAll(query: ListQuery(limit: 100, status: "pending"), API.reservations)
    var reviews: Int? = nil
    switch await reviewQueueCount(api: api) {
    case .success(let count): reviews = count
    case .failure(let error):
      // The review queue is optional for this screen; the count is hidden if unavailable.
      if error.isConnectivity { throw error }
    }
    return Counts(
      students: students.items.filter(\.active).count, studentsComplete: students.complete,
      pendingReservations: pending.items.filter { ReservationRules.canDecide($0, now: now) }.count,
      pendingReviews: reviews, checkedAt: students.checkedAt)
  }

  nonisolated static func reviewQueueCount(api: APIClient) async -> Result<Int, ARMSError> {
    do {
      let subs = try await api.collectAll(query: ListQuery(limit: 100, status: "submitted"), API.submissions)
      return .success(subs.items.filter { $0.state == .submitted }.count)
    } catch {
      return .failure((error as? ARMSError) ?? .offline)
    }
  }

  public func load() async {
    today.beginLoading()
    counts.beginLoading()
    let api = context.api
    let now = context.now()
    today.apply(
      await context.fetch(cacheKey: "today-lessons", checkedAt: { $0.checkedAt }) { () async throws in
        try await api.send(API.todayLessons()).value
      })
    counts.apply(
      await context.fetch(cacheKey: "teacher-counts", checkedAt: { $0.checkedAt }) { () async throws in
        try await TeacherHomeModel.fetchCounts(api: api, now: now)
      })
    await NotificationsModel.refreshUnreadCount(context: context)
  }
}

/// IOS-11 本日の授業 (JST today; student: approved lessons, teacher: lessons taught).
@MainActor
@Observable
public final class TodayLessonsModel {
  public private(set) var today = Loadable<Page<LessonSlot>>()
  public let context: AppContext

  public init(context: AppContext) { self.context = context }

  public var dateLabel: String { JaFormat.instantDate(context.now(), calendar: context.calendar) }
  public var lessons: [LessonSlot] { (today.value?.items ?? []).sorted { $0.startsAt < $1.startsAt } }
  public var isTeacher: Bool { context.role == .teacher }

  public func load() async {
    today.beginLoading()
    let api = context.api
    today.apply(
      await context.fetch(cacheKey: "today-lessons", checkedAt: { $0.checkedAt }) { () async throws in
        try await api.send(API.todayLessons()).value
      })
  }

  /// Tag for a lesson card: the student's reservation status, or 「担当授業」 for teachers.
  public func tag(for slot: LessonSlot) -> (label: String, tone: StatusTone) {
    if isTeacher { return ("担当授業", .info) }
    if let mine = slot.myReservation { return (mine.status.labelJa, mine.status.tone) }
    return (ReservationStatus.approved.labelJa, .success)
  }
}
