import ARMSKit
import AVKit
import QuickLook
import SafariServices
import SwiftUI

enum MaterialPresentation: Identifiable {
  case file(URL, title: String)
  case video(URL, title: String)
  case web(URL)

  var id: String {
    switch self {
    case .file(let url, _), .video(let url, _), .web(let url): return url.absoluteString
    }
  }
}

/// Private material files are downloaded to a temporary folder only for viewing and deleted when
/// the viewer closes (the signed URL expires after 5 minutes on the server).
enum MaterialFiles {
  static var directory: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("ARMSMaterials", isDirectory: true)
  }

  static func download(_ remote: URL, contentType: String, kind: MaterialKind) async throws -> URL {
    let (temporary, response) = try await URLSession.shared.download(from: remote)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      try? FileManager.default.removeItem(at: temporary)
      throw URLError(.badServerResponse)
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let destination = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension(
      fileExtension(contentType: contentType, kind: kind))
    try FileManager.default.moveItem(at: temporary, to: destination)
    return destination
  }

  static func fileExtension(contentType: String, kind: MaterialKind) -> String {
    switch contentType.lowercased().split(separator: ";").first.map(String.init) ?? "" {
    case "application/pdf": return "pdf"
    case "image/png": return "png"
    case "image/jpeg", "image/jpg": return "jpg"
    case "image/heic": return "heic"
    case "image/gif": return "gif"
    case "image/webp": return "webp"
    default: return kind == .pdf ? "pdf" : "jpg"
    }
  }

  static func removeDownloads() {
    try? FileManager.default.removeItem(at: directory)
  }
}

struct MaterialViewer: View {
  @Environment(\.dismiss) private var dismiss
  let presentation: MaterialPresentation

  var body: some View {
    switch presentation {
    case .web(let url):
      SafariView(url: url).ignoresSafeArea()
    case .file(let url, let title):
      NavigationStack {
        QuickLookPreview(url: url)
          .ignoresSafeArea(edges: .bottom)
          .navigationTitle(title)
          .navigationBarTitleDisplayMode(.inline)
          .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
      }
    case .video(let url, let title):
      NavigationStack {
        VideoPlayerView(url: url)
          .navigationTitle(title)
          .navigationBarTitleDisplayMode(.inline)
          .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
      }
    }
  }
}

private struct VideoPlayerView: View {
  let url: URL
  @State private var player: AVPlayer?

  var body: some View {
    VideoPlayer(player: player)
      .background(Color.black)
      .onAppear {
        let player = AVPlayer(url: url)
        self.player = player
        player.play()
      }
      .onDisappear { player?.pause() }
      .accessibilityLabel("教材動画")
  }
}

private struct QuickLookPreview: UIViewControllerRepresentable {
  let url: URL

  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: QLPreviewController, context: Context) {
    context.coordinator.url = url
    controller.reloadData()
  }

  func makeCoordinator() -> Coordinator { Coordinator(url: url) }

  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    var url: URL
    init(url: URL) { self.url = url }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
      url as NSURL
    }
  }
}

private struct SafariView: UIViewControllerRepresentable {
  let url: URL

  func makeUIViewController(context: Context) -> SFSafariViewController {
    let configuration = SFSafariViewController.Configuration()
    configuration.entersReaderIfAvailable = false
    return SFSafariViewController(url: url, configuration: configuration)
  }

  func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
