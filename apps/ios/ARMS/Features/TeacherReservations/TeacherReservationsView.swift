import ARMSKit
import SwiftUI

/// IOS-17 担当授業の予約 (teacher scope): explicit approve / reject with a reason (synced to the Web app).
struct TeacherReservationsView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    ModelHost(make: { TeacherReservationsModel(context: app.context) }) { model in
      TeacherReservationsScreen(model: model)
    }
    .navigationTitle("担当授業の予約")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct TeacherReservationsScreen: View {
  @Environment(AppModel.self) private var app
  @Bindable var model: TeacherReservationsModel
  @State private var rejecting: Reservation?
  @State private var approving: Reservation?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        Picker("表示", selection: $model.filter) {
          ForEach(TeacherReservationsModel.Filter.allCases, id: \.self) { filter in
            Text(filter.labelJa).tag(filter)
          }
        }
        .pickerStyle(.segmented)
        .frame(minHeight: ARMSMetrics.minTapTarget)

        if let message = model.actionMessage { MessageBanner(kind: .success, text: message) }
        if let error = model.actionError { MessageBanner(kind: .error, text: error.messageWithRequestId) }

        LoadStateView(
          state: model.reservations, isEmpty: { _ in model.items.isEmpty }, retry: model.load,
          empty: {
            EmptyStateView(
              systemImage: "tray",
              title: model.filter == .pending ? "承認待ちの予約はありません" : "担当授業の予約はありません")
          }
        ) { _ in
          LazyVStack(spacing: 12) {
            ForEach(model.items) { reservation in
              card(reservation)
            }
          }
        }

        InfoNote(text: "却下には理由を入力します。担当外の予約は表示されません。")
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
    .sheet(item: $rejecting) { reservation in
      RejectReasonSheet(reservation: reservation, model: model)
    }
    .confirmationDialog(
      "この予約を承認しますか？", isPresented: Binding(get: { approving != nil }, set: { if !$0 { approving = nil } }),
      titleVisibility: .visible, presenting: approving
    ) { reservation in
      Button("承認する") { Task { await model.approve(reservation) } }
      Button("やめる", role: .cancel) {}
    } message: { reservation in
      Text("\(reservation.studentName ?? "受講者")さんの「\(reservation.slotTitle ?? "授業")」\(JaFormat.dateTimeRange(reservation.startsAt, reservation.endsAt, calendar: app.context.calendar))の予約を承認し、確定します。")
    }
  }

  private func card(_ r: Reservation) -> some View {
    let status = ReservationRules.effectiveStatus(r, now: app.context.now())
    return ARMSCard {
      HStack(alignment: .firstTextBaseline) {
        Text(r.studentName ?? "受講者").font(.headline).foregroundStyle(ARMSColor.text)
        Spacer()
        StatusTag(label: status.labelJa, tone: status.tone)
      }
      Text("\(r.slotTitle ?? "授業") / \(JaFormat.compactDateTime(r.startsAt, calendar: app.context.calendar))")
        .font(.headline)
        .foregroundStyle(ARMSColor.text)
      if let classroom = r.classroomName {
        Text(classroom).font(.subheadline).foregroundStyle(ARMSColor.text)
      }
      if status == .pending {
        Text("保持期限：\(JaFormat.dateTime(r.expiresAt, calendar: app.context.calendar))")
          .font(.footnote)
          .foregroundStyle(ARMSColor.muted)
      }
      if model.canDecide(r) {
        HStack(spacing: 12) {
          PrimaryButton(title: "承認", isLoading: model.busyIds.contains(r.id)) { approving = r }
          SecondaryButton(title: "却下", isEnabled: !model.busyIds.contains(r.id)) { rejecting = r }
        }
      } else {
        LinkButton(title: "詳細を見る") { app.router.push(.reservation(id: r.id)) }
      }
    }
  }
}

private struct RejectReasonSheet: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(AppModel.self) private var app
  let reservation: Reservation
  let model: TeacherReservationsModel
  @State private var reason = ""
  @State private var validation: String?
  @State private var isSending = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          ARMSCard {
            Text("却下する予約").font(.headline).foregroundStyle(ARMSColor.text)
            KeyValueRow(label: "受講者", value: reservation.studentName ?? "受講者")
            KeyValueRow(
              label: "授業",
              value: "\(reservation.slotTitle ?? "授業") \(JaFormat.dateTimeRange(reservation.startsAt, reservation.endsAt, calendar: app.context.calendar))",
              showsDivider: false)
          }
          VStack(alignment: .leading, spacing: 6) {
            Text("却下の理由（必須・1,000文字以内）").font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
            TextField("例：講師の日程変更のため", text: $reason, axis: .vertical)
              .lineLimit(3...8)
              .armsTextField(error: validation)
              .accessibilityLabel("却下の理由")
            if let validation { FieldError(text: validation) }
            Text("理由は受講者に通知されます。").font(.footnote).foregroundStyle(ARMSColor.muted)
          }
          if let error = model.actionError { MessageBanner(kind: .error, text: error.messageWithRequestId) }
          PrimaryButton(title: "却下する", isLoading: isSending) {
            Task {
              isSending = true
              defer { isSending = false }
              validation = await model.reject(reservation, reason: reason)
              if validation == nil, model.actionError == nil { dismiss() }
            }
          }
        }
        .padding(ARMSMetrics.gutter)
      }
      .armsScreen()
      .navigationTitle("予約を却下")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
      }
    }
  }
}
