import Foundation
import Observation

/// IOS-12 教材・確認テスト for one unit: private material download (5-minute URL), receipt,
/// quiz and assignment entry points, with the student's own status (`learner_status`).
@MainActor
@Observable
public final class UnitMaterialsModel {
  public let unitId: String
  public let unitTitle: String
  public private(set) var materials = Loadable<Page<Material>>()
  /// Receipts confirmed by the server during this screen session.
  public private(set) var receivedIds = Set<String>()
  public private(set) var busyIds = Set<String>()
  public private(set) var actionError: ARMSError?
  public private(set) var actionMessage: String?
  private var keys = ActionKeys()
  public let context: AppContext

  public init(unitId: String, unitTitle: String, context: AppContext) {
    self.unitId = unitId
    self.unitTitle = unitTitle
    self.context = context
  }

  /// Students only see published, clean (or not applicable) materials; blocked/pending files are hidden.
  /// (The server already filters student lists; this is defence in depth.)
  public var visibleMaterials: [Material] {
    (materials.value?.items ?? []).filter { m in
      m.published && (m.scanState == .clean || m.scanState == .notApplicable)
    }
  }

  public var isStudent: Bool { context.role == .student }

  /// Confirmed on the server (`learner_status.confirmed_at`) or during this session.
  public func isConfirmed(_ material: Material) -> Bool {
    receivedIds.contains(material.id) || material.isConfirmedByLearner
  }

  /// Student status line, e.g. 「確認済み（10月2日）」「テスト92点・合格（受験2回）」「提出済み（確認待ち）」.
  public func learnerStatusText(_ material: Material) -> String? {
    guard isStudent else { return nil }
    let status = material.learnerStatus
    switch material.kind {
    case .pdf, .video, .image, .link:
      if let at = status?.confirmedAt {
        return "確認済み（\(JaFormat.instantDate(at, calendar: context.calendar, withYear: false))）"
      }
      return receivedIds.contains(material.id) ? "確認済み" : nil
    case .quiz:
      guard let used = status?.quizAttemptsUsed, used > 0 else { return "未受験" }
      let score = status?.quizScore.map { "テスト\(UnitPresentation.formatScore($0))点・" } ?? ""
      return "\(score)\(status?.quizPassed == true ? "合格" : "不合格")（受験\(used)回）"
    case .assignment:
      return status?.submissionState.map(\.labelJa) ?? "未提出"
    }
  }

  public func load() async {
    materials.beginLoading()
    let api = context.api
    let unitId = self.unitId
    materials.apply(
      await context.fetch(cacheKey: "unit-materials/\(unitId)", checkedAt: { $0.checkedAt }) { () async throws in
        try await api.collectPage(maxPages: 3, query: ListQuery(limit: 100), { q in API.unitMaterials(unitId: unitId, query: q) })
      })
  }

  /// Returns what to open: a link material's https URL directly from the (permission-checked) DTO,
  /// otherwise a fresh 5-minute URL from `GET /materials/{id}/download` (never cached or stored).
  public func downloadURL(for material: Material) async -> MaterialDownload? {
    guard !busyIds.contains(material.id) else { return nil }
    actionError = nil
    if material.kind == .link, let url = material.secureExternalURL {
      return MaterialDownload(url: url.absoluteString, expiresAt: context.now().addingTimeInterval(300), contentType: "text/html")
    }
    busyIds.insert(material.id)
    defer { busyIds.remove(material.id) }
    do {
      let download = try await context.api.send(API.materialDownload(id: material.id)).value.data
      guard let url = URL(string: download.url), url.scheme?.lowercased() == "https" || Self.isLoopback(url) else {
        actionError = .local(code: "INVALID_URL", messageJa: "教材のURLが正しくありません。管理者にお問い合わせください。")
        return nil
      }
      return download
    } catch {
      actionError = error
      return nil
    }
  }

  /// A local development stack serves presigned URLs over http://127.0.0.1.
  nonisolated static func isLoopback(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "http" && ["127.0.0.1", "localhost"].contains(url.host ?? "")
  }

  /// 「教材を確認しました」 → `POST /materials/{id}/receipt` (`data: {material_id, confirmed_at, unit_state}`).
  public func confirmReceipt(_ material: Material) async {
    guard !busyIds.contains(material.id), !isConfirmed(material) else { return }
    if let blocker = context.mutationBlocker() {
      actionError = blocker
      return
    }
    let action = "receipt:\(material.id)"
    let key = keys.key(for: action)
    busyIds.insert(material.id)
    actionError = nil
    defer { busyIds.remove(material.id) }
    do {
      let result = try await context.api.send(API.materialReceipt(id: material.id, key: key)).value
      guard result.success else {
        actionError = .local(code: "NOT_RECORDED", messageJa: "確認を記録できませんでした。再度お試しください。")
        return
      }
      keys.complete(action)
      receivedIds.insert(material.id)
      actionMessage = "「\(material.title)」の確認を記録しました。"
    } catch {
      actionError = error
    }
  }
}

/// Server-scored quiz (no answers on the client).
@MainActor
@Observable
public final class QuizModel {
  public let material: Material
  public private(set) var quiz = Loadable<DataEnvelope<Quiz>>()
  public private(set) var session: QuizSession?
  public private(set) var result: QuizResult?
  public private(set) var isSubmitting = false
  public private(set) var error: ARMSError?
  private var attemptKey = IdempotencyKey()
  public let context: AppContext

  public init(material: Material, context: AppContext) {
    self.material = material
    self.context = context
  }

  public func load() async {
    quiz.beginLoading()
    let api = context.api
    let id = material.id
    // Quiz content is not cached offline: attempts must be fresh.
    quiz.apply(
      await context.fetch(cacheKey: nil, checkedAt: { $0.checkedAt }) { () async throws in
        try await api.send(API.quiz(materialId: id)).value
      })
    if let q = quiz.value?.data, session?.quiz != q || result != nil {
      session = QuizSession(quiz: q)
      result = nil
      attemptKey = IdempotencyKey()
    }
  }

  public func select(_ choiceId: String, for questionId: String) { session?.select(choiceId, for: questionId) }
  public func next() { session?.next() }
  public func previous() { session?.previous() }

  public var canSubmit: Bool {
    guard let session else { return false }
    return session.isComplete && session.quiz.attemptsRemaining > 0 && !isSubmitting && result == nil && context.canMutate
  }

  public func submit() async {
    guard let session, session.isComplete, !isSubmitting, result == nil else { return }
    if let blocker = context.mutationBlocker() {
      error = blocker
      return
    }
    isSubmitting = true
    error = nil
    defer { isSubmitting = false }
    do {
      result = try await context.api.send(API.submitQuiz(materialId: material.id, input: session.input(), key: attemptKey))
        .value.data
    } catch {
      self.error = error
      if !error.isConnectivity, error.httpStatus.map({ $0 < 500 }) ?? false { attemptKey = IdempotencyKey() }
    }
  }

  /// 「100点・合格」 (server score of this attempt only).
  public var resultText: String? {
    guard let result else { return nil }
    return "\(UnitPresentation.formatScore(result.score))点・\(result.passed ? "合格" : "不合格")"
  }

  /// 「5問中4問正解 / 合格点80点」.
  public var resultDetail: String? {
    guard let result else { return nil }
    return "\(result.questionCount)問中\(result.correctCount)問正解 / 合格点\(UnitPresentation.formatScore(result.passScore))点"
  }

  /// 「進捗に反映される点数：92点（残り1回受験できます）」.
  public var resultPolicyText: String? {
    guard let result else { return nil }
    let remaining = result.attemptsRemaining > 0 ? "残り\(result.attemptsRemaining)回受験できます" : "受験回数の上限に達しました"
    return "進捗に反映される点数：\(UnitPresentation.formatScore(result.effectiveScore))点（\(remaining)）"
  }

  /// Another attempt is possible after a failed one (server count).
  public var canRetry: Bool {
    guard let result else { return false }
    return !result.passed && result.attemptsRemaining > 0
  }

  /// Starts a new attempt (only when the server still allows one).
  public func retry() async {
    result = nil
    await load()
  }
}

/// A file chosen for an assignment (PDF / PNG / JPEG, ≤ 20 MB).
public struct AssignmentAttachment: Sendable, Equatable {
  public let filename: String
  public let contentType: String
  public let data: Data

  public init(filename: String, contentType: String, data: Data) {
    self.filename = filename
    self.contentType = contentType
    self.data = data
  }

  /// 「報告書.pdf（1.2MB）」.
  public var label: String {
    let mb = Double(data.count) / 1_048_576
    let size = mb >= 1 ? String(format: "%.1fMB", mb) : "\(max(1, data.count / 1024))KB"
    return "\(filename)（\(size)）"
  }
}

/// Assignment submission (`POST /materials/{id}/submissions`) with an optional file:
/// `POST /uploads` (purpose assignment) → presigned PUT with `required_headers` →
/// `POST /uploads/{id}/complete` → submit with `object_key`.
@MainActor
@Observable
public final class AssignmentModel {
  public enum Phase: Equatable, Sendable {
    case idle
    case uploading
    case verifying
    case submitting
  }

  public let material: Material
  public var body = ""
  public private(set) var attachment: AssignmentAttachment?
  public private(set) var phase: Phase = .idle
  public private(set) var error: ARMSError?
  public private(set) var submission: Submission?
  /// Upload already completed for the current attachment (reused when only the submit failed).
  private var completedUpload: (attachment: AssignmentAttachment, objectKey: String)?
  private var uploadKeys = ActionKeys()
  private var keys = ActionKeys()
  public let context: AppContext

  public init(material: Material, context: AppContext) {
    self.material = material
    self.context = context
  }

  public var isSubmitting: Bool { phase != .idle }

  /// 「提出中…」 labels for the button.
  public var progressLabel: String? {
    switch phase {
    case .idle: return nil
    case .uploading: return "ファイルを送信中…"
    case .verifying: return "ファイルを確認中…"
    case .submitting: return "提出中…"
    }
  }

  public var validationMessage: String? { AssignmentRules.validate(body, hasAttachment: attachment != nil) }
  public var characterCountLabel: String { "\(body.count) / \(AssignmentRules.maxLength)文字" }

  /// The server refuses a new submission while one waits for review or after acceptance.
  public var blockedReason: String? {
    switch material.learnerStatus?.submissionState {
    case .submitted?: return ErrorCatalog.message(for: "SUBMISSION_AWAITING_REVIEW")
    case .accepted?: return ErrorCatalog.message(for: "SUBMISSION_ALREADY_ACCEPTED")
    default: return nil
    }
  }

  /// Latest teacher comment (e.g. for a revision request).
  public var teacherFeedback: String? {
    guard let feedback = material.learnerStatus?.feedback, !feedback.isEmpty else { return nil }
    return feedback
  }

  /// Attaches a file after local checks (type, extension, size). Returns the error message, if any.
  @discardableResult
  public func attach(filename: String, contentType: String, data: Data) -> String? {
    if let message = AssignmentRules.validateAttachment(filename: filename, contentType: contentType, sizeBytes: data.count) {
      error = .validation(["file": message])
      return message
    }
    attachment = AssignmentAttachment(filename: filename, contentType: contentType, data: data)
    error = nil
    return nil
  }

  public func removeAttachment() {
    attachment = nil
    if error?.fieldErrors["file"] != nil { error = nil }
  }

  public func submit() async {
    guard !isSubmitting, submission == nil else { return }
    if let blocker = context.mutationBlocker() {
      error = blocker
      return
    }
    if let message = validationMessage {
      error = .validation(["body": message])
      return
    }
    let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
    error = nil
    defer { phase = .idle }
    do throws(ARMSError) {
      var objectKey: String?
      if let attachment {
        objectKey = try await upload(attachment)
      }
      phase = .submitting
      let action = "submission:\(material.id):\(text):\(objectKey ?? "")"
      let key = keys.key(for: action)
      do throws(ARMSError) {
        submission = try await context.api.send(
          API.submitAssignment(materialId: material.id, input: SubmissionInput(body: text, objectKey: objectKey), key: key)
        ).value.data
        keys.complete(action)
      } catch {
        if !error.isConnectivity, error.httpStatus.map({ $0 < 500 }) ?? false { keys.complete(action) }
        if ["UPLOAD_EXPIRED", "FILE_REJECTED", "UPLOAD_NOT_READY"].contains(error.code) { completedUpload = nil }
        throw error
      }
    } catch {
      self.error = error
    }
  }

  /// Quarantine upload; returns the `object_key` to attach.
  private func upload(_ attachment: AssignmentAttachment) async throws(ARMSError) -> String {
    if let done = completedUpload, done.attachment == attachment { return done.objectKey }
    let api = context.api
    phase = .uploading
    let action = "upload:\(attachment.filename):\(attachment.data.count):\(attachment.data.hashValue)"
    let ticket: UploadTicket
    do {
      ticket = try await api.send(
        API.createUpload(
          UploadInput(
            filename: attachment.filename, contentType: attachment.contentType, sizeBytes: attachment.data.count,
            purpose: .assignment),
          key: uploadKeys.key(for: action))
      ).value.data
    } catch {
      if !error.isConnectivity { uploadKeys.complete(action) }
      throw error
    }
    // The presigned URL is single-use per ticket: a later retry must request a new one.
    uploadKeys.complete(action)
    try await api.putObject(ticket, body: attachment.data)
    phase = .verifying
    let completed = try await api.send(API.completeUpload(id: ticket.id, key: IdempotencyKey())).value
    if let status = try? completed.data?.decode(UploadStatus.self), !status.isAttachable {
      throw ARMSError.local(
        code: status.state == .expired ? "UPLOAD_EXPIRED" : "FILE_REJECTED",
        messageJa: ErrorCatalog.message(for: status.state == .expired ? "UPLOAD_EXPIRED" : "FILE_REJECTED"))
    }
    completedUpload = (attachment, ticket.objectKey)
    return ticket.objectKey
  }

  public var successMessage: String? {
    guard let submission else { return nil }
    let file = submission.hasFile ? "（ファイル添付あり）" : ""
    return "提出しました\(file)（\(submission.state.labelJa)）。講師の評価をお待ちください。"
  }
}
