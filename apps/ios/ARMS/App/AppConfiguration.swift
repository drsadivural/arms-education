@_exported import ARMSKit
import Foundation

/// SwiftUI also declares a public `Material` (blur materials); this app-level alias makes every `Material` in the app
/// target mean the ARMS learning material and avoids "'Material' is ambiguous for type lookup".
typealias Material = ARMSKit.Material

/// Build-time configuration read from Info.plist (values come from the xcconfig files:
/// `API_BASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `TERMS_URL`, `PRIVACY_POLICY_URL`).
/// Real values are customer inputs and are never committed.
struct AppConfiguration: Equatable {
  let apiBaseURL: URL
  let supabaseURL: URL
  let supabasePublishableKey: String
  let termsURL: URL?
  let privacyPolicyURL: URL?
  let apnsEnvironment: APNsEnvironment

  enum Problem: Error, Equatable {
    case missing([String])
    case invalid([String])

    var keys: [String] {
      switch self {
      case .missing(let keys), .invalid(let keys): return keys
      }
    }
  }

  static func load(from info: [String: Any]?) -> Result<AppConfiguration, Problem> {
    func value(_ key: String) -> String? {
      guard let raw = info?[key] as? String else { return nil }
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      // Unresolved build settings stay as "$(NAME)".
      return trimmed.isEmpty || trimmed.hasPrefix("$(") ? nil : trimmed
    }
    var missing: [String] = []
    var invalid: [String] = []
    let api = value("ARMSAPIBaseURL")
    let supabase = value("ARMSSupabaseURL")
    let key = value("ARMSSupabasePublishableKey")
    if api == nil { missing.append("API_BASE_URL") }
    if supabase == nil { missing.append("SUPABASE_URL") }
    if key == nil { missing.append("SUPABASE_PUBLISHABLE_KEY") }
    if !missing.isEmpty { return .failure(.missing(missing)) }

    let apiURL = api.flatMap(validatedURL).map(withAPIPath)
    let supabaseURL = supabase.flatMap(validatedURL)
    if apiURL == nil { invalid.append("API_BASE_URL") }
    if supabaseURL == nil { invalid.append("SUPABASE_URL") }
    if !invalid.isEmpty { return .failure(.invalid(invalid)) }

    return .success(
      AppConfiguration(
        apiBaseURL: apiURL!, supabaseURL: supabaseURL!, supabasePublishableKey: key!,
        termsURL: value("ARMSTermsURL").flatMap(validatedURL),
        privacyPolicyURL: value("ARMSPrivacyPolicyURL").flatMap(validatedURL),
        apnsEnvironment: value("ARMSAPNsEnvironment") == "production" ? .production : .sandbox))
  }

  /// HTTPS only; plain HTTP is accepted for localhost (local Workers / Supabase during development).
  static func validatedURL(_ raw: String) -> URL? {
    guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), let host = url.host, !host.isEmpty else {
      return nil
    }
    if scheme == "https" { return url }
    if scheme == "http", ["localhost", "127.0.0.1"].contains(host.lowercased()) { return url }
    return nil
  }

  /// `https://arms.example.com` → `https://arms.example.com/api/v1` (an explicit path is kept).
  static func withAPIPath(_ url: URL) -> URL {
    let path = url.path
    if path.isEmpty || path == "/" { return url.appendingPathComponent("api/v1") }
    return url
  }
}
