import Foundation
import Observation

/// UI state labels (labels.ts `VOICE_STATE_LABELS`).
public enum VoiceUIState: String, Sendable, Equatable, CaseIterable {
  case idle
  case connecting
  case listening
  case confirming
  case speaking
  case reconnecting
  case error

  public var labelJa: String {
    switch self {
    case .idle: return "待機中"
    case .connecting: return "接続中"
    case .listening: return "聞いています"
    case .confirming: return "確認中"
    case .speaking: return "話しています"
    case .reconnecting: return "再接続中"
    case .error: return "エラー"
    }
  }
}

public enum VoiceEndReason: Sendable, Equatable {
  case user
  case silence
  case maxDuration
  case background
  case interruption
  case connectionLost
  case failure(String)

  /// Message shown after the session ended (nil when the user ended it).
  public var messageJa: String? {
    switch self {
    case .user: return nil
    case .silence: return "60秒間音声がなかったため、音声を終了しました。"
    case .maxDuration: return "1回の会話の上限時間に達したため、音声を終了しました。"
    case .background: return "アプリがバックグラウンドに移動したため、音声を終了しました。"
    case .interruption: return "通話などの割り込みがあったため、音声を終了しました。"
    case .connectionLost: return "通信が切断されたため、音声を終了しました。もう一度開始できます。"
    case .failure(let message): return message
    }
  }
}

/// Structured result shown inline in the conversation (e.g. the 「本日の授業」 card).
public enum VoiceResultCard: Sendable, Equatable {
  case lessons(title: String, [LessonSlot])
  case reservations([Reservation])
  case progress(StudentProgress)

  static func parse(tool: VoiceTool, data: JSONValue?) -> VoiceResultCard? {
    guard let data else { return nil }
    func list(_ keys: [String]) -> JSONValue? {
      if case .array = data { return data }
      for k in keys { if let v = data[k], case .array = v { return v } }
      return nil
    }
    switch tool {
    case .todayLessons:
      if let items = list(["items", "lessons"]), let slots = try? items.decode([LessonSlot].self) {
        return .lessons(title: "本日の授業", slots)
      }
    case .searchSlots:
      if let items = list(["items", "slots"]), let slots = try? items.decode([LessonSlot].self) {
        return .lessons(title: "空き枠", slots)
      }
    case .getReservations:
      if let items = list(["items", "reservations"]), let r = try? items.decode([Reservation].self) {
        return .reservations(r)
      }
      if let single = try? (data["reservation"] ?? data).decode(Reservation.self) { return .reservations([single]) }
    case .getProgress:
      if let p = try? (data["progress"] ?? data).decode(StudentProgress.self) { return .progress(p) }
    default:
      return nil
    }
    return nil
  }
}

public struct VoiceTranscriptEntry: Sendable, Equatable, Identifiable {
  public enum Speaker: Sendable, Equatable {
    case user
    case assistant
    /// Local status line (tool refused, result of an on-screen confirmation…).
    case notice
  }

  public let id: String
  public let speaker: Speaker
  public var text: String
  public var isFinal: Bool
  public var interrupted: Bool
  public var card: VoiceResultCard?
}

/// Executes allow-listed tools through `POST /voice/tool-calls`.
public protocol VoiceToolExecuting: Sendable {
  func execute(_ input: VoiceToolInput, key: IdempotencyKey) async throws(ARMSError) -> ActionResult
}

public struct APIVoiceToolExecutor: VoiceToolExecuting {
  let api: APIClient
  public init(api: APIClient) { self.api = api }

  public func execute(_ input: VoiceToolInput, key: IdempotencyKey) async throws(ARMSError) -> ActionResult {
    try await api.send(API.voiceToolCall(input, key: key)).value
  }
}

/// Platform-independent voice conversation logic: transcript, tool-call bridge, the
/// confirmation gate, barge-in, single-active-response discipline and silence/max timers.
///
/// Invariants:
/// - Only one model response is active at a time: `response.create` is sent only when no response
///   is in progress, so assistant audio can never play twice concurrently.
/// - Tool outputs are returned with `conversation.item.create` (`function_call_output`) after the
///   response that requested them is done, followed by exactly one `response.create`.
/// - Commit tools reach the API only after an explicit confirmation of the same, unexpired card.
@MainActor
@Observable
public final class VoiceConversation {
  public static let silenceTimeout: TimeInterval = 60
  public static let transcriptWait: TimeInterval = 3

  public let sessionId: String
  public let role: Role
  public let calendar: OrgCalendar
  public let expiresAt: Date?

  public private(set) var entries: [VoiceTranscriptEntry] = []
  public private(set) var confirmation = ConfirmationMachine()
  public private(set) var isMuted = false
  public private(set) var pushToTalk = false
  public private(set) var isTalking = false
  public private(set) var assistantSpeaking = false
  public private(set) var lastErrorMessage: String?
  public private(set) var endRequest: VoiceEndReason?

  private let sendEvent: (RealtimeClientEvent) -> Bool
  private let setMicrophone: (Bool) -> Void
  private let executor: any VoiceToolExecuting
  private let now: () -> Date
  private let sleeper: any Sleeper

  private var activeResponseId: String?
  private var awaitingResponseCreated = false
  private var lastActivityAt: Date
  private var handledCallIds = Set<String>()
  private var runningCalls = Set<String>()
  private var readyOutputs: [(callId: String, output: String)] = []
  private var pendingSystemMessages: [String] = []
  /// A user turn (text or push-to-talk) arrived while a response was active: answer it next.
  private var responseRequested = false
  private var pendingUserItems = Set<String>()
  private var callKeys: [String: IdempotencyKey] = [:]
  private var buttonCommitKeys: [String: IdempotencyKey] = [:]
  private var assistantItemByResponse: [String: String] = [:]
  private var currentAssistantItemId: String?

  public init(
    sessionId: String, role: Role, calendar: OrgCalendar, expiresAt: Date?,
    executor: any VoiceToolExecuting, now: @escaping () -> Date, sleeper: any Sleeper = TaskSleeper(),
    send: @escaping (RealtimeClientEvent) -> Bool, setMicrophone: @escaping (Bool) -> Void
  ) {
    self.sessionId = sessionId
    self.role = role
    self.calendar = calendar
    self.expiresAt = expiresAt
    self.executor = executor
    self.now = now
    self.sleeper = sleeper
    self.sendEvent = send
    self.setMicrophone = setMicrophone
    self.lastActivityAt = now()
  }

  // MARK: Derived state

  /// State chip shown on IOS-13/14 while connected.
  public var uiState: VoiceUIState {
    if assistantSpeaking { return .speaking }
    if confirmation.state.isAwaitingUser { return .confirming }
    if pushToTalk && !isTalking { return .idle }
    return .listening
  }

  public var hasActiveResponse: Bool { activeResponseId != nil || awaitingResponseCreated }
  public var hasRunningToolCalls: Bool { !runningCalls.isEmpty }

  // MARK: Server events

  public func handle(_ event: RealtimeServerEvent) {
    switch event {
    case .sessionCreated, .sessionUpdated, .ignored:
      break
    case .speechStarted(let itemId):
      touch()
      if let itemId { pendingUserItems.insert(itemId) }
      if assistantSpeaking || activeResponseId != nil { bargeIn() }
    case .speechStopped(let itemId):
      touch()
      if let itemId { pendingUserItems.insert(itemId) }
    case .inputTranscriptDelta(let itemId, let delta):
      touch()
      appendText(id: "u-\(itemId)", speaker: .user, delta: delta)
    case .inputTranscriptCompleted(let itemId, let transcript):
      touch()
      pendingUserItems.remove(itemId)
      finalize(id: "u-\(itemId)", speaker: .user, text: transcript)
      evaluateConfirmation(utterance: transcript, method: .voice(transcript: transcript))
    case .inputTranscriptFailed(let itemId):
      pendingUserItems.remove(itemId)
    case .responseCreated(let responseId):
      activeResponseId = responseId.isEmpty ? "unknown" : responseId
      awaitingResponseCreated = false
    case .outputTranscriptDelta(let responseId, let itemId, let delta):
      touch()
      if let responseId { assistantItemByResponse[responseId] = itemId }
      currentAssistantItemId = itemId
      appendText(id: "a-\(itemId)", speaker: .assistant, delta: delta)
    case .outputTranscriptDone(_, let itemId, let transcript):
      touch()
      if !transcript.isEmpty { finalize(id: "a-\(itemId)", speaker: .assistant, text: transcript) }
    case .functionCallArgumentsDone(let call):
      startToolCall(call)
    case .responseDone(let responseId, let status, let calls):
      for call in calls { startToolCall(call) }
      if status == "cancelled" || status == "incomplete", let responseId,
        let itemId = assistantItemByResponse[responseId]
      {
        markInterrupted(id: "a-\(itemId)")
      }
      if responseId == nil || responseId == activeResponseId || activeResponseId == "unknown" {
        activeResponseId = nil
      }
      awaitingResponseCreated = false
      flushIfReady()
    case .outputAudioStarted:
      touch()
      assistantSpeaking = true
    case .outputAudioStopped, .outputAudioCleared:
      touch()
      assistantSpeaking = false
    case .error(let code, _, _):
      // Benign races (cancelling a response that already finished) are expected after barge-in.
      if let code, code.contains("cancel") || code == "response_cancel_not_active" { return }
      lastErrorMessage = "音声アシスタントで問題が発生しました。もう一度お話しいただくか、画面から操作してください。"
    }
  }

  // MARK: Local actions

  public func sendText(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, endRequest == nil else { return }
    touch()
    entries.append(
      VoiceTranscriptEntry(
        id: "t-\(UUID().uuidString)", speaker: .user, text: trimmed, isFinal: true, interrupted: false, card: nil))
    evaluateConfirmation(utterance: trimmed, method: .text(trimmed))
    if assistantSpeaking || activeResponseId != nil { bargeIn() }
    _ = sendEvent(.userText(trimmed))
    requestResponse()
  }

  public func setMuted(_ muted: Bool) {
    isMuted = muted
    applyMicrophone()
  }

  /// Push-to-talk mode disables server VAD; the user holds the talk button to speak.
  public func setPushToTalk(_ enabled: Bool) {
    guard pushToTalk != enabled else { return }
    pushToTalk = enabled
    isTalking = false
    _ = sendEvent(.setTurnDetection(serverVAD: !enabled))
    applyMicrophone()
  }

  public func beginTalking() {
    guard pushToTalk, !isTalking else { return }
    touch()
    if assistantSpeaking || activeResponseId != nil { bargeIn() }
    _ = sendEvent(.inputAudioBufferClear)
    isTalking = true
    applyMicrophone()
  }

  public func endTalking() {
    guard pushToTalk, isTalking else { return }
    touch()
    isTalking = false
    applyMicrophone()
    _ = sendEvent(.inputAudioBufferCommit)
    requestResponse()
  }

  /// 「内容を変更する」: discards the card (nothing was written) and lets the user restate.
  public func requestChange() {
    guard confirmation.state.card != nil else { return }
    confirmation.discard()
    addNotice("確認内容を取り消しました。申請は送信していません。変更したい内容をお話しください。")
    queueSystemMessage("利用者は確認内容を変更したいと言っています。申請は送信していません。希望の日時や授業を改めて確認してください。")
  }

  /// 「この内容で申請する」 button: explicit confirmation and direct commit via the API.
  public func confirmByButton() async {
    guard case .awaiting(let card) = confirmation.state else { return }
    guard confirmation.confirm(.button, now: now()) else {
      addNotice(VoiceToolRejection.confirmationExpired.messageJa)
      return
    }
    let tool: VoiceTool = card.intent == .reserve ? .commitReservation : .commitCancellation
    let key = buttonCommitKeys[card.actionToken] ?? IdempotencyKey()
    buttonCommitKeys[card.actionToken] = key
    let callId = "ui-confirm-\(key.value)"
    let outcome = await commit(card: card, tool: tool, callId: callId, key: key)
    let summary = outcome.jsonString()
    queueSystemMessage(
      "利用者が画面のボタンで確認内容を確定しました。サーバーの結果: \(summary)。この結果だけを根拠に、日本語で簡潔に伝えてください。")
  }

  /// Periodic check (1 s): confirmation expiry, 60 s silence, server session expiry.
  public func tick() {
    let t = now()
    confirmation.tick(now: t)
    guard endRequest == nil else { return }
    if let expiresAt, t >= expiresAt {
      endRequest = .maxDuration
      return
    }
    if !assistantSpeaking, runningCalls.isEmpty, !hasActiveResponse,
      t.timeIntervalSince(lastActivityAt) >= VoiceConversation.silenceTimeout
    {
      endRequest = .silence
    }
  }

  /// Called when the session ends for any reason: an unconfirmed card is discarded and never re-sent.
  public func finish() {
    switch confirmation.state {
    case .committed, .failed, .none, .discarded: break
    default: confirmation.discard()
    }
    readyOutputs.removeAll()
    pendingSystemMessages.removeAll()
    responseRequested = false
  }

  public func clearError() { lastErrorMessage = nil }

  // MARK: Tool calls

  private func startToolCall(_ call: RealtimeFunctionCall) {
    guard !handledCallIds.contains(call.callId) else { return }
    handledCallIds.insert(call.callId)
    runningCalls.insert(call.callId)
    touch()
    Task { @MainActor [weak self] in
      guard let self else { return }
      let output = await self.execute(call)
      self.runningCalls.remove(call.callId)
      self.readyOutputs.append((call.callId, output.jsonString()))
      self.flushIfReady()
    }
  }

  /// Validates and executes one model tool call; returns the JSON output for the model.
  func execute(_ call: RealtimeFunctionCall) async -> JSONValue {
    guard let tool = VoiceTool(rawValue: call.name) else {
      return rejectionOutput(.unknownTool(call.name))
    }
    guard tool.isAllowed(for: role) else { return rejectionOutput(.notAllowedForRole) }
    let arguments: JSONValue
    switch tool.validate(argumentsJSON: call.arguments) {
    case .failure(let rejection): return rejectionOutput(rejection)
    case .success(let value): arguments = value
    }

    if tool.isCommit, let intent = tool.intent {
      let token = arguments["action_token"]?.stringValue ?? ""
      await waitForPendingTranscripts()
      switch confirmation.authorizeCommit(token: token, intent: intent, now: now()) {
      case .failure(let rejection):
        if rejection == .confirmationRequired {
          addNotice("確認が取れていないため、まだ送信していません。ボタンを押すか「はい、申請して」とお答えください。")
        }
        return rejectionOutput(rejection)
      case .success(let card):
        let key = callKeys[call.callId] ?? IdempotencyKey()
        callKeys[call.callId] = key
        return await performCommit(card: card, tool: tool, callId: call.callId, key: key)
      }
    }

    let key = callKeys[call.callId] ?? IdempotencyKey()
    callKeys[call.callId] = key
    let input = VoiceToolInput(sessionId: sessionId, callId: call.callId, toolName: tool.rawValue, arguments: arguments)
    do {
      let result = try await executor.execute(input, key: key)
      if tool.isPrepare, let intent = tool.intent {
        if let card = VoiceConfirmationCard.parse(data: result.data, intent: intent, receivedAt: now(), calendar: calendar)
        {
          confirmation.present(card)
        } else {
          addNotice("確認内容を表示できませんでした。画面から操作してください。")
          return errorOutput(code: "INVALID_RESPONSE", message: "確認内容を表示できませんでした。画面から操作してください。")
        }
      }
      if let card = VoiceResultCard.parse(tool: tool, data: result.data) {
        attachCard(card)
      }
      return successOutput(result)
    } catch {
      if tool.isPrepare, error.code == "ACTION_TOKEN_INVALID" { confirmation.discard() }
      return errorOutput(code: error.code, message: error.messageJa)
    }
  }

  private func commit(card: VoiceConfirmationCard, tool: VoiceTool, callId: String, key: IdempotencyKey) async -> JSONValue {
    switch confirmation.authorizeCommit(token: card.actionToken, intent: card.intent, now: now()) {
    case .failure(let rejection):
      addNotice(rejection.messageJa)
      return rejectionOutput(rejection)
    case .success(let authorized):
      return await performCommit(card: authorized, tool: tool, callId: callId, key: key)
    }
  }

  private func performCommit(card: VoiceConfirmationCard, tool: VoiceTool, callId: String, key: IdempotencyKey) async
    -> JSONValue
  {
    let input = VoiceToolInput(
      sessionId: sessionId, callId: callId, toolName: tool.rawValue, arguments: ["action_token": .string(card.actionToken)])
    do {
      let result = try await executor.execute(input, key: key)
      let message = VoiceConversation.commitMessage(intent: card.intent, data: result.data)
      confirmation.finishCommit(success: true, message: message)
      addNotice(message)
      return successOutput(result)
    } catch {
      confirmation.finishCommit(success: false, message: error.messageJa)
      addNotice(error.messageJa)
      return errorOutput(code: error.code, message: error.messageJa)
    }
  }

  /// Result line after a commit. 「予約確定」 is only used when the server says `approved`.
  static func commitMessage(intent: VoiceIntent, data: JSONValue?) -> String {
    let status = (data?["reservation"]?["status"] ?? data?["status"])?.stringValue.flatMap(ReservationStatus.init(rawValue:))
    switch (intent, status) {
    case (.reserve, .pending?): return "予約を申請しました。現在、担当講師の承認待ちです。"
    case (.reserve, .approved?): return "予約が確定しました。"
    case (.reserve, _): return "申請を受け付けました。状態は「自分の予約」で確認できます。"
    case (.cancel, .cancelled?): return "予約を取り消しました。"
    case (.cancel, _): return "取消を受け付けました。状態は「自分の予約」で確認できます。"
    }
  }

  private func waitForPendingTranscripts() async {
    guard confirmation.state.isAwaitingUser, !pendingUserItems.isEmpty else { return }
    var waited: TimeInterval = 0
    while waited < VoiceConversation.transcriptWait, confirmation.state.isAwaitingUser, !pendingUserItems.isEmpty {
      do { try await sleeper.sleep(seconds: 0.1) } catch { return }
      waited += 0.1
    }
  }

  private func evaluateConfirmation(utterance: String, method: ConfirmationMethod) {
    guard case .awaiting(let card) = confirmation.state else { return }
    switch AffirmationClassifier.classify(utterance, intent: card.intent) {
    case .confirmed:
      confirmation.confirm(method, now: now())
    case .rejected:
      confirmation.discard()
      addNotice(card.intent == .reserve ? "申請は送信していません。" : "取消は送信していません。")
    case .ambiguous:
      break
    }
  }

  // MARK: Response discipline

  private func requestResponse() {
    guard !hasActiveResponse, runningCalls.isEmpty else {
      responseRequested = true
      return
    }
    if sendEvent(.responseCreate) { awaitingResponseCreated = true }
  }

  private func queueSystemMessage(_ text: String) {
    pendingSystemMessages.append(text)
    flushIfReady()
  }

  private func flushIfReady() {
    guard !hasActiveResponse, runningCalls.isEmpty else { return }
    guard !readyOutputs.isEmpty || !pendingSystemMessages.isEmpty || responseRequested else { return }
    for output in readyOutputs { _ = sendEvent(.functionCallOutput(callId: output.callId, output: output.output)) }
    for message in pendingSystemMessages { _ = sendEvent(.systemText(message)) }
    readyOutputs.removeAll()
    pendingSystemMessages.removeAll()
    responseRequested = false
    if sendEvent(.responseCreate) { awaitingResponseCreated = true }
  }

  /// User started speaking over the assistant: stop the current response and drop buffered audio
  /// so the old answer never continues or replays.
  private func bargeIn() {
    if let id = activeResponseId {
      _ = sendEvent(.responseCancel(responseId: id == "unknown" ? nil : id))
    }
    if assistantSpeaking { _ = sendEvent(.outputAudioBufferClear) }
    if let itemId = currentAssistantItemId { markInterrupted(id: "a-\(itemId)") }
    assistantSpeaking = false
  }

  private func applyMicrophone() {
    let enabled = !isMuted && (!pushToTalk || isTalking)
    setMicrophone(enabled)
  }

  // MARK: Transcript helpers

  private func touch() { lastActivityAt = now() }

  private func appendText(id: String, speaker: VoiceTranscriptEntry.Speaker, delta: String) {
    if let i = entries.firstIndex(where: { $0.id == id }) {
      if !entries[i].isFinal { entries[i].text += delta }
    } else {
      entries.append(VoiceTranscriptEntry(id: id, speaker: speaker, text: delta, isFinal: false, interrupted: false, card: nil))
    }
  }

  private func finalize(id: String, speaker: VoiceTranscriptEntry.Speaker, text: String) {
    if let i = entries.firstIndex(where: { $0.id == id }) {
      if !entries[i].interrupted { entries[i].text = text }
      entries[i].isFinal = true
    } else if !text.isEmpty {
      entries.append(VoiceTranscriptEntry(id: id, speaker: speaker, text: text, isFinal: true, interrupted: false, card: nil))
    }
  }

  private func markInterrupted(id: String) {
    if let i = entries.firstIndex(where: { $0.id == id }) {
      entries[i].interrupted = true
      entries[i].isFinal = true
    }
  }

  private func addNotice(_ text: String) {
    entries.append(
      VoiceTranscriptEntry(id: "n-\(UUID().uuidString)", speaker: .notice, text: text, isFinal: true, interrupted: false, card: nil))
  }

  private func attachCard(_ card: VoiceResultCard) {
    entries.append(
      VoiceTranscriptEntry(id: "c-\(UUID().uuidString)", speaker: .notice, text: "", isFinal: true, interrupted: false, card: card))
  }

  // MARK: Output JSON

  private func successOutput(_ result: ActionResult) -> JSONValue {
    ["ok": true, "data": result.data ?? .null, "checked_at": .string(ISO8601.format(result.checkedAt))]
  }

  private func errorOutput(code: String, message: String) -> JSONValue {
    ["ok": false, "code": .string(code), "message_ja": .string(message)]
  }

  private func rejectionOutput(_ rejection: VoiceToolRejection) -> JSONValue {
    errorOutput(code: rejection.code, message: rejection.messageJa)
  }
}
