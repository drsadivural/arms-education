import Foundation

/// A calendar date without time or timezone (OpenAPI `format: date`, `YYYY-MM-DD`).
/// Comparison is lexical on (year, month, day). Never derived by truncating a UTC instant.
public struct LocalDate: Hashable, Comparable, Sendable, CustomStringConvertible {
  public let year: Int
  public let month: Int
  public let day: Int

  /// Strict constructor: rejects non-existent dates such as 2026-02-30.
  public init?(year: Int, month: Int, day: Int) {
    guard (1...9999).contains(year), (1...12).contains(month), day >= 1,
      day <= LocalDate.daysInMonth(year: year, month: month)
    else { return nil }
    self.year = year
    self.month = month
    self.day = day
  }

  /// Parses `YYYY-MM-DD` strictly.
  public init?(_ string: String) {
    let parts = string.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
      parts.allSatisfy({ $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
      let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2])
    else { return nil }
    self.init(year: y, month: m, day: d)
  }

  public var isoString: String {
    "\(Pad.four(year))-\(Pad.two(month))-\(Pad.two(day))"
  }

  public var description: String { isoString }

  public var yearMonth: YearMonth { YearMonth(year: year, month: month)! }

  public static func < (lhs: LocalDate, rhs: LocalDate) -> Bool {
    (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
  }

  public static func isLeapYear(_ year: Int) -> Bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
  }

  public static func daysInMonth(year: Int, month: Int) -> Int {
    switch month {
    case 1, 3, 5, 7, 8, 10, 12: return 31
    case 4, 6, 9, 11: return 30
    case 2: return isLeapYear(year) ? 29 : 28
    default: return 0
    }
  }

  /// Days since 1970-01-01 (proleptic Gregorian), used for date arithmetic.
  public var daysSinceEpoch: Int {
    // Howard Hinnant's days_from_civil.
    let y = month <= 2 ? year - 1 : year
    let era = (y >= 0 ? y : y - 399) / 400
    let yoe = y - era * 400
    let mp = (month + 9) % 12
    let doy = (153 * mp + 2) / 5 + day - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + doe - 719468
  }

  public init(daysSinceEpoch z0: Int) {
    let z = z0 + 719468
    let era = (z >= 0 ? z : z - 146096) / 146097
    let doe = z - era * 146097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = doy - (153 * mp + 2) / 5 + 1
    let m = mp < 10 ? mp + 3 : mp - 9
    let y = yoe + era * 400 + (m <= 2 ? 1 : 0)
    self.year = y
    self.month = m
    self.day = d
  }

  public func adding(days: Int) -> LocalDate {
    LocalDate(daysSinceEpoch: daysSinceEpoch + days)
  }

  public func days(until other: LocalDate) -> Int {
    other.daysSinceEpoch - daysSinceEpoch
  }

  /// 0 = Sunday … 6 = Saturday.
  public var weekday: Int {
    let w = (daysSinceEpoch + 4) % 7  // 1970-01-01 was a Thursday.
    return w < 0 ? w + 7 : w
  }
}

extension LocalDate: Codable {
  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    let raw = try container.decode(String.self)
    guard let value = LocalDate(raw) else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date: \(raw)")
    }
    self = value
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(isoString)
  }
}

/// A calendar month (`YYYY-MM`), used for the booking calendar and `month` list filters.
public struct YearMonth: Hashable, Comparable, Sendable, CustomStringConvertible {
  public let year: Int
  public let month: Int

  public init?(year: Int, month: Int) {
    guard (1...9999).contains(year), (1...12).contains(month) else { return nil }
    self.year = year
    self.month = month
  }

  public init?(_ string: String) {
    let parts = string.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 2, parts[0].count == 4, parts[1].count == 2,
      let y = Int(parts[0]), let m = Int(parts[1])
    else { return nil }
    self.init(year: y, month: m)
  }

  public var isoString: String { "\(Pad.four(year))-\(Pad.two(month))" }
  public var description: String { isoString }

  public var firstDay: LocalDate { LocalDate(year: year, month: month, day: 1)! }
  public var numberOfDays: Int { LocalDate.daysInMonth(year: year, month: month) }
  public var lastDay: LocalDate { LocalDate(year: year, month: month, day: numberOfDays)! }

  public func adding(months delta: Int) -> YearMonth {
    let index = year * 12 + (month - 1) + delta
    let y = index >= 0 ? index / 12 : (index - 11) / 12
    let m = index - y * 12 + 1
    return YearMonth(year: y, month: m)!
  }

  public static func < (lhs: YearMonth, rhs: YearMonth) -> Bool {
    (lhs.year, lhs.month) < (rhs.year, rhs.month)
  }

  public func contains(_ date: LocalDate) -> Bool {
    date.year == year && date.month == month
  }
}

/// Zero padding without `String(format:)` (locale- and platform-independent).
enum Pad {
  static func two(_ n: Int) -> String { n < 10 && n >= 0 ? "0\(n)" : "\(n)" }
  static func four(_ n: Int) -> String {
    let s = String(n)
    return s.count >= 4 ? s : String(repeating: "0", count: 4 - s.count) + s
  }
}
