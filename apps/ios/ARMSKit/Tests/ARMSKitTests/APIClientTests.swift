import Foundation
import XCTest

@testable import ARMSKit

final class APIClientTests: XCTestCase {
  func testGetSendsBearerAndNoCookieOrCSRF() async throws {
    let t = MockTransport()
    t.on(.get, "/me", json: Fixtures.meJSON())
    let client = makeClient(t)
    let response = try await client.send(API.me(selectedRole: .student))
    XCTAssertEqual(response.value.data.role, .student)
    let request = try XCTUnwrap(t.requests.first)
    XCTAssertEqual(request.url.absoluteString, "https://api.example.test/api/v1/me")
    XCTAssertEqual(request.header("Authorization"), "Bearer access-token-1")
    XCTAssertEqual(request.header("X-ARMS-Selected-Role"), "student")
    XCTAssertEqual(request.header("Accept-Language"), "ja-JP")
    XCTAssertNil(request.header("Cookie"))
    XCTAssertNil(request.header("X-CSRF-Token"))
    XCTAssertNil(request.header("Idempotency-Key"))
    XCTAssertNil(request.header("X-ARMS-Org"))
  }

  func testOrganizationHeaderWhenSelected() async throws {
    let t = MockTransport()
    t.on(.get, "/me", json: Fixtures.meJSON())
    let org = OrganizationSelection(Fixtures.orgId)
    _ = try await makeClient(t, organization: org).send(API.me(selectedRole: nil))
    XCTAssertEqual(t.requests.first?.header("X-ARMS-Org"), Fixtures.orgId)
    XCTAssertNil(t.requests.first?.header("X-ARMS-Selected-Role"))
  }

  func testQueryEncoding() async throws {
    let t = MockTransport()
    t.on(.get, "/lesson-slots", json: Fixtures.page([]))
    _ = try await makeClient(t).send(
      API.lessonSlots(ListQuery(limit: 500, q: " IT + 基礎 ", month: YearMonth("2026-10"))))
    let url = try XCTUnwrap(t.requests.first?.url)
    let comps = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
    let items = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).map { ($0.name, $0.value ?? "") })
    XCTAssertEqual(items["limit"], "100")  // clamped to the contract maximum
    XCTAssertEqual(items["month"], "2026-10")
    XCTAssertEqual(items["q"], "IT + 基礎")
    XCTAssertTrue(url.absoluteString.contains("%2B"))
  }

  func testFinalContractQueriesAndPaths() {
    func query(_ items: [QueryItem]) -> [String: String] { Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value) }) }
    let key = IdempotencyKey()
    let reservations = API.reservations(
      ListQuery(
        status: ListQuery.statuses([.pending, .approved]), idempotencyKey: key, slotId: Fixtures.slotId, sort: "-created_at"))
    XCTAssertEqual(
      query(reservations.query),
      ["status": "pending,approved", "idempotency_key": key.value, "slot_id": Fixtures.slotId, "sort": "-created_at"])
    XCTAssertEqual(query(API.submissions(ListQuery(studentId: "s", state: "submitted")).query), ["student_id": "s", "state": "submitted"])
    XCTAssertEqual(query(API.notifications(ListQuery(limit: 30, status: "unread")).query), ["limit": "30", "status": "unread"])
    XCTAssertEqual(API.attendanceRoster(slotId: Fixtures.slotId).path, "/lesson-slots/\(Fixtures.slotId)/attendance")
    XCTAssertEqual(API.lessonSlot(id: Fixtures.slotId).path, "/lesson-slots/\(Fixtures.slotId)")
    XCTAssertEqual(API.submissionFile(id: "S1").path, "/submissions/s1/file")
    XCTAssertEqual(API.markAllNotificationsRead().path, "/notifications/read-all")
    XCTAssertEqual(API.voiceQuota().path, "/voice/quota")
    let delete = API.unregisterDevice(tokenHash: String(repeating: "A", count: 64))
    XCTAssertEqual(delete.method, .delete)
    XCTAssertEqual(delete.path, "/devices/" + String(repeating: "a", count: 64))
    XCTAssertNil(delete.ifMatch, "device registrations are not versioned")
    XCTAssertNotNil(API.createUpload(UploadInput(filename: "a.pdf", contentType: "application/pdf", sizeBytes: 1, purpose: .assignment), key: key).idempotencyKey)
  }

  func testMutationHeadersIdempotencyAndCreatedStatus() async throws {
    let t = MockTransport()
    t.on(.post, "/reservations", status: 201, json: Fixtures.reservationJSON())
    let key = IdempotencyKey()
    let response = try await makeClient(t).send(API.createReservation(slotId: Fixtures.slotId, key: key))
    XCTAssertEqual(response.status, 201)
    XCTAssertEqual(response.value.status, .pending)
    let request = try XCTUnwrap(t.requests.first)
    XCTAssertEqual(request.header("Idempotency-Key"), key.value)
    XCTAssertEqual(request.header("Content-Type"), "application/json")
    XCTAssertEqual(body(request)?["slot_id"]?.stringValue, Fixtures.slotId)
    XCTAssertEqual(key.value, key.value.lowercased())
  }

  func testPatchSendsQuotedIfMatch() async throws {
    let t = MockTransport()
    t.on(.patch, "/me/preferences", json: Fixtures.actionJSON(#"{"row_version":4}"#), headers: ["ETag": "\"4\""])
    let response = try await makeClient(t).send(
      API.updatePreferences(PreferenceInput(theme: .dark, notificationsEnabled: true), rowVersion: 3))
    XCTAssertEqual(t.requests.first?.header("If-Match"), "\"3\"")
    XCTAssertEqual(response.etagVersion, 4)
  }

  func testErrorBodyIsDecodedWithJapaneseMessage() async {
    let t = MockTransport()
    t.on(
      .post, "/reservations", status: 409,
      json: Fixtures.errorJSON("SLOT_FULL", "この授業は満席です。", requestId: "req-42"))
    do {
      _ = try await makeClient(t).send(API.createReservation(slotId: Fixtures.slotId, key: IdempotencyKey()))
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error.code, "SLOT_FULL")
      XCTAssertEqual(error.messageJa, "この授業は満席です。")
      XCTAssertEqual(error.requestId, "req-42")
      XCTAssertEqual(error.httpStatus, 409)
      XCTAssertEqual(error.messageWithRequestId, "この授業は満席です。（問い合わせ番号: req-42）")
    }
    XCTAssertEqual(t.requests.count, 1, "409 is never retried")
  }

  func testFieldErrors() async {
    let t = MockTransport()
    t.on(
      .post, "/reservations/\(Fixtures.reservationId)/reject", status: 422,
      json: Fixtures.errorJSON("VALIDATION_FAILED", "入力内容を確認してください。", extra: #","field_errors":{"reason":"理由を入力してください"}"#))
    do {
      _ = try await makeClient(t).send(
        API.rejectReservation(id: Fixtures.reservationId, expectedVersion: 1, reason: "x", key: IdempotencyKey()))
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error.fieldErrors["reason"], "理由を入力してください")
    }
  }

  func testNonJSONErrorFallsBackToCatalog() async {
    let t = MockTransport()
    t.on(.get, "/me") { _, _ in
      HTTPResponse(status: 502, headers: ["X-Request-Id": "edge-1"], body: Data("<html>Bad gateway</html>".utf8))
    }
    do {
      _ = try await makeClient(t).send(API.me(selectedRole: nil))
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error.code, "INTERNAL")
      XCTAssertEqual(error.messageJa, "予期しないエラーが発生しました。時間をおいて再度お試しください。")
      XCTAssertEqual(error.requestId, "edge-1")
    }
  }

  func testRetries429WithRetryAfterReusingIdempotencyKey() async throws {
    let t = MockTransport()
    t.on(.post, "/reservations") { _, n in
      n < 3
        ? HTTPResponse(
          status: 429, headers: ["Retry-After": "2"],
          body: Data(Fixtures.errorJSON("RATE_LIMITED", "操作が多すぎます。しばらくしてから再度お試しください。").utf8))
        : HTTPResponse(status: 201, body: Data(Fixtures.reservationJSON().utf8))
    }
    let sleeper = RecordingSleeper()
    let key = IdempotencyKey()
    let response = try await makeClient(t, sleeper: sleeper).send(API.createReservation(slotId: Fixtures.slotId, key: key))
    XCTAssertEqual(response.status, 201)
    XCTAssertEqual(t.requests.count, 3)
    XCTAssertEqual(Set(t.requests.compactMap { $0.header("Idempotency-Key") }), [key.value])
    XCTAssertEqual(sleeper.delays, [2, 2])
  }

  func testRetries503WithJitteredBackoffThenGivesUp() async {
    let t = MockTransport()
    t.on(.get, "/today-lessons", status: 503, json: Fixtures.errorJSON("DB_UNAVAILABLE", "データベースに接続できません。変更は保存されていません。"))
    let sleeper = RecordingSleeper()
    do {
      _ = try await makeClient(t, sleeper: sleeper).send(API.todayLessons())
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error.code, "DB_UNAVAILABLE")
    }
    XCTAssertEqual(t.requests.count, 3)
    // base 0.5 s × 2^(n-1) × jitter 0.5
    XCTAssertEqual(sleeper.delays, [0.25, 0.5])
  }

  func testNotConfiguredIsNotRetried() async {
    let t = MockTransport()
    t.on(
      .post, "/devices", status: 503,
      json: Fixtures.errorJSON("NOT_CONFIGURED", "この機能は必要な外部サービスが未設定のため利用できません。管理者にお問い合わせください。"))
    let sleeper = RecordingSleeper()
    do {
      _ = try await makeClient(t, sleeper: sleeper).send(
        API.registerDevice(DeviceInput(token: "ab01", environment: .sandbox), key: IdempotencyKey()))
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error.code, "NOT_CONFIGURED")
    }
    XCTAssertEqual(t.requests.count, 1)
    XCTAssertTrue(sleeper.delays.isEmpty)
  }

  func testPresignedPutSendsOnlySignedHeaders() async throws {
    let t = MockTransport()
    let url = "https://r2.example.invalid/b/quarantine/o/k?X-Amz-Signature=s"
    t.on(.put, url) { _, n in
      if n == 1 { throw TransportError.connectionLost }
      return HTTPResponse(status: 200)
    }
    let ticket = UploadTicket(id: "u", uploadUrl: url, objectKey: "quarantine/o/k", expiresAt: fixedNow, requiredHeaders: ["Content-Type": "image/png"])
    try await makeClient(t, organization: OrganizationSelection("org-1")).putObject(ticket, body: Data([1, 2, 3]))
    XCTAssertEqual(t.requests.count, 2, "transport failure retried")
    let put = t.requests[1]
    XCTAssertEqual(put.method, .put)
    XCTAssertEqual(put.headers, ["Content-Type": "image/png"], "no Authorization / X-ARMS-Org on the storage URL")
    XCTAssertEqual(put.body, Data([1, 2, 3]))

    let expired = MockTransport()
    expired.on(.put, url) { _, _ in HTTPResponse(status: 403) }
    do {
      try await makeClient(expired).putObject(ticket, body: Data([1]))
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error.code, "UPLOAD_EXPIRED")
    }
    do {
      let insecure = UploadTicket(id: "u", uploadUrl: "http://r2.example.invalid/x", objectKey: "k", expiresAt: fixedNow, requiredHeaders: [:])
      try await makeClient(MockTransport()).putObject(insecure, body: Data([1]))
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error.code, "UPLOAD_FAILED")
    }
  }

  func testTimeoutRetriedOnlyForRetrySafeRequests() async {
    let t = MockTransport()
    t.on(.post, "/notifications/n1/read", error: .timedOut)
    let sleeper = RecordingSleeper()
    let client = makeClient(t, sleeper: sleeper)
    do {
      _ = try await client.send(API.markNotificationRead(id: "n1"))
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error, .timedOut)
      XCTAssertTrue(error.isConnectivity)
    }
    XCTAssertEqual(t.requests.count, 1, "POST without Idempotency-Key is not resent")

    let t2 = MockTransport()
    t2.on(.post, "/reservations") { _, n in
      if n == 1 { throw TransportError.connectionLost }
      return HTTPResponse(status: 201, body: Data(Fixtures.reservationJSON().utf8))
    }
    let key = IdempotencyKey()
    let ok = try? await makeClient(t2, sleeper: sleeper).send(API.createReservation(slotId: Fixtures.slotId, key: key))
    XCTAssertEqual(ok?.status, 201)
    XCTAssertEqual(t2.requests.map { $0.header("Idempotency-Key") }, [key.value, key.value])
  }

  func testOfflineIsNotRetried() async {
    let t = MockTransport()
    t.on(.get, "/me", error: .offline)
    do {
      _ = try await makeClient(t).send(API.me(selectedRole: nil))
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error, .offline)
      XCTAssertEqual(error.messageJa, "ネットワークに接続できません。通信環境を確認してから再度お試しください。")
    }
    XCTAssertEqual(t.requests.count, 1)
  }

  func test401RefreshesTokenOnceAndRetries() async throws {
    let t = MockTransport()
    t.on(.get, "/me") { request, _ in
      request.header("Authorization") == "Bearer access-token-2"
        ? HTTPResponse(status: 200, body: Data(Fixtures.meJSON().utf8))
        : HTTPResponse(status: 401, body: Data(Fixtures.errorJSON("UNAUTHENTICATED", "ログインが必要です。再度ログインしてください。").utf8))
    }
    let tokens = StubTokens()
    let expired = SessionExpiryFlag()
    let response = try await makeClient(t, tokens: tokens, expired: expired).send(API.me(selectedRole: .student))
    XCTAssertEqual(response.value.data.role, .student)
    XCTAssertEqual(tokens.refreshCount, 1)
    XCTAssertEqual(t.requests.count, 2)
    XCTAssertEqual(expired.count, 0)
  }

  func test401WithFailedRefreshExpiresSession() async {
    let t = MockTransport()
    t.on(.get, "/me", status: 401, json: Fixtures.errorJSON("SESSION_EXPIRED", "セッションの有効期限が切れました。再度ログインしてください。"))
    let tokens = StubTokens()
    tokens.refreshShouldFail = true
    let expired = SessionExpiryFlag()
    do {
      _ = try await makeClient(t, tokens: tokens, expired: expired).send(API.me(selectedRole: nil))
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error.code, "SESSION_EXPIRED")
      XCTAssertTrue(error.requiresSignIn)
    }
    XCTAssertEqual(expired.count, 1)
    XCTAssertEqual(t.requests.count, 1)
  }

  func testPublicEndpointHasNoAuthorization() async throws {
    let t = MockTransport()
    t.on(.post, "/auth/password-reset", json: Fixtures.actionJSON())
    let tokens = StubTokens()
    tokens.signedIn = false
    _ = try await makeClient(t, tokens: tokens).send(API.passwordReset(email: "wada@example.invalid"))
    XCTAssertNil(t.requests.first?.header("Authorization"))
  }

  func testNotSignedInFailsBeforeSending() async {
    let t = MockTransport()
    let tokens = StubTokens()
    tokens.signedIn = false
    let expired = SessionExpiryFlag()
    do {
      _ = try await makeClient(t, tokens: tokens, expired: expired).send(API.me(selectedRole: nil))
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error, .notSignedIn)
    }
    XCTAssertTrue(t.requests.isEmpty)
    XCTAssertEqual(expired.count, 1)
  }

  func testContractMismatchIsDecodingError() async {
    let t = MockTransport()
    t.on(.get, "/me", json: #"{"data":{"id":"x"},"checked_at":"2026-10-02T02:00:00Z"}"#)
    do {
      _ = try await makeClient(t).send(API.me(selectedRole: nil))
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error.code, "DECODING_FAILED")
    }
  }

  func testCollectAllFollowsCursor() async throws {
    let t = MockTransport()
    t.on(.get, "/students") { request, _ in
      let cursor = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value
      let item = #"{"id":"s\#(cursor ?? "0")","employee_number":"E","display_name":"A","kana":"","email":"a@example.invalid","company_name":"","department_name":"開発部","joined_on":"2026-10-01","classroom_id":"c","teacher_id":"t","training_starts_on":"2026-10-01","training_due_on":"2026-12-31","active":true,"row_version":1,"progress_percent":null}"#
      return HTTPResponse(status: 200, body: Data(Fixtures.page([item], next: cursor == nil ? "c1" : (cursor == "c1" ? "c2" : nil)).utf8))
    }
    let all = try await makeClient(t).collectAll(query: ListQuery(limit: 100), API.students)
    XCTAssertEqual(all.items.map(\.id), ["s0", "sc1", "sc2"])
    XCTAssertTrue(all.complete)
    let limited = try await makeClient(t).collectAll(maxPages: 2, query: ListQuery(), API.students)
    XCTAssertFalse(limited.complete)
  }

  func testRetryPolicyMath() {
    let p = RetryPolicy(maxAttempts: 4, baseDelay: 1, maxDelay: 5)
    XCTAssertEqual(p.delay(afterAttempt: 1, retryAfter: nil, random: 1), 1)
    XCTAssertEqual(p.delay(afterAttempt: 3, retryAfter: nil, random: 1), 4)
    XCTAssertEqual(p.delay(afterAttempt: 5, retryAfter: nil, random: 1), 5)
    XCTAssertEqual(p.delay(afterAttempt: 2, retryAfter: nil, random: 0), 0.05)
    XCTAssertEqual(p.delay(afterAttempt: 1, retryAfter: 30, random: 0.3), 5)
    XCTAssertEqual(RetryPolicy.parseRetryAfter(" 3 "), 3)
    XCTAssertNil(RetryPolicy.parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT"))
    XCTAssertEqual(RetryPolicy(maxAttempts: 0).maxAttempts, 1)
  }

  func testPathIdsAreEncoded() {
    XCTAssertEqual(API.reservation(id: "AB/../x").path, "/reservations/ab%2F%2E%2E%2Fx")
    XCTAssertEqual(API.reservation(id: Fixtures.reservationId.uppercased()).path, "/reservations/\(Fixtures.reservationId)")
  }

  func testIdempotencyKeyValidation() {
    XCTAssertNil(IdempotencyKey("not-a-uuid"))
    XCTAssertEqual(IdempotencyKey(Fixtures.slotId.uppercased())?.value, Fixtures.slotId)
    XCTAssertNotEqual(IdempotencyKey(), IdempotencyKey())
  }

  func testFileResponseCacheRoundTripAndWipe() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("armskit-cache-\(UUID().uuidString)")
    let cache = FileResponseCache(directory: dir)
    cache.storeValue(["a": 1], savedAt: fixedNow, forKey: "user/x?y=z")
    let loaded = cache.loadValue([String: Int].self, forKey: "user/x?y=z")
    XCTAssertEqual(loaded?.value, ["a": 1])
    XCTAssertEqual(loaded?.savedAt, fixedNow)
    XCTAssertFalse(FileResponseCache.fileName(for: "../etc").contains("/"))
    cache.removeAll()
    XCTAssertNil(cache.load(forKey: "user/x?y=z"))
  }

  func testRealtimeCallsClientSendsSDPWithEphemeralSecret() async throws {
    let t = MockTransport()
    t.on(.post, "https://api.openai.com/v1/realtime/calls") { request, _ in
      HTTPResponse(status: 201, body: Data("v=0\r\no=- answer\r\n".utf8))
    }
    let client = RealtimeCallsClient(transport: t)
    let answer = try await client.exchange(offerSDP: "v=0\r\no=- offer\r\n", clientSecret: "ek_test")
    XCTAssertTrue(answer.hasPrefix("v=0"))
    let request = try XCTUnwrap(t.requests.first)
    XCTAssertEqual(request.url.absoluteString, "https://api.openai.com/v1/realtime/calls")
    XCTAssertEqual(request.header("Authorization"), "Bearer ek_test")
    XCTAssertEqual(request.header("Content-Type"), "application/sdp")
    XCTAssertEqual(request.body.map { String(decoding: $0, as: UTF8.self) }, "v=0\r\no=- offer\r\n")
  }

  func testRealtimeCallsClientMapsProviderErrors() async {
    let t = MockTransport()
    t.on(.post, "https://api.openai.com/v1/realtime/calls", status: 401, json: #"{"error":{"message":"Invalid ephemeral key"}}"#)
    do {
      _ = try await RealtimeCallsClient(transport: t).exchange(offerSDP: "v=0", clientSecret: "ek_expired")
      XCTFail("expected error")
    } catch {
      XCTAssertEqual(error.code, "VOICE_UNAVAILABLE")
      XCTAssertEqual(error.messageJa, "現在、音声機能を利用できません。画面から操作してください。")
      XCTAssertFalse(error.messageJa.contains("ephemeral"))
    }
  }
}
