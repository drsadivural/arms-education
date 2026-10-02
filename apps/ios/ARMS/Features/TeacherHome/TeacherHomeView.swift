import ARMSKit
import SwiftUI

/// IOS-03 講師ホーム: 担当受講者・本日の授業・承認待ち, 担当授業 (→ 出欠), 対応が必要な項目.
struct TeacherHomeView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    ModelHost(make: { TeacherHomeModel(context: app.context) }) { model in
      TeacherHomeScreen(model: model)
    }
    .navigationTitle("講師ホーム")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct TeacherHomeScreen: View {
  @Environment(AppModel.self) private var app
  let model: TeacherHomeModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        BrandHeader(trailingName: app.context.me?.displayName) { app.router.push(.settings) }

        VStack(alignment: .leading, spacing: 6) {
          Text(model.dateLabel).font(.subheadline).foregroundStyle(ARMSColor.muted)
          Text(model.greeting)
            .font(.title.weight(.bold))
            .foregroundStyle(ARMSColor.text)
            .accessibilityAddTraits(.isHeader)
        }

        LoadStateView(state: model.counts, retry: model.load) { counts in
          HStack(spacing: 12) {
            StatTile(
              value: "\(counts.students)\(counts.studentsComplete ? "" : "+")", label: "担当受講者"
            ) { app.router.tab = .progress }
            StatTile(value: "\(model.lessons.count)", label: "本日の授業") { app.router.push(.todayLessons) }
            StatTile(value: "\(counts.pendingReservations)", label: "承認待ち") { app.router.tab = .booking }
          }
        }

        SectionHeader(title: "担当授業", actionTitle: "すべて") { app.router.push(.todayLessons) }
        LoadStateView(
          state: model.today, isEmpty: { $0.items.isEmpty }, retry: model.load,
          empty: { EmptyStateView(systemImage: "calendar", title: "本日の担当授業はありません") }
        ) { _ in
          VStack(spacing: 12) {
            ForEach(model.lessons) { slot in
              Button {
                app.router.push(.attendance(slot))
              } label: {
                LessonRow(slot: slot, tag: ("担当授業", .info))
              }
              .buttonStyle(.plain)
              .accessibilityHint("出欠を記録します")
            }
          }
        }

        if let counts = model.counts.value {
          ARMSCard {
            Text("対応が必要な項目").font(.headline).foregroundStyle(ARMSColor.text)
            if let reviews = counts.pendingReviews {
              ActionRow(title: "課題の評価待ち", value: "\(reviews)件") { app.router.tab = .progress }
              Divider().overlay(ARMSColor.border)
            }
            ActionRow(title: "予約の承認待ち", value: "\(counts.pendingReservations)件") { app.router.tab = .booking }
          }
        }

        PrimaryButton(title: "担当受講者の進捗を見る", systemImage: "chart.bar") { app.router.tab = .progress }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
  }
}

struct StatTile: View {
  let value: String
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 6) {
        Text(value).font(.title.weight(.bold)).foregroundStyle(ARMSColor.text).minimumScaleFactor(0.6)
        Text(label).font(.caption).foregroundStyle(ARMSColor.muted).multilineTextAlignment(.center)
      }
      .frame(maxWidth: .infinity, minHeight: 88)
      .background(ARMSColor.surface, in: RoundedRectangle(cornerRadius: ARMSMetrics.cardRadius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: ARMSMetrics.cardRadius, style: .continuous).strokeBorder(ARMSColor.border, lineWidth: 1))
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(label) \(value)")
    .accessibilityAddTraits(.isButton)
  }
}

struct ActionRow: View {
  let title: String
  let value: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack {
        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
        Spacer()
        Text("\(value) →").font(.subheadline).foregroundStyle(ARMSColor.text)
      }
      .frame(minHeight: ARMSMetrics.minTapTarget)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(title) \(value)")
  }
}
