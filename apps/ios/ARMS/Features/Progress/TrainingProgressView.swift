import ARMSKit
import SwiftUI

/// IOS-04 研修の進捗 (受講者本人). Values come from the shared server progress service.
struct TrainingProgressView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    ModelHost(make: { ProgressModel(context: app.context) }) { model in
      TrainingProgressScreen(model: model)
    }
    .navigationTitle("研修の進捗")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct TrainingProgressScreen: View {
  @Environment(AppModel.self) private var app
  let model: ProgressModel

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        LoadStateView(state: model.progress, retry: model.load) { progress in
          if let summary = model.summary {
            ARMSCard {
              Text("研修の進捗").font(.headline).foregroundStyle(ARMSColor.text)
              ViewThatFits(in: .horizontal) {
                HStack(spacing: 20) {
                  ProgressRing(fraction: summary.fraction, percentText: summary.percentText)
                  summaryTexts(summary)
                }
                VStack(alignment: .leading, spacing: 16) {
                  ProgressRing(fraction: summary.fraction, percentText: summary.percentText)
                  summaryTexts(summary)
                }
              }
            }
          }

          if !progress.enrollments.isEmpty {
            SectionHeader(title: "受講中のプログラム")
            ARMSCard {
              ForEach(Array(progress.enrollments.enumerated()), id: \.element.id) { index, enrollment in
                EnrollmentSummaryRow(enrollment: enrollment)
                if index < progress.enrollments.count - 1 { Divider().overlay(ARMSColor.border) }
              }
            }
          }

          SectionHeader(title: "単元ごとの状況")
          if progress.units.isEmpty {
            EmptyStateView(
              systemImage: "list.bullet.rectangle", title: "単元はまだ割り当てられていません",
              message: "研修プログラムが割り当てられると、ここに単元が表示されます。")
          } else if progress.enrollments.count > 1 {
            // Several programs: units grouped by program in program order.
            ForEach(progress.enrollments) { enrollment in
              Text(EnrollmentPresentation.title(enrollment))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ARMSColor.muted)
              unitCards(progress.units(of: enrollment))
            }
          } else {
            unitCards(progress.units.sorted { $0.position < $1.position })
          }
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
  }

  private func unitCards(_ units: [UnitProgress]) -> some View {
    VStack(spacing: 12) {
      ForEach(units, id: \.rowId) { unit in
        UnitProgressCard(unit: unit, calendar: app.context.calendar) {
          app.router.push(.unitMaterials(unitId: unit.id, title: unit.title))
        }
      }
    }
  }

  private func summaryTexts(_ summary: ProgressSummary) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(summary.requiredText).font(.headline).foregroundStyle(ARMSColor.text)
      Text(summary.headline).font(.subheadline).foregroundStyle(ARMSColor.muted)
      if let due = summary.dueText {
        Text(due).font(.subheadline).foregroundStyle(due.hasPrefix("期限超過") ? ARMSColor.danger : ARMSColor.muted)
      }
      if let updated = model.updatedLabel {
        Text(updated).font(.subheadline).foregroundStyle(ARMSColor.muted)
      }
    }
  }
}

struct UnitProgressCard: View {
  let unit: UnitProgress
  var calendar: OrgCalendar = .tokyo
  var onOpen: (() -> Void)? = nil

  var body: some View {
    ARMSCard {
      HStack(alignment: .firstTextBaseline) {
        Text(unit.title).font(.headline).foregroundStyle(ARMSColor.text)
        Spacer()
        if !unit.required { StatusTag(label: "任意", tone: .neutral) }
        StatusTag(label: unit.state.labelJa, tone: unit.state.tone)
      }
      Text(UnitPresentation.detail(unit)).font(.subheadline).foregroundStyle(ARMSColor.muted)
      if let completed = UnitPresentation.completedLabel(unit, calendar: calendar) {
        Text(completed).font(.caption).foregroundStyle(ARMSColor.muted)
      }
      if let fraction = UnitPresentation.fraction(unit) {
        LinearProgressBar(fraction: fraction, label: "\(Int(fraction * 100))%")
      }
      if let feedback = unit.feedback, !feedback.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          Text("講師コメント").font(.caption.weight(.semibold)).foregroundStyle(ARMSColor.muted)
          Text(feedback).font(.subheadline).foregroundStyle(ARMSColor.text)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ARMSColor.surfaceMuted, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      }
      if let onOpen {
        LinkButton(title: "教材・確認テストを開く", action: onOpen)
      }
    }
  }
}
