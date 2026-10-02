import Foundation
import XCTest

@testable import ARMSKit

final class ISO8601Tests: XCTestCase {
  func testParsesZuluWithAndWithoutFraction() {
    XCTAssertEqual(ISO8601.parse("2026-10-05T05:00:00Z")?.timeIntervalSince1970, 1_791_176_400)
    XCTAssertEqual(ISO8601.parse("2026-10-05T05:00:00.000Z")?.timeIntervalSince1970, 1_791_176_400)
    XCTAssertEqual(ISO8601.parse("2026-10-05T05:00:00.250Z")!.timeIntervalSince1970, 1_791_176_400.25, accuracy: 0.001)
  }

  func testParsesNumericOffsets() {
    XCTAssertEqual(ISO8601.parse("2026-10-05T14:00:00+09:00")?.timeIntervalSince1970, 1_791_176_400)
    XCTAssertEqual(ISO8601.parse("2026-10-05T14:00:00.123456+09:00")!.timeIntervalSince1970, 1_791_176_400.123456, accuracy: 0.001)
    XCTAssertEqual(ISO8601.parseManually("2026-10-05T14:00:00+0900")?.timeIntervalSince1970, 1_791_176_400)
  }

  func testRejectsInvalid() {
    XCTAssertNil(ISO8601.parse("2026-10-05"))
    XCTAssertNil(ISO8601.parse("not a date"))
    XCTAssertNil(ISO8601.parseManually("2026-02-30T00:00:00Z"))
  }

  func testFormatRoundTrip() {
    let d = ISO8601.parse("2026-10-05T05:00:00.250Z")!
    XCTAssertEqual(ISO8601.format(d), "2026-10-05T05:00:00.250Z")
  }
}

final class LocalDateTests: XCTestCase {
  func testStrictParsing() {
    XCTAssertEqual(LocalDate("2026-10-05")?.isoString, "2026-10-05")
    XCTAssertNil(LocalDate("2026-02-30"))
    XCTAssertNil(LocalDate("2026-2-3"))
    XCTAssertNil(LocalDate("2026-10-05T00:00"))
    XCTAssertNotNil(LocalDate("2028-02-29"))
    XCTAssertNil(LocalDate("2027-02-29"))
  }

  func testWeekdayAndArithmetic() {
    let d = LocalDate("2026-10-05")!
    XCTAssertEqual(d.weekday, 1)  // Monday
    XCTAssertEqual(LocalDate("2026-10-02")!.weekday, 5)  // Friday
    XCTAssertEqual(d.adding(days: 27).isoString, "2026-11-01")
    XCTAssertEqual(LocalDate("2026-12-31")!.adding(days: 1).isoString, "2027-01-01")
    XCTAssertEqual(LocalDate("2026-03-01")!.adding(days: -1).isoString, "2026-02-28")
    XCTAssertEqual(LocalDate("1970-01-01")!.daysSinceEpoch, 0)
    XCTAssertEqual(LocalDate(daysSinceEpoch: LocalDate("2026-10-05")!.daysSinceEpoch), d)
    XCTAssertTrue(LocalDate("2026-10-04")! < d)
  }

  func testCodable() throws {
    let data = try ARMSJSON.encoder.encode(["d": LocalDate("2026-12-31")!])
    XCTAssertEqual(String(decoding: data, as: UTF8.self), #"{"d":"2026-12-31"}"#)
    XCTAssertThrowsError(try ARMSJSON.decoder.decode([String: LocalDate].self, from: Data(#"{"d":"2026-13-01"}"#.utf8)))
  }

  func testYearMonth() {
    let m = YearMonth("2026-10")!
    XCTAssertEqual(m.numberOfDays, 31)
    XCTAssertEqual(m.adding(months: 3).isoString, "2027-01")
    XCTAssertEqual(m.adding(months: -10).isoString, "2025-12")
    XCTAssertEqual(YearMonth("2028-02")!.numberOfDays, 29)
    XCTAssertTrue(m.contains(LocalDate("2026-10-31")!))
    XCTAssertFalse(m.contains(LocalDate("2026-11-01")!))
    XCTAssertNil(YearMonth("2026-13"))
  }
}

final class JSONValueTests: XCTestCase {
  func testRoundTripKeepsSnakeCaseKeys() throws {
    let raw = #"{"slot_id":"abc","n":3,"ok":true,"list":[1,"x",null],"nested":{"action_token":"t"}}"#
    let value = try JSONValue(jsonString: raw)
    XCTAssertEqual(value["slot_id"]?.stringValue, "abc")
    XCTAssertEqual(value["n"]?.intValue, 3)
    XCTAssertEqual(value["ok"]?.boolValue, true)
    XCTAssertEqual(value["list"]?[2], .null)
    XCTAssertEqual(value["nested"]?["action_token"]?.stringValue, "t")
    let again = try JSONValue(jsonString: value.jsonString())
    XCTAssertEqual(again, value)
    XCTAssertTrue(value.jsonString().contains("\"slot_id\""))
  }

  func testIntValueRejectsFractions() {
    XCTAssertNil(JSONValue.number(1.5).intValue)
    XCTAssertEqual(JSONValue.number(2).intValue, 2)
  }
}

final class FormattingTests: XCTestCase {
  let cal = OrgCalendar.tokyo

  func testDateFormatsMatchContractHelpers() {
    let start = ISO8601.parse("2026-10-05T05:00:00Z")!  // 14:00 JST
    let end = ISO8601.parse("2026-10-05T06:30:00Z")!
    XCTAssertEqual(JaFormat.date(LocalDate("2026-10-05")!), "10月5日（月）")
    XCTAssertEqual(JaFormat.date(LocalDate("2026-10-02")!, withYear: true), "2026年10月2日（金）")
    XCTAssertEqual(JaFormat.instantDate(start, calendar: cal), "2026年10月5日（月）")
    XCTAssertEqual(JaFormat.time(start, calendar: cal), "14:00")
    XCTAssertEqual(JaFormat.timeRange(start, end, calendar: cal), "14:00–15:30")
    XCTAssertEqual(JaFormat.slotRange(start, end, calendar: cal), "10/5（月）14:00–15:30")
    XCTAssertEqual(JaFormat.dateTime(start, calendar: cal), "10月5日（月）14:00")
    XCTAssertEqual(JaFormat.dateTimeRange(start, end, calendar: cal), "10月5日（月）14:00–15:30")
    XCTAssertEqual(JaFormat.shortDateTime(start, calendar: cal), "10月5日 14:00")
    XCTAssertEqual(JaFormat.month(YearMonth("2026-10")!), "2026年10月")
    XCTAssertTrue(JaFormat.timeRange(start, end, calendar: cal).contains("\u{2013}"))
  }

  func testJSTDateNeverTruncatesUTC() {
    // 2026-10-04T15:30Z is already 10月5日 00:30 in Tokyo.
    let instant = ISO8601.parse("2026-10-04T15:30:00Z")!
    XCTAssertEqual(cal.localDate(of: instant).isoString, "2026-10-05")
    XCTAssertEqual(JaFormat.time(instant, calendar: cal), "00:30")
    let range = cal.dayRange(LocalDate("2026-10-05")!)
    XCTAssertEqual(ISO8601.format(range.lowerBound), "2026-10-04T15:00:00.000Z")
    XCTAssertEqual(ISO8601.format(range.upperBound), "2026-10-05T15:00:00.000Z")
    XCTAssertEqual(ISO8601.format(cal.instant(of: LocalDate("2026-10-05")!, hour: 14)), "2026-10-05T05:00:00.000Z")
  }

  func testUnknownTimezoneFallsBackToTokyo() {
    XCTAssertEqual(OrgCalendar(timeZoneIdentifier: "Not/AZone").timeZone.identifier, "Asia/Tokyo")
    XCTAssertEqual(OrgCalendar(timeZoneIdentifier: nil), .tokyo)
  }

  func testLastUpdatedAndNotificationTimes() {
    let now = fixedNow  // 2026-10-02 11:00 JST
    XCTAssertEqual(JaFormat.lastUpdated(ISO8601.parse("2026-10-02T02:20:00Z")!, now: now, calendar: cal), "最終更新 11:20")
    XCTAssertEqual(
      JaFormat.lastUpdated(ISO8601.parse("2026-10-01T02:20:00Z")!, now: now, calendar: cal), "最終更新 10月1日 11:20")
    XCTAssertEqual(JaFormat.notificationTime(ISO8601.parse("2026-10-02T01:10:00Z")!, now: now, calendar: cal), "10:10")
    XCTAssertEqual(JaFormat.notificationTime(ISO8601.parse("2026-10-01T01:10:00Z")!, now: now, calendar: cal), "昨日")
    XCTAssertEqual(JaFormat.notificationTime(ISO8601.parse("2026-09-30T01:10:00Z")!, now: now, calendar: cal), "9月30日")
    XCTAssertEqual(JaFormat.notificationTime(ISO8601.parse("2025-09-30T01:10:00Z")!, now: now, calendar: cal), "2025年9月30日")
  }

  func testMiscFormatting() {
    XCTAssertEqual(JaFormat.duration(seconds: 105), "1分45秒")
    XCTAssertEqual(JaFormat.duration(seconds: 45), "45秒")
    XCTAssertEqual(JaFormat.duration(seconds: 120), "2分")
    XCTAssertEqual(JaFormat.duration(seconds: -3), "0秒")
    XCTAssertEqual(JaFormat.minutes(seconds: 0), "0分")
    XCTAssertEqual(JaFormat.minutes(seconds: 170), "3分")
    XCTAssertEqual(JaFormat.remainingSeats(3), "残り3席")
    XCTAssertEqual(JaFormat.remainingSeats(0), "満席")
    XCTAssertEqual(JaFormat.percent(nil), "未設定")
    XCTAssertEqual(JaFormat.percent(76), "76%")
    XCTAssertEqual(JaFormat.percent(130), "100%")
    XCTAssertEqual(JaFormat.familyName("和田 一夫"), "和田")
    XCTAssertEqual(JaFormat.familyName("和田　一夫"), "和田")
    XCTAssertEqual(JaFormat.initial("和田 一夫"), "和")
    XCTAssertEqual(JaFormat.greeting(now: fixedNow.addingTimeInterval(-2 * 3600), calendar: cal), "おはようございます")
    XCTAssertEqual(JaFormat.greeting(now: fixedNow.addingTimeInterval(3 * 3600), calendar: cal), "こんにちは")
  }

  func testStatusLabelsMatchContract() {
    XCTAssertEqual(ReservationStatus.allCases.map(\.labelJa), ["承認待ち", "承認済み", "却下", "取消済み", "申請期限切れ", "削除済み"])
    XCTAssertEqual(UnitState.allCases.map(\.labelJa), ["未着手", "受講中", "確認待ち", "完了"])
    XCTAssertEqual(AttendanceState.allCases.map(\.labelJa), ["出席", "欠席", "遅刻", "公欠"])
    XCTAssertEqual(ScanState.allCases.map(\.labelJa), ["検査待ち", "検査済み", "公開不可（検出）", "検査対象外"])
    XCTAssertEqual(MaterialKind.allCases.map(\.labelJa), ["PDF", "動画", "画像", "外部リンク", "確認テスト", "課題"])
    XCTAssertEqual(VoiceUIState.allCases.map(\.labelJa), ["待機中", "接続中", "聞いています", "確認中", "話しています", "再接続中", "エラー"])
    XCTAssertEqual(ThemePreference.system.labelJa, "システムに合わせる")
    XCTAssertEqual(Role.admin.labelJa, "管理者")
    XCTAssertEqual(SubmissionState.revisionRequested.labelJa, "再提出依頼")
    XCTAssertTrue(ReservationStatus.pending.holdsSeat)
    XCTAssertFalse(ReservationStatus.expired.holdsSeat)
  }
}
