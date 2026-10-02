import Foundation
import Observation

/// Sign-in, server role check and session lifecycle (IOS-01).
///
/// The role is decided by the server: after Supabase sign-in the app calls `GET /me` with
/// `X-ARMS-Selected-Role`. A mismatch shows 「このアカウントでは選択した利用区分にログインできません」
/// and signs out; administrators are refused with 「管理者の操作はWeb管理画面をご利用ください。」.
@MainActor
@Observable
public final class SessionStore {
  public enum State: Equatable, Sendable {
    case launching
    case signedOut
    case choosingOrganization([OrganizationChoice])
    case signedIn(Me)
    /// Session restore could not reach the server and no cached profile exists.
    case restoreFailed(String)
  }

  public static let roleMismatchMessage = "このアカウントでは選択した利用区分にログインできません"
  public static let adminMessage = "管理者の操作はWeb管理画面をご利用ください。"
  public static let passwordResetSentMessage =
    "パスワード再設定の案内を送信しました。登録済みのメールアドレスの場合、数分以内にメールが届きます。"

  public private(set) var state: State = .launching
  public private(set) var isWorking = false
  /// Error shown on the login screen.
  public var message: String?
  public var fieldErrors: [String: String] = [:]
  public var selectedRole: SelectableRole {
    didSet { context.keyValues.set(selectedRole.rawValue, forKey: StorageKeys.selectedRole) }
  }
  /// Signed in from the offline cache (server role check pending).
  public private(set) var isOfflineSession = false

  private let auth: any AuthService
  public let context: AppContext

  public init(auth: any AuthService, context: AppContext) {
    self.auth = auth
    self.context = context
    self.selectedRole =
      context.keyValues.string(forKey: StorageKeys.selectedRole).flatMap(SelectableRole.init(rawValue:)) ?? .student
    if let org = context.keyValues.string(forKey: StorageKeys.organizationId) {
      context.api.organization.organizationId = org
    }
  }

  public var me: Me? {
    if case .signedIn(let me) = state { return me }
    return nil
  }

  // MARK: Launch

  /// Restores a stored Supabase session and re-verifies the role with the server.
  public func restore() async {
    guard await auth.hasStoredSession() else {
      state = .signedOut
      return
    }
    await verifyRole(isRestore: true)
  }

  // MARK: Sign-in

  public func signIn(email rawEmail: String, password: String) async {
    guard !isWorking else { return }
    let email = rawEmail.trimmingCharacters(in: .whitespacesAndNewlines)
    var errors: [String: String] = [:]
    if email.isEmpty {
      errors["email"] = "メールアドレスを入力してください。"
    } else if !SessionStore.looksLikeEmail(email) {
      errors["email"] = "メールアドレスの形式が正しくありません。"
    }
    if password.isEmpty { errors["password"] = "パスワードを入力してください。" }
    fieldErrors = errors
    guard errors.isEmpty else {
      message = nil
      return
    }
    message = nil
    isWorking = true
    defer { isWorking = false }
    do {
      try await auth.signIn(email: email, password: password)
    } catch let error as ARMSError {
      message = error.messageJa
      return
    } catch {
      message = ErrorCatalog.message(for: "AUTH_PROVIDER_UNAVAILABLE")
      return
    }
    await verifyRole(isRestore: false)
  }

  public func chooseOrganization(_ choice: OrganizationChoice) async {
    context.api.organization.organizationId = choice.id
    context.keyValues.set(choice.id, forKey: StorageKeys.organizationId)
    isWorking = true
    defer { isWorking = false }
    await verifyRole(isRestore: false)
  }

  /// Re-reads `/me` (pull-to-refresh, after preference changes elsewhere, foreground).
  public func refreshMe() async {
    guard case .signedIn = state else { return }
    do {
      let me = try await context.api.send(API.me(selectedRole: selectedRole.role)).value.data
      try acceptOrThrow(me)
      context.setMe(me)
      context.storeCached(me, savedAt: context.now(), key: "me")
      state = .signedIn(me)
      isOfflineSession = false
    } catch {
      if error.isConnectivity { return }
      if error.code == "ROLE_MISMATCH" || error.code == "ADMIN_USE_WEB" || error.requiresSignIn {
        await signOut(message: messageForRejected(error))
      }
    }
  }

  public func retryRestore() async {
    state = .launching
    await restore()
  }

  // MARK: Password reset

  /// `POST /auth/password-reset`. The API answers identically whether or not the address exists.
  @discardableResult
  public func requestPasswordReset(email rawEmail: String) async -> Result<String, ARMSError> {
    let email = rawEmail.trimmingCharacters(in: .whitespacesAndNewlines)
    guard SessionStore.looksLikeEmail(email) else {
      return .failure(.validation(["email": "メールアドレスの形式が正しくありません。"]))
    }
    do {
      // The server picks the e-mail link target (Web /auth/callback, which then sends students back
      // to the app); the client never supplies a redirect.
      let result = try await context.api.send(API.passwordReset(email: email)).value
      let server = result.data?["message_ja"]?.stringValue
      return .success(server.flatMap { $0.isEmpty ? nil : $0 } ?? SessionStore.passwordResetSentMessage)
    } catch {
      return .failure(error)
    }
  }

  /// Password policy enforced by `POST /auth/password` (shown next to the reset form).
  public static let passwordPolicyMessage = "パスワードは10文字以上で、英字と数字を含めてください。"

  // MARK: Sign-out

  public func signOut(message: String? = nil) async {
    await auth.signOut()
    context.clearSessionData()
    context.api.organization.organizationId = nil
    context.keyValues.set(nil, forKey: StorageKeys.organizationId)
    isOfflineSession = false
    self.message = message
    state = .signedOut
  }

  /// Called by the API client when a 401 could not be recovered by a token refresh.
  public func handleSessionExpired() async {
    guard case .signedIn = state else { return }
    await signOut(message: ErrorCatalog.message(for: "SESSION_EXPIRED"))
  }

  // MARK: Role verification

  private func verifyRole(isRestore: Bool) async {
    let selected = selectedRole
    do {
      let me = try await context.api.send(API.me(selectedRole: selected.role)).value.data
      try acceptOrThrow(me)
      context.setMe(me)
      context.storeCached(me, savedAt: context.now(), key: "me")
      isOfflineSession = false
      message = nil
      state = .signedIn(me)
    } catch {
      await handleVerificationFailure(error, isRestore: isRestore)
    }
  }

  /// Defence in depth on top of the server check.
  private func acceptOrThrow(_ me: Me) throws(ARMSError) {
    if me.role == .admin {
      throw .api(APIErrorBody(code: "ADMIN_USE_WEB", messageJa: SessionStore.adminMessage, requestId: ""), status: 403)
    }
    if me.role != selectedRole.role {
      throw .api(
        APIErrorBody(code: "ROLE_MISMATCH", messageJa: SessionStore.roleMismatchMessage, requestId: ""), status: 403)
    }
    if !me.active {
      throw .api(
        APIErrorBody(code: "ACCOUNT_DISABLED", messageJa: ErrorCatalog.message(for: "ACCOUNT_DISABLED"), requestId: ""),
        status: 403)
    }
  }

  private func handleVerificationFailure(_ error: ARMSError, isRestore: Bool) async {
    switch error.code {
    case "ROLE_MISMATCH":
      // An administrator selecting 受講者/講師 also gets ROLE_MISMATCH: tell them to use the Web app.
      let isAdmin = (try? await context.api.send(API.me(selectedRole: nil)).value.data.role) == .admin
      await signOut(message: isAdmin ? SessionStore.adminMessage : SessionStore.roleMismatchMessage)
    case "ADMIN_USE_WEB":
      await signOut(message: SessionStore.adminMessage)
    case "ORG_SELECTION_REQUIRED":
      let choices = SessionStore.organizations(from: error)
      if choices.isEmpty {
        await signOut(message: error.messageJa)
      } else {
        context.api.organization.organizationId = nil
        state = .choosingOrganization(choices)
      }
    default:
      if error.isConnectivity, isRestore, let cached = context.loadCached(Me.self, key: "me"),
        cached.value.role == selectedRole.role
      {
        // Offline launch: show the last data read-only; the role is re-checked when back online.
        context.setMe(cached.value)
        context.setOnline(false)
        isOfflineSession = true
        state = .signedIn(cached.value)
      } else if error.isConnectivity, isRestore {
        state = .restoreFailed(error.messageJa)
      } else if error.requiresSignIn || error.code == "FORBIDDEN" {
        await signOut(message: messageForRejected(error))
      } else if isRestore {
        state = .restoreFailed(error.messageWithRequestId)
      } else {
        // The role was not verified, so the session must not stay signed in.
        await signOut(message: error.messageWithRequestId)
      }
    }
  }

  private func messageForRejected(_ error: ARMSError) -> String {
    switch error.code {
    case "ROLE_MISMATCH": return SessionStore.roleMismatchMessage
    case "ADMIN_USE_WEB": return SessionStore.adminMessage
    default: return error.messageJa
    }
  }

  static func organizations(from error: ARMSError) -> [OrganizationChoice] {
    guard case .api(let body, _) = error, let list = body.details?["organizations"]?.arrayValue else { return [] }
    return list.compactMap { item in
      guard let id = item["id"]?.stringValue, let name = item["name"]?.stringValue else { return nil }
      return OrganizationChoice(id: id, name: name)
    }
  }

  static func looksLikeEmail(_ s: String) -> Bool {
    let parts = s.split(separator: "@", omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, parts[1].contains("."), !parts[1].hasPrefix("."), !parts[1].hasSuffix(".")
    else { return false }
    return !s.contains(where: { $0.isWhitespace })
  }
}
