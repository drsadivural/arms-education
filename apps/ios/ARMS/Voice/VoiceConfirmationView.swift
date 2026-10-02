import ARMSKit
import SwiftUI

/// IOS-14 音声で予約を確認: the server-prepared card (120 s), explicit confirmation by button or a
/// clear 「はい、申請して」. Nothing is written before that; ambiguous replies never commit.
struct VoiceConfirmationView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let voice: VoiceSessionController
  let cardId: String

  var body: some View {
    NavigationStack {
      TimelineView(.periodic(from: .now, by: 1)) { timeline in
        content(now: timeline.date)
      }
      .armsScreen()
      .navigationTitle("音声で予約を確認")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("閉じる") {
            if voice.conversation?.confirmation.state.isAwaitingUser == true {
              voice.requestChange()
            } else {
              voice.dismissConfirmationResult()
            }
            dismiss()
          }
        }
      }
    }
  }

  @ViewBuilder private func content(now: Date) -> some View {
    let state = voice.conversation?.confirmation.state ?? .none
    if let card = state.card {
      let calendar = app.context.calendar
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          Text(card.prompt)
            .font(.body)
            .foregroundStyle(ARMSColor.text)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ARMSColor.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(ARMSColor.border))

          // Card fields exactly as prepared by the server (`data.card`); nothing is written yet.
          ARMSCard {
            Text(card.intent == .reserve ? "予約申請の内容" : "取消する予約").font(.headline).foregroundStyle(ARMSColor.text)
            VStack(spacing: 0) {
              if let schedule = card.scheduleLabel { KeyValueRow(label: "日時", value: schedule) }
              if let title = card.lessonTitle { KeyValueRow(label: "授業", value: title) }
              if let teacher = card.teacherName { KeyValueRow(label: "担当講師", value: teacher) }
              if let classroom = card.classroomName { KeyValueRow(label: "クラス", value: classroom) }
              if let seats = card.remainingSeats { KeyValueRow(label: "空き", value: JaFormat.remainingSeats(seats)) }
              if let status = card.statusLabel { KeyValueRow(label: "現在の状態", value: status) }
              if let deadline = card.cancelDeadline {
                KeyValueRow(label: "取消期限", value: JaFormat.dateTime(deadline, calendar: calendar))
              }
              KeyValueRow(label: "受講者", value: card.studentName ?? app.context.me?.displayName ?? "—", showsDivider: false)
            }
          }

          switch state {
          case .awaiting:
            InfoNote(text: card.voiceHint)
            PrimaryButton(title: card.confirmButtonTitle, isEnabled: !card.isExpired(now: now) && app.context.canMutate) {
              Task { await voice.confirmByButton() }
            }
            SecondaryButton(title: "内容を変更する") {
              voice.requestChange()
              dismiss()
            }
          case .confirmed:
            // Confirmed by voice: the assistant is sending it; the button must not send a second time.
            InfoNote(text: card.intent == .reserve ? "確認しました。申請を送信しています…" : "確認しました。取消を送信しています…")
            PrimaryButton(title: card.confirmButtonTitle, isLoading: true, isEnabled: false) {}
            SecondaryButton(title: "内容を変更する") {
              voice.requestChange()
              dismiss()
            }
          case .committing:
            PrimaryButton(title: "送信中…", isLoading: true) {}
          case .committed(_, let message):
            MessageBanner(kind: .success, text: message)
            PrimaryButton(title: "閉じる") {
              voice.dismissConfirmationResult()
              dismiss()
            }
          case .failed(_, let message):
            MessageBanner(kind: .error, text: message)
            SecondaryButton(title: "閉じる") {
              voice.dismissConfirmationResult()
              dismiss()
            }
          case .expired:
            MessageBanner(kind: .error, text: "確認の有効期限が切れました。申請は送信していません。もう一度内容を確認してください。")
            SecondaryButton(title: "閉じる") {
              voice.dismissConfirmationResult()
              dismiss()
            }
          case .none, .discarded:
            EmptyView()
          }

          WaveformView(
            isAnimating: voice.uiState == .speaking || voice.uiState == .listening || voice.uiState == .confirming,
            reduceMotion: reduceMotion
          )
          .frame(height: 70)
          .accessibilityHidden(true)

          if state.isAwaitingUser {
            Text(card.remainingLabel(now: now))
              .font(.footnote)
              .foregroundStyle(ARMSColor.muted)
              .frame(maxWidth: .infinity)
              .accessibilityLabel(card.remainingLabel(now: now))
          }
        }
        .padding(ARMSMetrics.gutter)
      }
    } else {
      VStack(spacing: 12) {
        Text("確認内容はありません。").foregroundStyle(ARMSColor.muted)
        SecondaryButton(title: "閉じる") { dismiss() }
      }
      .padding(ARMSMetrics.gutter)
    }
  }
}

/// Decorative waveform; static when Reduce Motion is on or nothing is happening.
struct WaveformView: View {
  let isAnimating: Bool
  let reduceMotion: Bool
  private let heights: [CGFloat] = [0.2, 0.35, 0.5, 0.3, 0.65, 0.85, 0.55, 1.0, 0.7, 0.45, 0.9, 0.6, 0.35, 0.75, 0.5, 0.3, 0.2]

  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !isAnimating || reduceMotion)) { timeline in
      let t = timeline.date.timeIntervalSinceReferenceDate
      GeometryReader { geo in
        HStack(alignment: .center, spacing: 6) {
          ForEach(heights.indices, id: \.self) { i in
            let wave = isAnimating && !reduceMotion ? (sin(t * 6 + Double(i) * 0.7) + 1) / 2 : 0.5
            Capsule()
              .fill(ARMSColor.primary.opacity(isAnimating ? 0.9 : 0.4))
              .frame(width: 5, height: max(6, geo.size.height * heights[i] * CGFloat(0.55 + 0.45 * wave)))
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
  }
}
