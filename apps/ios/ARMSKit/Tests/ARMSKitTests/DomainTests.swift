import Foundation
import XCTest

@testable import ARMSKit

final class ProgressRulesTests: XCTestCase {
  func progress(_ json: String) -> StudentProgress {
    try! ARMSJSON.decoder.decode(StudentProgress.self, from: Data(json.utf8))
  }

  func testNullPercentShowsUnset() {
    let s = ProgressSummary(progress: progress(Fixtures.progressJSON(percent: "null", units: "[]")))
    XCTAssertEqual(s.percentText, "未設定")
    XCTAssertNil(s.fraction)
    XCTAssertFalse(s.isConfigured)
    XCTAssertEqual(s.headline, "研修プログラムが未設定です")
  }

  func testSummaryTexts() {
    let s = ProgressSummary(progress: progress(Fixtures.progressJSON()))
    XCTAssertEqual(s.percentText, "76%")
    XCTAssertEqual(s.fraction!, 0.76, accuracy: 0.0001)
    XCTAssertEqual(s.requiredText, "必須単元 6 / 8 完了")
    XCTAssertEqual(s.headline, "講師の確認を待っている単元があります")
  }

  func testCompletedHeadline() {
    let json = Fixtures.progressJSON(
      percent: "100",
      units: "[" + Fixtures.unitJSON(id: "u1", title: "A", state: "completed", score: "90", quizPassed: "true") + "]"
    ).replacingOccurrences(of: #""required_completed":6"#, with: #""required_completed":8"#)
    XCTAssertEqual(ProgressSummary(progress: progress(json)).headline, "すべての必須単元を完了しました")
  }

  func testOverdueHeadlineAndEnrollmentPresentation() {
    let p = progress(Fixtures.progressJSON(overdue: true))
    XCTAssertEqual(ProgressSummary(progress: p).headline, "期限を過ぎている研修プログラムがあります")
    let e = p.enrollments[0]
    XCTAssertEqual(EnrollmentPresentation.title(e), "新入社員基礎研修（第2版）")
    XCTAssertEqual(EnrollmentPresentation.dueText(e), "期限：2026年12月25日（金）")
    XCTAssertEqual(EnrollmentPresentation.requiredText(e), "必須単元 6 / 8 完了")
    XCTAssertEqual(EnrollmentPresentation.status(e).label, "期限超過")
    let onTime = progress(Fixtures.progressJSON()).enrollments[0]
    XCTAssertEqual(EnrollmentPresentation.status(onTime).label, "受講中")
    XCTAssertEqual(ProgressSummary(progress: p).dueText, "期限超過：12月25日（金）（新入社員基礎研修）")
    XCTAssertEqual(ProgressSummary(progress: progress(Fixtures.progressJSON())).dueText, "次の期限：12月25日（金）（新入社員基礎研修）")
    let none = StudentProgress(
      studentId: "s", progressPercent: nil, requiredTotal: 0, requiredCompleted: 0, units: [], checkedAt: fixedNow)
    XCTAssertNil(ProgressSummary(progress: none).dueText)
  }

  func testUnitDetailUsesServerBreakdownOnly() {
    let units = progress(Fixtures.progressJSON()).units
    XCTAssertEqual(UnitPresentation.detail(units[0]), "教材確認 2/2・テスト92点（合格）・課題 講師評価済み")
    XCTAssertEqual(UnitPresentation.detail(units[1]), "テスト88点（合格）")
    XCTAssertEqual(UnitPresentation.detail(units[2]), "課題提出済み・講師の評価待ち")
    XCTAssertEqual(UnitPresentation.detail(units[3]), "教材確認 0/1")
    let bare = UnitProgress(id: "x", title: "x", state: .notStarted, weight: 1, score: nil, requiresReview: false, feedback: nil)
    XCTAssertEqual(UnitPresentation.detail(bare), "まだ始めていません")
    let attendance = UnitProgress(
      id: "y", title: "y", state: .inProgress, weight: 1, score: nil, requiresReview: false, feedback: nil, quizPassed: false,
      attendanceRequired: true)
    XCTAssertEqual(UnitPresentation.detail(attendance), "テスト未受験・授業への出席が必要")
    XCTAssertEqual(UnitPresentation.completedLabel(units[0], calendar: .tokyo), "完了日：10月1日（木）")
    XCTAssertEqual(UnitPresentation.fraction(units[0]), 1)
    XCTAssertNil(UnitPresentation.fraction(units[2]))
    XCTAssertEqual(UnitPresentation.formatScore(88.5), "88.5")
  }

  func testStudentStatusOverdueUsesLocalDates() {
    func student(percent: Int?, due: String, active: Bool = true) -> Student {
      Student(
        id: "s", employeeNumber: "E", displayName: "中村 翔太", kana: "", email: "n@example.invalid", companyName: "",
        departmentName: "開発部", joinedOn: LocalDate("2026-10-01")!, classroomId: "c", teacherId: "t",
        trainingStartsOn: LocalDate("2026-10-01")!, trainingDueOn: LocalDate(due)!, active: active, rowVersion: 1,
        progressPercent: percent)
    }
    let today = LocalDate("2026-10-02")!
    XCTAssertEqual(StudentListStatus(student: student(percent: 42, due: "2026-10-01"), today: today), .overdue)
    XCTAssertEqual(StudentListStatus(student: student(percent: 42, due: "2026-10-02"), today: today), .inProgress)
    XCTAssertEqual(StudentListStatus(student: student(percent: 100, due: "2026-09-01"), today: today), .completed)
    XCTAssertEqual(StudentListStatus(student: student(percent: nil, due: "2026-12-31"), today: today), .notConfigured)
    XCTAssertEqual(StudentListStatus(student: student(percent: 50, due: "2026-12-31", active: false), today: today), .inactive)
    XCTAssertEqual(StudentListStatus.overdue.labelJa, "期限超過")
  }
}

final class ReservationRulesTests: XCTestCase {
  func testCancelAllowedOnlyBeforeDeadline() {
    let r = Fixtures.reservation(Fixtures.reservationJSON(status: "approved"))
    let deadline = ISO8601.parse("2026-10-04T05:00:00Z")!
    XCTAssertTrue(ReservationRules.canCancel(r, now: deadline.addingTimeInterval(-1)))
    XCTAssertFalse(ReservationRules.canCancel(r, now: deadline))
    XCTAssertEqual(ReservationRules.cancelUnavailableReason(r, now: deadline), "取消期限を過ぎているため取消できません。")
    XCTAssertNil(ReservationRules.cancelUnavailableReason(r, now: fixedNow))
  }

  func testDefaultDeadlineIs24HoursBeforeStart() {
    let r = Fixtures.reservation(Fixtures.reservationJSON(status: "approved", cancelDeadline: nil))
    XCTAssertEqual(ISO8601.format(ReservationRules.cancelDeadline(r)), "2026-10-04T05:00:00.000Z")
  }

  func testTerminalStatesCannotBeCancelled() {
    for status in ["rejected", "cancelled", "expired", "removed"] {
      XCTAssertFalse(ReservationRules.canCancel(Fixtures.reservation(Fixtures.reservationJSON(status: status)), now: fixedNow))
    }
  }

  func testPendingPastHoldIsShownExpired() {
    let r = Fixtures.reservation(Fixtures.reservationJSON(status: "pending", expiresAt: "2026-10-02T01:00:00Z"))
    XCTAssertEqual(ReservationRules.effectiveStatus(r, now: fixedNow), .expired)
    XCTAssertFalse(ReservationRules.canCancel(r, now: fixedNow))
    XCTAssertFalse(ReservationRules.canDecide(r, now: fixedNow))
    XCTAssertEqual(ReservationRules.statusMessage(r, now: fixedNow), "承認されないまま申請の保持期限を過ぎました。")
  }

  func testStatusMessagesDistinguishPendingAndConfirmed() {
    let pending = Fixtures.reservation()
    XCTAssertEqual(ReservationRules.statusMessage(pending, now: fixedNow), "担当講師の承認を待っています。")
    XCTAssertEqual(ReservationRules.headline(pending, now: fixedNow), "承認を待っています")
    let approved = Fixtures.reservation(Fixtures.reservationJSON(status: "approved"))
    XCTAssertEqual(ReservationRules.statusMessage(approved, now: fixedNow), "予約が確定しています。")
    let rejected = Fixtures.reservation(Fixtures.reservationJSON(status: "rejected", reason: #""講師の日程変更のため""#))
    XCTAssertEqual(ReservationRules.statusMessage(rejected, now: fixedNow), "理由：講師の日程変更のため")
  }

  func testMeetingLinkOnlyForApprovedHTTPS() {
    let approved = Fixtures.reservation(
      Fixtures.reservationJSON(status: "approved", meetingUrl: #""https://meet.example.invalid/a""#))
    XCTAssertEqual(ReservationRules.meetingURL(approved)?.absoluteString, "https://meet.example.invalid/a")
    let pending = Fixtures.reservation(Fixtures.reservationJSON(status: "pending", meetingUrl: #""https://meet.example.invalid/a""#))
    XCTAssertNil(ReservationRules.meetingURL(pending))
    let http = Fixtures.reservation(Fixtures.reservationJSON(status: "approved", meetingUrl: #""http://meet.example.invalid/a""#))
    XCTAssertNil(ReservationRules.meetingURL(http))
  }

  func testHistoryLabels() {
    func entry(_ type: String, _ status: String?, actor: String? = "田中 祥司", reason: String? = nil) -> Reservation.HistoryEntry {
      .init(eventType: type, status: status, reason: reason, actorName: actor, createdAt: fixedNow)
    }
    XCTAssertEqual(ReservationRules.historyLabel(entry("reservation.created", "pending", actor: "和田 一夫")), "予約を申請")
    XCTAssertEqual(ReservationRules.historyLabel(entry("reservation.approved", "approved")), "田中 祥司が承認")
    XCTAssertEqual(
      ReservationRules.historyLabel(entry("reservation.rejected", "rejected", reason: "日程変更")), "田中 祥司が却下（理由：日程変更）")
    XCTAssertEqual(ReservationRules.historyLabel(entry("reservation.expired", "expired", actor: nil)), "申請期限切れ")
    XCTAssertEqual(ReservationRules.historyLabel(entry("custom.event", "cancelled", actor: nil)), "取り消されました")
    XCTAssertEqual(ReservationRules.historyLabel(entry("custom.event", nil, actor: nil)), "更新されました")
  }

  func testRejectReasonValidation() {
    XCTAssertEqual(ReservationRules.validateRejectReason("  "), "却下の理由を入力してください。")
    XCTAssertNil(ReservationRules.validateRejectReason("日程変更のため"))
    XCTAssertEqual(ReservationRules.validateRejectReason(String(repeating: "あ", count: 1001)), "理由は1,000文字以内で入力してください。")
    XCTAssertNil(ReservationRules.validateRejectReason(String(repeating: "あ", count: 1000)))
  }

  func testReferenceNumber() {
    XCTAssertEqual(ReservationRules.referenceNumber(Fixtures.reservation()), "ARMS-66666666")
  }
}

final class SlotRulesTests: XCTestCase {
  func testAvailability() {
    XCTAssertEqual(SlotRules.availability(Fixtures.slot(), now: fixedNow), .bookable)
    XCTAssertEqual(SlotRules.availability(Fixtures.slot(Fixtures.slotJSON(remaining: 0)), now: fixedNow), .full)
    XCTAssertEqual(
      SlotRules.availability(Fixtures.slot(Fixtures.slotJSON(closesAt: "2026-10-02T01:59:59Z")), now: fixedNow), .closed)
    XCTAssertEqual(SlotRules.availability(Fixtures.slot(Fixtures.slotJSON(state: "cancelled")), now: fixedNow), .cancelled)
    let mine = Fixtures.slot(Fixtures.slotJSON(myReservation: #"{"id":"r","status":"pending"}"#))
    XCTAssertEqual(SlotRules.availability(mine, now: fixedNow), .alreadyRequested(.pending))
    XCTAssertEqual(SlotRules.availabilityLabel(.alreadyRequested(.pending), remaining: 2), "申請済み（承認待ち）")
    let cancelledMine = Fixtures.slot(Fixtures.slotJSON(myReservation: #"{"id":"r","status":"cancelled"}"#))
    XCTAssertEqual(SlotRules.availability(cancelledMine, now: fixedNow), .bookable)
    XCTAssertEqual(SlotRules.availabilityLabel(.bookable, remaining: 3), "残り3席")
    XCTAssertEqual(SlotRules.formatLabel(Fixtures.slot()), "オンライン")
    XCTAssertEqual(SlotRules.formatLabel(Fixtures.slot(Fixtures.slotJSON(hasMeeting: false))), "対面")
  }

  func testGroupingUsesJSTDates() {
    let lateUTC = Fixtures.slot(
      Fixtures.slotJSON(id: "a", startsAt: "2026-10-04T15:30:00Z", endsAt: "2026-10-04T16:30:00Z"))  // 10/5 00:30 JST
    let afternoon = Fixtures.slot(Fixtures.slotJSON(id: "b"))
    let grouped = SlotRules.groupByDate([afternoon, lateUTC], calendar: .tokyo)
    XCTAssertEqual(grouped[LocalDate("2026-10-05")!]?.map(\.id), ["a", "b"])
    XCTAssertNil(grouped[LocalDate("2026-10-04")!])
  }

  func testTimeBands() {
    let cal = OrgCalendar.tokyo
    let at = { (h: Int) in cal.instant(of: LocalDate("2026-10-05")!, hour: h) }
    XCTAssertTrue(SlotRules.TimeBand.morning.contains(at(9), calendar: cal))
    XCTAssertFalse(SlotRules.TimeBand.morning.contains(at(12), calendar: cal))
    XCTAssertTrue(SlotRules.TimeBand.afternoon.contains(at(14), calendar: cal))
    XCTAssertTrue(SlotRules.TimeBand.evening.contains(at(17), calendar: cal))
  }

  func testMonthGridStartsOnMonday() {
    let grid = MonthGrid(month: YearMonth("2026-10")!)
    XCTAssertEqual(MonthGrid.weekdayHeaders, ["月", "火", "水", "木", "金", "土", "日"])
    // 2026-10-01 is a Thursday → three leading blanks (月火水).
    XCTAssertEqual(grid.weeks[0].prefix(3).allSatisfy { $0 == nil }, true)
    XCTAssertEqual(grid.weeks[0][3]?.isoString, "2026-10-01")
    XCTAssertEqual(grid.weeks[1][0]?.isoString, "2026-10-05")
    XCTAssertEqual(grid.weeks.count, 5)
    XCTAssertEqual(grid.weeks.flatMap { $0 }.compactMap { $0 }.count, 31)
    XCTAssertTrue(grid.weeks.allSatisfy { $0.count == 7 })
  }
}

final class DeepLinkTests: XCTestCase {
  func testParsesAppURLs() {
    XCTAssertEqual(DeepLink.parse("arms://reservations/\(Fixtures.reservationId)"), .reservation(id: Fixtures.reservationId))
    XCTAssertEqual(
      DeepLink.parse("arms://reservations/\(Fixtures.reservationId.uppercased())"), .reservation(id: Fixtures.reservationId))
    XCTAssertEqual(DeepLink.parse("arms://lessons/today"), .todayLessons)
    XCTAssertEqual(DeepLink.parse("arms://notifications"), .notifications)
    XCTAssertEqual(DeepLink.parse("arms://reservations"), .reservations)
    XCTAssertEqual(DeepLink.parse("arms://progress"), .progress)
    XCTAssertEqual(DeepLink.parse("arms://units/\(Fixtures.unitId)/materials"), .unitMaterials(unitId: Fixtures.unitId))
    // Server DEEP_LINKS (services/api/src/domain/notifications/rules.ts).
    XCTAssertEqual(DeepLink.parse("arms://lesson-slots/\(Fixtures.slotId)"), .lessonSlot(id: Fixtures.slotId))
    XCTAssertNil(DeepLink.parse("arms://lesson-slots/x"))
    XCTAssertNil(DeepLink.parse("arms://settings/users"), "admin-only Web destination")
  }

  func testPushPayloadKey() {
    let userInfo: [AnyHashable: Any] = [
      "aps": ["alert": ["title": "予約が承認されました", "body": "…"], "sound": "default"],
      "deep_link": "arms://reservations/\(Fixtures.reservationId)",
    ]
    XCTAssertEqual(DeepLink.fromPush(userInfo: userInfo), .reservation(id: Fixtures.reservationId))
    XCTAssertNil(DeepLink.fromPush(userInfo: ["aps": [:]]))
  }

  func testParsesRelativePaths() {
    XCTAssertEqual(DeepLink.parse("/reservations/\(Fixtures.reservationId)"), .reservation(id: Fixtures.reservationId))
    XCTAssertEqual(DeepLink.parse("/lessons/today"), .todayLessons)
    XCTAssertEqual(DeepLink.parse("/today-lessons"), .todayLessons)
  }

  func testRejectsForeignOrMalformedLinks() {
    XCTAssertNil(DeepLink.parse("https://evil.example/reservations/\(Fixtures.reservationId)"))
    XCTAssertNil(DeepLink.parse("arms://reservations/not-a-uuid"))
    XCTAssertNil(DeepLink.parse("arms://lessons/tomorrow"))
    XCTAssertNil(DeepLink.parse("arms://admin/settings"))
    XCTAssertNil(DeepLink.parse(""))
  }

  func testRoundTripAndLabels() {
    for link in [
      DeepLink.reservation(id: Fixtures.reservationId), .todayLessons, .notifications, .progress, .reservations,
      .lessonSlot(id: Fixtures.slotId),
    ] {
      XCTAssertEqual(DeepLink.parse(link.url.absoluteString), link)
    }
    XCTAssertEqual(DeepLink.reservation(id: "x").actionLabel, "予約内容を確認")
    XCTAssertEqual(DeepLink.progress.actionLabel, "進捗を確認")
  }
}

final class LearningDraftTests: XCTestCase {
  func testAttendanceDraftFromRoster() {
    func item(_ id: String, _ name: String, state: AttendanceState? = nil) -> AttendanceRoster.Item {
      .init(
        studentId: id, studentName: name, employeeNumber: "E-\(id)", reservationId: "r-\(id)", reservationStatus: .approved,
        attendanceState: state, note: "", recordedByName: state == nil ? nil : "田中 祥司", recordedAt: state == nil ? nil : fixedNow)
    }
    let roster = AttendanceRoster(
      slotId: Fixtures.slotId, slotTitle: "IT基礎", startsAt: fixedNow, endsAt: fixedNow.addingTimeInterval(5400), state: .open,
      editable: true, items: [item("sa", "鈴木 大輔"), item("sb", "和田 一夫"), item("sa", "重複")])
    var draft = AttendanceDraft(roster: roster)
    XCTAssertEqual(draft.rows.map(\.studentId), ["sa", "sb"], "roster order, duplicates dropped")
    XCTAssertTrue(draft.rows.allSatisfy { $0.state == .present })
    draft.setState(.late, for: "sa")
    draft.setNote("  電車遅延  ", for: "sa")
    draft.setNote(String(repeating: "x", count: 2000), for: "sb")
    let input = draft.input()
    let a = input.records.first { $0.studentId == "sa" }
    XCTAssertEqual(a?.state, .late)
    XCTAssertEqual(a?.note, "電車遅延")
    XCTAssertEqual(input.records.first { $0.studentId == "sb" }?.note?.count, 1000)
  }

  func testQuizSessionSendsOnlySelections() {
    let quiz = Quiz(
      id: "q", title: "確認テスト",
      questions: [
        QuizQuestion(id: "q1", prompt: "1", choices: [.init(id: "a", label: "A"), .init(id: "b", label: "B")]),
        QuizQuestion(id: "q2", prompt: "2", choices: [.init(id: "c", label: "C"), .init(id: "d", label: "D")]),
      ], attemptsUsed: 0, attemptsRemaining: 2, passScore: 80)
    var s = QuizSession(quiz: quiz)
    XCTAssertFalse(s.canAdvance)
    s.select("zzz", for: "q1")
    XCTAssertFalse(s.canAdvance, "unknown choice ids are ignored")
    s.select("a", for: "q1")
    s.select("b", for: "q1")
    XCTAssertEqual(s.selected(for: "q1"), ["b"])
    s.next()
    XCTAssertEqual(s.currentQuestion?.id, "q2")
    XCTAssertFalse(s.isComplete)
    s.select("d", for: "q2")
    XCTAssertTrue(s.isComplete)
    XCTAssertEqual(s.input(), QuizInput(answers: [.init(questionId: "q1", selectedOptionIds: ["b"]), .init(questionId: "q2", selectedOptionIds: ["d"])]))
    XCTAssertEqual(QuizSession.summary(quiz), "全2問 / 合格点80点 / 受験可能（残り2回）")
  }

  func testAssignmentValidation() {
    XCTAssertEqual(AssignmentRules.validate("   "), "提出内容を入力してください。")
    XCTAssertNil(AssignmentRules.validate("業務改善の提案"))
    XCTAssertNotNil(AssignmentRules.validate(String(repeating: "あ", count: 10_001)))
    XCTAssertEqual(AssignmentRules.validateFeedback(""), "講師コメントを入力してください。")
    // A file alone is a valid submission (server: body or object_key).
    XCTAssertNil(AssignmentRules.validate("", hasAttachment: true))
    XCTAssertNil(AssignmentRules.validateAttachment(filename: "報告書.pdf", contentType: "application/pdf", sizeBytes: 1200))
    XCTAssertNil(AssignmentRules.validateAttachment(filename: "photo.JPG", contentType: "image/jpeg", sizeBytes: 1200))
    XCTAssertEqual(
      AssignmentRules.validateAttachment(filename: "a.docx", contentType: "application/msword", sizeBytes: 10),
      "添付できるファイルはPDF・PNG・JPEGです。")
    XCTAssertEqual(
      AssignmentRules.validateAttachment(filename: "a.png", contentType: "application/pdf", sizeBytes: 10),
      "ファイルの拡張子が形式と一致しません。")
    XCTAssertEqual(
      AssignmentRules.validateAttachment(filename: "a.pdf", contentType: "application/pdf", sizeBytes: 21 * 1024 * 1024),
      "ファイルサイズは20MB以下にしてください。")
  }

  func testActionKeysReuseUntilComplete() {
    var keys = ActionKeys()
    let a = keys.key(for: "reserve:1")
    XCTAssertEqual(keys.key(for: "reserve:1"), a)
    XCTAssertNotEqual(keys.key(for: "reserve:2"), a)
    keys.complete("reserve:1")
    XCTAssertNotEqual(keys.key(for: "reserve:1"), a)
  }
}
