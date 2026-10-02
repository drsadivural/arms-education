import ARMSKit
import SwiftUI
import UniformTypeIdentifiers

/// 確認テスト: answers are scored on the server; the app never has the correct answers.
struct QuizView: View {
  @Environment(AppModel.self) private var app
  let material: Material

  var body: some View {
    ModelHost(make: { QuizModel(material: material, context: app.context) }) { model in
      QuizScreen(model: model)
    }
    .navigationTitle("確認テスト")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct QuizScreen: View {
  @Environment(AppModel.self) private var app
  let model: QuizModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        LoadStateView(state: model.quiz, retry: model.load) { envelope in
          let quiz = envelope.data
          ARMSCard {
            Text(quiz.title).font(.headline).foregroundStyle(ARMSColor.text)
            Text(QuizSession.summary(quiz)).font(.subheadline).foregroundStyle(ARMSColor.muted)
            Text(QuizSession.policyText(quiz)).font(.caption).foregroundStyle(ARMSColor.muted)
            if let current = QuizSession.currentScoreText(quiz) {
              Text(current).font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
            }
            if !model.material.description.isEmpty {
              Text(model.material.description).font(.subheadline).foregroundStyle(ARMSColor.text)
            }
          }
          if let result = model.result {
            resultCard(result, quiz: quiz)
          } else if quiz.attemptsRemaining <= 0 {
            InfoNote(text: "受験回数の上限に達しました。結果は進捗画面で確認できます。", tone: .warning)
          } else if let session = model.session, let question = session.currentQuestion {
            questionCard(session: session, question: question)
          }
          if let error = model.error {
            MessageBanner(kind: .error, text: error.messageWithRequestId)
          }
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .task { await model.load() }
  }

  private func questionCard(session: QuizSession, question: QuizQuestion) -> some View {
    ARMSCard {
      Text("Q\(session.currentIndex + 1). \(question.prompt)")
        .font(.headline)
        .foregroundStyle(ARMSColor.text)
        .accessibilityAddTraits(.isHeader)
      Text("\(session.currentIndex + 1) / \(session.questionCount)問").font(.caption).foregroundStyle(ARMSColor.muted)
      ForEach(question.choices) { choice in
        let selected = session.selected(for: question.id).contains(choice.id)
        Button {
          model.select(choice.id, for: question.id)
        } label: {
          HStack(spacing: 10) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
              .foregroundStyle(selected ? ARMSColor.primary : ARMSColor.muted)
              .accessibilityHidden(true)
            Text(choice.label).font(.subheadline).foregroundStyle(ARMSColor.text).multilineTextAlignment(.leading)
            Spacer(minLength: 0)
          }
          .padding(14)
          .frame(minHeight: ARMSMetrics.minTapTarget)
          .background(
            selected ? ARMSColor.infoBackground : ARMSColor.surface,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
          )
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .strokeBorder(selected ? ARMSColor.primary : ARMSColor.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
      HStack(spacing: 12) {
        if session.currentIndex > 0 {
          SecondaryButton(title: "前の問題へ") { model.previous() }
        }
        if session.isLastQuestion {
          PrimaryButton(title: "回答を送信", isLoading: model.isSubmitting, isEnabled: model.canSubmit) {
            Task { await model.submit() }
          }
        } else {
          PrimaryButton(title: "次の問題へ", isEnabled: session.canAdvance) { model.next() }
        }
      }
    }
  }

  private func resultCard(_ result: QuizResult, quiz: Quiz) -> some View {
    ARMSCard {
      Text("結果").font(.headline).foregroundStyle(ARMSColor.text)
      HStack {
        Text(model.resultText ?? "").font(.title2.bold()).foregroundStyle(ARMSColor.text)
        Spacer()
        StatusTag(label: result.passed ? "合格" : "不合格", tone: result.passed ? .success : .danger)
      }
      if let detail = model.resultDetail {
        Text(detail).font(.subheadline).foregroundStyle(ARMSColor.text)
      }
      if let policy = model.resultPolicyText {
        Text(policy).font(.subheadline).foregroundStyle(ARMSColor.muted)
      }
      Text("採点はサーバーで行われ、進捗に反映されます。").font(.footnote).foregroundStyle(ARMSColor.muted)
      if model.canRetry {
        SecondaryButton(title: "もう一度受験する", isEnabled: app.context.canMutate) { Task { await model.retry() } }
      }
    }
  }
}

/// 課題の提出 (text and/or one PDF・PNG・JPEG file via the quarantine upload flow).
struct AssignmentView: View {
  @Environment(AppModel.self) private var app
  let material: Material

  var body: some View {
    ModelHost(make: { AssignmentModel(material: material, context: app.context) }) { model in
      AssignmentScreen(model: model)
    }
    .navigationTitle("課題の提出")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct AssignmentScreen: View {
  @Environment(AppModel.self) private var app
  @Bindable var model: AssignmentModel
  @State private var importing = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text(model.material.title).font(.title3.bold()).foregroundStyle(ARMSColor.text)
        if !model.material.description.isEmpty {
          Text(model.material.description).font(.subheadline).foregroundStyle(ARMSColor.text)
        }
        if let feedback = model.teacherFeedback {
          InfoNote(text: "講師コメント：\(feedback)", tone: .warning)
        }
        if let submission = model.submission, let message = model.successMessage {
          MessageBanner(kind: .success, text: message)
          ARMSCard {
            Text("提出内容").font(.headline).foregroundStyle(ARMSColor.text)
            if !submission.body.isEmpty {
              Text(submission.body).font(.body).foregroundStyle(ARMSColor.text)
            }
            if submission.hasFile {
              Label(submission.filename ?? "添付ファイル", systemImage: "paperclip").font(.subheadline).foregroundStyle(ARMSColor.text)
              if submission.scanState == .pending {
                Text("添付ファイルはウイルス検査中です。検査が終わると講師が確認できます。").font(.footnote).foregroundStyle(ARMSColor.muted)
              }
            }
            StatusTag(label: submission.state.labelJa, tone: submission.state.tone)
          }
        } else if let blocked = model.blockedReason {
          InfoNote(text: blocked, tone: .info)
        } else {
          VStack(alignment: .leading, spacing: 6) {
            Text("提出内容（ファイルを添付する場合は任意）").font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
            TextField("課題への回答を入力してください", text: $model.body, axis: .vertical)
              .lineLimit(6...16)
              .padding(14)
              .background(ARMSColor.surface, in: RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius))
              .overlay(RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius).strokeBorder(ARMSColor.border))
              .accessibilityLabel("提出内容")
            HStack {
              if let error = model.error?.fieldErrors["body"] { FieldError(text: error) }
              Spacer()
              Text(model.characterCountLabel).font(.caption).foregroundStyle(ARMSColor.muted)
            }
          }
          attachmentSection
          if let error = model.error, error.fieldErrors.isEmpty {
            MessageBanner(kind: .error, text: error.messageWithRequestId)
          }
          PrimaryButton(
            title: model.progressLabel ?? "提出する", isLoading: model.isSubmitting, isEnabled: app.context.canMutate
          ) {
            Task { await model.submit() }
          }
          Text("提出後は講師が評価します。評価結果はお知らせと進捗画面で確認できます。")
            .font(.footnote)
            .foregroundStyle(ARMSColor.muted)
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf, .png, .jpeg]) { result in
      guard case .success(let url) = result else { return }
      attach(url)
    }
  }

  @ViewBuilder private var attachmentSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("添付ファイル（任意・PDF／PNG／JPEG・20MBまで）").font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
      if let attachment = model.attachment {
        HStack {
          Label(attachment.label, systemImage: "paperclip").font(.subheadline).foregroundStyle(ARMSColor.text)
          Spacer()
          Button("削除", role: .destructive) { model.removeAttachment() }
            .font(.subheadline)
            .frame(minHeight: ARMSMetrics.minTapTarget)
            .disabled(model.isSubmitting)
        }
      } else {
        SecondaryButton(title: "ファイルを選択", systemImage: "paperclip", isEnabled: !model.isSubmitting) { importing = true }
      }
      if let error = model.error?.fieldErrors["file"] { FieldError(text: error) }
    }
  }

  /// Reads the picked file (security-scoped) and hands it to the model, which checks type and size.
  private func attach(_ url: URL) {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    guard let data = try? Data(contentsOf: url) else {
      model.removeAttachment()
      return
    }
    let ext = url.pathExtension.lowercased()
    let contentType = ext == "pdf" ? "application/pdf" : ext == "png" ? "image/png" : "image/jpeg"
    model.attach(filename: url.lastPathComponent, contentType: contentType, data: data)
  }
}
