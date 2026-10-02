import Foundation

/// Japanese display formatting. Matches `packages/contracts/src/time.ts`:
/// 「10月5日（月）」「2026年10月2日（金）」「14:00」「14:00–15:30」「10/5（月）14:00–15:30」.
/// Full-width parentheses and an en dash (U+2013) are used exactly as in the designs.
public enum JaFormat {
  public static let weekdays = ["日", "月", "火", "水", "木", "金", "土"]
  public static let enDash = "\u{2013}"

  // MARK: Dates

  /// 「10月5日（月）」 or with year 「2026年10月5日（月）」 for a date-only value.
  public static func date(_ d: LocalDate, withYear: Bool = false) -> String {
    "\(withYear ? "\(d.year)年" : "")\(d.month)月\(d.day)日（\(weekdays[d.weekday])）"
  }

  /// 「10月5日」 (no weekday).
  public static func monthDay(_ d: LocalDate) -> String { "\(d.month)月\(d.day)日" }

  /// 「2026年12月31日」.
  public static func fullDateNoWeekday(_ d: LocalDate) -> String { "\(d.year)年\(d.month)月\(d.day)日" }

  /// Date of an instant in the organisation timezone. Default includes the year: 「2026年10月2日（金）」.
  public static func instantDate(_ t: Date, calendar: OrgCalendar, withYear: Bool = true) -> String {
    date(calendar.localDate(of: t), withYear: withYear)
  }

  /// 「14:00」.
  public static func time(_ t: Date, calendar: OrgCalendar) -> String {
    let p = calendar.parts(of: t)
    return "\(Pad.two(p.hour)):\(Pad.two(p.minute))"
  }

  /// 「14:00–15:30」.
  public static func timeRange(_ start: Date, _ end: Date, calendar: OrgCalendar) -> String {
    "\(time(start, calendar: calendar))\(enDash)\(time(end, calendar: calendar))"
  }

  /// 「10/5（月）14:00–15:30」.
  public static func slotRange(_ start: Date, _ end: Date, calendar: OrgCalendar) -> String {
    let p = calendar.parts(of: start)
    return "\(p.month)/\(p.day)（\(weekdays[p.weekday])）\(timeRange(start, end, calendar: calendar))"
  }

  /// 「10月5日（月）14:00」.
  public static func dateTime(_ t: Date, calendar: OrgCalendar) -> String {
    "\(instantDate(t, calendar: calendar, withYear: false))\(time(t, calendar: calendar))"
  }

  /// 「10月5日（月）14:00–15:30」.
  public static func dateTimeRange(_ start: Date, _ end: Date, calendar: OrgCalendar) -> String {
    "\(instantDate(start, calendar: calendar, withYear: false))\(timeRange(start, end, calendar: calendar))"
  }

  /// 「10月2日 14:20」 (申請日時・履歴).
  public static func shortDateTime(_ t: Date, calendar: OrgCalendar) -> String {
    let p = calendar.parts(of: t)
    return "\(p.month)月\(p.day)日 \(Pad.two(p.hour)):\(Pad.two(p.minute))"
  }

  /// 「10/5 14:00」 (compact list form).
  public static func compactDateTime(_ t: Date, calendar: OrgCalendar) -> String {
    let p = calendar.parts(of: t)
    return "\(p.month)/\(p.day) \(Pad.two(p.hour)):\(Pad.two(p.minute))"
  }

  /// 「2026年10月」.
  public static func month(_ m: YearMonth) -> String { "\(m.year)年\(m.month)月" }

  // MARK: Relative / meta

  /// 「最終更新 11:20」, or with the date when not today: 「最終更新 10月1日 11:20」.
  public static func lastUpdated(_ checkedAt: Date, now: Date, calendar: OrgCalendar) -> String {
    if calendar.isSameDay(checkedAt, now) {
      return "最終更新 \(time(checkedAt, calendar: calendar))"
    }
    return "最終更新 \(shortDateTime(checkedAt, calendar: calendar))"
  }

  /// Notification timestamps: today 「15:10」, yesterday 「昨日」, this year 「10月1日」, else 「2025年10月1日」.
  public static func notificationTime(_ t: Date, now: Date, calendar: OrgCalendar) -> String {
    let day = calendar.localDate(of: t)
    let today = calendar.localDate(of: now)
    if day == today { return time(t, calendar: calendar) }
    if day == today.adding(days: -1) { return "昨日" }
    if day.year == today.year { return monthDay(day) }
    return fullDateNoWeekday(day)
  }

  /// 「1分45秒」「45秒」「2分」 for countdowns.
  public static func duration(seconds: Int) -> String {
    let s = max(0, seconds)
    let m = s / 60
    let r = s % 60
    if m == 0 { return "\(r)秒" }
    if r == 0 { return "\(m)分" }
    return "\(m)分\(r)秒"
  }

  /// 「3分」 (rounded up so that any use shows at least 1分).
  public static func minutes(seconds: Int) -> String {
    let s = max(0, seconds)
    return "\((s + 59) / 60)分"
  }

  /// 「残り3席」 / 「満席」.
  public static func remainingSeats(_ remaining: Int) -> String {
    remaining > 0 ? "残り\(remaining)席" : "満席"
  }

  /// Percent text: nil → 「未設定」 (no programme/units), otherwise 「76%」.
  public static func percent(_ value: Int?) -> String {
    guard let value else { return "未設定" }
    return "\(min(100, max(0, value)))%"
  }

  /// Display-name helpers: 「和田 一夫」 → 「和田」 (family name before the first space).
  public static func familyName(_ displayName: String) -> String {
    let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    let separators: Set<Character> = [" ", "　"]
    if let idx = trimmed.firstIndex(where: { separators.contains($0) }) {
      return String(trimmed[..<idx])
    }
    return trimmed
  }

  /// First character for avatar tiles: 「和田 一夫」 → 「和」.
  public static func initial(_ displayName: String) -> String {
    displayName.trimmingCharacters(in: .whitespacesAndNewlines).first.map(String.init) ?? "？"
  }

  /// Time-of-day greeting in the organisation timezone.
  public static func greeting(now: Date, calendar: OrgCalendar) -> String {
    let h = calendar.parts(of: now).hour
    switch h {
    case 4..<11: return "おはようございます"
    case 11..<18: return "こんにちは"
    default: return "こんばんは"
    }
  }
}
