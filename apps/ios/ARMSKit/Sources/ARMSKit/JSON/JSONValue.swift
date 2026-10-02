import Foundation

/// An arbitrary JSON value. Used for the free-form parts of the contract
/// (`ActionResult.data`, `Resource.data`, `Error.details`, voice tool arguments/results)
/// and for OpenAI Realtime data-channel events.
///
/// Object keys are preserved exactly (no snake/camel conversion).
public enum JSONValue: Sendable, Hashable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public subscript(key: String) -> JSONValue? {
    if case .object(let dict) = self { return dict[key] }
    return nil
  }

  public subscript(index: Int) -> JSONValue? {
    if case .array(let items) = self, items.indices.contains(index) { return items[index] }
    return nil
  }

  public var stringValue: String? {
    if case .string(let s) = self { return s }
    return nil
  }

  public var doubleValue: Double? {
    if case .number(let n) = self { return n }
    return nil
  }

  public var intValue: Int? {
    guard case .number(let n) = self, n.rounded() == n, abs(n) < 9.0e15 else { return nil }
    return Int(n)
  }

  public var boolValue: Bool? {
    if case .bool(let b) = self { return b }
    return nil
  }

  public var arrayValue: [JSONValue]? {
    if case .array(let a) = self { return a }
    return nil
  }

  public var objectValue: [String: JSONValue]? {
    if case .object(let o) = self { return o }
    return nil
  }

  public var isNull: Bool {
    if case .null = self { return true }
    return false
  }
}

extension JSONValue: Codable {
  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let b = try? container.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? container.decode(Double.self) {
      self = .number(n)
    } else if let s = try? container.decode(String.self) {
      self = .string(s)
    } else if let a = try? container.decode([JSONValue].self) {
      self = .array(a)
    } else if let o = try? container.decode([String: JSONValue].self) {
      self = .object(o)
    } else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case .bool(let b): try container.encode(b)
    case .number(let n): try container.encode(n)
    case .string(let s): try container.encode(s)
    case .array(let a): try container.encode(a)
    case .object(let o): try container.encode(o)
    }
  }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
  ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral, ExpressibleByNilLiteral
{
  public init(stringLiteral value: String) { self = .string(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(floatLiteral value: Double) { self = .number(value) }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    var dict: [String: JSONValue] = [:]
    for (k, v) in elements { dict[k] = v }
    self = .object(dict)
  }
  public init(nilLiteral: ()) { self = .null }
}

extension JSONValue {
  /// Parses UTF-8 JSON text.
  public init(jsonData data: Data) throws {
    self = try JSONDecoder().decode(JSONValue.self, from: data)
  }

  public init(jsonString string: String) throws {
    try self.init(jsonData: Data(string.utf8))
  }

  /// Compact JSON text with sorted keys (stable for tests and idempotent payloads).
  public func jsonData() -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    // Encoding a JSONValue cannot fail: every case maps onto a JSON primitive.
    return (try? encoder.encode(self)) ?? Data("null".utf8)
  }

  public func jsonString() -> String {
    String(decoding: jsonData(), as: UTF8.self)
  }

  /// Decodes this value into a Decodable type using the ARMS JSON conventions.
  public func decode<T: Decodable>(_ type: T.Type) throws -> T {
    try ARMSJSON.decoder.decode(T.self, from: jsonData())
  }

  /// Encodes an Encodable value into a JSONValue.
  public static func encode<T: Encodable>(_ value: T) throws -> JSONValue {
    try JSONValue(jsonData: ARMSJSON.encoder.encode(value))
  }
}
