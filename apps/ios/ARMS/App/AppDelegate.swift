import ARMSKit
import UIKit
import UserNotifications

/// APNs registration and notification taps. The payload's `deep_link` (e.g.
/// `arms://reservations/<id>`) opens the matching screen; the screen re-reads state from the API
/// (push content is never treated as the source of truth).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  @MainActor weak var app: AppModel?

  func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    Task { @MainActor in
      await self.app?.didRegisterForRemoteNotifications(deviceToken: deviceToken)
    }
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
    // Push is optional: in-app notifications (お知らせ) keep working without APNs.
  }

  func application(
    _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    // Content-available pushes only signal that data changed: refresh when the app is next active.
    Task { @MainActor in
      self.app?.context.requestRefresh()
      completionHandler(.newData)
    }
  }

  // Foreground presentation: show the banner and refresh the lists.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    Task { @MainActor in self.app?.context.requestRefresh() }
    completionHandler([.banner, .list, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let raw = response.notification.request.content.userInfo["deep_link"] as? String
    Task { @MainActor in
      if let raw, let link = DeepLink.parse(raw) {
        self.app?.handle(link)
      }
      completionHandler()
    }
  }
}
