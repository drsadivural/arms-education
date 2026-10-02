import Foundation
import Observation

/// Sign-in, server role check and session lifecycle (IOS-01).
///
/// The role is decided by the server: after sign-in (POST /auth/tokens) the app calls `GET /me` with
/// `X-ARMS-Selected-Role`. A mismatch shows 「このアカウントでは選択した利用区分にログインできません」
/// and signs out; administrators are refused with 「管理者の操作はWeb管理画面をご利用ください。」.
///
/// Biometric login (Face ID / Touch ID, opt-in per user): after a password sign-in the app offers it; when it is on,
/// a stored session is not used (no API call) until the biometric check succeeds — at launch and after
/// `relockAfterSeconds` in the background. Changed enrollment, unavailable biometrics or sign-out turn it off and the
/// password is required again.
@MainActor
@Observable
public final class SessionStore {
  public enum State: Equatable, Sendable {
    case launching
    case signedOut
    case choosingOrganization([OrganizationChoice])
    case signedIn(Me)
    /// A stored session exists but biometric login is on: waiting for Face ID / Touch ID.
    case locked(BiometryKind)
    /// Session restore could not reach the server and no cached profile exists.
    case restoreFailed(String)
  }

  public static let roleMismatchMessage = "このアカウントでは選択した利用区分にログインできません"
  public static let adminMessage = "管理者の操作はWeb管理画面をご利用ください。"
  public static let biometricChangedMessage =
    "Face ID / Touch ID の登録内容が変更されたため、パスワードでログインしてください。"
  public static let biometricUnavailableMessage =
    "生体認証を利用できないため、パスワードでログインしてください。"
  public static let biometricLockedOutMessage =
    "生体認証が一時的に利用できません。パスワードでログインしてください。"
  public static let biometricFailedMessage =
    "本人確認ができませんでした。もう一度お試しいただくか、パスワードでログインしてください。"
  /// Background time after which a biometric-protected session locks again.
  public static let relockAfterSeconds: TimeInterval = 5 * 60
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
  /// Device biometrics (refreshed at launch and when settings open).
  public private(set) var biometricAvailability: BiometricAvailability = .unavailable
  /// Show 「次回から Face ID でログインしますか？」 after a password sign-in.
  public var offerBiometricLogin = false
  /// Biometric login is on for the stored session (mirrors StorageKeys.biometricLoginUserId).
  public private(set) var isBiometricLoginEnabled = false

  private let auth: any AuthService
  private let biometrics: (any BiometricAuthenticator)?
  public let context: AppContext

  public init(auth: any AuthService, context: AppContext, biometrics: (any BiometricAuthenticator)? = nil) {
    self.auth = auth
    self.biometrics = biometrics
    self.context = context
    self.isBiometricLoginEnabled = context.keyValues.string(forKey: StorageKeys.biometricLoginUserId) != nil
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

  /// Restores the stored session (Keychain) and re-verifies the role with the server. With biometric login on, the
  /// session stays locked (nothing is sent) until `unlock()` succeeds.
  public func restore() async {
    await refreshBiometricAvailability()
    guard await auth.hasStoredSession() else {
      state = .signedOut
      return
    }
    if isBiometricLoginEnabled {
      guard let kind = await biometricLockKind() else { return }
      state = .locked(kind)
      return
    }
    await verifyRole(isRestore: true)
  }

  // MARK: Biometric login

  public func refreshBiometricAvailability() async {
    biometricAvailability = await biometrics?.availability() ?? .unavailable
  }

  /// The kind to lock with, or nil after signing out because biometrics can no longer protect this session.
  private func biometricLockKind() async -> BiometryKind? {
    guard case .available(let kind) = biometricAvailability else {
      await signOut(message: SessionStore.biometricUnavailableMessage)
      return nil
    }
    let stored = context.keyValues.string(forKey: StorageKeys.biometricLoginEnrollment)
    let current = await biometrics?.enrollmentState()?.base64EncodedString()
    guard let stored, stored == current else {
      await signOut(message: SessionStore.biometricChangedMessage)
      return nil
    }
    return kind
  }

  /// Face ID / Touch ID → the stored session is used (role re-checked with the server as at launch).
  public func unlock() async {
    guard case .locked = state, let biometrics, !isWorking else { return }
    isWorking = true
    let result = await biometrics.authenticate(reason: "ARMSにログインします")
    isWorking = false
    switch result {
    case .success:
      message = nil
      // Enrollment may have changed while the app was in the background.
      guard await biometricLockKind() != nil else { return }
      state = .launching
      await verifyRole(isRestore: true)
    case .cancelled:
      break
    case .fallbackToPassword:
      await signOut()
    case .lockedOut:
      await signOut(message: SessionStore.biometricLockedOutMessage)
    case .unavailable:
      await signOut(message: SessionStore.biometricUnavailableMessage)
    case .failed:
      message = SessionStore.biometricFailedMessage
    }
  }

  /// 「パスワードでログイン」 on the lock screen.
  public func usePasswordInstead() async {
    await signOut()
  }

  /// Locks a signed-in session after `relockAfterSeconds` in the background (biometric login on only).
  public func lockAfterBackground(seconds: TimeInterval) {
    guard seconds >= SessionStore.relockAfterSeconds, case .signedIn = state, isBiometricLoginEnabled,
      case .available(let kind) = biometricAvailability
    else { return }
    state = .locked(kind)
  }

  /// Turns biometric login on (after a successful check) or off. Returns false when it could not be turned on.
  @discardableResult
  public func setBiometricLogin(enabled: Bool) async -> Bool {
    offerBiometricLogin = false
    guard enabled else {
      clearBiometricLogin()
      return true
    }
    await refreshBiometricAvailability()
    guard let me, case .available(let kind) = biometricAvailability, let biometrics else { return false }
    switch await biometrics.authenticate(reason: "\(kind.labelJa)でのログインを有効にします") {
    case .success:
      context.keyValues.set(me.id, forKey: StorageKeys.biometricLoginUserId)
      context.keyValues.set(await biometrics.enrollmentState()?.base64EncodedString(), forKey: StorageKeys.biometricLoginEnrollment)
      isBiometricLoginEnabled = true
      return true
    default:
      return false
    }
  }

  /// 「今はしない」: not offered again to this user on this device (still available in 設定).
  public func declineBiometricLogin() {
    offerBiometricLogin = false
    if let id = me?.id { context.keyValues.set(id, forKey: StorageKeys.biometricLoginDeclinedUserId) }
  }

  private func clearBiometricLogin() {
    context.keyValues.set(nil, forKey: StorageKeys.biometricLoginUserId)
    context.keyValues.set(nil, forKey: StorageKeys.biometricLoginEnrollment)
    isBiometricLoginEnabled = false
  }

  private func offerBiometricLoginIfUseful() {
    guard let me, case .available = biometricAvailability, !isBiometricLoginEnabled,
      context.keyValues.string(forKey: StorageKeys.biometricLoginDeclinedUserId) != me.id
    else { return }
    offerBiometricLogin = true
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
    if me != nil {
      await refreshBiometricAvailability()
      offerBiometricLoginIfUseful()
    }
  }

  public func chooseOrganization(_ choice: OrganizationChoice) async {
    context.api.organization.organizationId = choice.id
    context.keyValues.set(choice.id, forKey: StorageKeys.organizationId)
    isWorking = true
    await verifyRole(isRestore: false)
    isWorking = false
    if me != nil {
      await refreshBiometricAvailability()
      offerBiometricLoginIfUseful()
    }
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
    clearBiometricLogin()
    offerBiometricLogin = false
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
