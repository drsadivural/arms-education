import ARMSKit
import SwiftUI

/// IOS-16 出欠を記録 (teacher of the lesson). Changes are audited on the server.
struct AttendanceView: View {
  @Environment(AppModel.self) private var app
  let slot: LessonSlot

  var body: some View {
    ModelHost(make: { AttendanceModel(slot: slot, context: app.context) }) { model in
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
          Text(model.slot.title).font(.title3.bold()).foregroundStyle(ARMSColor.text)
            .accessibilityAddTraits(.isHeader)
          Text(model.subtitle).font(.subheadline).foregroundStyle(ARMSColor.muted)
        }

        LoadStateView(
          state: model.roster, isEmpty: { $0.isEmpty }, retry: model.load,
          empty: {
            EmptyStateView(systemImage: "person.crop.circle.badge.questionmark", title: "この授業の承認済み予約はありません")
          }
        ) { _ in
          VStack(spacing: 12) {
            ForEach(model.draft.rows) { row in
              ARMSCard {
                Text(row.studentName).font(.headline).foregroundStyle(ARMSColor.text)
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
                if expandedNotes.contains(row.studentId) || !row.note.isEmpty {
                  TextField(
                    "コメント（任意）",
                    text: Binding(get: { row.note }, set: { model.setNote($0, for: row.studentId) }), axis: .vertical
                  )
                  .lineLimit(1...4)
                  .armsTextField()
                  .accessibilityLabel("\(row.studentName)のコメント")
                } else {
                  Button("必要に応じてコメントを記録できます。") { expandedNotes.insert(row.studentId) }
                    .font(.footnote)
                    .foregroundStyle(ARMSColor.muted)
                    .frame(minHeight: ARMSMetrics.minTapTarget)
                }
              }
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

        InfoNote(text: "担当授業の出欠だけを記録できます。変更は操作履歴に残ります。")
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
  }
}
