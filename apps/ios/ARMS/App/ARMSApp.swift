import ARMSKit
import SwiftUI

@main
struct ARMSApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @Environment(\.scenePhase) private var scenePhase
  @State private var bootstrap = Bootstrap()

  var body: some Scene {
    WindowGroup {
      Group {
        switch bootstrap.state {
        case .ready(let app):
          RootView()
            .environment(app)
            .preferredColorScheme(app.theme.colorScheme)
            .onOpenURL { app.handle(url: $0) }
            .task { appDelegate.app = app }
        case .misconfigured(let problem):
          ConfigurationErrorView(problem: problem)
        }
      }
      .tint(ARMSColor.primary)
    }
    .onChange(of: scenePhase) { _, phase in
      guard case .ready(let app) = bootstrap.state else { return }
      Task { await app.scenePhaseChanged(isActive: phase == .active, isBackground: phase == .background) }
    }
  }
}

/// Builds the app from Info.plist configuration once per process.
@MainActor
@Observable
final class Bootstrap {
  enum State {
    case ready(AppModel)
    case misconfigured(AppConfiguration.Problem)
  }

  let state: State

  init() {
    switch AppConfiguration.load(from: Bundle.main.infoDictionary) {
    case .success(let configuration):
      state = .ready(AppModel(configuration: configuration))
    case .failure(let problem):
      state = .misconfigured(problem)
    }
  }
}

/// Shown when the build was made without the customer's connection settings.
struct ConfigurationErrorView: View {
  let problem: AppConfiguration.Problem

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        BrandHeader(subtitle: "新入社員研修システム")
        ARMSCard {
          Label("アプリの接続設定が不足しています", systemImage: "gearshape.2")
            .font(.headline)
            .foregroundStyle(ARMSColor.danger)
          Text("このビルドには接続先の設定が含まれていないため、ログインできません。管理者にお問い合わせください。")
            .font(.subheadline)
            .foregroundStyle(ARMSColor.text)
          Text(problemText).font(.caption).foregroundStyle(ARMSColor.muted)
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
  }

  private var problemText: String {
    switch problem {
    case .missing(let keys): return "未設定: \(keys.joined(separator: ", "))"
    case .invalid(let keys): return "形式が正しくありません: \(keys.joined(separator: ", "))"
    }
  }
}
