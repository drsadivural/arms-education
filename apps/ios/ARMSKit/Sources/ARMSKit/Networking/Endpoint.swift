import Foundation

public enum HTTPMethod: String, Sendable {
  case get = "GET"
  case post = "POST"
  case put = "PUT"
  case patch = "PATCH"
  case delete = "DELETE"
}

/// A UUID sent as `Idempotency-Key`. Generated once per user action and reused for every
/// automatic retry, double tap and manual "retry" of that same action.
public struct IdempotencyKey: Hashable, Sendable, CustomStringConvertible {
  public let value: String

  public init() { self.value = UUID().uuidString.lowercased() }

  /// Accepts an existing UUID string (e.g. restored from a pending action).
  public init?(_ string: String) {
    guard UUID(uuidString: string) != nil else { return nil }
    self.value = string.lowercased()
  }

  public var description: String { value }
}

public struct QueryItem: Sendable, Hashable {
  public let name: String
  public let value: String

  public init(_ name: String, _ value: String) {
    self.name = name
    self.value = value
  }
}

/// A typed request description. `Response` is decoded from 2xx bodies.
public struct Endpoint<Response: Decodable & Sendable>: Sendable {
  public var method: HTTPMethod
  /// Path relative to the API base (which already contains `/api/v1`), starting with `/`.
  public var path: String
  public var query: [QueryItem]
  public var body: Data?
  public var headers: [String: String]
  public var idempotencyKey: IdempotencyKey?
  /// Sent as `If-Match: "<row_version>"` (PATCH optimistic concurrency).
  public var ifMatch: Int?
  public var requiresAuth: Bool
  /// Accepted success statuses (e.g. `[201]` for reservation creation).
  public var successStatuses: Set<Int>

  public init(
    method: HTTPMethod, path: String, query: [QueryItem] = [], body: Data? = nil, headers: [String: String] = [:],
    idempotencyKey: IdempotencyKey? = nil, ifMatch: Int? = nil, requiresAuth: Bool = true,
    successStatuses: Set<Int> = [200]
  ) {
    self.method = method
    self.path = path
    self.query = query
    self.body = body
    self.headers = headers
    self.idempotencyKey = idempotencyKey
    self.ifMatch = ifMatch
    self.requiresAuth = requiresAuth
    self.successStatuses = successStatuses
  }

  /// Safe to resend after a transport failure: reads, or writes protected by an idempotency key.
  public var isRetrySafe: Bool {
    method == .get || idempotencyKey != nil
  }

  public static func encodeBody<B: Encodable>(_ body: B) -> Data {
    // Encoding our own Codable inputs cannot fail (no non-conforming floats are produced).
    (try? ARMSJSON.encoder.encode(body)) ?? Data("{}".utf8)
  }
}

/// A decoded response plus transport metadata.
public struct APIResponse<Value: Sendable>: Sendable {
  public let value: Value
  public let status: Int
  /// Parsed strong ETag (`"<row_version>"`), when present.
  public let etagVersion: Int?
  public let requestId: String?

  public init(value: Value, status: Int, etagVersion: Int?, requestId: String?) {
    self.value = value
    self.status = status
    self.etagVersion = etagVersion
    self.requestId = requestId
  }

  static func parseETag(_ raw: String?) -> Int? {
    guard var s = raw?.trimmingCharacters(in: .whitespaces), !s.isEmpty else { return nil }
    if s.hasPrefix("W/") { s.removeFirst(2) }
    s = s.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
    return Int(s)
  }
}

/// List query parameters shared by the contract's list endpoints.
public struct ListQuery: Sendable, Hashable {
  public var cursor: String?
  public var limit: Int?
  public var q: String?
  public var classroomId: String?
  public var teacherId: String?
  public var studentId: String?
  public var status: String?
  public var from: LocalDate?
  public var to: LocalDate?
  public var month: YearMonth?
  public var department: String?
  public var idempotencyKey: IdempotencyKey?
  /// `GET /submissions?state=` (submitted / accepted / revision_requested).
  public var state: String?
  /// `GET /reservations?slot_id=`.
  public var slotId: String?
  /// `GET /submissions?material_id=`.
  public var materialId: String?
  /// `GET /reservations?sort=` (starts_at / -starts_at / -created_at).
  public var sort: String?

  public init(
    cursor: String? = nil, limit: Int? = nil, q: String? = nil, classroomId: String? = nil, teacherId: String? = nil,
    studentId: String? = nil, status: String? = nil, from: LocalDate? = nil, to: LocalDate? = nil,
    month: YearMonth? = nil, department: String? = nil, idempotencyKey: IdempotencyKey? = nil, state: String? = nil,
    slotId: String? = nil, materialId: String? = nil, sort: String? = nil
  ) {
    self.cursor = cursor
    self.limit = limit
    self.q = q
    self.classroomId = classroomId
    self.teacherId = teacherId
    self.studentId = studentId
    self.status = status
    self.from = from
    self.to = to
    self.month = month
    self.department = department
    self.idempotencyKey = idempotencyKey
    self.state = state
    self.slotId = slotId
    self.materialId = materialId
    self.sort = sort
  }

  /// Comma-separated reservation status filter (`status=pending,approved`).
  public static func statuses(_ list: [ReservationStatus]) -> String {
    list.map(\.rawValue).joined(separator: ",")
  }

  public var items: [QueryItem] {
    var out: [QueryItem] = []
    if let cursor { out.append(QueryItem("cursor", cursor)) }
    if let limit { out.append(QueryItem("limit", String(min(100, max(1, limit))))) }
    if let q, !q.trimmingCharacters(in: .whitespaces).isEmpty {
      out.append(QueryItem("q", q.trimmingCharacters(in: .whitespaces)))
    }
    if let classroomId { out.append(QueryItem("classroom_id", classroomId)) }
    if let teacherId { out.append(QueryItem("teacher_id", teacherId)) }
    if let studentId { out.append(QueryItem("student_id", studentId)) }
    if let status { out.append(QueryItem("status", status)) }
    if let from { out.append(QueryItem("from", from.isoString)) }
    if let to { out.append(QueryItem("to", to.isoString)) }
    if let month { out.append(QueryItem("month", month.isoString)) }
    if let department { out.append(QueryItem("department", department)) }
    if let idempotencyKey { out.append(QueryItem("idempotency_key", idempotencyKey.value)) }
    if let state { out.append(QueryItem("state", state)) }
    if let slotId { out.append(QueryItem("slot_id", slotId)) }
    if let materialId { out.append(QueryItem("material_id", materialId)) }
    if let sort { out.append(QueryItem("sort", sort)) }
    return out
  }

  public func with(cursor: String?) -> ListQuery {
    var copy = self
    copy.cursor = cursor
    return copy
  }
}
