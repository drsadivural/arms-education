import Foundation

/// Typed client for the ARMS Workers API.
///
/// - Authentication: `Authorization: Bearer <Supabase access token>` only (no cookies, no CSRF).
/// - Mutations carry the endpoint's `Idempotency-Key`; every automatic retry reuses it.
/// - PATCH carries `If-Match: "<row_version>"`.
/// - `429` / `503` are retried with exponential backoff + jitter (honouring `Retry-After`).
/// - Transport failures are retried only for retry-safe requests (GET or idempotency-keyed).
/// - A `401` triggers one token refresh and one resend; if that fails `onSessionExpired` fires.
public final class APIClient: Sendable {
  public let baseURL: URL
  private let transport: any HTTPTransport
  private let tokens: any AccessTokenProvider
  private let retryPolicy: RetryPolicy
  private let sleeper: any Sleeper
  private let random: any RandomSource
  public let organization: OrganizationSelection
  private let onSessionExpired: @Sendable () async -> Void

  public init(
    baseURL: URL,
    transport: any HTTPTransport,
    tokens: any AccessTokenProvider,
    organization: OrganizationSelection = OrganizationSelection(),
    retryPolicy: RetryPolicy = .default,
    sleeper: any Sleeper = TaskSleeper(),
    random: any RandomSource = SystemRandomSource(),
    onSessionExpired: @escaping @Sendable () async -> Void = {}
  ) {
    self.baseURL = baseURL
    self.transport = transport
    self.tokens = tokens
    self.organization = organization
    self.retryPolicy = retryPolicy
    self.sleeper = sleeper
    self.random = random
    self.onSessionExpired = onSessionExpired
  }

  /// Sends the request and decodes the success body.
  @discardableResult
  public func send<R>(_ endpoint: Endpoint<R>) async throws(ARMSError) -> APIResponse<R> {
    var attempt = 0
    var refreshedAfter401 = false
    while true {
      attempt += 1
      if Task.isCancelled { throw .cancelled }
      let request = try await buildRequest(endpoint)
      let response: HTTPResponse
      do {
        response = try await transport.send(request)
      } catch {
        let mapped = Self.map(error)
        if mapped == .cancelled { throw .cancelled }
        if endpoint.isRetrySafe, error != .offline, attempt < retryPolicy.maxAttempts {
          try await pause(attempt: attempt, retryAfter: nil)
          continue
        }
        throw mapped
      }

      if endpoint.successStatuses.contains(response.status) {
        return try decodeSuccess(endpoint, response)
      }

      let failure = Self.decodeError(response)
      if response.status == 401, endpoint.requiresAuth {
        if !refreshedAfter401 {
          refreshedAfter401 = true
          do {
            _ = try await tokens.refreshAccessToken()
            attempt -= 1  // The refresh round-trip does not consume a retry attempt.
            continue
          } catch {
            await onSessionExpired()
            throw failure
          }
        }
        await onSessionExpired()
        throw failure
      }
      if RetryPolicy.retryableStatuses.contains(response.status), attempt < retryPolicy.maxAttempts,
        !RetryPolicy.permanentCodes.contains(failure.code)
      {
        try await pause(attempt: attempt, retryAfter: RetryPolicy.parseRetryAfter(response.header("Retry-After")))
        continue
      }
      throw failure
    }
  }

  /// Uploads bytes to the presigned quarantine URL of `POST /uploads`. The URL itself is the
  /// credential (no Authorization / organisation headers); `required_headers` (Content-Type) are
  /// signed and must be sent unchanged, and the body length must equal the declared size.
  /// Transport failures are retried (a PUT of the same bytes to the same key is idempotent).
  public func putObject(_ ticket: UploadTicket, body: Data, timeout: TimeInterval = 120) async throws(ARMSError) {
    // https only; plain http is accepted solely for a loopback development stack.
    guard let url = URL(string: ticket.uploadUrl), let scheme = url.scheme?.lowercased(),
      scheme == "https" || (scheme == "http" && ["127.0.0.1", "localhost"].contains(url.host ?? ""))
    else {
      throw .local(code: "UPLOAD_FAILED", messageJa: APIClient.uploadFailedMessage)
    }
    // Content-Length (also signed) is set by the URL loading system from the body.
    let request = HTTPRequest(url: url, method: .put, headers: ticket.requiredHeaders, body: body, timeout: timeout)
    var attempt = 0
    while true {
      attempt += 1
      if Task.isCancelled { throw .cancelled }
      let response: HTTPResponse
      do {
        response = try await transport.send(request)
      } catch {
        let mapped = Self.map(error)
        if mapped == .cancelled { throw .cancelled }
        if error != .offline, attempt < retryPolicy.maxAttempts {
          try await pause(attempt: attempt, retryAfter: nil)
          continue
        }
        throw mapped
      }
      if (200..<300).contains(response.status) { return }
      if RetryPolicy.retryableStatuses.contains(response.status) || response.status >= 500, attempt < retryPolicy.maxAttempts {
        try await pause(attempt: attempt, retryAfter: RetryPolicy.parseRetryAfter(response.header("Retry-After")))
        continue
      }
      // 403 from object storage = the 15-minute signature expired (or the bytes did not match it).
      if response.status == 403 { throw .local(code: "UPLOAD_EXPIRED", messageJa: ErrorCatalog.message(for: "UPLOAD_EXPIRED")) }
      throw .local(code: "UPLOAD_FAILED", messageJa: APIClient.uploadFailedMessage)
    }
  }

  static let uploadFailedMessage = "ファイルをアップロードできませんでした。通信環境を確認して、もう一度お試しください。"

  // MARK: - Request building

  func url(for endpoint: Endpoint<some Decodable & Sendable>) throws(ARMSError) -> URL {
    guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
      throw .notConfigured("API_BASE_URL")
    }
    var basePath = components.path
    while basePath.hasSuffix("/") { basePath.removeLast() }
    components.path = basePath + endpoint.path
    if !endpoint.query.isEmpty {
      components.queryItems = endpoint.query.map { URLQueryItem(name: $0.name, value: $0.value) }
      // `+` is not encoded by URLComponents but would be decoded as a space by many servers.
      components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
    }
    guard let url = components.url else { throw .notConfigured("API_BASE_URL") }
    return url
  }

  func buildRequest<R>(_ endpoint: Endpoint<R>) async throws(ARMSError) -> HTTPRequest {
    var headers: [String: String] = [
      "Accept": "application/json",
      "Accept-Language": "ja-JP",
    ]
    if endpoint.requiresAuth {
      do {
        headers["Authorization"] = "Bearer \(try await tokens.accessToken())"
      } catch let error as ARMSError {
        // The stored session can no longer be refreshed: the user must sign in again.
        if error == .notSignedIn { await onSessionExpired() }
        throw error
      } catch {
        await onSessionExpired()
        throw .notSignedIn
      }
      if let org = organization.organizationId { headers["X-ARMS-Org"] = org }
    }
    if endpoint.body != nil { headers["Content-Type"] = "application/json" }
    if let key = endpoint.idempotencyKey { headers["Idempotency-Key"] = key.value }
    if let version = endpoint.ifMatch { headers["If-Match"] = "\"\(version)\"" }
    for (k, v) in endpoint.headers { headers[k] = v }
    return HTTPRequest(url: try url(for: endpoint), method: endpoint.method, headers: headers, body: endpoint.body)
  }

  private func pause(attempt: Int, retryAfter: TimeInterval?) async throws(ARMSError) {
    let delay = retryPolicy.delay(afterAttempt: attempt, retryAfter: retryAfter, random: random.next())
    do {
      try await sleeper.sleep(seconds: delay)
    } catch {
      throw .cancelled
    }
  }

  // MARK: - Response decoding

  private func decodeSuccess<R>(_ endpoint: Endpoint<R>, _ response: HTTPResponse) throws(ARMSError) -> APIResponse<R> {
    let requestId = response.header("X-Request-Id")
    let etag = APIResponse<R>.parseETag(response.header("ETag"))
    let body = response.body.isEmpty ? Data("{}".utf8) : response.body
    do {
      let value = try ARMSJSON.decoder.decode(R.self, from: body)
      return APIResponse(value: value, status: response.status, etagVersion: etag, requestId: requestId)
    } catch {
      throw .decoding("\(endpoint.method.rawValue) \(endpoint.path): \(Self.describe(error))")
    }
  }

  static func decodeError(_ response: HTTPResponse) -> ARMSError {
    if let body = try? ARMSJSON.decoder.decode(APIErrorBody.self, from: response.body), !body.code.isEmpty {
      return .api(body, status: response.status)
    }
    let code = ErrorCatalog.code(forStatus: response.status)
    let requestId = response.header("X-Request-Id") ?? ""
    return .api(
      APIErrorBody(code: code, messageJa: ErrorCatalog.message(for: code), requestId: requestId),
      status: response.status)
  }

  static func map(_ error: TransportError) -> ARMSError {
    switch error {
    case .offline: return .offline
    case .timedOut, .connectionLost: return .timedOut
    case .cancelled: return .cancelled
    case .other: return .offline
    }
  }

  static func describe(_ error: any Error) -> String {
    switch error {
    case DecodingError.keyNotFound(let key, let ctx):
      return "missing \(key.stringValue) at \(ctx.codingPath.map(\.stringValue).joined(separator: "."))"
    case DecodingError.typeMismatch(_, let ctx), DecodingError.valueNotFound(_, let ctx),
      DecodingError.dataCorrupted(let ctx):
      return "invalid value at \(ctx.codingPath.map(\.stringValue).joined(separator: ".")): \(ctx.debugDescription)"
    default:
      return String(describing: type(of: error))
    }
  }
}

/// Items gathered across pages by `collectAll`.
public struct Collected<T: Sendable>: Sendable {
  public let items: [T]
  public let checkedAt: Date
  /// False when `maxPages` was reached before the last page.
  public let complete: Bool
}

extension APIClient {
  /// Follows `next_cursor` until exhausted or `maxPages` is reached. Throws `ARMSError`.
  public func collectAll<T>(
    maxPages: Int = 10, query: ListQuery, _ make: @escaping @Sendable (ListQuery) -> Endpoint<Page<T>>
  ) async throws -> Collected<T> {
    var items: [T] = []
    var cursor: String? = nil
    var checkedAt: Date? = nil
    for _ in 0..<maxPages {
      let response = try await send(make(query.with(cursor: cursor)))
      items.append(contentsOf: response.value.items)
      if checkedAt == nil { checkedAt = response.value.checkedAt }
      guard let next = response.value.nextCursor, !next.isEmpty else {
        return Collected(items: items, checkedAt: checkedAt ?? Date(), complete: true)
      }
      cursor = next
    }
    return Collected(items: items, checkedAt: checkedAt ?? Date(), complete: false)
  }

  /// Like `collectAll`, packaged as one page carrying the first page's `checked_at`.
  public func collectPage<T>(
    maxPages: Int = 10, query: ListQuery, _ make: @escaping @Sendable (ListQuery) -> Endpoint<Page<T>>
  ) async throws -> Page<T> {
    let collected = try await collectAll(maxPages: maxPages, query: query, make)
    return Page(items: collected.items, nextCursor: nil, checkedAt: collected.checkedAt)
  }
}
