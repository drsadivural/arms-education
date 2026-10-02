import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// A minimal HTTP request value (independent of URLRequest so it is Sendable on every platform).
public struct HTTPRequest: Sendable, Equatable {
  public var url: URL
  public var method: HTTPMethod
  public var headers: [String: String]
  public var body: Data?
  public var timeout: TimeInterval

  public init(url: URL, method: HTTPMethod, headers: [String: String] = [:], body: Data? = nil, timeout: TimeInterval = 30) {
    self.url = url
    self.method = method
    self.headers = headers
    self.body = body
    self.timeout = timeout
  }

  public func header(_ name: String) -> String? {
    headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
  }
}

public struct HTTPResponse: Sendable, Equatable {
  public var status: Int
  public var headers: [String: String]
  public var body: Data

  public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
    self.status = status
    self.headers = headers
    self.body = body
  }

  public func header(_ name: String) -> String? {
    headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
  }
}

/// Transport-level failures (no HTTP response was received).
public enum TransportError: Error, Sendable, Equatable {
  case offline
  case timedOut
  case connectionLost
  case cancelled
  case other(String)
}

public protocol HTTPTransport: Sendable {
  func send(_ request: HTTPRequest) async throws(TransportError) -> HTTPResponse
}

/// URLSession-backed transport. Cookies are never stored or sent (iOS uses Bearer only).
public final class URLSessionTransport: HTTPTransport, @unchecked Sendable {
  private let session: URLSession

  public init(configuration: URLSessionConfiguration? = nil) {
    let config = configuration ?? URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.httpCookieAcceptPolicy = .never
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    #if !os(Linux)
      config.waitsForConnectivity = false
    #endif
    self.session = URLSession(configuration: config)
  }

  public func send(_ request: HTTPRequest) async throws(TransportError) -> HTTPResponse {
    var urlRequest = URLRequest(url: request.url, timeoutInterval: request.timeout)
    urlRequest.httpMethod = request.method.rawValue
    for (k, v) in request.headers { urlRequest.setValue(v, forHTTPHeaderField: k) }
    urlRequest.httpBody = request.body
    urlRequest.httpShouldHandleCookies = false
    let session = self.session
    // Cancelling the Swift task cancels the URLSession task (the request ends with `.cancelled`).
    let running = RunningTask()
    let result: Result<HTTPResponse, TransportError> = await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        let task = session.dataTask(with: urlRequest) { data, response, error in
          if let error {
            continuation.resume(returning: .failure(URLSessionTransport.map(error)))
            return
          }
          guard let http = response as? HTTPURLResponse else {
            continuation.resume(returning: .failure(.other("no HTTP response")))
            return
          }
          var headers: [String: String] = [:]
          for (key, value) in http.allHeaderFields {
            if let k = key as? String, let v = value as? String { headers[k] = v }
          }
          continuation.resume(returning: .success(HTTPResponse(status: http.statusCode, headers: headers, body: data ?? Data())))
        }
        running.start(task)
      }
    } onCancel: {
      running.cancel()
    }
    return try result.get()
  }

  /// Holds the data task so a cancellation that races with its creation still cancels it.
  private final class RunningTask: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionDataTask?
    private var cancelled = false

    func start(_ task: URLSessionDataTask) {
      let cancelNow = lock.withLock {
        self.task = task
        return cancelled
      }
      task.resume()
      if cancelNow { task.cancel() }
    }

    func cancel() {
      let task = lock.withLock {
        cancelled = true
        return self.task
      }
      task?.cancel()
    }
  }

  static func map(_ error: any Error) -> TransportError {
    guard let urlError = error as? URLError else { return .other(String(describing: type(of: error))) }
    switch urlError.code {
    case .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dataNotAllowed, .internationalRoamingOff,
      .dnsLookupFailed:
      return .offline
    case .timedOut:
      return .timedOut
    case .networkConnectionLost:
      return .connectionLost
    case .cancelled:
      return .cancelled
    default:
      return .other("URLError \(urlError.code.rawValue)")
    }
  }
}
