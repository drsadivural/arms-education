import ARMSKit
import SwiftUI

/// IOS-16 出欠を記録 (teacher of the lesson). The roster and the current records come from
/// `GET /lesson-slots/{id}/attendance`; saving opens 30 minutes before the start. Changes are audited
/// on the server.
struct AttendanceView: View {
  @Environment(AppModel.self) private var app
  let slotId: String
  let slot: LessonSlot?

  init(slot: LessonSlot) {
    self.slotId = slot.id
    self.slot = slot
  }

  init(slotId: String) {
    self.slotId = slotId
    self.slot = nil
  }

  var body: some View {
    ModelHost(make: { AttendanceModel(slotId: slotId, slot: slot, context: app.context) }) { model in
      AttendanceScreen(model: model)
    }
    .navigationTitle("出欠を記録")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct AttendanceScreen: View {
  @Environment(AppModel.self) private var app
  let model: AttendanceModel
  @State private var expandedNotes = Set<String>()

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 4) {
          Text(model.title).font(.title3.bold()).foregroundStyle(ARMSColor.text)
            .accessibilityAddTraits(.isHeader)
          if !model.subtitle.isEmpty {
            Text(model.subtitle).font(.subheadline).foregroundStyle(ARMSColor.muted)
          }
        }

        if let reason = model.notEditableMessage {
          InfoNote(text: reason, tone: .warning)
        }

        LoadStateView(
          state: model.roster, isEmpty: { $0.data.items.isEmpty }, retry: model.load,
          empty: {
            EmptyStateView(systemImage: "person.crop.circle.badge.questionmark", title: "この授業の承認済み予約はありません")
          }
        ) { _ in
          VStack(spacing: 12) {
            ForEach(model.draft.rows) { row in
              rowCard(row)
            }
          }

          if let error = model.error {
            MessageBanner(kind: .error, text: error.messageWithRequestId)
          }
          if let saved = model.savedMessage {
            MessageBanner(kind: .success, text: saved)
          }
          PrimaryButton(title: "出欠を保存", isLoading: model.isSaving, isEnabled: model.canSave) {
            Task { await model.save() }
          }
        }

        InfoNote(text: "担当授業の出欠だけを記録できます。授業開始の30分前から記録でき、変更は操作履歴に残ります。")
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
  }

  @ViewBuilder private func rowCard(_ row: AttendanceDraft.Row) -> some View {
    ARMSCard {
      HStack(alignment: .firstTextBaseline) {
        VStack(alignment: .leading, spacing: 2) {
          Text(row.studentName).font(.headline).foregroundStyle(ARMSColor.text)
          if !row.employeeNumber.isEmpty {
            Text("社員番号 \(row.employeeNumber)").font(.caption).foregroundStyle(ARMSColor.muted)
          }
        }
        Spacer()
        if let status = row.reservationStatus, status != .approved {
          // Recorded earlier, but the reservation is no longer approved (kept for correction).
          StatusTag(label: "予約：\(status.labelJa)", tone: status.tone)
        }
      }
      Picker(
        "\(row.studentName)の出欠",
        selection: Binding(get: { row.state }, set: { model.setState($0, for: row.studentId) })
      ) {
        ForEach(AttendanceState.allCases, id: \.self) { state in
          Text(state.labelJa).tag(state)
        }
      }
      .pickerStyle(.segmented)
      .frame(minHeight: ARMSMetrics.minTapTarget)
      .disabled(!model.isEditable)
      if expandedNotes.contains(row.studentId) || !row.note.isEmpty {
        TextField(
          "コメント（任意）",
          text: Binding(get: { row.note }, set: { model.setNote($0, for: row.studentId) }), axis: .vertical
        )
        .lineLimit(1...4)
        .armsTextField()
        .disabled(!model.isEditable)
        .accessibilityLabel("\(row.studentName)のコメント")
      } else if model.isEditable {
        Button("必要に応じてコメントを記録できます。") { expandedNotes.insert(row.studentId) }
          .font(.footnote)
          .foregroundStyle(ARMSColor.muted)
          .frame(minHeight: ARMSMetrics.minTapTarget)
      }
      if let recordedAt = row.recordedAt {
        Text("記録済み：\(row.recordedByName ?? "—") \(JaFormat.shortDateTime(recordedAt, calendar: app.context.calendar))")
          .font(.caption)
          .foregroundStyle(ARMSColor.muted)
      }
    }
  }
}
