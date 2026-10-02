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

  func testProgressCarriesEnrollmentsAndUnitBreakdown() throws {
    let p = try decode(StudentProgress.self, Fixtures.progressJSON(overdue: true))
    XCTAssertEqual(p.studentName, "和田 一夫")
    XCTAssertEqual(p.enrollments.count, 1)
    let e = p.enrollments[0]
    XCTAssertEqual(e.programName, "新入社員基礎研修")
    XCTAssertEqual(e.versionNumber, 2)
    XCTAssertEqual(e.dueOn, LocalDate("2026-12-25"))
    XCTAssertTrue(e.overdue)
    XCTAssertEqual(p.units(of: e).map(\.id), ["u1", "u2", "u3", "u4"])
    let u1 = p.units[0]
    XCTAssertEqual(u1.materialsTotal, 2)
    XCTAssertEqual(u1.materialsConfirmed, 2)
    XCTAssertEqual(u1.quizPassed, true)
    XCTAssertEqual(u1.submissionState, .accepted)
    XCTAssertEqual(u1.completedAt.map(ISO8601.format), "2026-10-01T05:00:00.000Z")
    XCTAssertEqual(u1.rowId, "\(Fixtures.enrollmentId)/u1")
    XCTAssertNil(p.units[3].quizPassed)
    XCTAssertNil(p.units[3].submissionState)
  }

  func testLearningPayloads() throws {
    let material = try decode(
      Material.self,
      Fixtures.materialJSON(
        id: Fixtures.materialId, title: "基本ガイド.pdf", kind: "pdf",
        learner: #"{"confirmed_at":"2026-10-02T01:00:00.000Z","quiz_attempts_used":null,"quiz_score":null,"quiz_passed":null,"submission_state":null,"feedback":null}"#
      ))
    XCTAssertEqual(material.kind, .pdf)
    XCTAssertEqual(material.programVersionId, Fixtures.programVersionId)
    XCTAssertTrue(material.isConfirmedByLearner)
    let link = try decode(
      Material.self,
      Fixtures.materialJSON(id: "l", title: "社内ポータル", kind: "link", scanState: "not_applicable", sizeBytes: "null", externalUrl: #""https://portal.example.invalid/a""#))
    XCTAssertEqual(link.secureExternalURL?.absoluteString, "https://portal.example.invalid/a")
    XCTAssertNil(link.learnerStatus, "teacher view has no learner_status")
    let download = try decode(
      DataEnvelope<MaterialDownload>.self,
      #"{"data":{"url":"https://files.example.invalid/x?sig=1","expires_at":"2026-10-02T02:05:00Z","content_type":"application/pdf"},"checked_at":"2026-10-02T02:00:00Z"}"#
    )
    XCTAssertEqual(download.data.contentType, "application/pdf")
    let quiz = try decode(
      DataEnvelope<Quiz>.self,
      #"{"data":{"id":"q","title":"確認テスト","questions":[{"id":"q1","prompt":"不審なメールを受信した場合は？","choices":[{"id":"a","label":"添付ファイルをすぐに開く"},{"id":"b","label":"担当部署に確認して報告する"}]}],"attempts_used":1,"attempts_remaining":2,"pass_score":80,"max_attempts":3,"score_policy":"highest","total_points":10,"effective_score":60,"passed":false},"checked_at":"2026-10-02T02:00:00Z"}"#
    )
    XCTAssertEqual(quiz.data.questions[0].choices.count, 2)
    XCTAssertEqual(quiz.data.maxAttempts, 3)
    XCTAssertEqual(quiz.data.scorePolicy, .highest)
    XCTAssertEqual(QuizSession.policyText(quiz.data), "受験回数の上限：3回（最高点を採用）")
    XCTAssertEqual(QuizSession.currentScoreText(quiz.data), "現在の評価：60点・不合格")
    let result = try decode(
      DataEnvelope<QuizResult>.self,
      #"{"data":{"id":"a1","score":80,"passed":true,"submitted_at":"2026-10-02T02:01:00.000Z","attempts_used":2,"attempts_remaining":1,"pass_score":80,"effective_score":80,"correct_count":4,"question_count":5},"checked_at":"2026-10-02T02:01:00.000Z"}"#
    )
    XCTAssertEqual(result.data.correctCount, 4)
    XCTAssertEqual(result.data.attemptsRemaining, 1)
    let submission = try decode(
      Submission.self, Fixtures.submissionJSON(id: "s", state: "revision_requested", feedback: #""もう少し具体的に""#, rowVersion: 2))
    XCTAssertEqual(submission.state, .revisionRequested)
    XCTAssertEqual(submission.scanState, .notApplicable)
    XCTAssertEqual(submission.materialTitle, "業務改善レポート")
    XCTAssertFalse(submission.hasFile)
  }

  func testUploadPayloads() throws {
    let ticket = try decode(
      DataEnvelope<UploadTicket>.self,
      #"{"data":{"id":"u1","upload_url":"https://r2.example.invalid/quarantine/o/k?X-Amz-Signature=x","object_key":"quarantine/o/k","expires_at":"2026-10-02T02:15:00.000Z","required_headers":{"Content-Type":"application/pdf"}},"checked_at":"2026-10-02T02:00:00.000Z"}"#
    )
    XCTAssertEqual(ticket.data.requiredHeaders["Content-Type"], "application/pdf")
    XCTAssertEqual(ticket.data.objectKey, "quarantine/o/k")
    let status = try JSONValue(
      jsonString:
        #"{"id":"u1","purpose":"assignment","filename":"report.pdf","content_type":"application/pdf","size_bytes":1200,"state":"scanning","scan_state":"pending","object_key":"quarantine/o/k","created_at":"2026-10-02T02:00:00.000Z","completed_at":"2026-10-02T02:01:00.000Z","reject_code":null,"scanner_configured":false}"#
    ).decode(UploadStatus.self)
    XCTAssertTrue(status.isAttachable)
    XCTAssertEqual(status.purpose, .assignment)
    XCTAssertEqual(
      String(decoding: try ARMSJSON.encoder.encode(UploadInput(filename: "a.pdf", contentType: "application/pdf", sizeBytes: 3, purpose: .assignment)), as: UTF8.self),
      #"{"content_type":"application/pdf","filename":"a.pdf","purpose":"assignment","size_bytes":3}"#)
  }

  func testAttendanceRoster() throws {
    let roster = try decode(
      DataEnvelope<AttendanceRoster>.self,
      #"{"data":{"slot_id":"\#(Fixtures.slotId)","slot_title":"IT基礎","starts_at":"2026-10-05T05:00:00.000Z","ends_at":"2026-10-05T06:30:00.000Z","state":"open","editable":true,"items":[{"student_id":"s1","student_name":"和田 一夫","employee_number":"E001","reservation_id":"r1","reservation_status":"approved","attendance_state":null,"note":"","recorded_by_name":null,"recorded_at":null},{"student_id":"s2","student_name":"鈴木 大輔","employee_number":"E002","reservation_id":null,"reservation_status":null,"attendance_state":"late","note":"電車遅延","recorded_by_name":"田中 祥司","recorded_at":"2026-10-05T05:10:00.000Z"}]},"checked_at":"2026-10-05T05:20:00.000Z"}"#
    ).data
    XCTAssertTrue(roster.editable)
    XCTAssertEqual(roster.items[0].reservationStatus, .approved)
    XCTAssertNil(roster.items[0].attendanceState)
    XCTAssertEqual(roster.items[1].attendanceState, .late)
    XCTAssertNil(roster.items[1].reservationStatus)
    let draft = AttendanceDraft(roster: roster)
    XCTAssertEqual(draft.rows.map(\.state), [.present, .late], "unrecorded students default to 出席, recorded keep their state")
    XCTAssertEqual(draft.rows[1].note, "電車遅延")
    XCTAssertTrue(draft.rows[1].isRecorded)
  }

  func testVoiceToolResults() throws {
    let lessons = try JSONValue(
      jsonString:
        #"{"date":"2026-10-02","date_ja":"2026年10月2日（金）","lessons":[{"slot_id":"\#(Fixtures.slotId)","title":"IT基礎","date":"2026-10-02","date_ja":"10月2日（金）","start":"14:00","end":"15:30","teacher_name":"田中 祥司","classroom_name":"新入社員Aクラス","remaining":3,"state":"open","my_reservation_status":"approved","my_reservation_status_ja":"承認済み"}],"count":1,"checked_at":"2026-10-02T02:00:00.000Z"}"#
    )
    guard case .lessons(let title, let slots)? = VoiceResultCard.parse(tool: .todayLessons, data: lessons) else {
      return XCTFail("lessons card")
    }
    XCTAssertEqual(title, "本日の授業")
    XCTAssertEqual(slots.first?.myReservationStatus, .approved)
    let reservations = try JSONValue(
      jsonString:
        #"{"reservations":[{"reservation_id":"\#(Fixtures.reservationId)","title":"IT基礎","date":"2026-10-05","date_ja":"10月5日（月）","start":"14:00","end":"15:30","status":"pending","status_ja":"承認待ち","teacher_name":"田中 祥司","hold_expires_at":"2026-10-03T02:00:00.000Z","cancel_deadline":"2026-10-04T05:00:00.000Z"}],"from":"2026-09-25","checked_at":"2026-10-02T02:00:00.000Z"}"#
    )
    guard case .reservations(let list)? = VoiceResultCard.parse(tool: .getReservations, data: reservations) else {
      return XCTFail("reservations card")
    }
    XCTAssertEqual(list.first?.status, .pending)
    XCTAssertNotNil(list.first?.holdExpiresAt)
    let progress = try JSONValue(
      jsonString:
        #"{"student_name":"和田 一夫","progress_percent":null,"progress_ja":"未設定（必須の単元が割り当てられていません）","required_total":0,"required_completed":0,"programs":[],"units":[],"checked_at":"2026-10-02T02:00:00.000Z"}"#
    )
    guard case .progress(let summary)? = VoiceResultCard.parse(tool: .getProgress, data: progress) else {
      return XCTFail("progress card")
    }
    XCTAssertNil(summary.progressPercent)
    let failure = ActionResult(
      success: false, checkedAt: fixedNow, data: ["error_code": "SLOT_FULL", "message_ja": "この授業は満席です。"])
    XCTAssertEqual(failure.toolFailure, VoiceToolFailure(errorCode: "SLOT_FULL", messageJa: "この授業は満席です。"))
    XCTAssertNil(ActionResult(success: true, checkedAt: fixedNow, data: nil).toolFailure)
    XCTAssertEqual(ActionResult(success: false, checkedAt: fixedNow, data: nil).toolFailure?.errorCode, "TOOL_FAILED")
  }

  func testVoiceQuota() throws {
    let quota = try decode(
      DataEnvelope<VoiceQuota>.self,
      #"{"data":{"daily_quota_seconds":900,"max_session_seconds":300,"used_seconds":180,"remaining_seconds":720},"checked_at":"2026-10-02T02:00:00.000Z"}"#
    ).data
    XCTAssertEqual(quota.labelJa, "3分 / 15分")
    XCTAssertEqual(quota.remainingLabelJa, "本日の残り：12分")
    XCTAssertFalse(quota.isExhausted)
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
      #"{"session_id":"s1","client_secret":"ek_super_secret_value","expires_at":"2026-10-02T02:10:00Z","client_secret_expires_at":"2026-10-02T02:10:00Z","model":"gpt-realtime-2.1","voice":"marin","max_seconds":300,"tools":["today_lessons","get_progress"],"quota_remaining_seconds":600}"#
    )
    XCTAssertEqual(grant.clientSecret, "ek_super_secret_value")
    XCTAssertEqual(grant.maxSeconds, 300)
    XCTAssertEqual(grant.tools, ["today_lessons", "get_progress"])
    XCTAssertEqual(grant.quotaRemainingSeconds, 600)
    XCTAssertNotNil(grant.clientSecretExpiresAt)
    XCTAssertFalse(String(describing: grant).contains("ek_super_secret_value"))
    XCTAssertFalse(String(reflecting: grant).contains("ek_super_secret_value"))
    var dumped = ""
    dump(grant, to: &dumped)
    XCTAssertFalse(dumped.contains("ek_super_secret_value"))
  }

  /// Every code of packages/contracts/src/errors.ts has the same Japanese text in ErrorCatalog.
  func testErrorCatalogMirrorsContract() throws {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("packages/contracts/src/errors.ts")
    guard let source = try? String(contentsOf: url, encoding: .utf8) else {
      throw XCTSkip("packages/contracts/src/errors.ts is not available next to the package")
    }
    let regex = try NSRegularExpression(pattern: #"^\s*([A-Z_]+): \{ status: \d+, message_ja: "([^"]*)" \},?$"#, options: [.anchorsMatchLines])
    let ns = source as NSString
    var contract: [String: String] = [:]
    for m in regex.matches(in: source, range: NSRange(location: 0, length: ns.length)) {
      contract[ns.substring(with: m.range(at: 1))] = ns.substring(with: m.range(at: 2))
    }
    XCTAssertGreaterThan(contract.count, 60)
    for (code, message) in contract {
      XCTAssertEqual(ErrorCatalog.messages[code], message, code)
    }
    XCTAssertEqual(Set(ErrorCatalog.messages.keys).subtracting(contract.keys), [], "no codes the API does not know")
  }

  func testDeviceTokenHashMatchesServer() {
    // FIPS 180-4 vectors.
    XCTAssertEqual(SHA256Digest.hexDigest(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    XCTAssertEqual(SHA256Digest.hexDigest("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    XCTAssertEqual(
      SHA256Digest.hexDigest("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
    // Multi-block and exact 64-byte inputs (computed with Node's crypto).
    XCTAssertEqual(
      SHA256Digest.hexDigest(String(repeating: "a", count: 1000)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")
    XCTAssertEqual(
      SHA256Digest.hexDigest(String(repeating: "x", count: 64)), "7ce100971f64e7001e8fe5a51973ecdfe1ced42befe7ee8d5fd6219506b5393c")
    // sha256(lower-case hex token), as services/api/src/domain/notifications/devices.ts.
    XCTAssertEqual(DeviceInput.tokenHash(hexToken: "ABC"), SHA256Digest.hexDigest("abc"))
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
