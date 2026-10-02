import Foundation
import XCTest

@testable import ARMSKit

/// Decodes contract-shaped payloads (packages/contracts/openapi.json) into the iOS DTOs.
final class DTODecodingTests: XCTestCase {
  func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try ARMSJSON.decoder.decode(T.self, from: Data(json.utf8))
  }

  func testMeResponse() throws {
    let me = try decode(DataEnvelope<Me>.self, Fixtures.meJSON()).data
    XCTAssertEqual(me.role, .student)
    XCTAssertEqual(me.displayName, "和田 一夫")
    XCTAssertEqual(me.organization.timezone, "Asia/Tokyo")
    XCTAssertEqual(me.preferences.theme, .system)
    XCTAssertEqual(me.preferences.rowVersion, 0)
    XCTAssertEqual(me.student?.classroomName, "新入社員Aクラス")
    XCTAssertEqual(me.student?.teacherName, "田中 祥司")
    let teacher = try decode(DataEnvelope<Me>.self, Fixtures.meJSON(role: "teacher")).data
    XCTAssertNil(teacher.student)
    // Cache round trip.
    let again = try ARMSJSON.decoder.decode(Me.self, from: ARMSJSON.encoder.encode(me))
    XCTAssertEqual(again, me)
  }

  func testProgressWithNullPercent() throws {
    let p = try decode(StudentProgress.self, Fixtures.progressJSON(percent: "null", units: "[]"))
    XCTAssertNil(p.progressPercent)
    XCTAssertEqual(p.units.count, 0)
    let full = try decode(StudentProgress.self, Fixtures.progressJSON())
    XCTAssertEqual(full.progressPercent, 76)
    XCTAssertEqual(full.units[0].score, 92)
    XCTAssertEqual(full.units[2].state, .reviewPending)
  }

  func testLessonSlotPage() throws {
    let page = try decode(
      Page<LessonSlot>.self,
      Fixtures.page([
        Fixtures.slotJSON(),
        Fixtures.slotJSON(
          id: "99999999-9999-4999-8999-999999999999", myReservation: #"{"id":"\#(Fixtures.reservationId)","status":"approved"}"#,
          meetingUrl: #""https://meet.example.invalid/abc""#),
      ], next: "cursor-2"))
    XCTAssertEqual(page.items.count, 2)
    XCTAssertEqual(page.nextCursor, "cursor-2")
    XCTAssertNil(page.items[0].meetingUrl)
    XCTAssertEqual(page.items[1].myReservation?.status, .approved)
    XCTAssertEqual(page.items[1].meetingUrl, "https://meet.example.invalid/abc")
    XCTAssertEqual(page.items[0].remaining, 3)
  }

  func testLessonSlotWithoutOptionalCounts() throws {
    let json = Fixtures.slotJSON().replacingOccurrences(of: #""pending_count":1,"approved_count":6,"#, with: "")
      .replacingOccurrences(of: #","my_reservation":null"#, with: "")
    let slot = try decode(LessonSlot.self, json)
    XCTAssertNil(slot.pendingCount)
    XCTAssertNil(slot.myReservation)
  }

  func testReservationWithHistory() throws {
    let r = try decode(
      Reservation.self,
      Fixtures.reservationJSON(
        status: "approved", meetingUrl: #""https://meet.example.invalid/x""#,
        history: """
          [{"event_type":"reservation.created","status":"pending","reason":null,"actor_name":"和田 一夫","created_at":"2026-10-02T05:20:00.000Z"},
           {"event_type":"reservation.approved","status":"approved","reason":null,"actor_name":"田中 祥司","created_at":"2026-10-02T06:10:00.000Z"}]
          """))
    XCTAssertEqual(r.status, .approved)
    XCTAssertEqual(r.history?.count, 2)
    XCTAssertEqual(r.cancelDeadline.map(ISO8601.format), "2026-10-04T05:00:00.000Z")
  }

  func testMinimalReservation() throws {
    // Only the contract's required fields.
    let json = """
      {"id":"\(Fixtures.reservationId)","slot_id":"\(Fixtures.slotId)","student_id":"\(Fixtures.studentId)","status":"expired",
       "starts_at":"2026-10-05T05:00:00Z","ends_at":"2026-10-05T06:30:00Z","expires_at":"2026-10-03T02:00:00Z","row_version":3,
       "checked_at":"2026-10-02T02:00:00Z"}
      """
    let r = try decode(Reservation.self, json)
    XCTAssertEqual(r.status, .expired)
    XCTAssertNil(r.slotTitle)
    XCTAssertNil(r.history)
  }

  func testLearningPayloads() throws {
    let material = try decode(
      Material.self,
      #"{"id":"\#(Fixtures.materialId)","unit_id":"\#(Fixtures.unitId)","title":"基本ガイド.pdf","kind":"pdf","required":true,"scan_state":"clean","published":true,"size_bytes":1024,"row_version":1}"#
    )
    XCTAssertEqual(material.kind, .pdf)
    let download = try decode(
      DataEnvelope<MaterialDownload>.self,
      #"{"data":{"url":"https://files.example.invalid/x?sig=1","expires_at":"2026-10-02T02:05:00Z","content_type":"application/pdf"},"checked_at":"2026-10-02T02:00:00Z"}"#
    )
    XCTAssertEqual(download.data.contentType, "application/pdf")
    let quiz = try decode(
      DataEnvelope<Quiz>.self,
      #"{"data":{"id":"q","title":"確認テスト","questions":[{"id":"q1","prompt":"不審なメールを受信した場合は？","choices":[{"id":"a","label":"添付ファイルをすぐに開く"},{"id":"b","label":"担当部署に確認して報告する"}]}],"attempts_used":0,"attempts_remaining":3,"pass_score":80},"checked_at":"2026-10-02T02:00:00Z"}"#
    )
    XCTAssertEqual(quiz.data.questions[0].choices.count, 2)
    let submission = try decode(
      Submission.self,
      #"{"id":"s","material_id":"m","student_id":"st","state":"revision_requested","body":"提案","scan_state":"not_applicable","feedback":"もう少し具体的に","row_version":2,"submitted_at":"2026-10-02T00:20:00Z"}"#
    )
    XCTAssertEqual(submission.state, .revisionRequested)
  }

  func testNotificationAndErrors() throws {
    let page = try decode(
      Page<AppNotification>.self,
      Fixtures.page([
        #"{"id":"n1","title":"予約が承認されました","body":"10月5日（月）14:00のIT基礎の予約が、田中講師に承認されました。","deep_link":"arms://reservations/\#(Fixtures.reservationId)","read_at":null,"created_at":"2026-10-02T06:10:00Z"}"#
      ]))
    XCTAssertFalse(page.items[0].isRead)
    let error = try decode(
      APIErrorBody.self,
      Fixtures.errorJSON("VALIDATION_FAILED", "入力内容を確認してください。", extra: #","field_errors":{"reason":"理由を入力してください"},"details":{"x":1}"#))
    XCTAssertEqual(error.fieldErrors?["reason"], "理由を入力してください")
    XCTAssertEqual(error.details?["x"]?.intValue, 1)
  }

  func testVoiceSessionSecretIsRedacted() throws {
    let grant = try decode(
      VoiceSessionGrant.self,
      #"{"session_id":"s1","client_secret":"ek_super_secret_value","expires_at":"2026-10-02T02:10:00Z","model":"gpt-realtime-2.1","voice":"marin"}"#
    )
    XCTAssertEqual(grant.clientSecret, "ek_super_secret_value")
    XCTAssertFalse(String(describing: grant).contains("ek_super_secret_value"))
    XCTAssertFalse(String(reflecting: grant).contains("ek_super_secret_value"))
    var dumped = ""
    dump(grant, to: &dumped)
    XCTAssertFalse(dumped.contains("ek_super_secret_value"))
  }

  func testInputsEncodeContractKeys() throws {
    func json<T: Encodable>(_ v: T) -> String { String(decoding: try! ARMSJSON.encoder.encode(v), as: UTF8.self) }
    XCTAssertEqual(json(ReservationInput(slotId: "s")), #"{"slot_id":"s"}"#)
    XCTAssertEqual(json(DecisionInput(expectedVersion: 3)), #"{"expected_version":3}"#)
    XCTAssertEqual(json(DecisionInput(expectedVersion: 3, reason: "日程変更")), #"{"expected_version":3,"reason":"日程変更"}"#)
    XCTAssertEqual(
      json(AttendanceInput(records: [.init(studentId: "a", state: .late, note: nil)])),
      #"{"records":[{"state":"late","student_id":"a"}]}"#)
    XCTAssertEqual(json(PreferenceInput(theme: .dark, notificationsEnabled: false)), #"{"notifications_enabled":false,"theme":"dark"}"#)
    XCTAssertEqual(json(DeleteAccountInput(reason: nil)), "{}")
    XCTAssertEqual(json(QuizInput(answers: [.init(questionId: "q1", selectedOptionIds: ["b"])])), #"{"answers":[{"question_id":"q1","selected_option_ids":["b"]}]}"#)
    XCTAssertEqual(json(ReviewInput(state: .accepted, feedback: "良い", expectedVersion: 2)), #"{"expected_version":2,"feedback":"良い","state":"accepted"}"#)
    XCTAssertEqual(
      json(VoiceToolInput(sessionId: "s", callId: "c", toolName: "today_lessons", arguments: [:])),
      #"{"arguments":{},"call_id":"c","session_id":"s","tool_name":"today_lessons"}"#)
    XCTAssertEqual(DeviceInput.hexToken(Data([0x0a, 0xff, 0x01])), "0aff01")
  }
}
