import ARMSKit
import Auth
import Foundation
import Security

/// Keychain-backed `TokenStore` (generic passwords, this device only, after first unlock).
/// Tokens never leave the Keychain except in memory for the `Authorization` header.
final class KeychainTokenStore: TokenStore, @unchecked Sendable {
  private let service: String
  private let lock = NSLock()

  init(service: String) {
    self.service = service
  }

  private func baseQuery(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }

  func data(forKey key: String) throws -> Data? {
    lock.lock()
    defer { lock.unlock() }
    var query = baseQuery(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    switch status {
    case errSecSuccess: return result as? Data
    case errSecItemNotFound: return nil
    default: throw KeychainError(status: status)
    }
  }

  func set(_ data: Data, forKey key: String) throws {
    lock.lock()
    defer { lock.unlock() }
    let query = baseQuery(key)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      var insert = query
      insert.merge(attributes) { _, new in new }
      let added = SecItemAdd(insert as CFDictionary, nil)
      guard added == errSecSuccess else { throw KeychainError(status: added) }
    } else if status != errSecSuccess {
      throw KeychainError(status: status)
    }
  }

  func removeValue(forKey key: String) throws {
    lock.lock()
    defer { lock.unlock() }
    let status = SecItemDelete(baseQuery(key) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
  }

  func removeAll() throws {
    lock.lock()
    defer { lock.unlock() }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
  }
}

struct KeychainError: Error, CustomStringConvertible {
  let status: OSStatus
  var description: String { "Keychain error \(status)" }
}

/// Bridges supabase-swift's session persistence onto ARMSKit's `TokenStore` (Keychain).
struct KeychainAuthStorage: AuthLocalStorage {
  let tokens: any TokenStore

  func store(key: String, value: Data) throws { try tokens.set(value, forKey: key) }
  func retrieve(key: String) throws -> Data? { try tokens.data(forKey: key) }
  func remove(key: String) throws { try tokens.removeValue(forKey: key) }
}

/// Non-secret preferences in `UserDefaults` (Required Reason API CA92.1: same-app access only).
final class UserDefaultsKeyValueStore: KeyValueStore, @unchecked Sendable {
  private let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  func string(forKey key: String) -> String? { defaults.string(forKey: key) }

  func set(_ value: String?, forKey key: String) {
    if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
  }

  func bool(forKey key: String) -> Bool { defaults.bool(forKey: key) }
  func set(_ value: Bool, forKey key: String) { defaults.set(value, forKey: key) }
}
