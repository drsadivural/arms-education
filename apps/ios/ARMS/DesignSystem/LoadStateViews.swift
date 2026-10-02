import ARMSKit
import SwiftUI

/// Common list/screen states: skeleton while loading, error with retry (and request id),
/// empty with the next action, offline banner (cached, read-only) and 「最終更新 HH:mm」.
struct LoadStateView<Value: Sendable, Content: View, Empty: View>: View {
  @Environment(AppModel.self) private var app
  let state: Loadable<Value>
  var isEmpty: (Value) -> Bool = { _ in false }
  let retry: () async -> Void
  @ViewBuilder var empty: () -> Empty
  @ViewBuilder var content: (Value) -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if state.isCached || !app.context.isOnline {
        OfflineBanner()
      }
      if let error = state.error, state.hasValue, !state.isCached {
        MessageBanner(kind: .error, text: error.messageWithRequestId)
      }
      if state.isInitialLoading {
        SkeletonList()
      } else if let value = state.value {
        if isEmpty(value) {
          empty()
        } else {
          content(value)
        }
        if let label = app.context.lastUpdatedLabel(state) {
          Text(label)
            .font(.caption)
            .foregroundStyle(ARMSColor.muted)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .accessibilityLabel(label)
        }
      } else if let error = state.error {
        ErrorStateView(error: error, retry: retry)
      } else {
        SkeletonList()
      }
    }
  }
}

extension LoadStateView where Empty == EmptyView {
  init(
    state: Loadable<Value>, retry: @escaping () async -> Void, @ViewBuilder content: @escaping (Value) -> Content
  ) {
    self.state = state
    self.retry = retry
    self.empty = { EmptyView() }
    self.content = content
  }
}

struct OfflineBanner: View {
  var body: some View {
    MessageBanner(kind: .info, text: "オフラインです。最後に取得した内容を表示しています（変更はできません）。")
  }
}

struct ErrorStateView: View {
  let error: ARMSError
  let retry: () async -> Void
  @State private var isRetrying = false

  var body: some View {
    ARMSCard {
      Label("読み込めませんでした", systemImage: "exclamationmark.triangle")
        .font(.headline)
        .foregroundStyle(ARMSColor.danger)
      Text(error.messageJa).font(.subheadline).foregroundStyle(ARMSColor.text)
      if let id = error.requestId, !id.isEmpty {
        Text("問い合わせ番号: \(id)").font(.caption).foregroundStyle(ARMSColor.muted).textSelection(.enabled)
      }
      SecondaryButton(title: "再試行", systemImage: "arrow.clockwise", isLoading: isRetrying) {
        Task {
          isRetrying = true
          await retry()
          isRetrying = false
        }
      }
    }
  }
}

struct EmptyStateView: View {
  let systemImage: String
  let title: String
  var message: String? = nil
  var actionTitle: String? = nil
  var action: (() -> Void)? = nil

  var body: some View {
    ARMSCard {
      VStack(spacing: 10) {
        Image(systemName: systemImage)
          .font(.largeTitle)
          .foregroundStyle(ARMSColor.muted)
          .accessibilityHidden(true)
        Text(title).font(.headline).foregroundStyle(ARMSColor.text).multilineTextAlignment(.center)
        if let message {
          Text(message).font(.subheadline).foregroundStyle(ARMSColor.muted).multilineTextAlignment(.center)
        }
        if let actionTitle, let action {
          SecondaryButton(title: actionTitle, action: action).padding(.top, 4)
        }
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 8)
    }
  }
}

struct SkeletonList: View {
  var rows = 3

  var body: some View {
    VStack(spacing: 12) {
      ForEach(0..<rows, id: \.self) { _ in
        ARMSCard {
          RoundedRectangle(cornerRadius: 6).fill(ARMSColor.surfaceMuted).frame(width: 160, height: 18)
          RoundedRectangle(cornerRadius: 6).fill(ARMSColor.surfaceMuted).frame(height: 14)
          RoundedRectangle(cornerRadius: 6).fill(ARMSColor.surfaceMuted).frame(width: 220, height: 14)
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("読み込み中")
  }
}
