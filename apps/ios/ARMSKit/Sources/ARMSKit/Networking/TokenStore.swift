import Foundation

/// Secure key/value storage for authentication material. The app implements it with the
/// Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`); Supabase Auth persists its
/// session through an adapter onto this protocol. Tests use `InMemoryTokenStore`.
public protocol TokenStore: Sendable {
  func data(forKey key: String) throws -> Data?
  func set(_ data: Data, forKey key: String) throws
  func removeValue(forKey key: String) throws
  func removeAll() throws
}

public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
  private let lock = NSLock()
  private var storage: [String: Data] = [:]

  public init() {}

  public func data(forKey key: String) throws -> Data? {
    lock.lock()
    defer { lock.unlock() }
    return storage[key]
  }

  public func set(_ data: Data, forKey key: String) throws {
    lock.lock()
    defer { lock.unlock() }
    storage[key] = data
  }

  public func removeValue(forKey key: String) throws {
    lock.lock()
    defer { lock.unlock() }
    storage[key] = nil
  }

  public func removeAll() throws {
    lock.lock()
    defer { lock.unlock() }
    storage.removeAll()
  }

  public var keys: [String] {
    lock.lock()
    defer { lock.unlock() }
    return Array(storage.keys)
  }
}

/// Supplies the Supabase access token for `Authorization: Bearer`.
public protocol AccessTokenProvider: Sendable {
  /// A valid (refreshed if needed) access token, or `ARMSError.notSignedIn`.
  func accessToken() async throws -> String
  /// Forces a refresh after the API answered 401; returns the new token or throws.
  func refreshAccessToken() async throws -> String
}

/// Identity provider operations used by the login flow (implemented with supabase-swift Auth in the app).
public protocol AuthService: AccessTokenProvider {
  /// Email/password sign-in. Throws `ARMSError.auth(...)` with a Japanese message.
  func signIn(email: String, password: String) async throws
  /// Revokes the local session (best effort remotely) and clears stored tokens.
  func signOut() async
  /// Whether a stored session exists (it may still need a refresh).
  func hasStoredSession() async -> Bool
}

/// Non-secret preferences (selected role, organisation, voice disclosure flag, cached theme).
public protocol KeyValueStore: Sendable {
  func string(forKey key: String) -> String?
  func set(_ value: String?, forKey key: String)
  func bool(forKey key: String) -> Bool
  func set(_ value: Bool, forKey key: String)
}

public final class InMemoryKeyValueStore: KeyValueStore, @unchecked Sendable {
  private let lock = NSLock()
  private var strings: [String: String] = [:]
  private var bools: [String: Bool] = [:]

  public init() {}

  public func string(forKey key: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return strings[key]
  }

  public func set(_ value: String?, forKey key: String) {
    lock.lock()
    defer { lock.unlock() }
    strings[key] = value
  }

  public func bool(forKey key: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return bools[key] ?? false
  }

  public func set(_ value: Bool, forKey key: String) {
    lock.lock()
    defer { lock.unlock() }
    bools[key] = value
  }
}

public enum StorageKeys {
  public static let selectedRole = "arms.selectedRole"
  public static let organizationId = "arms.organizationId"
  public static let voiceDisclosureShown = "arms.voiceDisclosureShown"
  public static let theme = "arms.theme"
  public static let lastUserId = "arms.lastUserId"
  /// SHA-256 of the registered APNs token (for `DELETE /devices/{token_hash}` on sign-out).
  public static let deviceTokenHash = "arms.deviceTokenHash"
}

/// Thread-safe holder of the `X-ARMS-Org` selection (multi-organisation users).
public final class OrganizationSelection: @unchecked Sendable {
  private let lock = NSLock()
  private var value: String?

  public init(_ initial: String? = nil) { self.value = initial }

  public var organizationId: String? {
    get {
      lock.lock()
      defer { lock.unlock() }
      return value
    }
    set {
      lock.lock()
      defer { lock.unlock() }
      value = newValue
    }
  }
}
