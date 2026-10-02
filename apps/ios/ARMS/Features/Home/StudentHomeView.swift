import ARMSKit
import SwiftUI

/// IOS-02 ホーム (受講者).
struct StudentHomeView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    ModelHost(make: { StudentHomeModel(context: app.context) }) { model in
      StudentHomeScreen(model: model)
    }
    .navigationTitle("ホーム")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct StudentHomeScreen: View {
  @Environment(AppModel.self) private var app
  let model: StudentHomeModel

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

        LoadStateView(state: model.progress, retry: model.load) { _ in
          if let summary = model.summary {
            ProgressSummaryCard(summary: summary) { app.router.tab = .progress }
          }
        }

        SectionHeader(title: "本日の授業", actionTitle: "すべて") { app.router.push(.todayLessons) }
        LoadStateView(
          state: model.today, isEmpty: { $0.items.isEmpty }, retry: model.load,
          empty: {
            EmptyStateView(
              systemImage: "calendar", title: "本日の承認済みの授業はありません",
              message: "空き枠から授業を予約できます。", actionTitle: "空き枠を探す"
            ) {
              app.router.bookingSegment = .slots
              app.router.tab = .booking
            }
          }
        ) { _ in
          VStack(spacing: 12) {
            ForEach(model.lessons) { slot in
              Button {
                app.router.push(.todayLessons)
              } label: {
                LessonRow(slot: slot, tag: slot.myReservation.map { ($0.status.labelJa, $0.status.tone) } ?? ("承認済み", .success))
              }
              .buttonStyle(.plain)
            }
          }
        }

        VoicePromoCard { app.router.tab = .voice }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
  }
}

struct ProgressSummaryCard: View {
  let summary: ProgressSummary
  var title = "研修の進捗"
  var onDetail: (() -> Void)? = nil

  var body: some View {
    ARMSCard {
      Text(title).font(.headline).foregroundStyle(ARMSColor.text)
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 20) { ring; texts }
        VStack(alignment: .leading, spacing: 16) { ring; texts }
      }
    }
  }

  private var ring: some View {
    ProgressRing(fraction: summary.fraction, percentText: summary.percentText)
  }

  private var texts: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(summary.headline).font(.headline).foregroundStyle(ARMSColor.text)
      Text(summary.requiredText).font(.subheadline).foregroundStyle(ARMSColor.muted)
      if let onDetail {
        LinkButton(title: "進捗の詳細を見る", action: onDetail)
      }
    }
  }
}

/// Lesson row used on home screens: time box, title, 「クラス · 講師」 and a status tag.
struct LessonRow: View {
  @Environment(AppModel.self) private var app
  let slot: LessonSlot
  let tag: (String, StatusTone)

  var body: some View {
    let calendar = app.context.calendar
    ARMSCard(padding: 14) {
      HStack(spacing: 14) {
        TimeBox(start: JaFormat.time(slot.startsAt, calendar: calendar), end: JaFormat.time(slot.endsAt, calendar: calendar))
        VStack(alignment: .leading, spacing: 4) {
          Text(slot.title).font(.headline).foregroundStyle(ARMSColor.text)
          Text("\(slot.classroomName) · \(slot.teacherName)")
            .font(.subheadline)
            .foregroundStyle(ARMSColor.muted)
        }
        Spacer(minLength: 8)
        StatusTag(label: tag.0, tone: tag.1)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

struct VoicePromoCard: View {
  let action: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("声でかんたん操作").font(.headline).foregroundStyle(ARMSColor.text)
      Text("「今日の授業を教えて」").font(.subheadline).foregroundStyle(ARMSColor.text)
      PrimaryButton(title: "AI音声を開始", systemImage: "mic.fill", action: action)
    }
    .padding(18)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ARMSColor.infoBackground, in: RoundedRectangle(cornerRadius: ARMSMetrics.cardRadius, style: .continuous))
  }
}
