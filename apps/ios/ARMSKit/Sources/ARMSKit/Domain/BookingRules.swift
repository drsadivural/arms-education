import Foundation

/// Reservation display and action rules (docs/04_RESERVATION_PROGRESS_JA.md).
public enum ReservationRules {
  /// Default cancellation deadline when the server did not send `cancel_deadline`:
  /// 24 hours before the lesson starts (the documented initial organisation setting).
  public static let defaultCancelBeforeSeconds: TimeInterval = 24 * 3600

  public static func cancelDeadline(_ r: Reservation) -> Date {
    r.cancelDeadline ?? r.startsAt.addingTimeInterval(-defaultCancelBeforeSeconds)
  }

  /// Students may cancel pending/approved reservations strictly before the deadline.
  /// The server re-checks (409 CANCELLATION_CLOSED); this only controls the UI.
  public static func canCancel(_ r: Reservation, now: Date) -> Bool {
    guard r.status == .pending || r.status == .approved else { return false }
    if r.status == .pending, r.expiresAt <= now { return false }
    return now < cancelDeadline(r)
  }

  /// Why cancellation is not offered (shown instead of the button).
  public static func cancelUnavailableReason(_ r: Reservation, now: Date) -> String? {
    switch r.status {
    case .pending, .approved:
      if r.status == .pending, r.expiresAt <= now { return "申請の保持期限が切れています。" }
      return now < cancelDeadline(r) ? nil : "取消期限を過ぎているため取消できません。"
    case .rejected, .cancelled, .expired, .removed:
      return nil
    }
  }

  /// A pending request whose seat-hold deadline passed is shown as expired even before the
  /// server's expiry job runs (lazy expiry happens on the server at the next read/decision).
  public static func effectiveStatus(_ r: Reservation, now: Date) -> ReservationStatus {
    if r.status == .pending, r.expiresAt <= now { return .expired }
    return r.status
  }

  /// One-line explanation under the status tag (IOS-09/10). 「予約確定」 is reserved for approved.
  public static func statusMessage(_ r: Reservation, now: Date) -> String {
    switch effectiveStatus(r, now: now) {
    case .pending: return "担当講師の承認を待っています。"
    case .approved: return "予約が確定しています。"
    case .rejected:
      if let reason = r.reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty {
        return "理由：\(reason)"
      }
      return "申請は却下されました。"
    case .cancelled: return "この予約は取り消されました。"
    case .expired: return "承認されないまま申請の保持期限を過ぎました。"
    case .removed: return "この予約は削除されました（履歴は保持されています）。"
    }
  }

  /// Detail-screen headline (IOS-10).
  public static func headline(_ r: Reservation, now: Date) -> String {
    switch effectiveStatus(r, now: now) {
    case .pending: return "承認を待っています"
    case .approved: return "予約が確定しています"
    case .rejected: return "申請は却下されました"
    case .cancelled: return "予約を取り消しました"
    case .expired: return "申請期限が切れました"
    case .removed: return "予約は削除されました"
    }
  }

  /// The meeting link is shown only for approved reservations that carry one.
  public static func meetingURL(_ r: Reservation) -> URL? {
    guard r.status == .approved, let raw = r.meetingUrl, let url = URL(string: raw),
      url.scheme?.lowercased() == "https"
    else { return nil }
    return url
  }

  /// Short human-readable reservation number derived from the id: 「ARMS-1A2B3C4D」.
  public static func referenceNumber(_ r: Reservation) -> String {
    let hex = r.id.replacingOccurrences(of: "-", with: "").uppercased()
    return "ARMS-\(hex.prefix(8))"
  }

  /// Teachers may approve/reject only pending, not-yet-expired requests.
  public static func canDecide(_ r: Reservation, now: Date) -> Bool {
    r.status == .pending && r.expiresAt > now
  }

  /// Reject reason: 1–1,000 characters after trimming.
  public static func validateRejectReason(_ reason: String) -> String? {
    let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return "却下の理由を入力してください。" }
    if trimmed.count > 1000 { return "理由は1,000文字以内で入力してください。" }
    return nil
  }

  /// Sort: upcoming first by start time; within same time by status.
  public static func sortedForList(_ items: [Reservation]) -> [Reservation] {
    items.sorted { a, b in
      if a.startsAt != b.startsAt { return a.startsAt < b.startsAt }
      return a.id < b.id
    }
  }

  /// Japanese label for one history entry, e.g. 「田中 祥司が承認」「予約を申請」.
  public static func historyLabel(_ entry: Reservation.HistoryEntry) -> String {
    let actor = entry.actorName.map { $0.trimmingCharacters(in: .whitespaces) }.flatMap { $0.isEmpty ? nil : $0 }
    let verb = historyVerb(entry)
    var text: String
    switch verb {
    case .created: text = "予約を申請"
    case .approved: text = actor.map { "\($0)が承認" } ?? "承認されました"
    case .rejected: text = actor.map { "\($0)が却下" } ?? "却下されました"
    case .cancelled: text = actor.map { "\($0)が取消" } ?? "取り消されました"
    case .expired: text = "申請期限切れ"
    case .removed: text = actor.map { "\($0)が削除" } ?? "削除されました"
    case .other(let status): text = status.map { "状態：\($0.labelJa)" } ?? "更新されました"
    }
    if let reason = entry.reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty,
      verb == .rejected || verb == .cancelled || verb == .removed
    {
      text += "（理由：\(reason)）"
    }
    return text
  }

  enum HistoryVerb: Equatable {
    case created, approved, rejected, cancelled, expired, removed
    case other(ReservationStatus?)
  }

  static func historyVerb(_ entry: Reservation.HistoryEntry) -> HistoryVerb {
    let type = entry.eventType.lowercased()
    let last = type.split(separator: ".").last.map(String.init) ?? type
    switch last {
    case "created", "requested", "create", "request": return .created
    case "approved", "approve": return .approved
    case "rejected", "reject": return .rejected
    case "cancelled", "canceled", "cancel": return .cancelled
    case "expired", "expire": return .expired
    case "removed", "remove", "deleted": return .removed
    default:
      switch entry.status.flatMap(ReservationStatus.init(rawValue:)) {
      case .pending?: return .created
      case .approved?: return .approved
      case .rejected?: return .rejected
      case .cancelled?: return .cancelled
      case .expired?: return .expired
      case .removed?: return .removed
      case nil: return .other(nil)
      }
    }
  }
}

/// Lesson-slot rules for the booking screen (IOS-07/08).
public enum SlotRules {
  public enum Availability: Equatable, Sendable {
    case bookable
    case alreadyRequested(ReservationStatus)
    case full
    case closed
    case cancelled
  }

  public static func availability(_ slot: LessonSlot, now: Date) -> Availability {
    if slot.state == .cancelled { return .cancelled }
    if let mine = slot.myReservation, mine.status.holdsSeat { return .alreadyRequested(mine.status) }
    if slot.state == .closed || slot.bookingClosesAt <= now || slot.startsAt <= now { return .closed }
    if slot.remaining <= 0 { return .full }
    return .bookable
  }

  public static func availabilityLabel(_ a: Availability, remaining: Int) -> String {
    switch a {
    case .bookable: return JaFormat.remainingSeats(remaining)
    case .alreadyRequested(let status): return status == .approved ? "予約済み（承認済み）" : "申請済み（承認待ち）"
    case .full: return "満席"
    case .closed: return "受付終了"
    case .cancelled: return "取消"
    }
  }

  public static func availabilityTone(_ a: Availability) -> StatusTone {
    switch a {
    case .bookable: return .success
    case .alreadyRequested(let status): return status == .approved ? .success : .warning
    case .full, .closed, .cancelled: return .neutral
    }
  }

  /// 「オンライン」 when the slot has a private meeting link, otherwise 「対面」.
  public static func formatLabel(_ slot: LessonSlot) -> String {
    slot.hasMeetingUrl ? "オンライン" : "対面"
  }

  /// Groups slots by their local start date in the organisation timezone.
  public static func groupByDate(_ slots: [LessonSlot], calendar: OrgCalendar) -> [LocalDate: [LessonSlot]] {
    var out: [LocalDate: [LessonSlot]] = [:]
    for slot in slots {
      out[calendar.localDate(of: slot.startsAt), default: []].append(slot)
    }
    for key in out.keys {
      out[key]?.sort { $0.startsAt < $1.startsAt }
    }
    return out
  }

  public enum TimeBand: String, Sendable, CaseIterable {
    case morning, afternoon, evening, any

    /// morning < 12:00 ≤ afternoon < 17:00 ≤ evening (organisation timezone).
    public func contains(_ instant: Date, calendar: OrgCalendar) -> Bool {
      let hour = calendar.parts(of: instant).hour
      switch self {
      case .morning: return hour < 12
      case .afternoon: return hour >= 12 && hour < 17
      case .evening: return hour >= 17
      case .any: return true
      }
    }
  }

  /// The meeting link is opened only when the server returned one (approved student / teacher).
  public static func meetingURL(_ slot: LessonSlot) -> URL? {
    guard let raw = slot.meetingUrl, let url = URL(string: raw), url.scheme?.lowercased() == "https" else {
      return nil
    }
    return url
  }
}

/// Month grid for the booking calendar. Weeks start on Monday (月 火 水 木 金 土 日) as in IOS-07.
public struct MonthGrid: Sendable, Equatable {
  public static let weekdayHeaders = ["月", "火", "水", "木", "金", "土", "日"]

  public let month: YearMonth
  /// Rows of 7 cells; nil cells are padding outside the month.
  public let weeks: [[LocalDate?]]

  public init(month: YearMonth) {
    self.month = month
    let first = month.firstDay
    // Monday-based column index: Monday = 0 … Sunday = 6.
    let leading = (first.weekday + 6) % 7
    var cells: [LocalDate?] = Array(repeating: nil, count: leading)
    for d in 0..<month.numberOfDays { cells.append(first.adding(days: d)) }
    while cells.count % 7 != 0 { cells.append(nil) }
    var rows: [[LocalDate?]] = []
    var index = 0
    while index < cells.count {
      rows.append(Array(cells[index..<(index + 7)]))
      index += 7
    }
    self.weeks = rows
  }
}
