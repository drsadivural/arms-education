import Foundation
import Observation

/// Result of a read that may fall back to cached data.
public enum FetchOutcome<T: Sendable>: Sendable {
  case fresh(T, checkedAt: Date)
  /// Network unavailable: last successful response shown read-only.
  case cached(T, savedAt: Date, error: ARMSError)
  case failure(ARMSError)
}

/// Loading state of one screen resource: loading / content / empty (decided by the view) /
/// error with retry / offline (cached, read-only), plus 「最終更新」.
public struct Loadable<Value: Sendable>: Sendable {
  public private(set) var value: Value?
  public private(set) var isLoading = false
  public private(set) var error: ARMSError?
  public private(set) var checkedAt: Date?
  /// True when `value` came from the offline cache.
  public private(set) var isCached = false

  public init(value: Value? = nil) { self.value = value }

  public var hasValue: Bool { value != nil }
  /// First load in progress (show a skeleton).
  public var isInitialLoading: Bool { isLoading && value == nil }
  /// Failed with nothing to show (show the error state with retry).
  public var failedWithoutValue: Bool { !isLoading && value == nil && error != nil }

  public mutating func beginLoading() {
    isLoading = true
  }

  public mutating func apply(_ outcome: FetchOutcome<Value>) {
    isLoading = false
    switch outcome {
    case .fresh(let v, let at):
      value = v
      checkedAt = at
      error = nil
      isCached = false
    case .cached(let v, let savedAt, let err):
      value = v
      checkedAt = savedAt
      error = err
      isCached = true
    case .failure(let err):
      error = err
      // Keep showing the previous value (if any) together with the error banner.
    }
  }

  /// Replaces the value after a confirmed mutation response.
  public mutating func update(_ v: Value, checkedAt at: Date) {
    value = v
    checkedAt = at
    error = nil
    isCached = false
  }

  public mutating func updateValue(_ transform: (inout Value) -> Void) {
    guard var v = value else { return }
    transform(&v)
    value = v
  }

  public mutating func clearError() { error = nil }
}

/// Shared services and session-scoped state for all view models (MainActor).
@MainActor
@Observable
public final class AppContext {
  public let api: APIClient
  public let keyValues: any KeyValueStore
  private let cache: any ResponseCache
  public let now: () -> Date

  /// Current user (set after the server role check).
  public private(set) var me: Me?
  /// Organisation calendar (Asia/Tokyo unless the organisation says otherwise).
  public private(set) var calendar: OrgCalendar = .tokyo
  /// Network reachability (NWPathMonitor in the app; also lowered on transport failures).
  public private(set) var isOnline = true
  /// Incremented on foreground return / pull-to-refresh-all; screens reload when it changes.
  public private(set) var refreshGeneration = 0
  /// Unread notification count for the bell badge.
  public var unreadNotifications = 0

  public init(api: APIClient, cache: any ResponseCache, keyValues: any KeyValueStore, now: @escaping () -> Date = Date.init) {
    self.api = api
    self.cache = cache
    self.keyValues = keyValues
    self.now = now
  }

  public var role: Role? { me?.role }
  /// Mutations are disabled while offline (cached data is read-only).
  public var canMutate: Bool { isOnline }
  public static let offlineMutationMessage = "オフラインのため操作できません。通信環境を確認してください。"

  public func setMe(_ me: Me?) {
    self.me = me
    calendar = me?.calendar ?? .tokyo
    if let me {
      keyValues.set(me.id, forKey: StorageKeys.lastUserId)
      keyValues.set(me.preferences.theme.rawValue, forKey: StorageKeys.theme)
    }
  }

  public func updatePreferences(_ preferences: Me.Preferences) {
    guard var current = me else { return }
    current.preferences = preferences
    me = current
    keyValues.set(preferences.theme.rawValue, forKey: StorageKeys.theme)
    storeCached(current, savedAt: now(), key: "me")
  }

  public func setOnline(_ online: Bool) {
    if online != isOnline { isOnline = online }
  }

  public func requestRefresh() { refreshGeneration += 1 }

  /// Wipes cached responses (sign-out / account switch).
  public func clearSessionData() {
    cache.removeAll()
    me = nil
    calendar = .tokyo
    unreadNotifications = 0
  }

  // MARK: Fetching with offline fallback

  private func namespaced(_ key: String) -> String {
    "\(me?.id ?? keyValues.string(forKey: StorageKeys.lastUserId) ?? "anonymous")/\(key)"
  }

  public func storeCached<T: Encodable>(_ value: T, savedAt: Date, key: String) {
    cache.storeValue(value, savedAt: savedAt, forKey: namespaced(key))
  }

  public func loadCached<T: Decodable>(_ type: T.Type, key: String) -> (value: T, savedAt: Date)? {
    cache.loadValue(T.self, forKey: namespaced(key))
  }

  /// Runs a read. On success the response is cached (when `cacheKey` is set) and the device is
  /// considered online; on connectivity failure the cached copy is returned read-only.
  public func fetch<T: Codable & Sendable>(
    cacheKey: String?, checkedAt: (T) -> Date, _ operation: () async throws -> T
  ) async -> FetchOutcome<T> {
    do {
      let value = try await operation()
      let at = checkedAt(value)
      if let cacheKey { storeCached(value, savedAt: at, key: cacheKey) }
      setOnline(true)
      return .fresh(value, checkedAt: at)
    } catch {
      let error = (error as? ARMSError) ?? .decoding(String(describing: type(of: error)))
      if error.isConnectivity {
        setOnline(false)
        if let cacheKey, let cached = loadCached(T.self, key: cacheKey) {
          return .cached(cached.value, savedAt: cached.savedAt, error: error)
        }
      }
      return .failure(error)
    }
  }

  /// Guard for mutations: returns an error when offline.
  public func mutationBlocker() -> ARMSError? {
    canMutate ? nil : .local(code: "OFFLINE", messageJa: AppContext.offlineMutationMessage)
  }

  /// 「最終更新 HH:mm」 (+ 「（オフライン）」 when cached).
  public func lastUpdatedLabel<V>(_ state: Loadable<V>) -> String? {
    guard let at = state.checkedAt else { return nil }
    let base = JaFormat.lastUpdated(at, now: now(), calendar: calendar)
    return state.isCached ? "\(base)（オフライン表示）" : base
  }
}

/// Generates one idempotency key per user action and keeps it for retries and double taps of
/// the same action; a different action (or changed content) gets a new key.
public struct ActionKeys: Sendable {
  private var keys: [String: IdempotencyKey] = [:]

  public init() {}

  public mutating func key(for action: String) -> IdempotencyKey {
    if let existing = keys[action] { return existing }
    let key = IdempotencyKey()
    keys[action] = key
    return key
  }

  /// Forget the key after the server confirmed the action (or the content changed).
  public mutating func complete(_ action: String) { keys[action] = nil }

  public func existingKey(for action: String) -> IdempotencyKey? { keys[action] }
}
