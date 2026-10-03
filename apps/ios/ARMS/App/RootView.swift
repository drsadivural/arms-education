import ARMSKit
import SwiftUI

struct RootView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    switch app.session.state {
    case .launching:
      LaunchView()
        .task { await app.launch() }
    case .signedOut:
      LoginView()
        // Also covers forced sign-outs initiated by SessionStore (expired session, role mismatch).
        .task { await app.resetUserState() }
    case .choosingOrganization(let choices):
      OrganizationPickerView(choices: choices)
    case .signedIn(let me):
      MainTabView(me: me)
        .modifier(BiometricOfferAlert())
    case .locked(let kind):
      BiometricLockView(kind: kind)
    case .restoreFailed(let message):
      RestoreFailedView(message: message)
    }
  }
}

private struct LaunchView: View {
  var body: some View {
    VStack(spacing: 24) {
      BrandHeader(subtitle: "新入社員研修システム")
      ProgressView("読み込み中…")
        .foregroundStyle(ARMSColor.muted)
    }
    .padding(ARMSMetrics.gutter)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .armsScreen()
  }
}

/// Face ID / Touch ID lock: the stored session is used only after the biometric check (prompted on appear).
private struct BiometricLockView: View {
  @Environment(AppModel.self) private var app
  let kind: BiometryKind

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      BrandHeader(subtitle: "新入社員研修システム")
      ARMSCard {
        Label("\(kind.labelJa)でログイン", systemImage: kind.systemImage)
          .font(.headline)
          .foregroundStyle(ARMSColor.text)
        Text("前回ログインしたアカウントで続けます。").font(.subheadline).foregroundStyle(ARMSColor.muted)
        if let message = app.session.message { MessageBanner(kind: .error, text: message) }
        PrimaryButton(title: "\(kind.labelJa)でログイン", systemImage: kind.systemImage, isLoading: app.session.isWorking) {
          Task { await app.unlock() }
        }
        SecondaryButton(title: "パスワードでログイン") {
          Task { await app.signOut() }
        }
      }
      Spacer()
    }
    .padding(ARMSMetrics.gutter)
    .armsScreen()
    .task { await app.unlock() }
  }
}

/// After a password sign-in: 「次回から Face ID でログインしますか？」 (once per user; also in 設定).
private struct BiometricOfferAlert: ViewModifier {
  @Environment(AppModel.self) private var app

  func body(content: Content) -> some View {
    @Bindable var session = app.session
    let label = session.biometricAvailability.kind?.labelJa ?? "Face ID"
    content.alert("次回から\(label)でログインしますか？", isPresented: $session.offerBiometricLogin) {
      Button("有効にする") { Task { await session.setBiometricLogin(enabled: true) } }
      Button("今はしない", role: .cancel) { session.declineBiometricLogin() }
    } message: {
      Text("パスワードの代わりに\(label)で本人確認してログインします。設定画面からいつでも変更できます。")
    }
  }
}

private struct RestoreFailedView: View {
  @Environment(AppModel.self) private var app
  let message: String
  @State private var isRetrying = false

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      BrandHeader(subtitle: "新入社員研修システム")
      ARMSCard {
        Label("サーバーに接続できません", systemImage: "wifi.exclamationmark")
          .font(.headline)
          .foregroundStyle(ARMSColor.danger)
        Text(message).font(.subheadline).foregroundStyle(ARMSColor.text)
        PrimaryButton(title: "再試行", systemImage: "arrow.clockwise", isLoading: isRetrying) {
          Task {
            isRetrying = true
            await app.launch()
            isRetrying = false
          }
        }
        SecondaryButton(title: "ログイン画面へ戻る") {
          Task { await app.signOut() }
        }
      }
      Spacer()
    }
    .padding(ARMSMetrics.gutter)
    .armsScreen()
  }
}

/// Bottom tabs: ホーム / 進捗 / 予約 / AI音声 (teachers get the same tabs scoped to their students and lessons).
struct MainTabView: View {
  @Environment(AppModel.self) private var app
  let me: Me

  var body: some View {
    @Bindable var router = app.router
    TabView(selection: $router.tab) {
      NavigationStack(path: $router.homePath) {
        Group {
          if me.role == .teacher { TeacherHomeView() } else { StudentHomeView() }
        }
        .rootToolbar()
        .routeDestinations()
      }
      .tabItem { Label("ホーム", systemImage: "house") }
      .tag(AppTab.home)

      NavigationStack(path: $router.progressPath) {
        Group {
          if me.role == .teacher { TeacherStudentsView() } else { TrainingProgressView() }
        }
        .rootToolbar()
        .routeDestinations()
      }
      .tabItem { Label("進捗", systemImage: "chart.bar") }
      .tag(AppTab.progress)

      NavigationStack(path: $router.bookingPath) {
        Group {
          if me.role == .teacher { TeacherReservationsView() } else { BookingView() }
        }
        .rootToolbar()
        .routeDestinations()
      }
      .tabItem { Label("予約", systemImage: "calendar") }
      .tag(AppTab.booking)

      NavigationStack(path: $router.voicePath) {
        VoiceAssistantView()
          .rootToolbar()
          .routeDestinations()
      }
      .tabItem { Label("AI音声", systemImage: "mic") }
      .tag(AppTab.voice)
    }
  }
}

extension View {
  /// Registers every pushable screen on the current NavigationStack.
  func routeDestinations() -> some View {
    navigationDestination(for: Route.self) { route in
      RouteDestinationView(route: route)
    }
  }

  /// Trailing toolbar on tab roots: お知らせ (with unread badge) and 設定.
  func rootToolbar() -> some View {
    modifier(RootToolbar())
  }
}

private struct RootToolbar: ViewModifier {
  @Environment(AppModel.self) private var app

  func body(content: Content) -> some View {
    content.toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        NavigationLink(value: Route.notifications) {
          Image(systemName: app.context.unreadNotifications > 0 ? "bell.badge" : "bell")
        }
        .accessibilityLabel(
          app.context.unreadNotifications > 0 ? "お知らせ（未読\(app.context.unreadNotifications)件）" : "お知らせ")
        NavigationLink("設定", value: Route.settings)
      }
    }
  }
}

struct RouteDestinationView: View {
  let route: Route

  var body: some View {
    switch route {
    case .todayLessons: TodayLessonsView()
    case .notifications: NotificationsView()
    case .settings: SettingsView()
    case .studentProgress: TrainingProgressView()
    case .unitMaterials(let unitId, let title): UnitMaterialsView(unitId: unitId, unitTitle: title)
    case .quiz(let material): QuizView(material: material)
    case .assignment(let material): AssignmentView(material: material)
    case .reservation(let id): ReservationDetailView(reservationId: id)
    case .bookingConfirm(let slot): BookingConfirmView(slot: slot)
    case .teacherStudents: TeacherStudentsView()
    case .studentDetail(let id): StudentDetailView(studentId: id)
    case .attendance(let slot): AttendanceView(slot: slot)
    case .teacherReservations: TeacherReservationsView()
    case .lessonSlot(let id): LessonSlotView(slotId: id)
    case .reviewQueue: ReviewQueueView()
    }
  }
}
