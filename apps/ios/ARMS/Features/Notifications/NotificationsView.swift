import ARMSKit
import SwiftUI

/// IOS-15 お知らせ: in-app notifications (works even when APNs is denied), read state, deep links.
struct NotificationsView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    ModelHost(make: { NotificationsModel(context: app.context) }) { model in
      NotificationsScreen(model: model)
    }
    .navigationTitle("お知らせ")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct NotificationsScreen: View {
  @Environment(AppModel.self) private var app
  let model: NotificationsModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        LoadStateView(
          state: model.notifications, isEmpty: { $0.items.isEmpty }, retry: model.load,
          empty: { EmptyStateView(systemImage: "bell", title: "お知らせはありません") }
        ) { _ in
          LazyVStack(spacing: 12) {
            ForEach(model.items) { notification in
              NotificationCard(notification: notification, time: model.timeLabel(notification)) {
                Task {
                  if let link = await model.open(notification), let role = app.context.role {
                    app.router.open(link, role: role)
                  }
                }
              }
            }
            if model.canLoadMore {
              SecondaryButton(title: "さらに表示", isLoading: model.isLoadingMore) { Task { await model.loadMore() } }
            }
          }
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
  }
}

private struct NotificationCard: View {
  let notification: AppNotification
  let time: String
  let onOpen: () -> Void

  var body: some View {
    let link = DeepLink.parse(notification.deepLink)
    ARMSCard {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        if !notification.isRead {
          Circle().fill(ARMSColor.primary).frame(width: 8, height: 8).accessibilityHidden(true)
        }
        Text(notification.title).font(.headline).foregroundStyle(ARMSColor.text)
        Spacer()
        Text(time).font(.caption).foregroundStyle(ARMSColor.muted)
      }
      Text(notification.body).font(.subheadline).foregroundStyle(ARMSColor.text)
      if !notification.isRead {
        Text("未読").font(.caption.weight(.semibold)).foregroundStyle(ARMSColor.primaryText)
      }
      if let link {
        LinkButton(title: link.actionLabel, action: onOpen)
      } else if !notification.isRead {
        LinkButton(title: "既読にする", action: onOpen)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(notification.isRead ? notification.title : "未読、\(notification.title)")
  }
}
