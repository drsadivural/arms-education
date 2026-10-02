import ARMSKit
import SwiftUI

/// IOS-11 本日の授業 (JST today). The private meeting link is shown only when the API returned it
/// (approved student, responsible teacher).
struct TodayLessonsView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    ModelHost(make: { TodayLessonsModel(context: app.context) }) { model in
      TodayLessonsScreen(model: model)
    }
    .navigationTitle("本日の授業")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct TodayLessonsScreen: View {
  @Environment(AppModel.self) private var app
  @Environment(\.openURL) private var openURL
  let model: TodayLessonsModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text(model.dateLabel).font(.subheadline).foregroundStyle(ARMSColor.muted)
        LoadStateView(
          state: model.today, isEmpty: { $0.items.isEmpty }, retry: model.load,
          empty: {
            EmptyStateView(
              systemImage: "calendar",
              title: model.isTeacher ? "本日の担当授業はありません" : "本日の承認済みの授業はありません")
          }
        ) { _ in
          VStack(spacing: 12) {
            ForEach(model.lessons) { slot in
              lessonCard(slot)
            }
          }
        }
        InfoNote(text: "授業の参加リンクは、承認済みの受講者だけに表示されます。")
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
  }

  private func lessonCard(_ slot: LessonSlot) -> some View {
    let calendar = app.context.calendar
    let tag = model.tag(for: slot)
    return ARMSCard {
      HStack(alignment: .firstTextBaseline) {
        Text(slot.title).font(.headline).foregroundStyle(ARMSColor.text)
        Spacer()
        StatusTag(label: tag.label, tone: tag.tone)
      }
      Text(JaFormat.timeRange(slot.startsAt, slot.endsAt, calendar: calendar))
        .font(.title3.weight(.semibold))
        .foregroundStyle(ARMSColor.text)
      Text("\(slot.teacherName) / \(slot.hasMeetingUrl ? "オンライン" : slot.classroomName)")
        .font(.subheadline)
        .foregroundStyle(ARMSColor.text)
      if let url = SlotRules.meetingURL(slot) {
        PrimaryButton(title: "授業に参加する", systemImage: "video") { openURL(url) }
      }
      if model.isTeacher {
        SecondaryButton(title: "出欠を記録", systemImage: "checklist") { app.router.push(.attendance(slot)) }
      }
      if let unitId = slot.unitId {
        SecondaryButton(title: "教材を確認する", systemImage: "doc.text") {
          app.router.push(.unitMaterials(unitId: unitId, title: slot.title))
        }
      }
    }
  }
}
