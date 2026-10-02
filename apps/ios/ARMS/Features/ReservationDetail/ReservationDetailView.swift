import ARMSKit
import SwiftUI

/// IOS-10 予約の詳細: status, approved meeting link, cancel deadline, history, cancellation.
struct ReservationDetailView: View {
  @Environment(AppModel.self) private var app
  let reservationId: String

  var body: some View {
    ModelHost(make: { ReservationDetailModel(reservationId: reservationId, context: app.context) }) { model in
      ReservationDetailScreen(model: model)
    }
    .navigationTitle("予約の詳細")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct ReservationDetailScreen: View {
  @Environment(AppModel.self) private var app
  @Environment(\.openURL) private var openURL
  let model: ReservationDetailModel
  @State private var confirmingCancel = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        LoadStateView(state: model.reservation, retry: model.load) { reservation in
          content(reservation)
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
    .confirmationDialog("この予約を取り消しますか？", isPresented: $confirmingCancel, titleVisibility: .visible) {
      Button("予約を取り消す", role: .destructive) {
        Task { await model.cancel(reason: nil) }
      }
      Button("やめる", role: .cancel) {}
    } message: {
      if let r = model.reservation.value {
        Text(
          "\(r.slotTitle ?? "授業") \(JaFormat.dateTimeRange(r.startsAt, r.endsAt, calendar: app.context.calendar)) の予約を取り消します。取り消した枠は他の受講者が予約できるようになります。"
        )
      }
    }
  }

  @ViewBuilder private func content(_ r: Reservation) -> some View {
    let now = app.context.now()
    let calendar = app.context.calendar
    let status = ReservationRules.effectiveStatus(r, now: now)
    ARMSCard {
      Text(r.slotTitle ?? "授業").font(.headline).foregroundStyle(ARMSColor.text)
      VStack(spacing: 8) {
        StatusTag(label: status.labelJa, tone: status.tone)
        Text(ReservationRules.headline(r, now: now))
          .font(.title3.bold())
          .foregroundStyle(ARMSColor.text)
          .multilineTextAlignment(.center)
      }
      .frame(maxWidth: .infinity)
      VStack(spacing: 0) {
        KeyValueRow(label: "日時", value: JaFormat.dateTime(r.startsAt, calendar: calendar))
        KeyValueRow(label: "終了", value: JaFormat.time(r.endsAt, calendar: calendar))
        if let teacher = r.teacherName { KeyValueRow(label: "担当講師", value: teacher) }
        if let classroom = r.classroomName { KeyValueRow(label: "所属クラス", value: classroom) }
        if app.context.role == .teacher, let student = r.studentName { KeyValueRow(label: "受講者", value: student) }
        KeyValueRow(label: "予約番号", value: ReservationRules.referenceNumber(r))
        if status == .pending {
          KeyValueRow(label: "席の保持期限", value: JaFormat.dateTime(r.expiresAt, calendar: calendar))
        }
        if status == .pending || status == .approved {
          KeyValueRow(label: "取消期限", value: JaFormat.dateTime(ReservationRules.cancelDeadline(r), calendar: calendar))
        }
        if status == .rejected, let reason = r.reason, !reason.isEmpty {
          KeyValueRow(label: "却下の理由", value: reason, showsDivider: false)
        }
      }
    }

    if let url = ReservationRules.meetingURL(r) {
      PrimaryButton(title: "授業ページを開く", systemImage: "video") { openURL(url) }
    } else if status == .approved {
      InfoNote(text: "この授業には参加リンクが設定されていません。会場は担当講師の案内をご確認ください。")
    }

    if let history = r.history, !history.isEmpty {
      ARMSCard {
        Text("変更履歴").font(.headline).foregroundStyle(ARMSColor.text)
        ForEach(Array(history.sorted { $0.createdAt > $1.createdAt }.enumerated()), id: \.offset) { _, entry in
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(JaFormat.shortDateTime(entry.createdAt, calendar: calendar))
              .font(.subheadline)
              .foregroundStyle(ARMSColor.text)
              .fixedSize()
            Text(ReservationRules.historyLabel(entry)).font(.subheadline).foregroundStyle(ARMSColor.text)
          }
          .accessibilityElement(children: .combine)
        }
      }
    }

    if let message = model.actionMessage {
      MessageBanner(kind: .success, text: message)
    }
    if let error = model.actionError {
      MessageBanner(kind: .error, text: error.messageWithRequestId)
    }

    if app.context.role == .student {
      if model.canCancel {
        SecondaryButton(title: "予約を取消する", isLoading: model.isCancelling, role: .destructive) {
          confirmingCancel = true
        }
      } else if let reason = ReservationRules.cancelUnavailableReason(r, now: now) {
        Text(reason).font(.footnote).foregroundStyle(ARMSColor.muted)
      }
    }
  }
}
