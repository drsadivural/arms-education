import Foundation
import Observation

/// IOS-15 お知らせ: the user's in-app notifications (all / unread), read state, 「すべて既読」 and
/// deep links.
@MainActor
@Observable
public final class NotificationsModel {
  public enum Filter: String, CaseIterable, Sendable {
    case all
    case unread

    public var labelJa: String {
      switch self {
      case .all: return "すべて"
      case .unread: return "未読"
      }
    }
  }

  public private(set) var notifications = Loadable<Page<AppNotification>>()
  public private(set) var isLoadingMore = false
  public private(set) var isMarkingAll = false
  public private(set) var actionError: ARMSError?
  public private(set) var filter: Filter = .all
  public let context: AppContext

  public init(context: AppContext) { self.context = context }

  public var items: [AppNotification] {
    let list = notifications.value?.items ?? []
    return filter == .unread ? list.filter { !$0.isRead } : list
  }

  public var canLoadMore: Bool { notifications.value?.nextCursor != nil && !isLoadingMore }
  public var canMarkAllRead: Bool { context.unreadNotifications > 0 && !isMarkingAll && context.canMutate }

  public func timeLabel(_ n: AppNotification) -> String {
    JaFormat.notificationTime(n.createdAt, now: context.now(), calendar: context.calendar)
  }

  private func query(cursor: String? = nil) -> ListQuery {
    ListQuery(cursor: cursor, limit: 30, status: filter == .unread ? "unread" : nil)
  }

  public func load() async {
    notifications.beginLoading()
    let api = context.api
    let query = self.query()
    notifications.apply(
      await context.fetch(cacheKey: "notifications/\(filter.rawValue)", checkedAt: { $0.checkedAt }) { () async throws in
        try await api.send(API.notifications(query)).value
      })
    await NotificationsModel.refreshUnreadCount(context: context)
  }

  public func setFilter(_ filter: Filter) async {
    guard filter != self.filter else { return }
    self.filter = filter
    notifications = Loadable()
    await load()
  }

  public func loadMore() async {
    guard let current = notifications.value, let cursor = current.nextCursor, !isLoadingMore else { return }
    isLoadingMore = true
    defer { isLoadingMore = false }
    do {
      let next = try await context.api.send(API.notifications(query(cursor: cursor))).value
      notifications.update(
        Page(items: current.items + next.items, nextCursor: next.nextCursor, checkedAt: current.checkedAt),
        checkedAt: current.checkedAt)
    } catch {
      notifications.apply(.failure(error))
    }
  }

  /// 「すべて既読」 → `POST /notifications/read-all` (`data: {updated}`).
  public func markAllRead() async {
    guard !isMarkingAll else { return }
    if let blocker = context.mutationBlocker() {
      actionError = blocker
      return
    }
    isMarkingAll = true
    actionError = nil
    defer { isMarkingAll = false }
    do {
      let result = try await context.api.send(API.markAllNotificationsRead()).value
      guard result.success else { return }
      let at = result.checkedAt
      notifications.updateValue { page in
        let items = page.items.map { n in
          n.isRead ? n : AppNotification(id: n.id, title: n.title, body: n.body, deepLink: n.deepLink, readAt: at, createdAt: n.createdAt)
        }
        page = Page(items: items, nextCursor: page.nextCursor, checkedAt: page.checkedAt)
      }
      context.unreadNotifications = 0
      if filter == .unread { await load() }
    } catch {
      actionError = error
    }
  }

  /// Marks as read on the server, then returns the deep link to open (if any).
  /// Navigation does not wait for the read call to succeed; the read state is updated only when
  /// the server confirms it.
  public func open(_ notification: AppNotification) async -> DeepLink? {
    let link = DeepLink.parse(notification.deepLink)
    guard !notification.isRead, context.canMutate else { return link }
    do {
      let result = try await context.api.send(API.markNotificationRead(id: notification.id)).value
      if result.success {
        notifications.updateValue { page in
          let items = page.items.map { n in
            n.id == notification.id
              ? AppNotification(
                id: n.id, title: n.title, body: n.body, deepLink: n.deepLink, readAt: result.checkedAt, createdAt: n.createdAt)
              : n
          }
          page = Page(items: items, nextCursor: page.nextCursor, checkedAt: page.checkedAt)
        }
        context.unreadNotifications = max(0, context.unreadNotifications - 1)
      }
    } catch {
      // Opening the destination is still allowed; the item stays unread and is retried next time.
    }
    return link
  }

  /// Unread count for the bell (`GET /notifications?status=unread`, first 100; more shows as 100).
  public static func refreshUnreadCount(context: AppContext) async {
    let query = ListQuery(limit: 100, status: "unread")
    guard let page = try? await context.api.send(API.notifications(query)).value else { return }
    context.unreadNotifications = page.items.filter { !$0.isRead }.count
  }
}

/// IOS-18 設定: theme / notifications preferences (server-stored with If-Match), voice quota,
/// account deletion request and sign-out.
@MainActor
@Observable
public final class SettingsModel {
  public private(set) var isSaving = false
  public private(set) var error: ARMSError?
  public private(set) var message: String?
  public private(set) var deletionRequested = false
  public private(set) var isRequestingDeletion = false
  private var deletionKey = IdempotencyKey()
  public let context: AppContext

  public init(context: AppContext) { self.context = context }

  public var me: Me? { context.me }
  public var theme: ThemePreference { context.me?.preferences.theme ?? .system }
  public var notificationsEnabled: Bool { context.me?.preferences.notificationsEnabled ?? true }

  /// 「受講者 / 新入社員Aクラス」 or 「講師」.
  public var accountSubtitle: String {
    guard let me = context.me else { return "" }
    if let s = me.student { return "\(me.role.labelJa) / \(s.classroomName)" }
    return "\(me.role.labelJa) / \(me.organization.name)"
  }

  public func setTheme(_ theme: ThemePreference) async {
    await save(PreferenceInput(theme: theme, notificationsEnabled: notificationsEnabled))
  }

  public func setNotificationsEnabled(_ enabled: Bool) async {
    await save(PreferenceInput(theme: theme, notificationsEnabled: enabled))
  }

  private func save(_ input: PreferenceInput) async {
    guard let me = context.me, !isSaving else { return }
    if let blocker = context.mutationBlocker() {
      error = blocker
      return
    }
    isSaving = true
    error = nil
    message = nil
    defer { isSaving = false }
    do {
      let response = try await context.api.send(API.updatePreferences(input, rowVersion: me.preferences.rowVersion))
      guard response.value.success else { return }
      let newVersion =
        response.value.data?["row_version"]?.intValue ?? response.etagVersion ?? (me.preferences.rowVersion + 1)
      context.updatePreferences(
        Me.Preferences(theme: input.theme, notificationsEnabled: input.notificationsEnabled, rowVersion: newVersion))
      message = "設定を保存しました。"
    } catch {
      self.error = error
      if error.code == "VERSION_CONFLICT" {
        // Another device changed the settings: reload the current values from the server.
        if let fresh = try? await context.api.send(API.me(selectedRole: me.role)).value.data {
          context.setMe(fresh)
        }
      }
    }
  }

  /// 「アカウント削除の申請」 (`POST /me/account-deletion`). Only shows success after the server confirmed.
  public func requestAccountDeletion(reason: String) async {
    guard !isRequestingDeletion, !deletionRequested else { return }
    if let blocker = context.mutationBlocker() {
      error = blocker
      return
    }
    if reason.count > 1000 {
      error = .validation(["reason": "理由は1,000文字以内で入力してください。"])
      return
    }
    isRequestingDeletion = true
    error = nil
    defer { isRequestingDeletion = false }
    do {
      let result = try await context.api.send(API.requestAccountDeletion(reason: reason, key: deletionKey)).value
      if result.success {
        deletionRequested = true
        message = "アカウント削除の申請を受け付けました。管理者の確認後に削除され、完了時にお知らせします。"
      }
    } catch {
      self.error = error
      if !error.isConnectivity, error.httpStatus.map({ $0 < 500 }) ?? false { deletionKey = IdempotencyKey() }
    }
  }

  public func clearMessages() {
    error = nil
    message = nil
  }
}

/// Registers the APNs device token with `POST /devices` (teacher/student only) and removes it with
/// `DELETE /devices/{token_hash}` on sign-out. `token_hash` = SHA-256 hex of the lower-case hex token
/// (the server returns the same value as `data.token_hash`); it is remembered (non-secret) so that a
/// later launch can still unregister.
@MainActor
public final class PushRegistration {
  private let context: AppContext
  private var lastRegisteredToken: String?

  public init(context: AppContext) { self.context = context }

  /// Hash of the device registered for the signed-in user (nil when none).
  public var registeredTokenHash: String? { context.keyValues.string(forKey: StorageKeys.deviceTokenHash) }

  @discardableResult
  public func register(deviceToken: Data, environment: APNsEnvironment) async -> Bool {
    guard let me = context.me, me.role != .admin else { return false }
    let token = DeviceInput.hexToken(deviceToken)
    guard token != lastRegisteredToken else { return true }
    do {
      let result = try await context.api.send(
        API.registerDevice(DeviceInput(token: token, environment: environment), key: IdempotencyKey())
      ).value
      if result.success {
        lastRegisteredToken = token
        let hash = result.data?["token_hash"]?.stringValue ?? DeviceInput.tokenHash(hexToken: token)
        context.keyValues.set(hash, forKey: StorageKeys.deviceTokenHash)
      }
      return result.success
    } catch {
      return false
    }
  }

  /// Sign-out: unregisters this device for the current user while the session is still valid.
  /// Best effort — push is optional and the server also drops tokens APNs reports as invalid.
  @discardableResult
  public func unregister() async -> Bool {
    guard let hash = registeredTokenHash ?? lastRegisteredToken.map({ DeviceInput.tokenHash(hexToken: $0) }) else {
      return true
    }
    defer { reset() }
    do {
      return try await context.api.send(API.unregisterDevice(tokenHash: hash)).value.success
    } catch {
      return false
    }
  }

  public func reset() {
    lastRegisteredToken = nil
    context.keyValues.set(nil, forKey: StorageKeys.deviceTokenHash)
  }
}
