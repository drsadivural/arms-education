import Foundation

/// Last successful API responses, used read-only while offline.
///
/// Entries are namespaced per user by the caller and wiped on sign-out. The saved time is stored
/// inside the entry (no file-timestamp APIs are used).
public protocol ResponseCache: Sendable {
  func store(_ data: Data, savedAt: Date, forKey key: String)
  func load(forKey key: String) -> (data: Data, savedAt: Date)?
  func removeAll()
}

extension ResponseCache {
  public func storeValue<T: Encodable>(_ value: T, savedAt: Date, forKey key: String) {
    guard let data = try? ARMSJSON.encoder.encode(value) else { return }
    store(data, savedAt: savedAt, forKey: key)
  }

  public func loadValue<T: Decodable>(_ type: T.Type, forKey key: String) -> (value: T, savedAt: Date)? {
    guard let entry = load(forKey: key), let value = try? ARMSJSON.decoder.decode(T.self, from: entry.data) else {
      return nil
    }
    return (value, entry.savedAt)
  }
}

public final class InMemoryResponseCache: ResponseCache, @unchecked Sendable {
  private let lock = NSLock()
  private var entries: [String: (Data, Date)] = [:]

  public init() {}

  public func store(_ data: Data, savedAt: Date, forKey key: String) {
    lock.lock()
    defer { lock.unlock() }
    entries[key] = (data, savedAt)
  }

  public func load(forKey key: String) -> (data: Data, savedAt: Date)? {
    lock.lock()
    defer { lock.unlock() }
    return entries[key].map { (data: $0.0, savedAt: $0.1) }
  }

  public func removeAll() {
    lock.lock()
    defer { lock.unlock() }
    entries.removeAll()
  }

  public var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return entries.count
  }
}

/// File-backed cache in a directory owned by the app (Application Support, excluded from backup
/// and written with complete file protection by the app target).
public final class FileResponseCache: ResponseCache, @unchecked Sendable {
  private struct Entry: Codable {
    let savedAt: Date
    let payload: Data
    enum CodingKeys: String, CodingKey {
      case savedAt = "saved_at"
      case payload
    }
  }

  private let directory: URL
  private let lock = NSLock()
  private let writeOptions: Data.WritingOptions

  public init(directory: URL, writeOptions: Data.WritingOptions = [.atomic]) {
    self.directory = directory
    self.writeOptions = writeOptions
  }

  /// Keys may contain any characters; file names are a hex encoding of the UTF-8 key.
  static func fileName(for key: String) -> String {
    key.utf8.map { b in
      let s = String(b, radix: 16)
      return s.count == 1 ? "0" + s : s
    }.joined() + ".json"
  }

  public func store(_ data: Data, savedAt: Date, forKey key: String) {
    lock.lock()
    defer { lock.unlock() }
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let encoded = try ARMSJSON.encoder.encode(Entry(savedAt: savedAt, payload: data))
      try encoded.write(to: directory.appendingPathComponent(Self.fileName(for: key)), options: writeOptions)
    } catch {
      // A cache write failure only means less offline data; never surface it to the user.
    }
  }

  public func load(forKey key: String) -> (data: Data, savedAt: Date)? {
    lock.lock()
    defer { lock.unlock() }
    let url = directory.appendingPathComponent(Self.fileName(for: key))
    guard let raw = try? Data(contentsOf: url), let entry = try? ARMSJSON.decoder.decode(Entry.self, from: raw) else {
      return nil
    }
    return (entry.payload, entry.savedAt)
  }

  public func removeAll() {
    lock.lock()
    defer { lock.unlock() }
    try? FileManager.default.removeItem(at: directory)
  }
}
