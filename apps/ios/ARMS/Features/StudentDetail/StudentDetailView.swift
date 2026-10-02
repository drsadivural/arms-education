import ARMSKit
import SwiftUI

/// IOS-06 受講者の詳細 (teacher): profile, progress, submissions awaiting review, unit states.
struct StudentDetailView: View {
  @Environment(AppModel.self) private var app
  let studentId: String

  var body: some View {
    ModelHost(make: { StudentDetailModel(studentId: studentId, context: app.context) }) { model in
      StudentDetailScreen(model: model)
    }
    .navigationTitle("受講者の詳細")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct StudentDetailScreen: View {
  @Environment(AppModel.self) private var app
  let model: StudentDetailModel
  @State private var reviewing: Submission?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        LoadStateView(state: model.student, retry: model.load) { envelope in
          let student = envelope.data
          ARMSCard {
            Text(student.displayName).font(.title3.bold()).foregroundStyle(ARMSColor.text)
            Text("\(student.departmentName) / 社員番号 \(student.employeeNumber)")
              .font(.subheadline)
              .foregroundStyle(ARMSColor.text)
            LinearProgressBar(
              fraction: (model.progress.value?.progressPercent ?? student.progressPercent).map { Double($0) / 100 },
              label: JaFormat.percent(model.progress.value?.progressPercent ?? student.progressPercent))
            Text("終了予定：\(JaFormat.fullDateNoWeekday(student.trainingDueOn))")
              .font(.subheadline)
              .foregroundStyle(ARMSColor.text)
          }
        }

        reviewSection

        LoadStateView(state: model.progress, retry: model.load) { progress in
          ARMSCard {
            Text("単元の状況").font(.headline).foregroundStyle(ARMSColor.text)
            if progress.units.isEmpty {
              Text("単元はまだ割り当てられていません").font(.subheadline).foregroundStyle(ARMSColor.muted)
            }
            ForEach(Array(progress.units.enumerated()), id: \.element.id) { index, unit in
              VStack(alignment: .leading, spacing: 4) {
                HStack {
                  Text(unit.title).font(.subheadline).foregroundStyle(ARMSColor.text)
                  Spacer()
                  StatusTag(
                    label: unit.state == .reviewPending ? "評価待ち" : unit.state.labelJa,
                    tone: unit.state.tone)
                }
                .frame(minHeight: ARMSMetrics.minTapTarget)
                Text(UnitPresentation.detail(unit)).font(.caption).foregroundStyle(ARMSColor.muted)
                if let feedback = unit.feedback, !feedback.isEmpty {
                  Text("講師コメント：\(feedback)").font(.caption).foregroundStyle(ARMSColor.text)
                }
              }
              if index < progress.units.count - 1 { Divider().overlay(ARMSColor.border) }
            }
          }
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
    .sheet(item: $reviewing) { submission in
      SubmissionReviewSheet(submission: submission) { reviewed in
        model.didReview(reviewed)
        Task { await model.load() }
      }
    }
  }

  @ViewBuilder private var reviewSection: some View {
    let pending = model.pendingSubmissions.value ?? []
    if !pending.isEmpty {
      ARMSCard {
        Text("評価が必要な課題").font(.headline).foregroundStyle(ARMSColor.text)
        ForEach(pending) { submission in
          VStack(alignment: .leading, spacing: 8) {
            Text("提出：\(JaFormat.shortDateTime(submission.submittedAt, calendar: app.context.calendar))")
              .font(.subheadline)
              .foregroundStyle(ARMSColor.muted)
            Text(submission.body)
              .font(.subheadline)
              .foregroundStyle(ARMSColor.text)
              .lineLimit(4)
            SecondaryButton(title: "提出内容を確認して評価", isEnabled: app.context.canMutate) { reviewing = submission }
          }
        }
      }
    } else if let error = model.pendingSubmissions.error, !error.isConnectivity, !model.reviewPendingUnits.isEmpty {
      // The review queue could not be read: show which units wait for review so nothing is hidden.
      ARMSCard {
        Text("評価が必要な課題").font(.headline).foregroundStyle(ARMSColor.text)
        ForEach(model.reviewPendingUnits) { unit in
          HStack {
            Text(unit.title).font(.subheadline).foregroundStyle(ARMSColor.text)
            Spacer()
            StatusTag(label: "評価待ち", tone: .warning)
          }
        }
        MessageBanner(kind: .error, text: "提出物を読み込めませんでした。\(error.messageWithRequestId)")
      }
    }
  }
}

/// 課題の評価: 講師コメント (required) + 再提出を依頼 / 合格にする.
struct SubmissionReviewSheet: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  let submission: Submission
  let onReviewed: (Submission) -> Void

  var body: some View {
    NavigationStack {
      ModelHost(make: { SubmissionReviewModel(submission: submission, context: app.context) }) { model in
        ReviewForm(model: model, onReviewed: onReviewed)
      }
      .navigationTitle("課題の評価")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
      }
    }
  }
}

private struct ReviewForm: View {
  @Environment(\.dismiss) private var dismiss
  @Bindable var model: SubmissionReviewModel
  let onReviewed: (Submission) -> Void

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        ARMSCard {
          Text("提出内容").font(.headline).foregroundStyle(ARMSColor.text)
          Text(model.submission.body)
            .font(.body)
            .foregroundStyle(ARMSColor.text)
            .textSelection(.enabled)
        }
        VStack(alignment: .leading, spacing: 6) {
          Text("講師コメント（必須）").font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
          TextField("例：課題の論点をよく整理できています。", text: $model.feedback, axis: .vertical)
            .lineLimit(3...8)
            .padding(14)
            .background(ARMSColor.surface, in: RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius))
            .overlay(RoundedRectangle(cornerRadius: ARMSMetrics.controlRadius).strokeBorder(ARMSColor.border))
            .accessibilityLabel("講師コメント")
          if let error = model.error?.fieldErrors["feedback"] { FieldError(text: error) }
        }
        if let error = model.error, error.fieldErrors.isEmpty {
          MessageBanner(kind: .error, text: error.messageWithRequestId)
        }
        if let success = model.successMessage {
          MessageBanner(kind: .success, text: success)
          PrimaryButton(title: "閉じる") { dismiss() }
        } else {
          HStack(spacing: 12) {
            SecondaryButton(title: "再提出を依頼", isLoading: model.isSubmitting) {
              Task { await submit(.revisionRequested) }
            }
            PrimaryButton(title: "合格にする", isLoading: model.isSubmitting) {
              Task { await submit(.accepted) }
            }
          }
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
  }

  private func submit(_ decision: ReviewDecision) async {
    if let reviewed = await model.review(decision) {
      onReviewed(reviewed)
    }
  }
}
