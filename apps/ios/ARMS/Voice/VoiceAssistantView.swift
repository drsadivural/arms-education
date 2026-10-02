import ARMSKit
import SwiftUI

/// IOS-13 AI音声アシスタント: Japanese voice over native WebRTC, live transcript, state labels,
/// mute / push-to-talk / end / text input. Answers come from the API via allow-listed tools.
struct VoiceAssistantView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    Group {
      if let voice = app.voice {
        VoiceAssistantScreen(voice: voice)
      } else {
        EmptyView()
      }
    }
    .navigationTitle("AI音声アシスタント")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct VoiceAssistantScreen: View {
  @Environment(AppModel.self) private var app
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let voice: VoiceSessionController
  @State private var text = ""
  @State private var showsDisclosure = false
  @FocusState private var textFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(spacing: 16) {
            Text("AIが生成した音声です")
              .font(.footnote)
              .foregroundStyle(ARMSColor.muted)
            WaveformView(isAnimating: voice.uiState == .speaking || voice.uiState == .listening, reduceMotion: reduceMotion)
              .frame(height: 90)
              .accessibilityHidden(true)
            stateChip
            if let status = voice.statusMessage {
              MessageBanner(kind: voice.uiState == .error ? .error : .info, text: status)
            }
            if voice.isRunning, voice.microphonePermission != .granted {
              InfoNote(text: "マイクが許可されていないため、文字入力で利用できます。設定アプリでマイクを許可すると音声で話せます。")
            }
            if let error = voice.conversation?.lastErrorMessage {
              MessageBanner(kind: .error, text: error) { voice.conversation?.clearError() }
            }
            if let conversation = voice.conversation {
              ForEach(conversation.entries) { entry in
                TranscriptBubble(entry: entry).id(entry.id)
              }
            }
            if !voice.isRunning {
              IdleIntro(isTeacher: app.context.role == .teacher)
            }
            Color.clear.frame(height: 1).id("bottom")
          }
          .padding(ARMSMetrics.gutter)
        }
        .onChange(of: voice.conversation?.entries.count ?? 0) { _, _ in
          withAnimation(reduceMotion ? nil : .easeOut) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
      }
      controls
    }
    .armsScreen()
    .sheet(item: confirmationBinding) { card in
      VoiceConfirmationView(voice: voice, cardId: card.id)
        .interactiveDismissDisabled(voice.conversation?.confirmation.state.isAwaitingUser ?? false)
    }
    .alert("AIが生成した音声です", isPresented: $showsDisclosure) {
      Button("同意して開始") {
        voice.acknowledgeDisclosure()
        Task { await voice.start() }
      }
      Button("キャンセル", role: .cancel) {}
    } message: {
      Text(
        "このアシスタントの声はAIが生成しています。会話はOpenAIの音声AIでリアルタイムに処理され、ARMSは音声と会話の全文を保存しません。予約の申請・取消は、確認カードで内容を確認してから実行します。"
      )
    }
  }

  /// The confirmation card sheet is shown while a prepared write is pending or just resolved.
  private var confirmationBinding: Binding<VoiceConfirmationCard?> {
    Binding(
      get: {
        guard let state = voice.conversation?.confirmation.state else { return nil }
        switch state {
        case .awaiting(let card), .confirmed(let card, _), .committing(let card), .committed(let card, _),
          .failed(let card, _), .expired(let card):
          return card
        case .none, .discarded:
          return nil
        }
      },
      set: { newValue in
        guard newValue == nil else { return }
        if voice.conversation?.confirmation.state.isAwaitingUser == true {
          voice.requestChange()
        } else {
          voice.dismissConfirmationResult()
        }
      })
  }

  private var stateChip: some View {
    HStack(spacing: 6) {
      Circle().fill(chipColor).frame(width: 8, height: 8).accessibilityHidden(true)
      Text(voice.uiState.labelJa).font(.subheadline.weight(.semibold))
      if voice.conversation?.isMuted == true {
        Text("・ミュート中").font(.subheadline)
      }
      if !voice.routeName.isEmpty, voice.isRunning {
        Text("・\(voice.routeName)").font(.caption).foregroundStyle(ARMSColor.muted)
      }
    }
    .foregroundStyle(ARMSColor.primaryText)
    .padding(.horizontal, 14)
    .padding(.vertical, 6)
    .background(ARMSColor.infoBackground, in: Capsule())
    .accessibilityElement(children: .combine)
    .accessibilityLabel("状態：\(voice.uiState.labelJa)\(voice.conversation?.isMuted == true ? "、ミュート中" : "")")
  }

  private var chipColor: Color {
    switch voice.uiState {
    case .error: return ARMSColor.danger
    case .reconnecting, .confirming: return ARMSColor.warning
    case .idle: return ARMSColor.muted
    default: return ARMSColor.primary
    }
  }

  @ViewBuilder private var controls: some View {
    VStack(spacing: 10) {
      if voice.isRunning, let conversation = voice.conversation {
        HStack(spacing: 10) {
          TextField("文字で入力する…", text: $text, axis: .vertical)
            .lineLimit(1...3)
            .focused($textFocused)
            .submitLabel(.send)
            .onSubmit(sendText)
            .armsTextField()
          Button(action: sendText) {
            Image(systemName: "paperplane.fill")
              .frame(width: ARMSMetrics.minTapTarget + 6, height: ARMSMetrics.minTapTarget + 6)
              .foregroundStyle(ARMSColor.onPrimary)
              .background(ARMSColor.primary, in: Circle())
          }
          .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          .accessibilityLabel("送信")
        }
        if conversation.pushToTalk {
          PushToTalkButton(
            isTalking: conversation.isTalking, isEnabled: voice.microphonePermission == .granted,
            begin: { voice.beginTalking() }, end: { voice.endTalking() })
        }
        HStack(spacing: 10) {
          SecondaryButton(
            title: conversation.isMuted ? "ミュート解除" : "ミュート",
            systemImage: conversation.isMuted ? "mic.slash" : "mic",
            isEnabled: voice.microphonePermission == .granted && !conversation.pushToTalk
          ) {
            voice.setMuted(!conversation.isMuted)
          }
          SecondaryButton(title: "音声を終了", systemImage: "stop.circle", role: .destructive) {
            Task { await voice.end(reason: .user) }
          }
        }
        Toggle("押して話す", isOn: Binding(get: { conversation.pushToTalk }, set: { voice.setPushToTalk($0) }))
          .font(.subheadline)
          .disabled(voice.microphonePermission != .granted)
          .frame(minHeight: ARMSMetrics.minTapTarget)
      } else {
        PrimaryButton(
          title: voice.uiState == .connecting ? "接続中…" : "AI音声を開始", systemImage: "mic.fill",
          isLoading: voice.uiState == .connecting, isEnabled: app.context.isOnline
        ) {
          if voice.needsDisclosure {
            showsDisclosure = true
          } else {
            Task { await voice.start() }
          }
        }
        if !app.context.isOnline {
          Text("オフラインのため音声機能を利用できません。").font(.footnote).foregroundStyle(ARMSColor.danger)
        }
      }
    }
    .padding(ARMSMetrics.gutter)
    .background(ARMSColor.surface.ignoresSafeArea(edges: .bottom))
    .overlay(alignment: .top) { Divider().overlay(ARMSColor.border) }
  }

  private func sendText() {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    voice.sendText(trimmed)
    text = ""
  }
}

private struct IdleIntro: View {
  let isTeacher: Bool

  var body: some View {
    ARMSCard {
      Text("話しかけてみましょう").font(.headline).foregroundStyle(ARMSColor.text)
      ForEach(examples, id: \.self) { example in
        Label(example, systemImage: "quote.bubble").font(.subheadline).foregroundStyle(ARMSColor.text)
      }
      Text("予約の申請や取消は、確認カードで内容を確認してから実行されます。音声を使わなくても、すべての操作は画面から行えます。")
        .font(.footnote)
        .foregroundStyle(ARMSColor.muted)
    }
  }

  private var examples: [String] {
    isTeacher
      ? ["「今日の授業を教えて」", "「承認待ちの予約はある？」", "「和田さんの進捗は？」"]
      : ["「今日の授業を教えて」", "「私の進捗は何パーセント？」", "「月曜午後の空き枠を探して」", "「予約できている？」"]
  }
}

private struct TranscriptBubble: View {
  @Environment(AppModel.self) private var app
  let entry: VoiceTranscriptEntry

  var body: some View {
    switch entry.speaker {
    case .user:
      HStack {
        Spacer(minLength: 40)
        Text(entry.text.isEmpty ? "…" : entry.text)
          .font(.subheadline)
          .foregroundStyle(ARMSColor.text)
          .padding(14)
          .background(ARMSColor.infoBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
          .accessibilityLabel("あなた：\(entry.text)")
      }
    case .assistant:
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text(entry.text)
            .font(.subheadline)
            .foregroundStyle(ARMSColor.text)
          if entry.interrupted {
            Text("（中断しました）").font(.caption).foregroundStyle(ARMSColor.muted)
          }
        }
        .padding(14)
        .background(ARMSColor.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(ARMSColor.border))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("アシスタント：\(entry.text)")
        Spacer(minLength: 40)
      }
    case .notice:
      if let card = entry.card {
        ResultCardView(card: card)
      } else {
        Text(entry.text)
          .font(.footnote)
          .foregroundStyle(ARMSColor.muted)
          .multilineTextAlignment(.center)
          .frame(maxWidth: .infinity)
      }
    }
  }
}

/// Inline structured result (e.g. 「本日の授業」) built from the API's tool output.
private struct ResultCardView: View {
  @Environment(AppModel.self) private var app
  let card: VoiceResultCard

  var body: some View {
    let calendar = app.context.calendar
    ARMSCard {
      switch card {
      case .lessons(let title, let slots):
        Text(title).font(.headline).foregroundStyle(ARMSColor.text)
        if slots.isEmpty {
          Text("該当する授業はありません").font(.subheadline).foregroundStyle(ARMSColor.muted)
        }
        ForEach(slots) { slot in
          VStack(alignment: .leading, spacing: 4) {
            Text(slot.title).font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
            Text("\(JaFormat.dateTimeRange(slot.startsAt, slot.endsAt, calendar: calendar)) / \(slot.teacherName)")
              .font(.caption)
              .foregroundStyle(ARMSColor.muted)
            if let mine = slot.myReservation {
              StatusTag(label: mine.status.labelJa, tone: mine.status.tone)
            }
          }
        }
      case .reservations(let reservations):
        Text("予約の状況").font(.headline).foregroundStyle(ARMSColor.text)
        ForEach(reservations) { r in
          HStack {
            VStack(alignment: .leading, spacing: 2) {
              Text(r.slotTitle ?? "授業").font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
              Text(JaFormat.dateTimeRange(r.startsAt, r.endsAt, calendar: calendar)).font(.caption)
                .foregroundStyle(ARMSColor.muted)
            }
            Spacer()
            let status = ReservationRules.effectiveStatus(r, now: app.context.now())
            StatusTag(label: status.labelJa, tone: status.tone)
          }
        }
      case .progress(let progress):
        let summary = ProgressSummary(progress: progress)
        Text("研修の進捗").font(.headline).foregroundStyle(ARMSColor.text)
        LinearProgressBar(fraction: summary.fraction, label: summary.percentText)
        Text(summary.requiredText).font(.caption).foregroundStyle(ARMSColor.muted)
      }
    }
  }
}

private struct PushToTalkButton: View {
  let isTalking: Bool
  let isEnabled: Bool
  let begin: () -> Void
  let end: () -> Void

  var body: some View {
    Text(isTalking ? "話しています…（指を離すと送信）" : "押して話す")
      .font(.body.weight(.semibold))
      .foregroundStyle(ARMSColor.onPrimary)
      .frame(maxWidth: .infinity, minHeight: 56)
      .background(isTalking ? ARMSColor.danger : ARMSColor.primary, in: RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius))
      .opacity(isEnabled ? 1 : 0.5)
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { _ in if isEnabled && !isTalking { begin() } }
          .onEnded { _ in if isTalking { end() } }
      )
      .accessibilityElement()
      .accessibilityLabel(isTalking ? "話しています。もう一度操作すると送信します" : "押して話す")
      .accessibilityAddTraits(.isButton)
      .accessibilityAction { if isTalking { end() } else if isEnabled { begin() } }
  }
}
