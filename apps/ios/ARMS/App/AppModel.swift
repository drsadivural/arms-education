import ARMSKit
import Foundation
import Observation
import UIKit
import UserNotifications

/// Forwards "session expired" from the API client (any thread) to the session store (MainActor).
@MainActor
final class SessionExpiryRelay {
  weak var store: SessionStore?
  func fire() async { await store?.handleSessionExpired() }
}

/// Composition root: services, session, navigation and app-wide lifecycle.
@MainActor
@Observable
final class AppModel {
  let configuration: AppConfiguration
  let context: AppContext
  let session: SessionStore
  let router = Router()
  private let connectivity = ConnectivityMonitor()
  private let push: PushRegistration
  @ObservationIgnored private var pendingDeepLink: DeepLink?
  @ObservationIgnored private var pendingDeviceToken: Data?
  private(set) var voice: VoiceSessionController?
  /// Identity the voice controller was built for (rebuilt when another user or role signs in).
  @ObservationIgnored private var voiceOwner: (id: String, role: Role)?
  /// System notification permission (Settings screen shows it next to the server preference).
  private(set) var notificationAuthorization: UNAuthorizationStatus = .notDetermined

  init(configuration: AppConfiguration) {
    self.configuration = configuration
    let bundleId = Bundle.main.bundleIdentifier ?? "arms"
    let keyValues = UserDefaultsKeyValueStore()
    let tokenStore = KeychainTokenStore(service: "\(bundleId).auth")
    let auth = SupabaseAuthService(
      supabaseURL: configuration.supabaseURL, publishableKey: configuration.supabasePublishableKey,
      storage: KeychainAuthStorage(tokens: tokenStore))
    let relay = SessionExpiryRelay()
    let api = APIClient(
      baseURL: configuration.apiBaseURL, transport: URLSessionTransport(), tokens: auth,
      onSessionExpired: { await relay.fire() })
    let context = AppContext(api: api, cache: Self.makeCache(), keyValues: keyValues)
    let session = SessionStore(auth: auth, context: context)
    relay.store = session
    self.context = context
    self.session = session
    self.push = PushRegistration(context: context)
    connectivity.start(updating: context)
  }

  private static func makeCache() -> any ResponseCache {
    let base =
      FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    var directory = base.appendingPathComponent("ARMS/ResponseCache", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? directory.setResourceValues(values)
    return FileResponseCache(directory: directory, writeOptions: [.atomic, .completeFileProtection])
  }

  /// Cached theme is used before `/me` arrives so the launch screen does not flash.
  var theme: ThemePreference {
    context.me?.preferences.theme
      ?? context.keyValues.string(forKey: StorageKeys.theme).flatMap(ThemePreference.init(rawValue:)) ?? .system
  }

  // MARK: Lifecycle

  func launch() async {
    await session.restore()
    await afterSignInIfNeeded()
  }

  func signIn(email: String, password: String) async {
    await session.signIn(email: email, password: password)
    await afterSignInIfNeeded()
  }

  func chooseOrganization(_ choice: OrganizationChoice) async {
    await session.chooseOrganization(choice)
    await afterSignInIfNeeded()
  }

  func signOut() async {
    // While the access token is still valid: DELETE /devices/{token_hash} so this device stops receiving the
    // user's pushes (best effort; offline sign-out still completes).
    if context.isOnline { await push.unregister() }
    await resetUserState()
    await session.signOut()
  }

  /// Clears everything tied to the signed-in user. Runs for explicit sign-out and whenever the session ends for other
  /// reasons (expired token, role mismatch, disabled account), so voice/microphone, push registration and navigation
  /// never leak into the next session. Idempotent. (After a forced sign-out the server drops the device row when the
  /// next user registers the same token.)
  func resetUserState() async {
    await voice?.end(reason: .user)
    voice = nil
    voiceOwner = nil
    push.reset()
    router.reset()
  }

  private func afterSignInIfNeeded() async {
    guard let me = session.me else {
      await resetUserState()
      return
    }
    if voice == nil || voiceOwner?.id != me.id || voiceOwner?.role != me.role {
      await voice?.end(reason: .user)
      voice = makeVoiceController(for: me)
      voiceOwner = (me.id, me.role)
    }
    if let link = pendingDeepLink {
      pendingDeepLink = nil
      router.open(link, role: me.role)
    }
    await refreshNotificationAuthorization()
    if me.preferences.notificationsEnabled {
      await requestNotificationPermissionIfNeeded()
    }
    if let token = pendingDeviceToken {
      pendingDeviceToken = nil
      await push.register(deviceToken: token, environment: configuration.apnsEnvironment)
    }
  }

  private func makeVoiceController(for me: Me) -> VoiceSessionController {
    let api = context.api
    let context = self.context
    return VoiceSessionController(
      api: api, role: me.role, calendar: me.calendar, audio: AudioSessionManager(), keyValues: context.keyValues,
      makeTransport: { WebRTCRealtimeTransport(callsClient: RealtimeCallsClient(transport: URLSessionTransport())) },
      isOnline: { [weak context] in context?.isOnline ?? false })
  }

  /// Scene phase handling: foreground re-fetches reservations/progress; background stops voice.
  func scenePhaseChanged(isActive: Bool, isBackground: Bool) async {
    if isActive, session.me != nil {
      context.requestRefresh()
      await session.refreshMe()
      await refreshNotificationAuthorization()
    } else if isBackground {
      await voice?.handleBackground()
    }
  }

  // MARK: Deep links & push

  func handle(url: URL) {
    guard let link = DeepLink.parse(url: url) else { return }
    handle(link)
  }

  func handle(_ link: DeepLink) {
    if let me = session.me {
      router.open(link, role: me.role)
    } else {
      pendingDeepLink = link
    }
  }

  func didRegisterForRemoteNotifications(deviceToken: Data) async {
    guard session.me != nil else {
      pendingDeviceToken = deviceToken
      return
    }
    await push.register(deviceToken: deviceToken, environment: configuration.apnsEnvironment)
  }

  func refreshNotificationAuthorization() async {
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    notificationAuthorization = settings.authorizationStatus
    if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
      UIApplication.shared.registerForRemoteNotifications()
    }
  }

  /// Asks for notification permission once (after sign-in, never at launch). Denial is fine:
  /// in-app notifications keep working.
  func requestNotificationPermissionIfNeeded() async {
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    guard settings.authorizationStatus == .notDetermined else { return }
    let granted = (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) ?? false
    notificationAuthorization = granted ? .authorized : .denied
    if granted { UIApplication.shared.registerForRemoteNotifications() }
  }
}
