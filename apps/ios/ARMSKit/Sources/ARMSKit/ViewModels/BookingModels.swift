import Foundation
import Observation

/// IOS-07 オンライン予約: month calendar (JST) of the student's classroom slots.
@MainActor
@Observable
public final class BookingModel {
  public private(set) var slots = Loadable<Page<LessonSlot>>()
  public private(set) var month: YearMonth
  public var selectedDate: LocalDate
  public let context: AppContext

  public init(context: AppContext) {
    self.context = context
    let today = context.calendar.today(now: context.now())
    self.month = today.yearMonth
    self.selectedDate = today
  }

  public var today: LocalDate { context.calendar.today(now: context.now()) }
  public var grid: MonthGrid { MonthGrid(month: month) }
  public var monthTitle: String { JaFormat.month(month) }
  public var canGoToPreviousMonth: Bool { month > today.yearMonth }

  private var byDate: [LocalDate: [LessonSlot]] {
    SlotRules.groupByDate(slots.value?.items ?? [], calendar: context.calendar)
  }

  /// Days that have at least one slot that can still be requested.
  public func hasBookableSlots(on date: LocalDate) -> Bool {
    let now = context.now()
    return (byDate[date] ?? []).contains { SlotRules.availability($0, now: now) == .bookable }
  }

  public func hasSlots(on date: LocalDate) -> Bool { !(byDate[date] ?? []).isEmpty }

  public var slotsForSelectedDate: [LessonSlot] { byDate[selectedDate] ?? [] }

  /// 「10月5日（月）の空き枠」.
  public var selectedDateTitle: String { "\(JaFormat.date(selectedDate))の空き枠" }

  public func load() async {
    slots.beginLoading()
    let api = context.api
    let query = ListQuery(limit: 100, month: month)
    let key = "lesson-slots/\(month.isoString)"
    slots.apply(
      await context.fetch(cacheKey: key, checkedAt: { $0.checkedAt }) { () async throws in
        try await api.collectPage(maxPages: 5, query: query, API.lessonSlots)
      })
  }

  public func showMonth(_ newMonth: YearMonth) async {
    guard newMonth != month else { return }
    month = newMonth
    if !month.contains(selectedDate) {
      selectedDate = month.contains(today) ? today : month.firstDay
    }
    await load()
  }

  public func select(_ date: LocalDate) { selectedDate = date }
}

/// IOS-08 予約内容の確認: submits a pending request once, safe against double taps and retries.
@MainActor
@Observable
public final class BookingConfirmModel {
  public enum Outcome: Equatable, Sendable {
    /// The server created (or had already created) the request; only now is 「申請しました」 shown.
    case submitted(Reservation)
  }

  public let slot: LessonSlot
  public private(set) var isSubmitting = false
  public private(set) var error: ARMSError?
  public private(set) var outcome: Outcome?
  /// One key for this user action; reused for retries until the server answers definitively.
  public private(set) var idempotencyKey = IdempotencyKey()
  public let context: AppContext

  public init(slot: LessonSlot, context: AppContext) {
    self.slot = slot
    self.context = context
  }

  public var studentName: String { context.me?.displayName ?? "" }
  public var dateLabel: String { JaFormat.instantDate(slot.startsAt, calendar: context.calendar, withYear: false) }
  public var timeLabel: String { JaFormat.timeRange(slot.startsAt, slot.endsAt, calendar: context.calendar) }
  public var cancelPolicyText: String {
    let hours = slot.cancelBeforeSeconds / 3600
    if slot.cancelBeforeSeconds > 0, slot.cancelBeforeSeconds % 3600 == 0 {
      return "取消期限は、授業開始の\(hours)時間前です。"
    }
    let deadline = slot.startsAt.addingTimeInterval(-TimeInterval(slot.cancelBeforeSeconds))
    return "取消期限は、\(JaFormat.dateTime(deadline, calendar: context.calendar))です。"
  }

  public var canSubmit: Bool {
    outcome == nil && !isSubmitting && context.canMutate
      && SlotRules.availability(slot, now: context.now()) == .bookable
  }

  public func submit() async {
    guard outcome == nil, !isSubmitting else { return }
    if let blocker = context.mutationBlocker() {
      error = blocker
      return
    }
    isSubmitting = true
    error = nil
    defer { isSubmitting = false }
    do {
      let reservation = try await context.api.send(API.createReservation(slotId: slot.id, key: idempotencyKey)).value
      outcome = .submitted(reservation)
    } catch {
      if error.isConnectivity {
        // The request may have been committed before the connection dropped: check by key
        // before reporting failure (never assume "not created" from a failed response).
        if let existing = await lookupByKey() {
          outcome = .submitted(existing)
          return
        }
      }
      self.error = error
      if !error.isConnectivity, error.code != "IDEMPOTENCY_IN_PROGRESS", error.httpStatus.map({ $0 < 500 }) ?? false {
        // A definitive business answer (e.g. SLOT_FULL): a new attempt is a new action.
        idempotencyKey = IdempotencyKey()
      }
    }
  }

  private func lookupByKey() async -> Reservation? {
    let query = ListQuery(limit: 1, idempotencyKey: idempotencyKey)
    guard let page = try? await context.api.send(API.reservations(query)).value else { return nil }
    return page.items.first { $0.slotId == slot.id }
  }

  public var successMessage: String? {
    guard case .submitted(let r)? = outcome else { return nil }
    switch r.status {
    case .pending: return "予約を申請しました。担当講師の承認をお待ちください。"
    case .approved: return "予約が確定しました。"
    default: return "申請の状態：\(r.status.labelJa)"
    }
  }
}

/// IOS-09 自分の予約.
@MainActor
@Observable
public final class MyReservationsModel {
  public private(set) var reservations = Loadable<Page<Reservation>>()
  public let context: AppContext

  public init(context: AppContext) { self.context = context }

  public var items: [Reservation] {
    let now = context.now()
    let list = (reservations.value?.items ?? []).filter { $0.status != .removed }
    let upcoming = list.filter { $0.endsAt >= now }.sorted { $0.startsAt < $1.startsAt }
    let past = list.filter { $0.endsAt < now }.sorted { $0.startsAt > $1.startsAt }
    return upcoming + past
  }

  public func load() async {
    reservations.beginLoading()
    let api = context.api
    reservations.apply(
      await context.fetch(cacheKey: "my-reservations", checkedAt: { $0.checkedAt }) { () async throws in
        try await api.collectPage(maxPages: 5, query: ListQuery(limit: 100), API.reservations)
      })
  }
}

/// IOS-10 予約の詳細 + 取消.
@MainActor
@Observable
public final class ReservationDetailModel {
  public let reservationId: String
  public private(set) var reservation = Loadable<Reservation>()
  public private(set) var isCancelling = false
  public private(set) var actionError: ARMSError?
  public private(set) var actionMessage: String?
  private var keys = ActionKeys()
  public let context: AppContext

  public init(reservationId: String, context: AppContext) {
    self.reservationId = reservationId
    self.context = context
  }

  public func load() async {
    reservation.beginLoading()
    let api = context.api
    let id = reservationId
    reservation.apply(
      await context.fetch(cacheKey: "reservation/\(id)", checkedAt: { $0.checkedAt }) { () async throws in
        try await api.send(API.reservation(id: id)).value
      })
  }

  public var canCancel: Bool {
    guard let r = reservation.value, context.role == .student else { return false }
    return ReservationRules.canCancel(r, now: context.now()) && context.canMutate
  }

  public func cancel(reason: String?) async {
    guard let r = reservation.value, !isCancelling else { return }
    if let blocker = context.mutationBlocker() {
      actionError = blocker
      return
    }
    let action = "cancel:\(r.id):\(r.rowVersion)"
    let key = keys.key(for: action)
    isCancelling = true
    actionError = nil
    defer { isCancelling = false }
    do {
      let trimmed = reason?.trimmingCharacters(in: .whitespacesAndNewlines)
      let updated = try await context.api.send(
        API.cancelReservation(
          id: r.id, expectedVersion: r.rowVersion, reason: (trimmed?.isEmpty ?? true) ? nil : trimmed, key: key)
      ).value
      keys.complete(action)
      reservation.update(updated, checkedAt: updated.checkedAt)
      actionMessage = updated.status == .cancelled ? "予約を取り消しました。" : "予約の状態：\(updated.status.labelJa)"
    } catch {
      actionError = error
      if error.code == "VERSION_CONFLICT" || error.code == "INVALID_STATE" || error.code == "CANCELLATION_CLOSED" {
        keys.complete(action)
        await load()
      }
    }
  }
}

/// IOS-17 担当授業の予約 (teacher): approve / reject with a reason.
@MainActor
@Observable
public final class TeacherReservationsModel {
  public enum Filter: String, CaseIterable, Sendable {
    case pending
    case all

    public var labelJa: String {
      switch self {
      case .pending: return "承認待ち"
      case .all: return "すべて"
      }
    }
  }

  public private(set) var reservations = Loadable<Page<Reservation>>()
  public private(set) var busyIds = Set<String>()
  public private(set) var actionError: ARMSError?
  public private(set) var actionMessage: String?
  public var filter: Filter = .pending
  private var keys = ActionKeys()
  public let context: AppContext

  public init(context: AppContext) { self.context = context }

  public var items: [Reservation] {
    let list = reservations.value?.items ?? []
    switch filter {
    case .pending: return ReservationRules.sortedForList(list.filter { $0.status == .pending })
    case .all: return ReservationRules.sortedForList(list.filter { $0.status != .removed })
    }
  }

  public func load() async {
    reservations.beginLoading()
    let api = context.api
    reservations.apply(
      await context.fetch(cacheKey: "teacher-reservations", checkedAt: { $0.checkedAt }) { () async throws in
        try await api.collectPage(maxPages: 5, query: ListQuery(limit: 100), API.reservations)
      })
  }

  public func canDecide(_ r: Reservation) -> Bool {
    ReservationRules.canDecide(r, now: context.now()) && context.canMutate && !busyIds.contains(r.id)
  }

  public func approve(_ r: Reservation) async {
    await decide(r, verb: "approve") { key in
      API.approveReservation(id: r.id, expectedVersion: r.rowVersion, key: key)
    }
  }

  /// Returns a validation message instead of sending when the reason is empty / too long.
  @discardableResult
  public func reject(_ r: Reservation, reason: String) async -> String? {
    if let message = ReservationRules.validateRejectReason(reason) { return message }
    let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    await decide(r, verb: "reject:\(trimmed)") { key in
      API.rejectReservation(id: r.id, expectedVersion: r.rowVersion, reason: trimmed, key: key)
    }
    return nil
  }

  private func decide(_ r: Reservation, verb: String, _ make: (IdempotencyKey) -> Endpoint<Reservation>) async {
    guard !busyIds.contains(r.id) else { return }
    if let blocker = context.mutationBlocker() {
      actionError = blocker
      return
    }
    let action = "\(verb):\(r.id):\(r.rowVersion)"
    let key = keys.key(for: action)
    busyIds.insert(r.id)
    actionError = nil
    actionMessage = nil
    defer { busyIds.remove(r.id) }
    do {
      let updated = try await context.api.send(make(key)).value
      keys.complete(action)
      reservations.updateValue { page in
        var items = page.items
        if let i = items.firstIndex(where: { $0.id == updated.id }) { items[i] = updated }
        page = Page(items: items, nextCursor: page.nextCursor, checkedAt: updated.checkedAt)
      }
      let who = updated.studentName ?? r.studentName ?? "受講者"
      actionMessage =
        updated.status == .approved
        ? "\(who)さんの予約を承認しました。" : updated.status == .rejected ? "\(who)さんの予約を却下しました。" : "予約の状態：\(updated.status.labelJa)"
    } catch {
      actionError = error
      if ["VERSION_CONFLICT", "RESERVATION_EXPIRED", "INVALID_STATE", "SLOT_FULL"].contains(error.code) {
        keys.complete(action)
        await load()
      }
    }
  }
}

/// IOS-16 出欠を記録 (teacher of the lesson). Attendees are the approved reservations of the slot.
@MainActor
@Observable
public final class AttendanceModel {
  public let slot: LessonSlot
  public private(set) var roster = Loadable<[Reservation]>()
  public private(set) var draft = AttendanceDraft(attendees: [])
  public private(set) var isSaving = false
  public private(set) var error: ARMSError?
  public private(set) var savedMessage: String?
  private var keys = ActionKeys()
  public let context: AppContext

  public init(slot: LessonSlot, context: AppContext) {
    self.slot = slot
    self.context = context
  }

  public var subtitle: String {
    "\(JaFormat.dateTimeRange(slot.startsAt, slot.endsAt, calendar: context.calendar)) / \(slot.classroomName)"
  }

  public func load() async {
    roster.beginLoading()
    let api = context.api
    let date = context.calendar.localDate(of: slot.startsAt)
    let slotId = slot.id
    let checked = context.now()
    roster.apply(
      await context.fetch(cacheKey: "attendance-roster/\(slotId)", checkedAt: { _ in checked }) {
        () async throws in
        let all = try await api.collectAll(
          maxPages: 5, query: ListQuery(limit: 100, status: "approved", from: date, to: date), API.reservations)
        return all.items.filter { $0.slotId == slotId && $0.status == .approved }
      })
    if let list = roster.value, draft.isEmpty || draft.rows.map(\.studentId) != AttendanceDraft(reservations: list, slotId: slotId).rows.map(\.studentId) {
      draft = AttendanceDraft(reservations: list, slotId: slotId)
    }
  }

  public func setState(_ state: AttendanceState, for studentId: String) {
    draft.setState(state, for: studentId)
    savedMessage = nil
  }

  public func setNote(_ note: String, for studentId: String) {
    draft.setNote(note, for: studentId)
    savedMessage = nil
  }

  public var canSave: Bool { !draft.isEmpty && !isSaving && context.canMutate }

  public func save() async {
    guard !draft.isEmpty, !isSaving else { return }
    if let blocker = context.mutationBlocker() {
      error = blocker
      return
    }
    let action = "attendance:\(slot.id):\(draft.contentFingerprint)"
    let key = keys.key(for: action)
    isSaving = true
    error = nil
    defer { isSaving = false }
    do {
      _ = try await context.api.send(API.recordAttendance(slotId: slot.id, input: draft.input(), key: key))
      keys.complete(action)
      savedMessage = "出欠を保存しました（\(draft.rows.count)名）。"
    } catch {
      self.error = error
    }
  }
}
