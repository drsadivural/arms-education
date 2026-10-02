import Foundation

/// In-app destinations reachable from URLs (`arms://…`), push payloads (APNs top-level key
/// `deep_link`, services/api/src/integrations/push.ts) and notification rows (`deep_link`).
///
/// Links produced by the server (services/api/src/domain/notifications/rules.ts `DEEP_LINKS`):
/// - `arms://reservations/<uuid>` → reservation detail
/// - `arms://lessons/today` → today's lessons
/// - `arms://lesson-slots/<uuid>` → lesson slot (e.g. 「担当授業が取り消されました」)
/// - `arms://settings/users` → admin-only (Web); ignored by the app
///
/// Also accepted (host-style and path-style are equivalent):
/// - `arms://reservations`, `arms://notifications`, `arms://progress`, `arms://units/<uuid>/materials`
/// - relative paths (`/reservations/<uuid>`, `/lessons/today`, …)
public enum DeepLink: Hashable, Sendable {
  case reservation(id: String)
  case reservations
  case todayLessons
  case lessonSlot(id: String)
  case notifications
  case progress
  case unitMaterials(unitId: String)

  public static let scheme = "arms"

  /// Top-level APNs payload key: `{"aps":{"alert":{…},"sound":"default"},"deep_link":"arms://…"}`.
  public static let pushPayloadKey = "deep_link"

  /// Link of a tapped push notification (nil when absent or not an app link).
  public static func fromPush(userInfo: [AnyHashable: Any]) -> DeepLink? {
    (userInfo[pushPayloadKey] as? String).flatMap { parse($0) }
  }

  public static func parse(_ raw: String) -> DeepLink? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if trimmed.hasPrefix("/") {
      return parse(segments: trimmed.split(separator: "/").map(String.init))
    }
    guard let url = URL(string: trimmed) else { return nil }
    return parse(url: url)
  }

  public static func parse(url: URL) -> DeepLink? {
    guard url.scheme?.lowercased() == scheme else { return nil }
    var segments: [String] = []
    if let host = url.host, !host.isEmpty { segments.append(host) }
    segments.append(contentsOf: url.path.split(separator: "/").map(String.init))
    return parse(segments: segments)
  }

  static func parse(segments raw: [String]) -> DeepLink? {
    let segments = raw.map { $0.removingPercentEncoding ?? $0 }.filter { !$0.isEmpty }
    guard let first = segments.first?.lowercased() else { return nil }
    switch first {
    case "reservations", "reservation", "bookings":
      if segments.count >= 2 {
        return isUUID(segments[1]) ? .reservation(id: segments[1].lowercased()) : nil
      }
      return .reservations
    case "lessons":
      return segments.count >= 2 && segments[1].lowercased() == "today" ? .todayLessons : nil
    case "today-lessons", "today":
      return .todayLessons
    case "lesson-slots", "lesson-slot", "slots":
      return segments.count >= 2 && isUUID(segments[1]) ? .lessonSlot(id: segments[1].lowercased()) : nil
    case "notifications":
      return .notifications
    case "progress":
      return .progress
    case "units":
      if segments.count >= 3, segments[2].lowercased() == "materials", isUUID(segments[1]) {
        return .unitMaterials(unitId: segments[1].lowercased())
      }
      return nil
    default:
      return nil
    }
  }

  static func isUUID(_ s: String) -> Bool { UUID(uuidString: s) != nil }

  /// Link label shown on notification cards (IOS-15).
  public var actionLabel: String {
    switch self {
    case .reservation, .reservations: return "予約内容を確認"
    case .todayLessons: return "本日の授業を見る"
    case .lessonSlot: return "授業の内容を確認"
    case .notifications: return "お知らせを見る"
    case .progress: return "進捗を確認"
    case .unitMaterials: return "教材を開く"
    }
  }

  public var url: URL {
    switch self {
    case .reservation(let id): return URL(string: "arms://reservations/\(id)")!
    case .reservations: return URL(string: "arms://reservations")!
    case .todayLessons: return URL(string: "arms://lessons/today")!
    case .lessonSlot(let id): return URL(string: "arms://lesson-slots/\(id)")!
    case .notifications: return URL(string: "arms://notifications")!
    case .progress: return URL(string: "arms://progress")!
    case .unitMaterials(let id): return URL(string: "arms://units/\(id)/materials")!
    }
  }
}
