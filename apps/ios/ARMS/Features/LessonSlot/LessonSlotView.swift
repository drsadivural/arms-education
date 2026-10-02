import ARMSKit
import SwiftUI

/// One lesson slot opened from a notification / push (`arms://lesson-slots/<id>`), e.g.
/// 「担当授業が取り消されました」. `GET /lesson-slots/{id}`; the teacher can open attendance, a student
/// can go to the booking confirmation.
struct LessonSlotView: View {
  @Environment(AppModel.self) private var app
  let slotId: String

  var body: some View {
    ModelHost(make: { LessonSlotModel(slotId: slotId, context: app.context) }) { model in
      LessonSlotScreen(model: model)
    }
    .navigationTitle("授業の内容")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct LessonSlotScreen: View {
  @Environment(AppModel.self) private var app
  let model: LessonSlotModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        LoadStateView(state: model.slot, retry: model.load) { envelope in
          let slot = envelope.data
          let calendar = app.context.calendar
          ARMSCard {
            HStack(alignment: .firstTextBaseline) {
              Text(slot.title).font(.headline).foregroundStyle(ARMSColor.text)
              Spacer()
              StatusTag(label: slot.state.labelJa, tone: slot.state == .open ? .info : .neutral)
            }
            VStack(spacing: 0) {
              KeyValueRow(label: "日時", value: JaFormat.dateTimeRange(slot.startsAt, slot.endsAt, calendar: calendar))
              KeyValueRow(label: "担当講師", value: slot.teacherName)
              KeyValueRow(label: "クラス", value: slot.classroomName)
              KeyValueRow(label: "空き", value: JaFormat.remainingSeats(slot.remaining), showsDivider: false)
            }
          }
          if slot.state == .cancelled {
            InfoNote(text: "この授業枠は取り消されています。予約していた受講者には通知済みです。", tone: .warning)
          }
          if model.canTakeAttendance {
            SecondaryButton(title: "出欠を記録", systemImage: "checklist") { app.router.push(.attendance(slot)) }
          }
          if model.canBook {
            PrimaryButton(title: "この授業を予約する", systemImage: "calendar.badge.plus") {
              app.router.push(.bookingConfirm(slot))
            }
          } else if let mine = slot.myReservation {
            LinkButton(title: "予約の詳細（\(mine.status.labelJa)）") { app.router.push(.reservation(id: mine.id)) }
          }
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
  }
}
