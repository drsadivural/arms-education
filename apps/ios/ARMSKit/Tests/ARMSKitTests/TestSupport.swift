import Foundation
import XCTest

@testable import ARMSKit

let testBaseURL = URL(string: "https://api.example.test/api/v1")!

/// 2026-10-02 11:00 JST (Friday).
let fixedNow = ISO8601.parse("2026-10-02T02:00:00Z")!

/// Scripted HTTP transport that records every request.
final class MockTransport: HTTPTransport, @unchecked Sendable {
  typealias Handler = @Sendable (HTTPRequest, Int) throws -> HTTPResponse

  private struct Route {
    let method: HTTPMethod
    let path: String
    let handler: Handler
  }

  private let lock = NSLock()
  private var routes: [Route] = []
  private var callCounts: [String: Int] = [:]
  private var recorded: [HTTPRequest] = []

  var requests: [HTTPRequest] {
    lock.lock()
    defer { lock.unlock() }
    return recorded
  }

  func requests(_ method: HTTPMethod, _ path: String) -> [HTTPRequest] {
    requests.filter { $0.method == method && Self.apiPath($0.url) == path }
  }

  /// Registers a handler for `METHOD /path` (path relative to `/api/v1`, without query).
  func on(_ method: HTTPMethod, _ path: String, _ handler: @escaping Handler) {
    lock.lock()
    defer { lock.unlock() }
    routes.insert(Route(method: method, path: path, handler: handler), at: 0)
  }

  func on(_ method: HTTPMethod, _ path: String, status: Int = 200, json: String, headers: [String: String] = [:]) {
    on(method, path) { _, _ in HTTPResponse(status: status, headers: headers, body: Data(json.utf8)) }
  }

  func on(_ method: HTTPMethod, _ path: String, error: TransportError) {
    on(method, path) { _, _ in throw error }
  }

  static func apiPath(_ url: URL) -> String {
    let p = url.path
    return p.hasPrefix("/api/v1") ? String(p.dropFirst("/api/v1".count)) : p
  }

  func send(_ request: HTTPRequest) async throws(TransportError) -> HTTPResponse {
    let path = Self.apiPath(request.url)
    let route: Route? = lock.withLock {
      recorded.append(request)
      let key = "\(request.method.rawValue) \(path)"
      callCounts[key, default: 0] += 1
      return routes.first { $0.method == request.method && ($0.path == path || $0.path == request.url.absoluteString) }
    }
    let count = lock.withLock { callCounts["\(request.method.rawValue) \(path)"] ?? 1 }
    guard let route else {
      return HTTPResponse(
        status: 404, body: Data(#"{"code":"NOT_FOUND","message_ja":"対象が見つかりません。","request_id":"req-missing"}"#.utf8))
    }
    do {
      return try route.handler(request, count)
    } catch let error as TransportError {
      throw error
    } catch {
      throw .other("handler")
    }
  }
}

/// Access token provider with scripted refresh behaviour.
final class StubTokens: AuthService, @unchecked Sendable {
  private let lock = NSLock()
  var token = "access-token-1"
  var refreshedToken = "access-token-2"
  var refreshShouldFail = false
  var refreshCount = 0
  var signedIn = true
  var signInError: ARMSError?
  var signInCount = 0
  var signOutCount = 0

  func accessToken() async throws -> String {
    try lock.withLock {
      guard signedIn else { throw ARMSError.notSignedIn }
      return token
    }
  }

  func refreshAccessToken() async throws -> String {
    try lock.withLock {
      refreshCount += 1
      if refreshShouldFail { throw ARMSError.auth(.sessionMissing) }
      token = refreshedToken
      return token
    }
  }

  func signIn(email: String, password: String) async throws {
    try lock.withLock {
      signInCount += 1
      if let signInError { throw signInError }
      signedIn = true
    }
  }

  func signOut() async {
    lock.withLock {
      signOutCount += 1
      signedIn = false
    }
  }

  func hasStoredSession() async -> Bool {
    lock.withLock { signedIn }
  }
}

/// Records requested delays without sleeping.
final class RecordingSleeper: Sleeper, @unchecked Sendable {
  private let lock = NSLock()
  private var recorded: [TimeInterval] = []
  var delays: [TimeInterval] {
    lock.lock()
    defer { lock.unlock() }
    return recorded
  }

  func sleep(seconds: TimeInterval) async throws {
    lock.withLock { recorded.append(seconds) }
    await Task.yield()
  }
}

struct FixedRandom: RandomSource {
  let value: Double
  func next() -> Double { value }
}

/// Mutable clock for MainActor tests.
@MainActor
final class TestClock {
  var now: Date
  init(_ now: Date = fixedNow) { self.now = now }
  func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
}

final class SessionExpiryFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = 0
  func increment() {
    lock.lock()
    value += 1
    lock.unlock()
  }
  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

func makeClient(
  _ transport: MockTransport, tokens: StubTokens = StubTokens(), sleeper: RecordingSleeper = RecordingSleeper(),
  expired: SessionExpiryFlag? = nil, organization: OrganizationSelection = OrganizationSelection()
) -> APIClient {
  APIClient(
    baseURL: testBaseURL, transport: transport, tokens: tokens, organization: organization, retryPolicy: .default,
    sleeper: sleeper, random: FixedRandom(value: 0.5),
    onSessionExpired: { expired?.increment() })
}

@MainActor
func makeContext(
  _ transport: MockTransport, me: Me? = Fixtures.studentMe, clock: TestClock? = nil, tokens: StubTokens = StubTokens(),
  cache: InMemoryResponseCache = InMemoryResponseCache(), keyValues: InMemoryKeyValueStore = InMemoryKeyValueStore()
) -> AppContext {
  let clock = clock ?? TestClock()
  let context = AppContext(
    api: makeClient(transport, tokens: tokens), cache: cache, keyValues: keyValues, now: { clock.now })
  if let me { context.setMe(me) }
  return context
}

func body(_ request: HTTPRequest) -> JSONValue? {
  request.body.flatMap { try? JSONValue(jsonData: $0) }
}

/// Waits until `condition` holds (for work started with `Task {}` inside the system under test).
@MainActor
func waitUntil(timeout: TimeInterval = 2, _ condition: () -> Bool) async {
  let deadline = Date().addingTimeInterval(timeout)
  while !condition(), Date() < deadline {
    try? await Task.sleep(nanoseconds: 5_000_000)
  }
}

enum Fixtures {
  static let studentId = "11111111-1111-4111-8111-111111111111"
  static let teacherId = "22222222-2222-4222-8222-222222222222"
  static let classroomId = "33333333-3333-4333-8333-333333333333"
  static let orgId = "44444444-4444-4444-8444-444444444444"
  static let slotId = "55555555-5555-4555-8555-555555555555"
  static let reservationId = "66666666-6666-4666-8666-666666666666"
  static let unitId = "77777777-7777-4777-8777-777777777777"
  static let materialId = "88888888-8888-4888-8888-888888888888"

  static func meJSON(role: String = "student", theme: String = "system", rowVersion: Int = 0, active: Bool = true) -> String {
    let student =
      role == "student"
      ? """
      {"employee_number":"E001","classroom_id":"\(classroomId)","classroom_name":"新入社員Aクラス","teacher_id":"\(teacherId)","teacher_name":"田中 祥司","department_name":"開発部"}
      """ : "null"
    return """
      {"data":{"id":"\(role == "teacher" ? teacherId : studentId)","display_name":"\(role == "teacher" ? "田中 祥司" : "和田 一夫")","email":"wada@example.invalid","role":"\(role)","active":\(active),
      "organization":{"id":"\(orgId)","name":"H&A研修センター","timezone":"Asia/Tokyo"},
      "preferences":{"theme":"\(theme)","notifications_enabled":true,"row_version":\(rowVersion)},
      "student":\(student),"mfa":{"required":false,"verified":false}},"checked_at":"2026-10-02T02:00:00.000Z"}
      """
  }

  static var studentMe: Me {
    try! ARMSJSON.decoder.decode(DataEnvelope<Me>.self, from: Data(meJSON().utf8)).data
  }

  static var teacherMe: Me {
    try! ARMSJSON.decoder.decode(DataEnvelope<Me>.self, from: Data(meJSON(role: "teacher").utf8)).data
  }

  static func slotJSON(
    id: String = slotId, title: String = "IT基礎・セキュリティ", startsAt: String = "2026-10-05T05:00:00.000Z",
    endsAt: String = "2026-10-05T06:30:00.000Z", closesAt: String = "2026-10-04T05:00:00.000Z", remaining: Int = 3,
    state: String = "open", myReservation: String = "null", meetingUrl: String = "null", hasMeeting: Bool = true,
    unitId: String? = Fixtures.unitId
  ) -> String {
    """
    {"id":"\(id)","classroom_id":"\(classroomId)","teacher_id":"\(teacherId)","unit_id":\(unitId.map { "\"\($0)\"" } ?? "null"),"title":"\(title)",
    "starts_at":"\(startsAt)","ends_at":"\(endsAt)","capacity":10,"booking_closes_at":"\(closesAt)","meeting_url":\(meetingUrl),
    "has_meeting_url":\(hasMeeting),"cancel_before_seconds":86400,"teacher_name":"田中 祥司","classroom_name":"新入社員Aクラス",
    "remaining":\(remaining),"pending_count":1,"approved_count":6,"state":"\(state)","my_reservation":\(myReservation),"row_version":1}
    """
  }

  static func slot(_ json: String = slotJSON()) -> LessonSlot {
    try! ARMSJSON.decoder.decode(LessonSlot.self, from: Data(json.utf8))
  }

  static func reservationJSON(
    id: String = reservationId, status: String = "pending", slotId: String = Fixtures.slotId,
    studentId: String = Fixtures.studentId, studentName: String = "和田 一夫",
    startsAt: String = "2026-10-05T05:00:00.000Z", endsAt: String = "2026-10-05T06:30:00.000Z",
    expiresAt: String = "2026-10-03T02:00:00.000Z", rowVersion: Int = 1, reason: String = "null",
    meetingUrl: String = "null", cancelDeadline: String? = "2026-10-04T05:00:00.000Z", history: String = "[]"
  ) -> String {
    """
    {"id":"\(id)","slot_id":"\(slotId)","student_id":"\(studentId)","status":"\(status)","starts_at":"\(startsAt)","ends_at":"\(endsAt)",
    "expires_at":"\(expiresAt)","row_version":\(rowVersion),"reason":\(reason),"student_name":"\(studentName)","employee_number":"E001",
    "slot_title":"IT基礎・セキュリティ","teacher_id":"\(teacherId)","teacher_name":"田中 祥司","classroom_id":"\(classroomId)",
    "classroom_name":"新入社員Aクラス","meeting_url":\(meetingUrl),\(cancelDeadline.map { "\"cancel_deadline\":\"\($0)\"," } ?? "")
    "created_at":"2026-10-02T05:20:00.000Z","updated_at":"2026-10-02T05:20:00.000Z","history":\(history),"checked_at":"2026-10-02T02:00:00.000Z"}
    """
  }

  static func reservation(_ json: String = reservationJSON()) -> Reservation {
    try! ARMSJSON.decoder.decode(Reservation.self, from: Data(json.utf8))
  }

  static func page(_ items: [String], next: String? = nil) -> String {
    """
    {"items":[\(items.joined(separator: ","))],"next_cursor":\(next.map { "\"\($0)\"" } ?? "null"),"checked_at":"2026-10-02T02:00:00.000Z"}
    """
  }

  static let enrollmentId = "99999999-0000-4000-8000-000000000001"
  static let programVersionId = "99999999-0000-4000-8000-000000000002"

  /// One `UnitProgress` exactly as `readStudentProgress` (services/api/src/domain/progress.ts) emits it.
  static func unitJSON(
    id: String, title: String, state: String, score: String = "null", requiresReview: Bool = false,
    feedback: String = "null", position: Int = 0, required: Bool = true, completedAt: String = "null",
    materialsTotal: Int = 0, materialsConfirmed: Int = 0, quizPassed: String = "null", submissionState: String = "null",
    attendanceRequired: Bool = false, attendanceSatisfied: Bool = false
  ) -> String {
    """
    {"id":"\(id)","title":"\(title)","state":"\(state)","weight":1,"score":\(score),"requires_review":\(requiresReview),"feedback":\(feedback),
    "enrollment_id":"\(enrollmentId)","program_version_id":"\(programVersionId)","program_name":"新入社員基礎研修","position":\(position),
    "required":\(required),"completed_at":\(completedAt),"materials_total":\(materialsTotal),"materials_confirmed":\(materialsConfirmed),
    "quiz_passed":\(quizPassed),"submission_state":\(submissionState),"attendance_required":\(attendanceRequired),
    "attendance_satisfied":\(attendanceSatisfied)}
    """
  }

  static func progressJSON(percent: String = "76", units: String? = nil, overdue: Bool = false) -> String {
    let u =
      units
      ?? "["
      + [
        unitJSON(
          id: "u1", title: "ビジネスマナー", state: "completed", score: "92", requiresReview: true, position: 0,
          completedAt: #""2026-10-01T05:00:00.000Z""#, materialsTotal: 2, materialsConfirmed: 2, quizPassed: "true",
          submissionState: #""accepted""#),
        unitJSON(
          id: "u2", title: "IT基礎・セキュリティ", state: "completed", score: "88", position: 1,
          completedAt: #""2026-10-01T06:00:00.000Z""#, quizPassed: "true"),
        unitJSON(
          id: "u3", title: "実践課題", state: "review_pending", requiresReview: true, position: 2,
          submissionState: #""submitted""#),
        unitJSON(id: "u4", title: "研修振り返り", state: "not_started", position: 3, materialsTotal: 1),
      ].joined(separator: ",") + "]"
    return """
      {"student_id":"\(studentId)","student_name":"和田 一夫","progress_percent":\(percent),"required_total":8,"required_completed":6,"units":\(u),
      "enrollments":[{"enrollment_id":"\(enrollmentId)","program_id":"99999999-0000-4000-8000-000000000003","program_name":"新入社員基礎研修",
      "program_version_id":"\(programVersionId)","version_number":2,"due_on":"2026-12-25","overdue":\(overdue),"progress_percent":\(percent),
      "required_total":8,"required_completed":6}],
      "checked_at":"2026-10-02T02:20:00.000Z"}
      """
  }

  /// `Material` as `materialDto` emits it (learner view when `learner` is given).
  static func materialJSON(
    id: String, title: String, kind: String, scanState: String = "clean", published: Bool = true,
    sizeBytes: String = "1", externalUrl: String = "null", questionCount: String = "null", learner: String? = nil,
    description: String = ""
  ) -> String {
    """
    {"id":"\(id)","unit_id":"\(unitId)","program_version_id":"\(programVersionId)","title":"\(title)","description":"\(description)",
    "kind":"\(kind)","required":true,"scan_state":"\(scanState)","published":\(published),"size_bytes":\(sizeBytes),"row_version":1,
    "external_url":\(externalUrl),"upload_id":null,"filename":null,"content_type":null,"question_count":\(questionCount)\(learner.map { #","learner_status":\#($0)"# } ?? "")}
    """
  }

  /// `Submission` as `submissionDto` emits it.
  static func submissionJSON(
    id: String, studentId: String = Fixtures.studentId, state: String = "submitted", body: String = "業務改善の提案",
    feedback: String = "null", rowVersion: Int = 1, submittedAt: String = "2026-10-02T00:20:00.000Z",
    hasFile: Bool = false, scanState: String = "not_applicable"
  ) -> String {
    """
    {"id":"\(id)","material_id":"m4","student_id":"\(studentId)","state":"\(state)","body":"\(body)","scan_state":"\(scanState)",
    "feedback":\(feedback),"row_version":\(rowVersion),"submitted_at":"\(submittedAt)","student_name":"和田 一夫",
    "material_title":"業務改善レポート","unit_id":"\(unitId)","unit_title":"実践課題","has_file":\(hasFile),
    "filename":\(hasFile ? #""report.pdf""# : "null"),"reviewed_at":null,"reviewer_name":null}
    """
  }

  static func errorJSON(_ code: String, _ message: String, requestId: String = "req-1", extra: String = "") -> String {
    #"{"code":"\#(code)","message_ja":"\#(message)","request_id":"\#(requestId)"\#(extra)}"#
  }

  static func actionJSON(_ data: String = "null") -> String {
    data == "null"
      ? #"{"success":true,"checked_at":"2026-10-02T02:00:00.000Z"}"#
      : #"{"success":true,"checked_at":"2026-10-02T02:00:00.000Z","data":\#(data)}"#
  }
}
