import ARMSKit
import Auth
import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Email/password authentication with Supabase Auth (supabase-swift `Auth` product).
///
/// - The session (access + refresh token) is persisted by `AuthClient` through `storage`,
///   which the app backs with the Keychain (`KeychainAuthStorage`).
/// - `accessToken()` returns a valid token, refreshing it when it is about to expire.
/// - Only the access token is ever handed to the ARMS API (`Authorization: Bearer`).
final class SupabaseAuthService: AuthService, @unchecked Sendable {
  private let client: AuthClient

  init(supabaseURL: URL, publishableKey: String, storage: any AuthLocalStorage) {
    client = AuthClient(
      url: Self.authURL(supabaseURL),
      headers: ["apikey": publishableKey, "Authorization": "Bearer \(publishableKey)"],
      storageKey: "arms-auth-session",
      localStorage: storage,
      autoRefreshToken: true,
      emitLocalSessionAsInitialSession: true
    )
  }

  func signIn(email: String, password: String) async throws {
    do {
      _ = try await client.signIn(email: email, password: password)
    } catch {
      throw ARMSError.auth(Self.map(error))
    }
  }

  func signOut() async {
    // Local scope: other devices of the same user stay signed in.
    try? await client.signOut(scope: .local)
  }

  func hasStoredSession() async -> Bool {
    client.currentSession != nil
  }

  func accessToken() async throws -> String {
    do {
      return try await client.session.accessToken
    } catch {
      throw Self.tokenError(error)
    }
  }

  func refreshAccessToken() async throws -> String {
    do {
      return try await client.refreshSession().accessToken
    } catch {
      throw Self.tokenError(error)
    }
  }

  /// Supabase project URL → Auth endpoint (`<project>/auth/v1`). A URL that already ends with
  /// `/auth/v1` (e.g. a local Supabase CLI gateway) is used as is.
  static func authURL(_ supabaseURL: URL) -> URL {
    var path = supabaseURL.path
    while path.hasSuffix("/") { path.removeLast() }
    return path.hasSuffix("/auth/v1") ? supabaseURL : supabaseURL.appendingPathComponent("auth/v1")
  }

  /// Network problems keep the session (offline mode); anything else means the user must sign in.
  static func tokenError(_ error: any Error) -> ARMSError {
    if error is URLError { return .offline }
    return .notSignedIn
  }

  static func map(_ error: any Error) -> AuthFailure {
    if error is URLError { return .network }
    guard let authError = error as? AuthError else { return .provider(code: "unknown") }
    switch authError.errorCode {
    case .invalidCredentials:
      return .invalidCredentials
    case .emailNotConfirmed:
      return .emailNotConfirmed
    case .overRequestRateLimit:
      return .rateLimited
    case .userBanned:
      return .accountDisabled
    case .sessionNotFound:
      return .sessionMissing
    default:
      return .provider(code: authError.errorCode.rawValue)
    }
  }
}
