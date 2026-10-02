import ARMSKit
import SwiftUI
import UIKit
import UserNotifications

/// IOS-18 設定: theme (server-stored per user), notifications, microphone, voice quota,
/// terms/privacy, account deletion request and sign-out.
struct SettingsView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    ModelHost(make: { SettingsModel(context: app.context) }) { model in
      SettingsScreen(model: model)
    }
    .navigationTitle("設定")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct SettingsScreen: View {
  @Environment(AppModel.self) private var app
  @Environment(\.openURL) private var openURL
  let model: SettingsModel
  @State private var showsDeletion = false
  @State private var confirmingLogout = false
  @State private var microphone: MicrophonePermission = AudioSessionManager.currentPermission()

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if let me = model.me {
          ARMSCard {
            Text("アカウント").font(.headline).foregroundStyle(ARMSColor.text)
            HStack(spacing: 12) {
              AvatarInitial(name: me.displayName)
              VStack(alignment: .leading, spacing: 2) {
                Text(me.displayName).font(.headline).foregroundStyle(ARMSColor.text)
                Text(model.accountSubtitle).font(.caption).foregroundStyle(ARMSColor.muted)
                Text(me.email).font(.caption).foregroundStyle(ARMSColor.muted)
              }
            }
          }
        }

        if let message = model.message { MessageBanner(kind: .success, text: message) }
        if let error = model.error { MessageBanner(kind: .error, text: error.messageWithRequestId) }

        ARMSCard {
          Text("表示と通知").font(.headline).foregroundStyle(ARMSColor.text)
          SettingRow(title: "テーマ") {
            Menu {
              ForEach(ThemePreference.allCases, id: \.self) { theme in
                Button {
                  Task { await model.setTheme(theme) }
                } label: {
                  if theme == model.theme {
                    Label(theme.labelJa, systemImage: "checkmark")
                  } else {
                    Text(theme.labelJa)
                  }
                }
              }
            } label: {
              Text("\(model.theme.labelJa) ›").font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
                .frame(minHeight: ARMSMetrics.minTapTarget)
            }
            .disabled(model.isSaving || !app.context.canMutate)
            .accessibilityLabel("テーマ：\(model.theme.labelJa)")
          }
          Divider().overlay(ARMSColor.border)
          SettingRow(title: "通知") {
            Toggle(
              "通知",
              isOn: Binding(
                get: { model.notificationsEnabled },
                set: { enabled in
                  Task {
                    await model.setNotificationsEnabled(enabled)
                    if enabled { await app.requestNotificationPermissionIfNeeded() }
                  }
                })
            )
            .labelsHidden()
            .disabled(model.isSaving || !app.context.canMutate)
            .accessibilityLabel("通知")
          }
          if model.notificationsEnabled && app.notificationAuthorization == .denied {
            HStack {
              Text("端末の設定で通知が許可されていません。アプリ内のお知らせは引き続き確認できます。")
                .font(.footnote)
                .foregroundStyle(ARMSColor.muted)
              Spacer()
              Button("設定を開く") { openSystemSettings() }.font(.footnote)
            }
          }
          Divider().overlay(ARMSColor.border)
          SettingRow(title: "言語") {
            Text("日本語").font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
          }
        }

        ARMSCard {
          Text("音声とプライバシー").font(.headline).foregroundStyle(ARMSColor.text)
          Button {
            openSystemSettings()
          } label: {
            SettingRow(title: "マイクの設定") {
              Text("\(microphoneLabel) ›").font(.subheadline).foregroundStyle(ARMSColor.text)
            }
          }
          .buttonStyle(.plain)
          .accessibilityLabel("マイクの設定：\(microphoneLabel)")
          Divider().overlay(ARMSColor.border)
          SettingRow(title: "本日の音声利用") {
            // GET /voice/quota (organisation-timezone day; open sessions count their reservation).
            VStack(alignment: .trailing, spacing: 2) {
              Text(app.voice?.quota?.labelJa ?? "—")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ARMSColor.text)
              if let quota = app.voice?.quota {
                Text(quota.remainingLabelJa).font(.caption).foregroundStyle(ARMSColor.muted)
              }
            }
            .accessibilityElement(children: .combine)
          }
          Divider().overlay(ARMSColor.border)
          Text("音声・会話全文は保存しません。").font(.footnote).foregroundStyle(ARMSColor.muted)
        }

        ARMSCard {
          Text("サポート").font(.headline).foregroundStyle(ARMSColor.text)
          if let terms = app.configuration.termsURL {
            linkRow("利用規約") { openURL(terms) }
            Divider().overlay(ARMSColor.border)
          }
          if let privacy = app.configuration.privacyPolicyURL {
            linkRow("プライバシーポリシー") { openURL(privacy) }
            Divider().overlay(ARMSColor.border)
          }
          linkRow("アカウント削除の申請") { showsDeletion = true }
        }

        SecondaryButton(title: "ログアウト", role: .destructive) { confirmingLogout = true }

        Text("ARMS \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")")
          .font(.caption)
          .foregroundStyle(ARMSColor.muted)
          .frame(maxWidth: .infinity)
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .onAppear { microphone = AudioSessionManager.currentPermission() }
    .task {
      await app.refreshNotificationAuthorization()
      await app.voice?.refreshQuota()
    }
    .sheet(isPresented: $showsDeletion) { AccountDeletionSheet(model: model) }
    .confirmationDialog("ログアウトしますか？", isPresented: $confirmingLogout, titleVisibility: .visible) {
      Button("ログアウト", role: .destructive) { Task { await app.signOut() } }
      Button("キャンセル", role: .cancel) {}
    }
  }

  private var microphoneLabel: String {
    switch microphone {
    case .granted: return "許可"
    case .denied: return "未許可"
    case .undetermined: return "未確認"
    }
  }

  private func linkRow(_ title: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      SettingRow(title: title) {
        Image(systemName: "chevron.right").font(.footnote).foregroundStyle(ARMSColor.muted).accessibilityHidden(true)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
  }

  private func openSystemSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
  }
}

private struct SettingRow<Trailing: View>: View {
  let title: String
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack {
      Text(title).font(.subheadline).foregroundStyle(ARMSColor.text)
      Spacer()
      trailing
    }
    .frame(minHeight: ARMSMetrics.minTapTarget)
    .contentShape(Rectangle())
  }
}

/// App Store requirement: in-app account deletion request (reviewed by an administrator).
private struct AccountDeletionSheet: View {
  @Environment(\.dismiss) private var dismiss
  let model: SettingsModel
  @State private var reason = ""
  @State private var confirming = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          InfoNote(
            text: "アカウント削除を申請すると、管理者が確認したうえでアカウントと関連データを削除します。研修記録の保存期間は組織の規定に従います。",
            tone: .warning)
          VStack(alignment: .leading, spacing: 6) {
            Text("理由（任意・1,000文字以内）").font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
            TextField("例：退職のため", text: $reason, axis: .vertical)
              .lineLimit(3...6)
              .armsTextField()
          }
          if let error = model.error { MessageBanner(kind: .error, text: error.messageWithRequestId) }
          if model.deletionRequested, let message = model.message {
            MessageBanner(kind: .success, text: message)
            PrimaryButton(title: "閉じる") { dismiss() }
          } else {
            SecondaryButton(title: "削除を申請する", isLoading: model.isRequestingDeletion, role: .destructive) {
              confirming = true
            }
          }
        }
        .padding(ARMSMetrics.gutter)
      }
      .armsScreen()
      .navigationTitle("アカウント削除の申請")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
      .confirmationDialog("アカウント削除を申請しますか？", isPresented: $confirming, titleVisibility: .visible) {
        Button("申請する", role: .destructive) { Task { await model.requestAccountDeletion(reason: reason) } }
        Button("キャンセル", role: .cancel) {}
      } message: {
        Text("管理者の確認後、このアカウントではログインできなくなります。")
      }
    }
  }
}
