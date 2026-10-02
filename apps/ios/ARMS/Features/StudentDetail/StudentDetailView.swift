import ARMSKit
import SwiftUI

/// IOS-06 受講者の詳細 (teacher): profile, assigned programs (version / due date / overdue),
/// submissions awaiting review, unit states.
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
            if let classroom = student.classroomName {
              Text(classroom).font(.subheadline).foregroundStyle(ARMSColor.muted)
            }
            LinearProgressBar(
              fraction: (model.progress.value?.progressPercent ?? student.progressPercent).map { Double($0) / 100 },
              label: JaFormat.percent(model.progress.value?.progressPercent ?? student.progressPercent))
            Text("研修終了予定：\(JaFormat.fullDateNoWeekday(student.trainingDueOn))")
              .font(.subheadline)
              .foregroundStyle(ARMSColor.text)
          }
        }

        reviewSection

        LoadStateView(state: model.progress, retry: model.load) { progress in
          if !progress.enrollments.isEmpty {
            ARMSCard {
              Text("受講中のプログラム").font(.headline).foregroundStyle(ARMSColor.text)
              ForEach(progress.enrollments) { enrollment in
                EnrollmentSummaryRow(enrollment: enrollment)
              }
            }
          }
          ARMSCard {
            Text("単元の状況").font(.headline).foregroundStyle(ARMSColor.text)
            if progress.units.isEmpty {
              Text("単元はまだ割り当てられていません").font(.subheadline).foregroundStyle(ARMSColor.muted)
            }
            ForEach(Array(progress.units.enumerated()), id: \.element.rowId) { index, unit in
              VStack(alignment: .leading, spacing: 4) {
                HStack {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(unit.title).font(.subheadline).foregroundStyle(ARMSColor.text)
                    if progress.enrollments.count > 1 {
                      Text(unit.programName).font(.caption2).foregroundStyle(ARMSColor.muted)
                    }
                  }
                  Spacer()
                  StatusTag(
                    label: unit.state == .reviewPending ? "評価待ち" : unit.state.labelJa,
                    tone: unit.state.tone)
                }
                .frame(minHeight: ARMSMetrics.minTapTarget)
                Text(UnitPresentation.detail(unit)).font(.caption).foregroundStyle(ARMSColor.muted)
                if let completed = UnitPresentation.completedLabel(unit, calendar: app.context.calendar) {
                  Text(completed).font(.caption).foregroundStyle(ARMSColor.muted)
                }
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
          SubmissionSummary(submission: submission)
          SecondaryButton(title: "提出内容を確認して評価", isEnabled: app.context.canMutate) { reviewing = submission }
        }
      }
    } else if let error = model.pendingSubmissions.error, !error.isConnectivity, !model.reviewPendingUnits.isEmpty {
      // The review queue could not be read: show which units wait for review so nothing is hidden.
      ARMSCard {
        Text("評価が必要な課題").font(.headline).foregroundStyle(ARMSColor.text)
        ForEach(model.reviewPendingUnits, id: \.rowId) { unit in
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

/// 「新入社員基礎研修（第2版）／期限：2026年12月25日（金）／期限超過」.
struct EnrollmentSummaryRow: View {
  let enrollment: EnrollmentProgress

  var body: some View {
    let status = EnrollmentPresentation.status(enrollment)
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline) {
        Text(EnrollmentPresentation.title(enrollment)).font(.subheadline.weight(.semibold)).foregroundStyle(ARMSColor.text)
        Spacer()
        StatusTag(label: status.label, tone: status.tone)
      }
      Text(EnrollmentPresentation.dueText(enrollment))
        .font(.caption)
        .foregroundStyle(enrollment.overdue ? ARMSColor.danger : ARMSColor.muted)
      LinearProgressBar(
        fraction: enrollment.progressPercent.map { Double($0) / 100 }, label: JaFormat.percent(enrollment.progressPercent))
      Text(EnrollmentPresentation.requiredText(enrollment)).font(.caption).foregroundStyle(ARMSColor.muted)
    }
    .accessibilityElement(children: .combine)
  }
}

/// One submission line in review lists.
struct SubmissionSummary: View {
  @Environment(AppModel.self) private var app
  let submission: Submission
  var showsStudent = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if showsStudent, !submission.studentName.isEmpty {
        Text(submission.studentName).font(.headline).foregroundStyle(ARMSColor.text)
      }
      if !submission.materialTitle.isEmpty {
        Text(submission.unitTitle.isEmpty ? submission.materialTitle : "\(submission.materialTitle)（\(submission.unitTitle)）")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ARMSColor.text)
      }
      Text("提出：\(JaFormat.shortDateTime(submission.submittedAt, calendar: app.context.calendar))")
        .font(.caption)
        .foregroundStyle(ARMSColor.muted)
      if !submission.body.isEmpty {
        Text(submission.body).font(.subheadline).foregroundStyle(ARMSColor.text).lineLimit(4)
      }
      if submission.hasFile {
        Label(submission.filename ?? "添付ファイル", systemImage: "paperclip").font(.caption).foregroundStyle(ARMSColor.muted)
      }
    }
  }
}

/// 課題の評価待ち (teacher): every assignment of the teacher's students waiting for review.
struct ReviewQueueView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    ModelHost(make: { ReviewQueueModel(context: app.context) }) { model in
      ReviewQueueScreen(model: model)
    }
    .navigationTitle("課題の評価待ち")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct ReviewQueueScreen: View {
  @Environment(AppModel.self) private var app
  let model: ReviewQueueModel
  @State private var reviewing: Submission?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        LoadStateView(
          state: model.submissions, isEmpty: { $0.isEmpty }, retry: model.load,
          empty: { EmptyStateView(systemImage: "tray", title: "評価待ちの課題はありません") }
        ) { _ in
          LazyVStack(spacing: 12) {
            ForEach(model.items) { submission in
              ARMSCard {
                SubmissionSummary(submission: submission, showsStudent: true)
                SecondaryButton(title: "提出内容を確認して評価", isEnabled: app.context.canMutate) { reviewing = submission }
                LinkButton(title: "受講者の詳細") { app.router.push(.studentDetail(id: submission.studentId)) }
              }
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
      }
    }
  }
}

/// 課題の評価: 提出内容（添付ファイル）＋ 講師コメント (required) + 再提出を依頼 / 合格にする.
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
  @State private var presentation: MaterialPresentation?
  @State private var openError: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        ARMSCard {
          Text(model.heading).font(.headline).foregroundStyle(ARMSColor.text)
          if !model.submission.studentName.isEmpty {
            Text(model.submission.studentName).font(.subheadline).foregroundStyle(ARMSColor.muted)
          }
          if model.submission.body.isEmpty {
            Text("（本文なし）").font(.subheadline).foregroundStyle(ARMSColor.muted)
          } else {
            Text(model.submission.body)
              .font(.body)
              .foregroundStyle(ARMSColor.text)
              .textSelection(.enabled)
          }
          if model.submission.hasFile {
            if let status = model.fileStatusText {
              InfoNote(text: status, tone: .warning)
            } else {
              SecondaryButton(
                title: "添付ファイルを開く（\(model.submission.filename ?? "ファイル")）", systemImage: "paperclip",
                isLoading: model.isOpeningFile, isEnabled: model.canOpenFile
              ) {
                Task { await openFile() }
              }
            }
            if let error = model.fileError { MessageBanner(kind: .error, text: error.messageWithRequestId) }
            if let openError { MessageBanner(kind: .error, text: openError) }
          }
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
          if error.code == "VERSION_CONFLICT" || error.code == "INVALID_STATE" {
            SecondaryButton(title: "閉じて最新の状態を確認") { dismiss() }
          }
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
    .sheet(item: $presentation, onDismiss: MaterialFiles.removeDownloads) { presentation in
      MaterialViewer(presentation: presentation)
    }
  }

  private func submit(_ decision: ReviewDecision) async {
    if let reviewed = await model.review(decision) {
      onReviewed(reviewed)
    }
  }

  /// Downloads the scanned file with the fresh 5-minute URL and previews it (deleted on close).
  private func openFile() async {
    openError = nil
    guard let download = await model.fileURL(), let url = URL(string: download.url) else { return }
    let kind: MaterialKind = download.contentType.lowercased().hasPrefix("image/") ? .image : .pdf
    do {
      let local = try await MaterialFiles.download(url, contentType: download.contentType, kind: kind)
      presentation = .file(local, title: model.submission.filename ?? "添付ファイル")
    } catch {
      openError = "ファイルをダウンロードできませんでした。通信環境を確認して、もう一度お試しください。"
    }
  }
}
