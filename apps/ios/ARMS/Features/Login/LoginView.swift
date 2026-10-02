import ARMSKit
import SwiftUI

/// IOS-01 ログイン: 受講者/講師, email/password (Supabase Auth), server role check, password reset.
struct LoginView: View {
  @Environment(AppModel.self) private var app
  @State private var email = ""
  @State private var password = ""
  @State private var showsReset = false
  @FocusState private var focus: Field?

  enum Field { case email, password }

  var body: some View {
    @Bindable var session = app.session
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        BrandHeader()
          .padding(.top, 8)

        VStack(alignment: .leading, spacing: 10) {
          Text("新入社員研修システム")
            .font(.subheadline)
            .foregroundStyle(ARMSColor.primaryText)
          Text("今日の学びが、\n明日の力に。")
            .font(.largeTitle.weight(.bold))
            .foregroundStyle(ARMSColor.text)
            .accessibilityAddTraits(.isHeader)
          Text("授業・進捗・予約をかんたんに確認。")
            .font(.subheadline)
            .foregroundStyle(ARMSColor.text)
        }

        Picker("利用区分", selection: $session.selectedRole) {
          ForEach(SelectableRole.allCases, id: \.self) { role in
            Text(role.labelJa).tag(role)
          }
        }
        .pickerStyle(.segmented)
        .frame(minHeight: ARMSMetrics.minTapTarget)
        .accessibilityLabel("利用区分")

        VStack(alignment: .leading, spacing: 6) {
          Text("メールアドレス").font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
          TextField("例: name@example.co.jp", text: $email)
            .textContentType(.username)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.next)
            .focused($focus, equals: .email)
            .onSubmit { focus = .password }
            .armsTextField(error: session.fieldErrors["email"])
            .accessibilityLabel("メールアドレス")
          if let error = session.fieldErrors["email"] { FieldError(text: error) }
        }

        VStack(alignment: .leading, spacing: 6) {
          Text("パスワード").font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
          SecureField("パスワード", text: $password)
            .textContentType(.password)
            .submitLabel(.go)
            .focused($focus, equals: .password)
            .onSubmit(submit)
            .armsTextField(error: session.fieldErrors["password"])
            .accessibilityLabel("パスワード")
          if let error = session.fieldErrors["password"] { FieldError(text: error) }
        }

        if let message = session.message {
          MessageBanner(kind: .error, text: message)
        }

        PrimaryButton(title: "ログイン", isLoading: session.isWorking, action: submit)

        Button("パスワードをお忘れですか？") { showsReset = true }
          .font(.subheadline)
          .foregroundStyle(ARMSColor.primaryText)
          .frame(maxWidth: .infinity, minHeight: ARMSMetrics.minTapTarget)

        Text("組織から招待されたアカウントで\nログインしてください。")
          .font(.footnote)
          .foregroundStyle(ARMSColor.muted)
          .multilineTextAlignment(.center)
          .frame(maxWidth: .infinity)
      }
      .padding(ARMSMetrics.gutter + 4)
    }
    .scrollDismissesKeyboard(.interactively)
    .armsScreen()
    .sheet(isPresented: $showsReset) {
      PasswordResetSheet(initialEmail: email)
    }
  }

  private func submit() {
    focus = nil
    Task { await app.signIn(email: email, password: password) }
  }
}

struct FieldError: View {
  let text: String
  var body: some View {
    Label(text, systemImage: "exclamationmark.circle")
      .font(.caption)
      .foregroundStyle(ARMSColor.danger)
  }
}

extension View {
  func armsTextField(error: String? = nil) -> some View {
    self
      .padding(.horizontal, 14)
      .frame(minHeight: 52)
      .background(ARMSColor.surface, in: RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius, style: .continuous)
          .strokeBorder(error == nil ? ARMSColor.border : ARMSColor.danger, lineWidth: 1))
      .foregroundStyle(ARMSColor.text)
  }
}

/// パスワード再設定 (`POST /auth/password-reset`; same answer whether or not the address exists).
struct PasswordResetSheet: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @State private var email: String
  @State private var isSending = false
  @State private var result: String?
  @State private var error: String?

  init(initialEmail: String) {
    _email = State(initialValue: initialEmail)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          Text("登録しているメールアドレスを入力してください。パスワード再設定の案内をお送りします。")
            .font(.subheadline)
            .foregroundStyle(ARMSColor.text)
          // The e-mail link opens the ARMS Web page where the new password is set; then sign in here.
          InfoNote(
            text: "メールのリンクから新しいパスワードを設定し、このアプリでログインしてください。\(SessionStore.passwordPolicyMessage)")
          TextField("メールアドレス", text: $email)
            .textContentType(.username)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .armsTextField(error: error)
          if let error { FieldError(text: error) }
          if let result { MessageBanner(kind: .success, text: result) }
          PrimaryButton(title: "再設定メールを送信", isLoading: isSending, isEnabled: result == nil) {
            Task {
              isSending = true
              defer { isSending = false }
              switch await app.session.requestPasswordReset(email: email) {
              case .success(let message):
                result = message
                error = nil
              case .failure(let failure):
                error = failure.fieldErrors["email"] ?? failure.messageWithRequestId
              }
            }
          }
        }
        .padding(ARMSMetrics.gutter)
      }
      .armsScreen()
      .navigationTitle("パスワードの再設定")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("閉じる") { dismiss() }
        }
      }
    }
  }
}

/// Shown when the account belongs to several organisations (`409 ORG_SELECTION_REQUIRED`).
struct OrganizationPickerView: View {
  @Environment(AppModel.self) private var app
  let choices: [OrganizationChoice]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        BrandHeader(subtitle: "新入社員研修システム")
        Text("利用する組織を選択してください")
          .font(.title3.bold())
          .foregroundStyle(ARMSColor.text)
        ForEach(choices) { choice in
          Button {
            Task { await app.chooseOrganization(choice) }
          } label: {
            ARMSCard {
              HStack {
                Text(choice.name).font(.headline).foregroundStyle(ARMSColor.text)
                Spacer()
                Image(systemName: "chevron.right").foregroundStyle(ARMSColor.muted).accessibilityHidden(true)
              }
              .frame(minHeight: ARMSMetrics.minTapTarget)
            }
          }
          .buttonStyle(.plain)
          .disabled(app.session.isWorking)
        }
        if let message = app.session.message { MessageBanner(kind: .error, text: message) }
        SecondaryButton(title: "ログアウト") { Task { await app.signOut() } }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
  }
}
