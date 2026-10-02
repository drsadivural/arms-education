import Foundation

/// Shared JSON conventions for the ARMS API.
///
/// - Keys are mapped with explicit `CodingKeys` (never a key strategy) so that free-form
///   objects (`JSONValue`) keep their original keys.
/// - `date-time` values are RFC 3339 / ISO 8601 with or without fractional seconds and with
///   `Z` or a numeric offset. They are encoded with millisecond precision in UTC.
public enum ARMSJSON {
  public static var decoder: JSONDecoder {
    let d = JSONDecoder()
    d.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let raw = try container.decode(String.self)
      guard let date = ISO8601.parse(raw) else {
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date-time: \(raw)")
      }
      return date
    }
    return d
  }

  public static var encoder: JSONEncoder {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    e.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      try container.encode(ISO8601.format(date))
    }
    return e
  }
}

/// RFC 3339 parsing/formatting without shared mutable formatter state.
public enum ISO8601 {
  public static func parse(_ string: String) -> Date? {
    let trimmed = string.trimmingCharacters(in: .whitespaces)
    if let d = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(trimmed) { return d }
    if let d = try? Date.ISO8601FormatStyle().parse(trimmed) { return d }
    return parseManually(trimmed)
  }

  public static func format(_ date: Date) -> String {
    date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
  }

  /// Fallback for offsets such as `+09:00` and arbitrary fraction lengths:
  /// `YYYY-MM-DDTHH:MM:SS[.fff…](Z|±HH:MM)`.
  static func parseManually(_ s: String) -> Date? {
    let scalars = Array(s.utf8)
    func num(_ from: Int, _ len: Int) -> Int? {
      guard from + len <= scalars.count else { return nil }
      var v = 0
      for i in from..<(from + len) {
        let c = scalars[i]
        guard c >= 48, c <= 57 else { return nil }
        v = v * 10 + Int(c - 48)
      }
      return v
    }
    guard scalars.count >= 20,
      let year = num(0, 4), scalars[4] == UInt8(ascii: "-"),
      let month = num(5, 2), scalars[7] == UInt8(ascii: "-"),
      let day = num(8, 2), scalars[10] == UInt8(ascii: "T") || scalars[10] == UInt8(ascii: " "),
      let hour = num(11, 2), scalars[13] == UInt8(ascii: ":"),
      let minute = num(14, 2), scalars[16] == UInt8(ascii: ":"),
      let second = num(17, 2)
    else { return nil }
    var index = 19
    var fraction = 0.0
    if index < scalars.count, scalars[index] == UInt8(ascii: ".") {
      index += 1
      var scale = 0.1
      while index < scalars.count, scalars[index] >= 48, scalars[index] <= 57 {
        fraction += Double(scalars[index] - 48) * scale
        scale /= 10
        index += 1
      }
    }
    guard index < scalars.count else { return nil }
    var offsetSeconds = 0
    let tz = scalars[index]
    if tz == UInt8(ascii: "Z") || tz == UInt8(ascii: "z") {
      guard index + 1 == scalars.count else { return nil }
    } else if tz == UInt8(ascii: "+") || tz == UInt8(ascii: "-") {
      guard let oh = num(index + 1, 2) else { return nil }
      var om = 0
      if index + 3 < scalars.count {
        if scalars[index + 3] == UInt8(ascii: ":") {
          guard let m = num(index + 4, 2), index + 6 == scalars.count else { return nil }
          om = m
        } else {
          guard let m = num(index + 3, 2), index + 5 == scalars.count else { return nil }
          om = m
        }
      }
      offsetSeconds = (oh * 3600 + om * 60) * (tz == UInt8(ascii: "+") ? 1 : -1)
    } else {
      return nil
    }
    guard (1...12).contains(month), (1...31).contains(day), hour < 24, minute < 60, second < 61 else { return nil }
    var comps = DateComponents()
    comps.year = year
    comps.month = month
    comps.day = day
    comps.hour = hour
    comps.minute = minute
    comps.second = second
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "UTC") ?? TimeZone(secondsFromGMT: 0)!
    guard let base = cal.date(from: comps), cal.component(.day, from: base) == day else { return nil }
    return base.addingTimeInterval(fraction - Double(offsetSeconds))
  }
}
