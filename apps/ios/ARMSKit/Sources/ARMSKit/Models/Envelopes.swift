import Foundation

/// `{ data, checked_at }` (contract `*Response` schemas).
public struct DataEnvelope<T: Codable & Sendable>: Codable, Sendable {
  public let data: T
  public let checkedAt: Date

  public init(data: T, checkedAt: Date) {
    self.data = data
    self.checkedAt = checkedAt
  }

  enum CodingKeys: String, CodingKey {
    case data
    case checkedAt = "checked_at"
  }
}

extension DataEnvelope: Equatable where T: Equatable {}

/// `{ items, next_cursor, checked_at }` (contract `*Page` schemas, keyset pagination).
public struct Page<T: Codable & Sendable>: Codable, Sendable {
  public let items: [T]
  public let nextCursor: String?
  public let checkedAt: Date

  public init(items: [T], nextCursor: String?, checkedAt: Date) {
    self.items = items
    self.nextCursor = nextCursor
    self.checkedAt = checkedAt
  }

  enum CodingKeys: String, CodingKey {
    case items
    case nextCursor = "next_cursor"
    case checkedAt = "checked_at"
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    items = try c.decode([T].self, forKey: .items)
    nextCursor = try c.decodeIfPresent(String.self, forKey: .nextCursor)
    checkedAt = try c.decode(Date.self, forKey: .checkedAt)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(items, forKey: .items)
    try c.encode(nextCursor, forKey: .nextCursor)
    try c.encode(checkedAt, forKey: .checkedAt)
  }
}

extension Page: Equatable where T: Equatable {}

/// `{ success, checked_at, data? }` (contract `ActionResult`).
public struct ActionResult: Codable, Sendable, Equatable {
  public let success: Bool
  public let checkedAt: Date
  public let data: JSONValue?

  public init(success: Bool, checkedAt: Date, data: JSONValue?) {
    self.success = success
    self.checkedAt = checkedAt
    self.data = data
  }

  enum CodingKeys: String, CodingKey {
    case success
    case checkedAt = "checked_at"
    case data
  }
}

/// `{ id, row_version?, data, checked_at }` (contract `Resource`).
public struct ResourceResult: Codable, Sendable, Equatable {
  public let id: String
  public let rowVersion: Int?
  public let data: JSONValue
  public let checkedAt: Date

  enum CodingKeys: String, CodingKey {
    case id
    case rowVersion = "row_version"
    case data
    case checkedAt = "checked_at"
  }
}
