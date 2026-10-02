import Foundation
import Observation

/// IOS-12 教材・確認テスト for one unit: private material download (5-minute URL), receipt,
/// quiz and assignment entry points.
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
  public var visibleMaterials: [Material] {
    (materials.value?.items ?? []).filter { m in
      m.published && (m.scanState == .clean || m.scanState == .notApplicable)
    }
  }

  public var isStudent: Bool { context.role == .student }

  public func load() async {
    materials.beginLoading()
    let api = context.api
    let unitId = self.unitId
    materials.apply(
      await context.fetch(cacheKey: "unit-materials/\(unitId)", checkedAt: { $0.checkedAt }) { () async throws in
        try await api.collectPage(maxPages: 3, query: ListQuery(limit: 100), { q in API.unitMaterials(unitId: unitId, query: q) })
      })
  }

  /// Requests a fresh short-lived URL right before opening (never cached or stored).
  public func downloadURL(for material: Material) async -> MaterialDownload? {
    guard !busyIds.contains(material.id) else { return nil }
    busyIds.insert(material.id)
    actionError = nil
    defer { busyIds.remove(material.id) }
    do {
      let download = try await context.api.send(API.materialDownload(id: material.id)).value.data
      guard let url = URL(string: download.url), url.scheme?.lowercased() == "https" else {
        actionError = .local(code: "INVALID_URL", messageJa: "教材のURLが正しくありません。管理者にお問い合わせください。")
        return nil
      }
      return download
    } catch {
      actionError = error
      return nil
    }
  }

  /// 「教材を確認しました」 → `POST /materials/{id}/receipt`.
  public func confirmReceipt(_ material: Material) async {
    guard !busyIds.contains(material.id), !receivedIds.contains(material.id) else { return }
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
    if let q = quiz.value?.data, session?.quiz.id != q.id || result != nil {
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

  /// 「88点・合格」 (server score only).
  public var resultText: String? {
    guard let result else { return nil }
    return "\(UnitPresentation.formatScore(result.score))点・\(result.passed ? "合格" : "不合格")"
  }

  /// Starts a new attempt (only when the server still allows one).
  public func retry() async {
    result = nil
    await load()
  }
}

/// Assignment submission (text body; `POST /materials/{id}/submissions`).
@MainActor
@Observable
public final class AssignmentModel {
  public let material: Material
  public var body = ""
  public private(set) var isSubmitting = false
  public private(set) var error: ARMSError?
  public private(set) var submission: Submission?
  private var keys = ActionKeys()
  public let context: AppContext

  public init(material: Material, context: AppContext) {
    self.material = material
    self.context = context
  }

  public var validationMessage: String? { AssignmentRules.validate(body) }
  public var characterCountLabel: String { "\(body.count) / \(AssignmentRules.maxLength)文字" }

  public func submit() async {
    guard !isSubmitting else { return }
    if let blocker = context.mutationBlocker() {
      error = blocker
      return
    }
    if let message = validationMessage {
      error = .validation(["body": message])
      return
    }
    let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
    let action = "submission:\(material.id):\(text)"
    let key = keys.key(for: action)
    isSubmitting = true
    error = nil
    defer { isSubmitting = false }
    do {
      submission = try await context.api.send(
        API.submitAssignment(materialId: material.id, input: SubmissionInput(body: text), key: key)
      ).value.data
      keys.complete(action)
    } catch {
      self.error = error
    }
  }

  public var successMessage: String? {
    guard let submission else { return nil }
    return "提出しました（\(submission.state.labelJa)）。講師の評価をお待ちください。"
  }
}
