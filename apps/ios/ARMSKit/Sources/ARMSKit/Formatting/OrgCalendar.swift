import Foundation

/// Organisation-timezone calendar (default Asia/Tokyo). Mirrors `packages/contracts/src/time.ts`:
/// display and "today" are always computed in the organisation timezone, never by truncating UTC.
public struct OrgCalendar: Sendable, Equatable {
  public static let defaultTimeZoneIdentifier = "Asia/Tokyo"
  public static let tokyo = OrgCalendar(timeZoneIdentifier: defaultTimeZoneIdentifier)

  public let timeZone: TimeZone
  private let calendar: Calendar

  /// Falls back to Asia/Tokyo when the identifier is missing or unknown.
  public init(timeZoneIdentifier: String?) {
    let tz =
      timeZoneIdentifier.flatMap { TimeZone(identifier: $0) }
      ?? TimeZone(identifier: OrgCalendar.defaultTimeZoneIdentifier)
      ?? TimeZone(secondsFromGMT: 9 * 3600)!
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = tz
    cal.locale = Locale(identifier: "ja_JP")
    self.timeZone = tz
    self.calendar = cal
  }

  public static func == (lhs: OrgCalendar, rhs: OrgCalendar) -> Bool {
    lhs.timeZone.identifier == rhs.timeZone.identifier
  }

  public struct Parts: Equatable, Sendable {
    public let year: Int
    public let month: Int
    public let day: Int
    public let hour: Int
    public let minute: Int
    public let second: Int
    /// 0 = Sunday … 6 = Saturday.
    public let weekday: Int
  }

  public func parts(of instant: Date) -> Parts {
    let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second, .weekday], from: instant)
    return Parts(
      year: c.year ?? 1970, month: c.month ?? 1, day: c.day ?? 1,
      hour: c.hour ?? 0, minute: c.minute ?? 0, second: c.second ?? 0,
      weekday: ((c.weekday ?? 1) - 1))
  }

  /// The local calendar date of an instant in the organisation timezone.
  public func localDate(of instant: Date) -> LocalDate {
    let p = parts(of: instant)
    return LocalDate(year: p.year, month: p.month, day: p.day)!
  }

  public func today(now: Date) -> LocalDate { localDate(of: now) }

  /// The instant at which the given wall-clock time occurs in the organisation timezone.
  public func instant(of date: LocalDate, hour: Int = 0, minute: Int = 0, second: Int = 0) -> Date {
    var comps = DateComponents()
    comps.year = date.year
    comps.month = date.month
    comps.day = date.day
    comps.hour = hour
    comps.minute = minute
    comps.second = second
    return calendar.date(from: comps) ?? Date(timeIntervalSince1970: 0)
  }

  /// [start, end) covering the local calendar day.
  public func dayRange(_ date: LocalDate) -> Range<Date> {
    instant(of: date)..<instant(of: date.adding(days: 1))
  }

  /// [start, end) covering the local calendar month.
  public func monthRange(_ month: YearMonth) -> Range<Date> {
    instant(of: month.firstDay)..<instant(of: month.adding(months: 1).firstDay)
  }

  public func isSameDay(_ a: Date, _ b: Date) -> Bool {
    localDate(of: a) == localDate(of: b)
  }
}
