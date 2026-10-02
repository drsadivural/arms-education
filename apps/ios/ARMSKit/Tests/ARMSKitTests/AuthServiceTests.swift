import Foundation
import XCTest

@testable import ARMSKit

/// `APIAuthService` against a mock `/api/v1/auth/tokens*` (shapes from packages/contracts TokenResponse).
final class AuthServiceTests: XCTestCase {
  private let base = URL(string: "https://api.example.test/api/v1")!

  private func tokenJSON(_ n: Int, expiresIn: Int = 3600, sessionEnd: String = "2027-01-01T00:00:00.000Z") -> String {
    #"{"data":{"access_token":"arms_at_\#(n)","refresh_token":"arms_rt_\#(n)","token_type":"Bearer","expires_in":\#(expiresIn),"refresh_expires_at":"\#(sessionEnd)","user_id":"11111111-1111-4111-8111-111111111111"},"checked_at":"2026-10-03T00:00:00.000Z"}"#
  }

  private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var value = Date(timeIntervalSince1970: 1_790_000_000)
    var now: Date { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value = value.addingTimeInterval(seconds) } }
  }

  private func makeService(_ t: MockTransport, store: InMemoryTokenStore = InMemoryTokenStore(), clock: Clock = Clock()) -> APIAuthService {
    APIAuthService(baseURL: base, transport: t, store: store, deviceLabel: "iPhone テスト", now: { clock.now })
  }

  func testSignInStoresTokensAndSendsOnlyCredentials() async throws {
    let t = MockTransport()
    t.on(.post, "/auth/tokens", json: tokenJSON(1))
    let store = InMemoryTokenStore()
    let auth = makeService(t, store: store)
    try await auth.signIn(email: "taro@example.invalid", password: "Secret-2026")
    let token = try await auth.accessToken()
    XCTAssertEqual(token, "arms_at_1")
    let hasSession = await auth.hasStoredSession()
    XCTAssertTrue(hasSession)
    let request = try XCTUnwrap(t.requests.first)
    XCTAssertEqual(request.url.absoluteString, "https://api.example.test/api/v1/auth/tokens")
    XCTAssertNil(request.header("Authorization"))
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body ?? Data()) as? [String: String])
    XCTAssertEqual(body, ["email": "taro@example.invalid", "password": "Secret-2026", "device_label": "iPhone テスト"])
    XCTAssertEqual(store.keys, [APIAuthService.storageKey])
    // A valid token is reused without network traffic.
    _ = try await auth.accessToken()
    XCTAssertEqual(t.requests.count, 1)
  }

  func testSignInErrorsAreJapanese() async {
    let t = MockTransport()
    let auth = makeService(t)
    t.on(.post, "/auth/tokens", status: 401, json: #"{"code":"INVALID_CREDENTIALS","message_ja":"メールアドレスまたはパスワードが正しくありません。","request_id":"r1"}"#)
    await assertThrows(try await auth.signIn(email: "a@example.invalid", password: "x"), .auth(.invalidCredentials))
    t.on(.post, "/auth/tokens", status: 403, json: #"{"code":"ACCOUNT_DISABLED","message_ja":"このアカウントは利用できません。管理者にお問い合わせください。","request_id":"r2"}"#)
    await assertThrows(try await auth.signIn(email: "a@example.invalid", password: "x"), .auth(.accountDisabled))
    let locked = "ログインの失敗が続いたため、一時的にログインを制限しています。"
    t.on(.post, "/auth/tokens", status: 429, json: #"{"code":"RATE_LIMITED","message_ja":"\#(locked)","request_id":"r3"}"#)
    do {
      try await auth.signIn(email: "a@example.invalid", password: "x")
      XCTFail("expected an error")
    } catch let error as ARMSError {
      XCTAssertEqual(error.code, "RATE_LIMITED")
      XCTAssertEqual(error.messageJa, locked)
    } catch { XCTFail("\(error)") }
    t.on(.post, "/auth/tokens", error: .offline)
    await assertThrows(try await auth.signIn(email: "a@example.invalid", password: "x"), .auth(.network))
    let hasSession = await auth.hasStoredSession()
    XCTAssertFalse(hasSession)
  }

  func testRefreshRotatesOnceForConcurrentCallers() async throws {
    let t = MockTransport()
    let clock = Clock()
    t.on(.post, "/auth/tokens", json: tokenJSON(1))
    let refreshed = tokenJSON(2)
    t.on(.post, "/auth/tokens/refresh") { request, _ in
      let body = try JSONSerialization.jsonObject(with: request.body ?? Data()) as? [String: String]
      XCTAssertEqual(body?["refresh_token"], "arms_rt_1")
      Thread.sleep(forTimeInterval: 0.05)
      return HTTPResponse(status: 200, body: Data(refreshed.utf8))
    }
    let auth = makeService(t, clock: clock)
    try await auth.signIn(email: "a@example.invalid", password: "x")
    clock.advance(3600 - 30)  // within the refresh margin
    async let a = auth.accessToken()
    async let b = auth.accessToken()
    async let c = auth.refreshAccessToken()
    let tokens = try await [a, b, c]
    XCTAssertEqual(tokens, ["arms_at_2", "arms_at_2", "arms_at_2"])
    XCTAssertEqual(t.requests(.post, "/auth/tokens/refresh").count, 1)
  }

  func testRejectedRefreshSignsOutButOfflineKeepsTheSession() async throws {
    let t = MockTransport()
    t.on(.post, "/auth/tokens", json: tokenJSON(1))
    let auth = makeService(t)
    try await auth.signIn(email: "a@example.invalid", password: "x")
    t.on(.post, "/auth/tokens/refresh", error: .offline)
    await assertThrows(try await auth.refreshAccessToken(), .offline)
    var hasSession = await auth.hasStoredSession()
    XCTAssertTrue(hasSession)
    t.on(.post, "/auth/tokens/refresh", status: 401, json: #"{"code":"SESSION_EXPIRED","message_ja":"セッションの有効期限が切れました。再度ログインしてください。","request_id":"r"}"#)
    await assertThrows(try await auth.refreshAccessToken(), .notSignedIn)
    hasSession = await auth.hasStoredSession()
    XCTAssertFalse(hasSession)
    await assertThrows(try await auth.accessToken(), .notSignedIn)
  }

  func testSessionEndsAtTheServerDeadline() async throws {
    let t = MockTransport()
    let clock = Clock()
    t.on(.post, "/auth/tokens", json: tokenJSON(1, sessionEnd: "2026-09-21T15:13:20Z"))
    let auth = makeService(t, clock: clock)
    try await auth.signIn(email: "a@example.invalid", password: "x")
    var hasSession = await auth.hasStoredSession()
    XCTAssertTrue(hasSession)
    clock.advance(24 * 3600)
    hasSession = await auth.hasStoredSession()
    XCTAssertFalse(hasSession)
  }

  func testSignOutRevokesAndClearsEvenWhenOffline() async throws {
    let t = MockTransport()
    let store = InMemoryTokenStore()
    t.on(.post, "/auth/tokens", json: tokenJSON(1))
    t.on(.post, "/auth/tokens/revoke", json: #"{"success":true,"checked_at":"2026-10-03T00:00:00.000Z"}"#)
    let auth = makeService(t, store: store)
    try await auth.signIn(email: "a@example.invalid", password: "x")
    await auth.signOut()
    let revoke = try XCTUnwrap(t.requests(.post, "/auth/tokens/revoke").first)
    XCTAssertEqual(try JSONSerialization.jsonObject(with: revoke.body ?? Data()) as? [String: String], ["refresh_token": "arms_rt_1"])
    XCTAssertTrue(store.keys.isEmpty)
    try await auth.signIn(email: "a@example.invalid", password: "x")
    t.on(.post, "/auth/tokens/revoke", error: .offline)
    await auth.signOut()
    XCTAssertTrue(store.keys.isEmpty)
  }

  func testRefreshFinishingAfterSignOutDoesNotRestoreTheSession() async throws {
    let t = MockTransport()
    let store = InMemoryTokenStore()
    let clock = Clock()
    t.on(.post, "/auth/tokens", json: tokenJSON(1))
    t.on(.post, "/auth/tokens/revoke", json: #"{"success":true,"checked_at":"2026-10-03T00:00:00.000Z"}"#)
    let refreshed = tokenJSON(2)
    t.on(.post, "/auth/tokens/refresh") { _, _ in
      Thread.sleep(forTimeInterval: 0.2)  // the response arrives after the user signed out
      return HTTPResponse(status: 200, body: Data(refreshed.utf8))
    }
    let auth = makeService(t, store: store, clock: clock)
    try await auth.signIn(email: "a@example.invalid", password: "x")
    clock.advance(3600)
    async let pending: String = auth.accessToken()
    try await Task.sleep(nanoseconds: 50_000_000)
    await auth.signOut()
    do {
      _ = try await pending
      XCTFail("the refresh must not succeed after sign-out")
    } catch let error as ARMSError {
      XCTAssertEqual(error, .notSignedIn)
    }
    XCTAssertTrue(store.keys.isEmpty, "a late refresh response must not write a session back")
    let hasSession = await auth.hasStoredSession()
    XCTAssertFalse(hasSession)
  }

  private func assertThrows<T>(_ expression: @autoclosure () async throws -> T, _ expected: ARMSError, file: StaticString = #filePath, line: UInt = #line) async {
    do {
      _ = try await expression()
      XCTFail("expected \(expected)", file: file, line: line)
    } catch let error as ARMSError {
      XCTAssertEqual(error, expected, file: file, line: line)
    } catch {
      XCTFail("unexpected \(error)", file: file, line: line)
    }
  }
}
