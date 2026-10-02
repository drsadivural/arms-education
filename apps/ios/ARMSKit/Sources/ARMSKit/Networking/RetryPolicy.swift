import Foundation

/// Exponential backoff with full jitter for `429` / `503` and retry-safe transport failures.
/// `Retry-After` (seconds) from the server takes precedence, capped at `maxDelay`.
public struct RetryPolicy: Sendable, Equatable {
  /// Total attempts including the first one.
  public var maxAttempts: Int
  public var baseDelay: TimeInterval
  public var maxDelay: TimeInterval

  public init(maxAttempts: Int = 3, baseDelay: TimeInterval = 0.5, maxDelay: TimeInterval = 8) {
    self.maxAttempts = max(1, maxAttempts)
    self.baseDelay = baseDelay
    self.maxDelay = maxDelay
  }

  public static let `default` = RetryPolicy()
  public static let none = RetryPolicy(maxAttempts: 1)

  /// Statuses that are retried: the server did not apply the change (rate limited / unavailable,
  /// transaction rolled back), so resending with the same idempotency key is safe.
  public static let retryableStatuses: Set<Int> = [429, 503]

  /// 429/503 answers that a retry cannot change: a missing server integration (APNs, storage,
  /// OpenAI) and an exhausted daily voice quota.
  public static let permanentCodes: Set<String> = ["NOT_CONFIGURED", "VOICE_QUOTA_EXCEEDED"]

  /// Delay before attempt `attempt + 1` (attempt is 1-based). `random` returns a value in [0, 1).
  public func delay(afterAttempt attempt: Int, retryAfter: TimeInterval?, random: Double) -> TimeInterval {
    if let retryAfter, retryAfter >= 0 {
      return min(retryAfter, maxDelay)
    }
    let exponential = min(maxDelay, baseDelay * pow(2, Double(max(0, attempt - 1))))
    // Full jitter: uniform in [0, exponential], but never below 50 ms to avoid hot loops.
    return max(0.05, exponential * min(max(random, 0), 1))
  }

  /// Parses `Retry-After` as delta-seconds (HTTP-date values are ignored).
  public static func parseRetryAfter(_ raw: String?) -> TimeInterval? {
    guard let raw = raw?.trimmingCharacters(in: .whitespaces), let seconds = Double(raw), seconds >= 0 else {
      return nil
    }
    return seconds
  }
}

/// Suspends for a duration; injectable for deterministic tests.
public protocol Sleeper: Sendable {
  func sleep(seconds: TimeInterval) async throws
}

public struct TaskSleeper: Sleeper {
  public init() {}
  public func sleep(seconds: TimeInterval) async throws {
    guard seconds > 0 else { return }
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
  }
}

/// Source of jitter in [0, 1); injectable for tests.
public protocol RandomSource: Sendable {
  func next() -> Double
}

public struct SystemRandomSource: RandomSource {
  public init() {}
  public func next() -> Double { Double.random(in: 0..<1) }
}
