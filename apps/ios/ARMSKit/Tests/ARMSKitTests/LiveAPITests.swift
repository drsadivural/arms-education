import Foundation
import XCTest

@testable import ARMSKit

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

// MARK: - Opt-in live contract test
//
// Runs the real ARMSKit client (URLSessionTransport → APIClient → DTOs / view models / voice bridge)
// against a LOCAL stack: wrangler dev + Postgres + GoTrue + MinIO. Skipped unless ARMS_LIVE_API=1.
//
//   apps/ios/ARMSKit/Scripts/live-contract-test.sh
//
// which seeds a fresh organisation (Scripts/seed-live.mjs) and runs
//   ARMS_LIVE_API=1 ARMS_LIVE_FIXTURE=<fixture.json> swift test --filter LiveAPITests
// Env: ARMS_LIVE_API_BASE (default http://127.0.0.1:8804/api/v1), ARMS_LIVE_AUTH_URL (default http://127.0.0.1:9999).
// Each run needs a fresh seed (bookings are not undone).

struct LiveFixture: Decodable {
  struct Person: Decodable {
    let id: String
    let email: String
  }
  struct Materials: Decodable {
    let link: String
    let quiz: String
    let assignment: String
  }
  struct Slots: Decodable {
    let a: String
    let b: String
    let c: String
  }
  let stamp: String
  let orgId: String
  let password: String
  let teacher: Person
  let student: Person
  let classroomId: String
  let programId: String
  let programVersionId: String
  let unitId: String
  let materials: Materials
  let slots: Slots
  let voiceSessionId: String
}

/// Supabase Auth (GoTrue) password grant — what supabase-swift does in the app.
final class GoTrueTokens: AuthService, @unchecked Sendable {
  let authURL: URL
  private let lock = NSLock()
  private var email: String
  private var password: String
  private var token: String?

  init(authURL: URL, email: String, password: String) {
    self.authURL = authURL
    self.email = email
    self.password = password
  }

  func accessToken() async throws -> String {
    if let token = lock.withLock({ token }) { return token }
    return try await refreshAccessToken()
  }

  func refreshAccessToken() async throws -> String {
    let (email, password) = lock.withLock { (self.email, self.password) }
    let token = try await Self.passwordGrant(authURL: authURL, email: email, password: password)
    lock.withLock { self.token = token }
    return token
  }

  func signIn(email: String, password: String) async throws {
    lock.withLock {
      self.email = email
      self.password = password
    }
    _ = try await refreshAccessToken()
  }

  func signOut() async { lock.withLock { token = nil } }
  func hasStoredSession() async -> Bool { lock.withLock { token != nil } }

  static func passwordGrant(authURL: URL, email: String, password: String) async throws -> String {
    var components = URLComponents(url: authURL.appendingPathComponent("token"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "grant_type", value: "password")]
    let body = try JSONSerialization.data(withJSONObject: ["email": email, "password": password])
    let response = try await URLSessionTransport().send(
      HTTPRequest(url: components.url!, method: .post, headers: ["Content-Type": "application/json"], body: body))
    guard response.status == 200, let json = try? JSONValue(jsonData: response.body),
      let token = json["access_token"]?.stringValue
    else {
      throw ARMSError.auth(.invalidCredentials)
    }
    return token
  }
}

@MainActor
final class LiveAPITests: XCTestCase {
  var fixture: LiveFixture!
  var baseURL: URL!
  var authURL: URL!

  /// Called first by every test (not `setUp`, to keep XCTest's isolation of the overridden method untouched).
  func prepare() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["ARMS_LIVE_API"] == "1", "set ARMS_LIVE_API=1 to run against the local stack")
    let env = ProcessInfo.processInfo.environment
    guard let path = env["ARMS_LIVE_FIXTURE"], let data = FileManager.default.contents(atPath: path) else {
      XCTFail("ARMS_LIVE_FIXTURE must point at the JSON written by Scripts/seed-live.mjs")
      throw XCTSkip("no fixture")
    }
    fixture = try JSONDecoder().decode(LiveFixture.self, from: data)
    baseURL = URL(string: env["ARMS_LIVE_API_BASE"] ?? "http://127.0.0.1:8804/api/v1")!
    authURL = URL(string: env["ARMS_LIVE_AUTH_URL"] ?? "http://127.0.0.1:9999")!
  }

  func client(_ person: LiveFixture.Person) -> APIClient {
    APIClient(
      baseURL: baseURL, transport: URLSessionTransport(),
      tokens: GoTrueTokens(authURL: authURL, email: person.email, password: fixture.password),
      retryPolicy: RetryPolicy(maxAttempts: 3, baseDelay: 0.2, maxDelay: 1))
  }

  func context(_ person: LiveFixture.Person, role: Role) async throws -> AppContext {
    let api = client(person)
    let context = AppContext(api: api, cache: InMemoryResponseCache(), keyValues: InMemoryKeyValueStore())
    context.setMe(try await api.send(API.me(selectedRole: role)).value.data)
    return context
  }

  func log(_ line: String) { print("[live] \(line)") }

  /// Expects an API error with `code` and returns it.
  @discardableResult
  func expectError<R>(_ code: String, _ endpoint: Endpoint<R>, on api: APIClient, file: StaticString = #filePath, line: UInt = #line)
    async -> ARMSError?
  {
    do {
      _ = try await api.send(endpoint)
      XCTFail("expected \(code) from \(endpoint.method.rawValue) \(endpoint.path)", file: file, line: line)
      return nil
    } catch {
      XCTAssertEqual(error.code, code, "\(endpoint.method.rawValue) \(endpoint.path): \(error.messageJa)", file: file, line: line)
      XCTAssertFalse(error.messageJa.isEmpty, file: file, line: line)
      return error
    }
  }

  // MARK: Identity

  func testA_IdentityAndRoleCheck() async throws {
    try prepare()
    // SessionStore drives GoTrue sign-in + GET /me with X-ARMS-Selected-Role exactly like the login screen.
    let tokens = GoTrueTokens(authURL: authURL, email: "", password: "")
    let api = APIClient(baseURL: baseURL, transport: URLSessionTransport(), tokens: tokens)
    let context = AppContext(api: api, cache: InMemoryResponseCache(), keyValues: InMemoryKeyValueStore())
    let session = SessionStore(auth: tokens, context: context)
    session.selectedRole = .student
    await session.signIn(email: fixture.student.email, password: fixture.password)
    guard case .signedIn(let me) = session.state else { return XCTFail("student sign-in: \(session.state) \(session.message ?? "")") }
    XCTAssertEqual(me.id, fixture.student.id)
    XCTAssertEqual(me.role, .student)
    XCTAssertEqual(me.organization.timezone, "Asia/Tokyo")
    XCTAssertEqual(me.student?.classroomId, fixture.classroomId)
    XCTAssertEqual(me.student?.teacherName, "田中 祥司")
    log("GET /me (student, X-ARMS-Selected-Role) → Me decoded")

    // The same account choosing 講師 is refused by the server (403 ROLE_MISMATCH) and signed out.
    await session.signOut()
    session.selectedRole = .teacher
    await session.signIn(email: fixture.student.email, password: fixture.password)
    XCTAssertEqual(session.state, .signedOut)
    XCTAssertEqual(session.message, SessionStore.roleMismatchMessage)
    await expectError("ROLE_MISMATCH", API.me(selectedRole: .teacher), on: client(fixture.student))
    log("GET /me (student as teacher) → 403 ROLE_MISMATCH → signed out")

    let teacherMe = try await client(fixture.teacher).send(API.me(selectedRole: .teacher)).value.data
    XCTAssertEqual(teacherMe.role, .teacher)
    XCTAssertNil(teacherMe.student)

    // Public password reset (server-controlled redirect, same message for every address).
    let reset = await session.requestPasswordReset(email: "nobody-\(fixture.stamp)@arms.local")
    guard case .success(let message) = reset else { return XCTFail("password reset: \(reset)") }
    XCTAssertFalse(message.isEmpty)
    log("POST /auth/password-reset → \(message)")
  }

  // MARK: Booking, today, attendance

  func testB_BookingTodayAndAttendance() async throws {
    try prepare()
    let student = client(fixture.student)
    let teacher = client(fixture.teacher)

    // Lesson slots (student scope) and the single slot.
    let slots = try await student.collectAll(query: ListQuery(limit: 100), API.lessonSlots)
    XCTAssertEqual(Set(slots.items.map(\.id)), [fixture.slots.a, fixture.slots.b, fixture.slots.c])
    let slotA = try XCTUnwrap(slots.items.first { $0.id == fixture.slots.a })
    XCTAssertNil(slotA.meetingUrl, "meeting URL hidden before approval")
    XCTAssertTrue(slotA.hasMeetingUrl)
    XCTAssertEqual(slotA.remaining, 10)
    let single = try await student.send(API.lessonSlot(id: fixture.slots.a))
    XCTAssertEqual(single.value.data.id, fixture.slots.a)
    XCTAssertEqual(single.etagVersion, single.value.data.rowVersion)
    log("GET /lesson-slots (\(slots.items.count)) and /lesson-slots/{id} → LessonSlot decoded")

    // Booking through the IOS-08 view model, then an idempotent retry with the same key.
    let studentContext = try await context(fixture.student, role: .student)
    let confirm = BookingConfirmModel(slot: slotA, context: studentContext)
    await confirm.submit()
    guard case .submitted(let created)? = confirm.outcome else { return XCTFail("booking: \(String(describing: confirm.error))") }
    XCTAssertEqual(created.status, .pending)
    XCTAssertEqual(created.slotId, fixture.slots.a)
    XCTAssertEqual(confirm.successMessage, "予約を申請しました。担当講師の承認をお待ちください。")
    let retry = try await student.send(API.createReservation(slotId: fixture.slots.a, key: confirm.idempotencyKey))
    XCTAssertEqual(retry.value.id, created.id, "same Idempotency-Key → same reservation")
    log("POST /reservations → \(retry.status) (retry with the same key returned the same reservation)")
    let byKey = try await student.send(API.reservations(ListQuery(limit: 5, idempotencyKey: confirm.idempotencyKey)))
    XCTAssertEqual(byKey.value.items.map(\.id), [created.id])
    let bySlot = try await student.send(
      API.reservations(ListQuery(status: ListQuery.statuses([.pending, .approved]), slotId: fixture.slots.a)))
    XCTAssertEqual(bySlot.value.items.map(\.id), [created.id])
    await expectError("ALREADY_RESERVED", API.createReservation(slotId: fixture.slots.a, key: IdempotencyKey()), on: student)
    log("GET /reservations?idempotency_key / ?slot_id&status=pending,approved; second request → 409 ALREADY_RESERVED")

    // Today's lesson: book C, teacher approves (bare Reservation), stale version is refused.
    let reservationC = try await student.send(API.createReservation(slotId: fixture.slots.c, key: IdempotencyKey())).value
    let teacherContext = try await context(fixture.teacher, role: .teacher)
    let decisions = TeacherReservationsModel(context: teacherContext)
    await decisions.load()
    let pendingC = try XCTUnwrap(decisions.items.first { $0.id == reservationC.id })
    await decisions.approve(pendingC)
    XCTAssertNil(decisions.actionError, decisions.actionError?.messageJa ?? "")
    XCTAssertEqual(decisions.actionMessage, "和田 一夫さんの予約を承認しました。")
    let stale = await expectError(
      "VERSION_CONFLICT", API.approveReservation(id: reservationC.id, expectedVersion: pendingC.rowVersion, key: IdempotencyKey()),
      on: teacher)
    XCTAssertEqual(stale?.reportedReservationStatus, .approved, "details.status")
    XCTAssertNotNil(stale?.details?["row_version"]?.intValue, "details.row_version")

    let detail = try await student.send(API.reservation(id: reservationC.id))
    XCTAssertEqual(detail.value.status, .approved)
    XCTAssertNotNil(detail.value.meetingUrl, "approved → meeting URL disclosed")
    XCTAssertGreaterThanOrEqual(detail.value.history?.count ?? 0, 2)
    XCTAssertEqual(detail.etagVersion, detail.value.rowVersion)
    await expectError(
      "INVALID_STATE", API.approveReservation(id: reservationC.id, expectedVersion: detail.value.rowVersion, key: IdempotencyKey()),
      on: teacher)
    log("POST /reservations/{id}/approve → bare Reservation; stale version → VERSION_CONFLICT details{status,row_version}; current version again → INVALID_STATE")

    let mine = MyReservationsModel(context: studentContext)
    await mine.load()
    XCTAssertTrue(Set(mine.items.map(\.id)).isSuperset(of: [created.id, reservationC.id]))

    // 本日の授業: student (approved) and teacher (own slots).
    let studentToday = TodayLessonsModel(context: studentContext)
    await studentToday.load()
    XCTAssertEqual(studentToday.lessons.map(\.id), [fixture.slots.c])
    XCTAssertEqual(studentToday.tag(for: studentToday.lessons[0]).label, "承認済み")
    let teacherToday = try await teacher.send(API.todayLessons()).value
    XCTAssertTrue(teacherToday.items.contains { $0.id == fixture.slots.c })
    log("GET /today-lessons (student/teacher) → C")

    // 出欠 (IOS-16): roster of C (starts within 30 minutes → editable), save, roster shows the record.
    let attendance = AttendanceModel(slotId: fixture.slots.c, context: teacherContext)
    await attendance.load()
    XCTAssertNil(attendance.roster.error, attendance.roster.error?.messageJa ?? "")
    XCTAssertTrue(attendance.isEditable)
    XCTAssertEqual(attendance.draft.rows.map(\.studentId), [fixture.student.id])
    attendance.setState(.late, for: fixture.student.id)
    attendance.setNote("電車遅延", for: fixture.student.id)
    await attendance.save()
    XCTAssertNil(attendance.error, attendance.error?.messageJa ?? "")
    XCTAssertEqual(attendance.savedMessage, "出欠を保存しました（1名）。")
    let recorded = try XCTUnwrap(attendance.roster.value?.data.items.first)
    XCTAssertEqual(recorded.attendanceState, .late)
    XCTAssertEqual(recorded.note, "電車遅延")
    XCTAssertEqual(recorded.recordedByName, "田中 祥司")
    XCTAssertTrue(attendance.draft.rows[0].isRecorded)
    log("GET/POST /lesson-slots/{C}/attendance → AttendanceRoster decoded, record saved (late, recorded_by)")

    // Slot A starts in 3 days: the roster is read-only and saving is refused with ATTENDANCE_NOT_OPEN.
    let early = AttendanceModel(slotId: fixture.slots.a, context: teacherContext)
    await early.load()
    XCTAssertFalse(early.isEditable)
    XCTAssertEqual(early.notEditableMessage, "出欠は授業開始の30分前から記録できます。")
    await expectError(
      "ATTENDANCE_NOT_OPEN",
      API.recordAttendance(
        slotId: fixture.slots.a, input: AttendanceInput(records: [.init(studentId: fixture.student.id, state: .present, note: nil)]),
        key: IdempotencyKey()),
      on: teacher)
    log("POST /lesson-slots/{A}/attendance → 409 ATTENDANCE_NOT_OPEN")
  }

  // MARK: Progress, materials, quiz, assignment upload, teacher review

  func testC_ProgressMaterialsAndReview() async throws {
    try prepare()
    let studentContext = try await context(fixture.student, role: .student)
    let teacherContext = try await context(fixture.teacher, role: .teacher)
    let teacher = teacherContext.api

    // IOS-04: the student's own progress (bare Progress with enrollments).
    let progress = ProgressModel(context: studentContext)
    await progress.load()
    let p = try XCTUnwrap(progress.progress.value, progress.progress.error?.messageJa ?? "")
    XCTAssertEqual(p.studentName, "和田 一夫")
    XCTAssertEqual(p.enrollments.count, 1)
    XCTAssertEqual(p.enrollments.first?.programName, "新入社員基礎研修")
    XCTAssertEqual(p.enrollments.first?.versionNumber, 1)
    XCTAssertEqual(p.enrollments.first?.overdue, false)
    XCTAssertEqual(p.units.map(\.id), [fixture.unitId])
    XCTAssertEqual(p.units.first?.materialsTotal, 1, "the required link")
    XCTAssertEqual(p.units.first?.quizPassed, false)
    log("GET /students/{id}/progress → \(EnrollmentPresentation.title(p.enrollments[0])) \(EnrollmentPresentation.dueText(p.enrollments[0])), unit: \(UnitPresentation.detail(p.units[0]))")

    // IOS-12: materials with learner_status; link opens its https URL; receipt; quiz attempt.
    let materials = UnitMaterialsModel(unitId: fixture.unitId, unitTitle: "IT基礎・セキュリティ", context: studentContext)
    await materials.load()
    XCTAssertNil(materials.materials.error, materials.materials.error?.messageJa ?? "")
    XCTAssertEqual(Set(materials.visibleMaterials.map(\.id)), [fixture.materials.link, fixture.materials.quiz, fixture.materials.assignment])
    XCTAssertTrue(materials.visibleMaterials.allSatisfy { $0.learnerStatus != nil && $0.programVersionId == fixture.programVersionId })
    let link = try XCTUnwrap(materials.visibleMaterials.first { $0.kind == .link })
    let viaDownload = try await studentContext.api.send(API.materialDownload(id: link.id)).value.data
    XCTAssertEqual(viaDownload.url, "https://portal.example.invalid/guide")
    XCTAssertEqual(viaDownload.contentType, "text/html")
    await materials.confirmReceipt(link)
    XCTAssertNil(materials.actionError, materials.actionError?.messageJa ?? "")
    await expectError("MATERIAL_KIND_MISMATCH", API.materialDownload(id: fixture.materials.quiz), on: studentContext.api)
    let detail = try await studentContext.api.send(API.material(id: link.id)).value.data
    XCTAssertNotNil(detail.learnerStatus?.confirmedAt)
    log("GET /units/{id}/materials, /materials/{id}, link download → external URL, receipt → confirmed_at")

    let quizMaterial = try XCTUnwrap(materials.visibleMaterials.first { $0.kind == .quiz })
    let quiz = QuizModel(material: quizMaterial, context: studentContext)
    await quiz.load()
    let loaded = try XCTUnwrap(quiz.quiz.value?.data, quiz.quiz.error?.messageJa ?? "")
    XCTAssertEqual(loaded.maxAttempts, 3)
    XCTAssertEqual(loaded.attemptsRemaining, 3)
    XCTAssertNil(loaded.effectiveScore)
    quiz.select("b", for: loaded.questions[0].id)
    await quiz.submit()
    XCTAssertEqual(quiz.resultText, "100点・合格", quiz.error?.messageJa ?? "")
    XCTAssertEqual(quiz.result?.correctCount, 1)
    XCTAssertEqual(quiz.result?.attemptsRemaining, 2)
    log("GET /materials/{id}/quiz, POST quiz-attempts → \(quiz.resultText ?? "-") / \(quiz.resultDetail ?? "-")")

    // Assignment with a PDF: POST /uploads → presigned PUT (MinIO) → complete → submit with object_key.
    let assignmentMaterial = try XCTUnwrap(materials.visibleMaterials.first { $0.kind == .assignment })
    let assignment = AssignmentModel(material: assignmentMaterial, context: studentContext)
    assignment.body = "業務改善の提案を添付します。"
    let pdf = Data("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n".utf8)
    XCTAssertNil(assignment.attach(filename: "改善提案.pdf", contentType: "application/pdf", data: pdf))
    await assignment.submit()
    let submission = try XCTUnwrap(assignment.submission, assignment.error?.messageWithRequestId ?? "")
    XCTAssertTrue(submission.hasFile)
    XCTAssertEqual(submission.filename, "改善提案.pdf")
    log("POST /uploads → PUT presigned → POST /uploads/{id}/complete → POST submissions (has_file, scan_state=\(submission.scanState.rawValue))")

    // IOS-06: teacher review queue, file access, review with expected_version, stale version.
    let detailModel = StudentDetailModel(studentId: fixture.student.id, context: teacherContext)
    await detailModel.load()
    XCTAssertEqual(detailModel.pendingSubmissions.value?.map(\.id), [submission.id], detailModel.pendingSubmissions.error?.messageJa ?? "")
    XCTAssertEqual(detailModel.progress.value?.enrollments.count, 1)
    let queue = ReviewQueueModel(context: teacherContext)
    await queue.load()
    XCTAssertEqual(queue.items.map(\.id), [submission.id])
    let review = SubmissionReviewModel(submission: queue.items[0], context: teacherContext)
    if submission.scanState == .clean {
      let file = await review.fileURL()
      XCTAssertNotNil(file, review.fileError?.messageJa ?? "")
    } else {
      XCTAssertFalse(review.canOpenFile)
      await expectError("SCAN_PENDING", API.submissionFile(id: submission.id), on: teacher)
    }
    review.feedback = "具体的な数値目標を追加して再提出してください。"
    let reviewed = await review.review(.revisionRequested)
    XCTAssertEqual(reviewed?.state, .revisionRequested, review.error?.messageJa ?? "")
    XCTAssertEqual(reviewed?.reviewerName, "田中 祥司")
    await expectError(
      "VERSION_CONFLICT",
      API.reviewSubmission(
        id: submission.id, input: ReviewInput(state: .accepted, feedback: "x", expectedVersion: submission.rowVersion),
        key: IdempotencyKey()),
      on: teacher)
    log("GET /submissions?student_id&state=submitted, /submissions/{id}/file, POST review (expected_version) → revision_requested; stale → VERSION_CONFLICT")

    let after = try await studentContext.api.send(API.material(id: assignmentMaterial.id)).value.data
    XCTAssertEqual(after.learnerStatus?.submissionState, .revisionRequested)
    XCTAssertEqual(after.learnerStatus?.feedback, "具体的な数値目標を追加して再提出してください。")
  }

  // MARK: Notifications and devices

  func testD_NotificationsAndDevices() async throws {
    try prepare()
    let studentContext = try await context(fixture.student, role: .student)
    let notifications = NotificationsModel(context: studentContext)
    await notifications.setFilter(.unread)
    XCTAssertNil(notifications.notifications.error, notifications.notifications.error?.messageJa ?? "")
    let unread = notifications.items
    XCTAssertGreaterThanOrEqual(unread.count, 2)
    XCTAssertTrue(unread.allSatisfy { !$0.isRead })
    XCTAssertEqual(studentContext.unreadNotifications, unread.count)
    let slotLink = try XCTUnwrap(unread.first { $0.deepLink.hasPrefix("arms://lesson-slots/") })
    let opened = await notifications.open(slotLink)
    XCTAssertEqual(opened, .lessonSlot(id: fixture.slots.b))
    XCTAssertTrue(unread.map { DeepLink.parse($0.deepLink) }.allSatisfy { $0 != nil }, "every server deep link is understood")
    await notifications.setFilter(.all)
    await notifications.markAllRead()
    XCTAssertNil(notifications.actionError, notifications.actionError?.messageJa ?? "")
    await NotificationsModel.refreshUnreadCount(context: studentContext)
    XCTAssertEqual(studentContext.unreadNotifications, 0)
    log("GET /notifications?status=unread (\(unread.count)), POST /{id}/read, POST /notifications/read-all → 0 unread")

    // Devices: the local stack has no APNs keys → 503 NOT_CONFIGURED (not retried); DELETE is idempotent.
    let push = PushRegistration(context: studentContext)
    let token = Data((0..<32).map { UInt8($0) })
    let registered = await push.register(deviceToken: token, environment: .sandbox)
    XCTAssertFalse(registered)
    await expectError(
      "NOT_CONFIGURED", API.registerDevice(DeviceInput(token: DeviceInput.hexToken(token), environment: .sandbox), key: IdempotencyKey()),
      on: studentContext.api)
    let removed = try await studentContext.api.send(
      API.unregisterDevice(tokenHash: DeviceInput.tokenHash(hexToken: DeviceInput.hexToken(token)))
    ).value
    XCTAssertTrue(removed.success)
    XCTAssertEqual(removed.data?["removed"]?.intValue, 0)
    log("POST /devices → 503 NOT_CONFIGURED; DELETE /devices/{sha256} → success removed=0")
  }

  // MARK: Voice

  func testE_VoiceSessionQuotaAndToolBridge() async throws {
    try prepare()
    let student = client(fixture.student)

    // No OpenAI key locally: the session endpoint answers 503 VOICE_UNAVAILABLE with a Japanese message.
    await expectError("VOICE_UNAVAILABLE", API.createVoiceSession(key: IdempotencyKey()), on: student)
    let quota = try await student.send(API.voiceQuota()).value.data
    XCTAssertEqual(quota.usedSeconds, 600, "the seeded open session counts its full reservation")
    XCTAssertEqual(quota.remainingSeconds, quota.dailyQuotaSeconds - 600)
    log("POST /voice/sessions → 503 VOICE_UNAVAILABLE; GET /voice/quota → \(quota.labelJa) \(quota.remainingLabelJa)")

    // The seeded session drives /voice/tool-calls through the ARMSKit bridge (as the WebRTC data channel would).
    let sink = EventSink()
    let conversation = VoiceConversation(
      sessionId: fixture.voiceSessionId, role: .student, calendar: .tokyo, expiresAt: nil,
      serverTools: ["today_lessons", "get_progress", "search_slots", "get_reservations", "prepare_reservation",
        "commit_reservation", "prepare_cancellation", "commit_cancellation"],
      executor: APIVoiceToolExecutor(api: student), now: Date.init, send: { sink.send($0) }, setMicrophone: { _ in })
    func call(_ name: String, _ arguments: String) -> String {
      let id = "live-\(UUID().uuidString)"
      conversation.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: id, name: name, arguments: arguments)))
      return id
    }
    func output(_ callId: String) async throws -> JSONValue {
      await waitUntil(timeout: 20) {
        sink.events.contains { $0.json["item"]?["call_id"]?.stringValue == callId }
      }
      let event = try XCTUnwrap(sink.events.first { $0.json["item"]?["call_id"]?.stringValue == callId }, "no output for \(callId)")
      // Let the next call flush: the fake model finishes its response.
      conversation.handle(.responseDone(responseId: nil, status: "completed", functionCalls: []))
      return try JSONValue(jsonString: event.json["item"]?["output"]?.stringValue ?? "")
    }

    // Read tools decode into result cards.
    let slotsOut = try await output(call("search_slots", #"{"date":"\#(try await slotDate(fixture.slots.b))","time_band":"any"}"#))
    XCTAssertEqual(slotsOut["ok"], true, slotsOut.jsonString())
    XCTAssertTrue(conversation.entries.contains { if case .lessons(_, let s)? = $0.card { return s.contains { $0.slotId == fixture.slots.b } } else { return false } })
    let progressOut = try await output(call("get_progress", "{}"))
    XCTAssertEqual(progressOut["ok"], true, progressOut.jsonString())
    XCTAssertTrue(conversation.entries.contains { if case .progress(let p)? = $0.card { return p.programs.count == 1 } else { return false } })

    // prepare → card (nothing written yet) → explicit confirmation → commit.
    let prepareOut = try await output(call("prepare_reservation", #"{"slot_id":"\#(fixture.slots.b)"}"#))
    XCTAssertEqual(prepareOut["ok"], true, prepareOut.jsonString())
    let card = try XCTUnwrap(conversation.confirmation.state.card)
    XCTAssertEqual(card.intent, .reserve)
    XCTAssertEqual(card.slotId, fixture.slots.b)
    XCTAssertEqual(card.lessonTitle, "IT基礎・セキュリティ")
    XCTAssertEqual(card.teacherName, "田中 祥司")
    XCTAssertEqual(card.remainingSeats, 10)
    XCTAssertNotNil(card.scheduleLabel)
    XCTAssertTrue(card.prompt.hasSuffix("申請してよろしいですか？"), card.prompt)
    XCTAssertGreaterThan(card.expiresAt, Date())
    let before = try await student.send(API.reservations(ListQuery(slotId: fixture.slots.b))).value.items
    XCTAssertTrue(before.isEmpty, "prepare writes nothing")
    log("prepare_reservation → card「\(card.prompt)」 \(card.scheduleLabel ?? "")")

    await conversation.confirmByButton()
    guard case .committed(_, let message) = conversation.confirmation.state else {
      return XCTFail("commit: \(conversation.confirmation.state)")
    }
    // The button result was handed to the model (system message + response.create); it finishes answering.
    XCTAssertTrue(sink.events.contains { $0.json["item"]?["role"] == "system" })
    conversation.handle(.responseDone(responseId: nil, status: "completed", functionCalls: []))
    let booked = try await student.send(API.reservations(ListQuery(slotId: fixture.slots.b))).value.items
    XCTAssertEqual(booked.count, 1, "exactly one reservation")
    XCTAssertEqual(booked.first?.status, .pending)
    XCTAssertFalse(message.contains("確定"))
    log("commit_reservation (button) → 「\(message)」; GET /reservations?slot_id=B → exactly 1 (pending)")

    // A second prepare for the same slot is a business failure (success:false), never a card.
    conversation.dismissConfirmationResult()
    let again = try await output(call("prepare_reservation", #"{"slot_id":"\#(fixture.slots.b)"}"#))
    XCTAssertEqual(again["ok"], false)
    XCTAssertEqual(again["code"], "ALREADY_RESERVED")
    XCTAssertEqual(conversation.confirmation.state, .none)
    log("prepare_reservation again → success:false ALREADY_RESERVED「\(again["message_ja"]?.stringValue ?? "")」")

    // get_reservations, then cancel by voice (prepare_cancellation → confirm by utterance → model commit).
    let listOut = try await output(call("get_reservations", "{}"))
    XCTAssertEqual(listOut["ok"], true)
    XCTAssertTrue(conversation.entries.contains { if case .reservations(let r)? = $0.card { return r.contains { $0.reservationId == booked[0].id } } else { return false } })
    let cancelOut = try await output(call("prepare_cancellation", #"{"reservation_id":"\#(booked[0].id)"}"#))
    XCTAssertEqual(cancelOut["ok"], true, cancelOut.jsonString())
    let cancelCard = try XCTUnwrap(conversation.confirmation.state.card)
    XCTAssertEqual(cancelCard.intent, .cancel)
    XCTAssertEqual(cancelCard.reservationId, booked[0].id)
    XCTAssertEqual(cancelCard.statusLabel, "承認待ち")
    XCTAssertNotNil(cancelCard.cancelDeadline)
    conversation.handle(.inputTranscriptCompleted(itemId: "u1", transcript: "はい、取り消して"))
    let commitOut = try await output(call("commit_cancellation", #"{"action_token":"\#(cancelCard.actionToken)"}"#))
    XCTAssertEqual(commitOut["ok"], true, commitOut.jsonString())
    let cancelled = try await student.send(API.reservation(id: booked[0].id)).value
    XCTAssertEqual(cancelled.status, .cancelled)
    log("prepare_cancellation → card (status_ja=\(cancelCard.statusLabel ?? "-")); 「はい、取り消して」 + commit_cancellation → cancelled")

    // The used token cannot be replayed under a new call id.
    let replay = try await output(call("commit_cancellation", #"{"action_token":"\#(cancelCard.actionToken)"}"#))
    XCTAssertEqual(replay["ok"], false, "the bridge refuses a commit without a fresh confirmation")
  }

  private func slotDate(_ slotId: String) async throws -> String {
    let slot = try await client(fixture.student).send(API.lessonSlot(id: slotId)).value.data
    return OrgCalendar.tokyo.localDate(of: slot.startsAt).isoString
  }
}
