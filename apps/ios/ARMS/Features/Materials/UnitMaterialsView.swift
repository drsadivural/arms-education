import ARMSKit
import SwiftUI

/// IOS-12 教材・確認テスト for one unit: private PDF/video/image via the 5-minute download URL,
/// receipt (「教材を確認しました」), server-scored quiz and assignment submission.
struct UnitMaterialsView: View {
  @Environment(AppModel.self) private var app
  let unitId: String
  let unitTitle: String

  var body: some View {
    ModelHost(make: { UnitMaterialsModel(unitId: unitId, unitTitle: unitTitle, context: app.context) }) { model in
      UnitMaterialsScreen(model: model)
    }
    .navigationTitle("教材・確認テスト")
    .navigationBarTitleDisplayMode(.inline)
  }
}

private struct UnitMaterialsScreen: View {
  @Environment(AppModel.self) private var app
  let model: UnitMaterialsModel
  @State private var presentation: MaterialPresentation?
  @State private var openingId: String?
  @State private var openError: String?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text(model.unitTitle).font(.title3.bold()).foregroundStyle(ARMSColor.text)
          .accessibilityAddTraits(.isHeader)
        if let message = model.actionMessage { MessageBanner(kind: .success, text: message) }
        if let error = model.actionError { MessageBanner(kind: .error, text: error.messageWithRequestId) }
        if let openError { MessageBanner(kind: .error, text: openError) }

        LoadStateView(
          state: model.materials, isEmpty: { _ in model.visibleMaterials.isEmpty }, retry: model.load,
          empty: {
            EmptyStateView(systemImage: "doc", title: "公開中の教材はありません", message: "教材が公開されると、ここに表示されます。")
          }
        ) { _ in
          VStack(spacing: 12) {
            ForEach(model.visibleMaterials) { material in
              materialCard(material)
            }
          }
        }
      }
      .padding(ARMSMetrics.gutter)
    }
    .armsScreen()
    .refreshable { await model.load() }
    .task(id: app.context.refreshGeneration) { await model.load() }
    .sheet(item: $presentation, onDismiss: MaterialFiles.removeDownloads) { presentation in
      MaterialViewer(presentation: presentation)
    }
  }

  @ViewBuilder private func materialCard(_ material: Material) -> some View {
    ARMSCard {
      HStack(alignment: .firstTextBaseline) {
        Label(material.title, systemImage: icon(material.kind))
          .font(.headline)
          .foregroundStyle(ARMSColor.text)
        Spacer()
        if material.required { StatusTag(label: "必須", tone: .info) }
      }
      HStack(spacing: 8) {
        Text(material.kind.labelJa).font(.caption).foregroundStyle(ARMSColor.muted)
        if let status = model.learnerStatusText(material) {
          Text("・\(status)").font(.caption).foregroundStyle(ARMSColor.muted)
        }
      }
      if !material.description.isEmpty {
        Text(material.description).font(.subheadline).foregroundStyle(ARMSColor.text)
      }
      if model.isStudent, material.kind == .assignment, let feedback = material.learnerStatus?.feedback, !feedback.isEmpty {
        Text("講師コメント：\(feedback)").font(.subheadline).foregroundStyle(ARMSColor.text)
      }
      switch material.kind {
      case .pdf, .video, .image, .link:
        HStack {
          if model.isStudent {
            if model.isConfirmed(material) {
              Label("確認済み", systemImage: "checkmark.circle.fill")
                .font(.subheadline)
                .foregroundStyle(ARMSColor.success)
            } else {
              SecondaryButton(
                title: "教材を確認しました", isLoading: model.busyIds.contains(material.id) && openingId != material.id,
                isEnabled: app.context.canMutate
              ) {
                Task { await model.confirmReceipt(material) }
              }
              .frame(maxWidth: 220)
            }
          }
          Spacer()
          Button {
            Task { await open(material) }
          } label: {
            HStack(spacing: 4) {
              if openingId == material.id { ProgressView() }
              Text("開く →").font(.subheadline.weight(.medium))
            }
            .foregroundStyle(ARMSColor.primaryText)
            .frame(minWidth: ARMSMetrics.minTapTarget, minHeight: ARMSMetrics.minTapTarget)
          }
          .disabled(openingId != nil || !app.context.isOnline)
          .accessibilityLabel("\(material.title)を開く")
        }
      case .quiz:
        if model.isStudent {
          PrimaryButton(title: "確認テストを開始", systemImage: "checkmark.square") { app.router.push(.quiz(material)) }
        } else {
          Text("確認テストは受講者が回答します。").font(.footnote).foregroundStyle(ARMSColor.muted)
        }
      case .assignment:
        if model.isStudent {
          PrimaryButton(title: "課題を提出", systemImage: "square.and.pencil") { app.router.push(.assignment(material)) }
        } else {
          Text("提出物は受講者の詳細画面で評価できます。").font(.footnote).foregroundStyle(ARMSColor.muted)
        }
      }
    }
  }

  private func icon(_ kind: MaterialKind) -> String {
    switch kind {
    case .pdf: return "doc.richtext"
    case .video: return "play.rectangle"
    case .image: return "photo"
    case .link: return "link"
    case .quiz: return "checklist"
    case .assignment: return "square.and.pencil"
    }
  }

  private func open(_ material: Material) async {
    openError = nil
    openingId = material.id
    defer { openingId = nil }
    // link → its https URL (from the DTO); pdf/video/image → fresh 5-minute URL from /download.
    guard let download = await model.downloadURL(for: material), let url = URL(string: download.url) else { return }
    switch material.kind {
    case .video:
      presentation = .video(url, title: material.title)
    case .link:
      presentation = .web(url)
    case .pdf, .image:
      do {
        let local = try await MaterialFiles.download(url, contentType: download.contentType, kind: material.kind)
        presentation = .file(local, title: material.title)
      } catch {
        openError = "教材をダウンロードできませんでした。通信環境を確認して、もう一度お試しください。"
      }
    case .quiz, .assignment:
      break
    }
  }
}
