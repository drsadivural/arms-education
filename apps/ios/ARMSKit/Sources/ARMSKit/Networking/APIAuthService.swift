import Foundation

/// Email/password sign-in against ARMS's own authentication (PostgreSQL-backed; no external identity provider).
///
/// - `POST /auth/tokens` → opaque access token (1 h) + refresh token; the role is checked afterwards with `GET /me`.
/// - `POST /auth/tokens/refresh` rotates both tokens. The server ends the session when a rotated-away refresh token
///   is presented again, so refreshes are single-flight: concurrent callers wait for the same request.
/// - `POST /auth/tokens/revoke` signs this device out (best effort; local tokens are always cleared).
/// Tokens are persisted in `TokenStore` (the Keychain in the app). Only the access token is ever sent to the
/// business API (`Authorization: Bearer`).
public actor APIAuthService: AuthService {
  struct StoredSession: Codable, Equatable {
    var accessToken: String
    var refreshToken: String
    var accessExpiresAt: Date
    var sessionExpiresAt: Date
    var userId: String
  }

  static let storageKey = "arms.auth.session"
  /// Refresh this long before the access token expires.
  static let refreshMargin: TimeInterval = 60

  /// The same API base as `APIClient` (…/api/v1).
  private let baseURL: URL
  private let transport: any HTTPTransport
  private let store: any TokenStore
  private let deviceLabel: String?
  private let now: @Sendable () -> Date
  private var refreshing: Task<StoredSession, any Error>?
  /// Bumped by sign-in and sign-out. A refresh started under an older generation discards its result, so a response
  /// that arrives after sign-out can never write a session back (cancelling the task does not stop the request).
  private var generation = 0

  public init(
    baseURL: URL, transport: any HTTPTransport, store: any TokenStore, deviceLabel: String? = nil,
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.baseURL = baseURL
    self.transport = transport
    self.store = store
    self.deviceLabel = deviceLabel
    self.now = now
  }

  // MARK: AuthService

  public func signIn(email: String, password: String) async throws {
    var body = ["email": email, "password": password]
    if let deviceLabel, !deviceLabel.isEmpty { body["device_label"] = String(deviceLabel.prefix(100)) }
    let response: HTTPResponse
    do {
      response = try await post("/auth/tokens", body)
    } catch {
      throw error == .cancelled ? ARMSError.cancelled : ARMSError.auth(.network)
    }
    guard response.status == 200 else { throw Self.signInError(response) }
    generation += 1
    refreshing = nil
    try save(try decodeSession(response))
  }

  public func signOut() async {
    let session = load()
    generation += 1
    clear()
    refreshing?.cancel()
    refreshing = nil
    if let session {
      // Best effort: the session also ends on the server after 30 idle days.
      _ = try? await post("/auth/tokens/revoke", ["refresh_token": session.refreshToken])
    }
  }

  public func hasStoredSession() async -> Bool {
    guard let session = load() else { return false }
    return session.sessionExpiresAt > now()
  }

  public func accessToken() async throws -> String {
    guard let session = load() else { throw ARMSError.notSignedIn }
    if session.accessExpiresAt.timeIntervalSince(now()) > Self.refreshMargin { return session.accessToken }
    return try await refreshAccessToken()
  }

  public func refreshAccessToken() async throws -> String {
    if let running = refreshing { return try await running.value.accessToken }
    guard let session = load() else { throw ARMSError.notSignedIn }
    let started = generation
    let task = Task { try await self.performRefresh(session, generation: started) }
    refreshing = task
    defer { if generation == started { refreshing = nil } }
    return try await task.value.accessToken
  }

  // MARK: Internals

  private func performRefresh(_ session: StoredSession, generation started: Int) async throws -> StoredSession {
    let response: HTTPResponse
    do {
      response = try await post("/auth/tokens/refresh", ["refresh_token": session.refreshToken])
    } catch {
      // Network problems keep the session (offline mode); the request can be retried later.
      throw APIClient.map(error)
    }
    // Signed out (or signed in again) while the request was in flight: the result belongs to an ended session.
    guard generation == started else { throw ARMSError.notSignedIn }
    if response.status == 200 {
      let fresh = try decodeSession(response)
      try save(fresh)
      return fresh
    }
    if response.status == 401 || response.status == 403 {
      // Expired, revoked (sign-out elsewhere, password reset, account stopped) or reused: sign in again.
      clear()
      throw ARMSError.notSignedIn
    }
    throw APIClient.decodeError(response)
  }

  private func post(_ path: String, _ body: [String: String]) async throws(TransportError) -> HTTPResponse {
    let url = baseURL.appendingPathComponent(String(path.dropFirst()))
    let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
    let request = HTTPRequest(
      url: url, method: .post,
      headers: ["Content-Type": "application/json", "Accept": "application/json", "Accept-Language": "ja-JP"],
      body: data, timeout: 20)
    return try await transport.send(request)
  }

  private struct TokenResponse: Decodable {
    struct Pair: Decodable {
      let access_token: String
      let refresh_token: String
      let expires_in: Double
      let refresh_expires_at: String
      let user_id: String
    }
    let data: Pair
  }

  private func decodeSession(_ response: HTTPResponse) throws -> StoredSession {
    guard let decoded = try? JSONDecoder().decode(TokenResponse.self, from: response.body),
      let sessionExpiresAt = Self.parseInstant(decoded.data.refresh_expires_at)
    else { throw ARMSError.decoding("token response") }
    let pair = decoded.data
    return StoredSession(
      accessToken: pair.access_token, refreshToken: pair.refresh_token,
      accessExpiresAt: now().addingTimeInterval(pair.expires_in), sessionExpiresAt: sessionExpiresAt, userId: pair.user_id)
  }

  static func parseInstant(_ text: String) -> Date? {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFraction.date(from: text) { return date }
    return ISO8601DateFormatter().date(from: text)
  }

  static func signInError(_ response: HTTPResponse) -> ARMSError {
    let error = APIClient.decodeError(response)
    switch error.code {
    case "INVALID_CREDENTIALS": return .auth(.invalidCredentials)
    case "ACCOUNT_DISABLED": return .auth(.accountDisabled)
    // RATE_LIMITED carries the lockout explanation from the server; other codes keep the server's message too.
    default: return error
    }
  }

  private func load() -> StoredSession? {
    guard let data = try? store.data(forKey: Self.storageKey) else { return nil }
    return try? JSONDecoder().decode(StoredSession.self, from: data)
  }

  private func save(_ session: StoredSession) throws {
    do {
      try store.set(try JSONEncoder().encode(session), forKey: Self.storageKey)
    } catch {
      throw ARMSError.local(code: "KEYCHAIN_FAILED", messageJa: "ログイン情報を端末に保存できませんでした。端末を再起動してから再度お試しください。")
    }
  }

  private func clear() {
    try? store.removeValue(forKey: Self.storageKey)
  }
}
