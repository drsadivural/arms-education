import Foundation
import XCTest

@testable import ARMSKit

// MARK: - Fakes

final class FakeToolExecutor: VoiceToolExecuting, @unchecked Sendable {
  private let lock = NSLock()
  private var calls: [(input: VoiceToolInput, key: IdempotencyKey)] = []
  var results: [String: Result<ActionResult, ARMSError>] = [:]

  var inputs: [VoiceToolInput] { lock.withLock { calls.map(\.input) } }
  var keys: [IdempotencyKey] { lock.withLock { calls.map(\.key) } }

  func execute(_ input: VoiceToolInput, key: IdempotencyKey) async throws(ARMSError) -> ActionResult {
    let result: Result<ActionResult, ARMSError> = lock.withLock {
      calls.append((input, key))
      return results[input.toolName] ?? .success(ActionResult(success: true, checkedAt: fixedNow, data: nil))
    }
    return try result.get()
  }

  static func ok(_ data: JSONValue?) -> Result<ActionResult, ARMSError> {
    .success(ActionResult(success: true, checkedAt: fixedNow, data: data))
  }
}

@MainActor
final class EventSink {
  var events: [RealtimeClientEvent] = []
  var microphone: [Bool] = []
  var open = true

  func send(_ e: RealtimeClientEvent) -> Bool {
    guard open else { return false }
    events.append(e)
    return true
  }

  var types: [String] { events.compactMap { $0.json["type"]?.stringValue } }
  func count(_ type: String) -> Int { types.filter { $0 == type }.count }
}

let token32 = String(repeating: "t", count: 40)

func prepareData(expires: String = "2026-10-02T02:02:00Z", token: String = token32) -> JSONValue {
  [
    "action_token": .string(token), "expires_at": .string(expires), "intent": "reserve",
    "slot": [
      "id": .string(Fixtures.slotId), "title": "IT基礎・セキュリティ", "starts_at": "2026-10-05T05:00:00Z",
      "ends_at": "2026-10-05T06:30:00Z", "teacher_name": "田中 祥司", "classroom_name": "新入社員Aクラス",
    ],
    "student_name": "和田 一夫",
  ]
}

@MainActor
func makeConversation(
  role: Role = .student, clock: TestClock, executor: FakeToolExecutor, sink: EventSink, expiresAt: Date? = nil
) -> VoiceConversation {
  VoiceConversation(
    sessionId: "voice-session-1", role: role, calendar: .tokyo, expiresAt: expiresAt, executor: executor,
    now: { clock.now }, sleeper: RecordingSleeper(),
    send: { sink.send($0) }, setMicrophone: { sink.microphone.append($0) })
}

// MARK: - Event parsing

final class RealtimeEventTests: XCTestCase {
  func parse(_ json: String) -> RealtimeServerEvent? { RealtimeServerEvent.parse(Data(json.utf8)) }

  func testParsesGAEvents() {
    XCTAssertEqual(
      parse(#"{"type":"input_audio_buffer.speech_started","audio_start_ms":1000,"item_id":"msg_003"}"#),
      .speechStarted(itemId: "msg_003"))
    XCTAssertEqual(
      parse(#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"i","content_index":0,"transcript":"今日の授業を教えて"}"#),
      .inputTranscriptCompleted(itemId: "i", transcript: "今日の授業を教えて"))
    XCTAssertEqual(
      parse(#"{"type":"response.output_audio_transcript.delta","response_id":"r","item_id":"m","delta":"本日は"}"#),
      .outputTranscriptDelta(responseId: "r", itemId: "m", delta: "本日は"))
    XCTAssertEqual(
      parse(#"{"type":"response.audio_transcript.delta","response_id":"r","item_id":"m","delta":"x"}"#),
      .outputTranscriptDelta(responseId: "r", itemId: "m", delta: "x"), "beta alias accepted")
    XCTAssertEqual(
      parse(#"{"type":"response.function_call_arguments.done","response_id":"r","item_id":"fc","output_index":0,"call_id":"call_1","name":"today_lessons","arguments":"{}"}"#),
      .functionCallArgumentsDone(RealtimeFunctionCall(callId: "call_1", name: "today_lessons", arguments: "{}", itemId: "fc", responseId: "r")))
    XCTAssertEqual(parse(#"{"type":"output_audio_buffer.started","response_id":"r"}"#), .outputAudioStarted(responseId: "r"))
    XCTAssertEqual(parse(#"{"type":"output_audio_buffer.cleared","response_id":"r"}"#), .outputAudioCleared(responseId: "r"))
    XCTAssertEqual(parse(#"{"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}"#), .responseCreated(responseId: "resp_1"))
    XCTAssertEqual(
      parse(#"{"type":"error","error":{"type":"invalid_request_error","code":"invalid_event","message":"bad","event_id":"e1"}}"#),
      .error(code: "invalid_event", message: "bad", eventId: "e1"))
    XCTAssertEqual(parse(#"{"type":"rate_limits.updated"}"#), .ignored(type: "rate_limits.updated"))
    XCTAssertNil(parse("not json"))
    XCTAssertNil(parse(#"{"no_type":1}"#))
  }

  func testResponseDoneCarriesFunctionCalls() {
    let event = parse(
      #"{"type":"response.done","response":{"id":"resp_2","status":"completed","output":[{"type":"message","id":"m"},{"type":"function_call","id":"fc_1","call_id":"call_9","name":"get_progress","arguments":"{}"}]}}"#
    )
    XCTAssertEqual(
      event,
      .responseDone(
        responseId: "resp_2", status: "completed",
        functionCalls: [RealtimeFunctionCall(callId: "call_9", name: "get_progress", arguments: "{}", itemId: "fc_1", responseId: "resp_2")]))
  }

  func testClientEventShapes() throws {
    XCTAssertEqual(
      RealtimeClientEvent.functionCallOutput(callId: "call_1", output: #"{"ok":true}"#).json,
      ["type": "conversation.item.create", "item": ["type": "function_call_output", "call_id": "call_1", "output": #"{"ok":true}"#]])
    XCTAssertEqual(RealtimeClientEvent.responseCreate.json, ["type": "response.create"])
    XCTAssertEqual(RealtimeClientEvent.responseCancel(responseId: "r").json, ["type": "response.cancel", "response_id": "r"])
    XCTAssertEqual(RealtimeClientEvent.outputAudioBufferClear.json, ["type": "output_audio_buffer.clear"])
    XCTAssertEqual(
      RealtimeClientEvent.userText("はい、申請して").json["item"]?["content"]?[0]?["type"], "input_text")
    XCTAssertEqual(RealtimeClientEvent.setTurnDetection(serverVAD: false).json["session"]?["audio"]?["input"]?["turn_detection"], .null)
    XCTAssertEqual(
      RealtimeClientEvent.setTurnDetection(serverVAD: true).json["session"]?["audio"]?["input"]?["turn_detection"]?["type"],
      "server_vad")
    XCTAssertEqual(RealtimeClientEvent.setTurnDetection(serverVAD: true).json["session"]?["type"], "realtime")
    let decoded = try JSONValue(jsonData: RealtimeClientEvent.responseCreate.data)
    XCTAssertEqual(decoded["type"], "response.create")
  }
}

// MARK: - Tools and confirmation

final class VoiceToolTests: XCTestCase {
  func testAllowlistMatchesContract() throws {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("packages/contracts/voice-tools.json")
    if let data = try? Data(contentsOf: url) {
      let json = try JSONValue(jsonData: data)
      let names = Set((json["tools"]?.arrayValue ?? []).compactMap { $0["name"]?.stringValue })
      XCTAssertEqual(names, Set(VoiceTool.allCases.map(\.rawValue)))
    } else {
      XCTAssertEqual(VoiceTool.allCases.count, 8)
    }
  }

  func testArgumentValidation() {
    XCTAssertNoThrow(try VoiceTool.todayLessons.validate(argumentsJSON: "").get())
    XCTAssertNoThrow(try VoiceTool.searchSlots.validate(argumentsJSON: #"{"date":"2026-10-05","time_band":"afternoon"}"#).get())
    XCTAssertThrowsError(try VoiceTool.searchSlots.validate(argumentsJSON: #"{"date":"10月5日","time_band":"afternoon"}"#).get())
    XCTAssertThrowsError(try VoiceTool.searchSlots.validate(argumentsJSON: #"{"date":"2026-10-05","time_band":"night"}"#).get())
    XCTAssertThrowsError(try VoiceTool.searchSlots.validate(argumentsJSON: #"{"date":"2026-10-05"}"#).get())
    XCTAssertThrowsError(try VoiceTool.prepareReservation.validate(argumentsJSON: #"{"slot_id":"abc"}"#).get())
    XCTAssertThrowsError(
      try VoiceTool.prepareReservation.validate(argumentsJSON: #"{"slot_id":"\#(Fixtures.slotId)","org_id":"x"}"#).get(),
      "additionalProperties: false — client-supplied org/user ids are refused")
    XCTAssertThrowsError(try VoiceTool.commitReservation.validate(argumentsJSON: #"{"action_token":"short"}"#).get())
    XCTAssertThrowsError(try VoiceTool.getProgress.validate(argumentsJSON: "[1]").get())
  }

  func testTeacherCannotWriteByVoice() {
    XCTAssertTrue(VoiceTool.getProgress.isAllowed(for: .teacher))
    XCTAssertTrue(VoiceTool.getReservations.isAllowed(for: .teacher))
    XCTAssertFalse(VoiceTool.prepareReservation.isAllowed(for: .teacher))
    XCTAssertFalse(VoiceTool.commitCancellation.isAllowed(for: .teacher))
    XCTAssertTrue(VoiceTool.commitReservation.isAllowed(for: .student))
    XCTAssertFalse(VoiceTool.todayLessons.isAllowed(for: .admin))
  }

  func testAffirmationClassifier() {
    typealias C = AffirmationClassifier
    XCTAssertEqual(C.classify("はい、申請して", intent: .reserve), .confirmed)
    XCTAssertEqual(C.classify("その内容でお願いします。", intent: .reserve), .confirmed)
    XCTAssertEqual(C.classify("予約して", intent: .reserve), .confirmed)
    XCTAssertEqual(C.classify("はい、取り消して", intent: .cancel), .confirmed)
    // Bare back-channel / hesitation / questions are not confirmations.
    XCTAssertEqual(C.classify("はい", intent: .reserve), .ambiguous)
    XCTAssertEqual(C.classify("うん", intent: .reserve), .ambiguous)
    XCTAssertEqual(C.classify("えーと、申請して", intent: .reserve), .ambiguous)
    XCTAssertEqual(C.classify("申請していいですか？", intent: .reserve), .ambiguous)
    XCTAssertEqual(C.classify("取り消して", intent: .reserve), .ambiguous, "intent mismatch")
    XCTAssertEqual(C.classify("いいえ、やめておきます", intent: .reserve), .rejected)
    XCTAssertEqual(C.classify("ちょっと待って", intent: .reserve), .rejected)
    XCTAssertEqual(C.classify("内容を変更したい", intent: .reserve), .rejected)
    XCTAssertEqual(C.classify("", intent: .reserve), .ambiguous)
  }

  func testCardParsingCapsExpiryAt120Seconds() {
    let card = VoiceConfirmationCard.parse(
      data: prepareData(expires: "2026-10-02T03:00:00Z"), intent: .reserve, receivedAt: fixedNow, calendar: .tokyo)!
    XCTAssertEqual(card.expiresAt, fixedNow.addingTimeInterval(120))
    XCTAssertEqual(card.prompt, "10月5日（月）14時から、田中講師のIT基礎・セキュリティを予約申請します。申請してよろしいですか？")
    XCTAssertEqual(card.remainingLabel(now: fixedNow.addingTimeInterval(15)), "確認内容の有効時間：残り1分45秒")
    XCTAssertEqual(card.slotId, Fixtures.slotId)
    XCTAssertNil(VoiceConfirmationCard.parse(data: ["action_token": "short"], intent: .reserve, receivedAt: fixedNow, calendar: .tokyo))
    let withSummary = VoiceConfirmationCard.parse(
      data: ["action_token": .string(token32), "summary_ja": "サーバー文面"], intent: .cancel, receivedAt: fixedNow, calendar: .tokyo)
    XCTAssertEqual(withSummary?.prompt, "サーバー文面")
    XCTAssertEqual(withSummary?.confirmButtonTitle, "この予約を取り消す")
  }

  func testConfirmationMachine() {
    let card = VoiceConfirmationCard(intent: .reserve, actionToken: token32, expiresAt: fixedNow.addingTimeInterval(120), prompt: "p")
    var m = ConfirmationMachine()
    m.present(card)
    XCTAssertEqual(m.authorizeCommit(token: token32, intent: .reserve, now: fixedNow), .failure(.confirmationRequired))
    XCTAssertTrue(m.confirm(.button, now: fixedNow))
    XCTAssertEqual(m.authorizeCommit(token: "other-token-other-token-other-token", intent: .reserve, now: fixedNow), .failure(.confirmationMismatch))
    XCTAssertEqual(m.authorizeCommit(token: token32, intent: .cancel, now: fixedNow), .failure(.confirmationMismatch))
    XCTAssertEqual(m.authorizeCommit(token: token32, intent: .reserve, now: fixedNow), .success(card))
    XCTAssertEqual(m.authorizeCommit(token: token32, intent: .reserve, now: fixedNow), .failure(.confirmationRequired), "no double commit")
    m.finishCommit(success: true, message: "ok")
    XCTAssertEqual(m.state, .committed(card, resultMessage: "ok"))

    var expiring = ConfirmationMachine()
    expiring.present(card)
    XCTAssertFalse(expiring.confirm(.button, now: fixedNow.addingTimeInterval(120)))
    XCTAssertEqual(expiring.state, .expired(card))

    var ticking = ConfirmationMachine()
    ticking.present(card)
    ticking.tick(now: fixedNow.addingTimeInterval(119))
    XCTAssertTrue(ticking.state.isAwaitingUser)
    ticking.tick(now: fixedNow.addingTimeInterval(121))
    XCTAssertEqual(ticking.state, .expired(card))
  }
}

// MARK: - Conversation

@MainActor
final class VoiceConversationTests: XCTestCase {
  func testReadToolCallReturnsOutputAfterResponseDone() async throws {
    let clock = TestClock()
    let executor = FakeToolExecutor()
    executor.results["today_lessons"] = FakeToolExecutor.ok(
      ["items": .array([try JSONValue(jsonString: Fixtures.slotJSON(title: "ビジネスマナー"))])])
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: executor, sink: sink)

    conv.handle(.responseCreated(responseId: "resp_1"))
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "call_1", name: "today_lessons", arguments: "{}", responseId: "resp_1")))
    await waitUntil { executor.inputs.count == 1 && !conv.hasRunningToolCalls }
    XCTAssertEqual(executor.inputs.first, VoiceToolInput(sessionId: "voice-session-1", callId: "call_1", toolName: "today_lessons", arguments: [:]))
    XCTAssertEqual(sink.count("conversation.item.create"), 0, "outputs wait until the requesting response is done")

    conv.handle(.responseDone(responseId: "resp_1", status: "completed", functionCalls: []))
    XCTAssertEqual(sink.types, ["conversation.item.create", "response.create"])
    let output = try JSONValue(jsonString: sink.events[0].json["item"]?["output"]?.stringValue ?? "")
    XCTAssertEqual(output["ok"], true)
    XCTAssertEqual(output["data"]?["items"]?[0]?["title"], "ビジネスマナー")
    XCTAssertTrue(conv.entries.contains { if case .lessons(let title, let slots)? = $0.card { return title == "本日の授業" && slots.count == 1 } else { return false } })

    // The same call id repeated by response.done is not executed twice.
    conv.handle(.responseDone(responseId: "resp_1", status: "completed", functionCalls: [RealtimeFunctionCall(callId: "call_1", name: "today_lessons", arguments: "{}")]))
    await waitUntil { !conv.hasRunningToolCalls }
    XCTAssertEqual(executor.inputs.count, 1)
  }

  func testUnknownToolAndInvalidArgumentsNeverReachAPI() async throws {
    let clock = TestClock()
    let executor = FakeToolExecutor()
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: executor, sink: sink)
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "c1", name: "delete_user", arguments: "{}")))
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "c2", name: "prepare_reservation", arguments: #"{"slot_id":"x"}"#)))
    await waitUntil { sink.count("response.create") == 1 }
    XCTAssertTrue(executor.inputs.isEmpty)
    let outputs = sink.events.compactMap { $0.json["item"]?["output"]?.stringValue }.compactMap { try? JSONValue(jsonString: $0) }
    XCTAssertEqual(Set(outputs.compactMap { $0["code"]?.stringValue }), ["UNKNOWN_TOOL", "VALIDATION_FAILED"])
    XCTAssertEqual(sink.count("response.create"), 1, "one response for both outputs")
  }

  func testCommitWithoutConfirmationIsRefusedLocally() async throws {
    let clock = TestClock()
    let executor = FakeToolExecutor()
    executor.results["prepare_reservation"] = FakeToolExecutor.ok(prepareData())
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: executor, sink: sink)

    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "p1", name: "prepare_reservation", arguments: #"{"slot_id":"\#(Fixtures.slotId)"}"#)))
    await waitUntil { conv.confirmation.state.isAwaitingUser }
    XCTAssertEqual(conv.uiState, .confirming)
    conv.handle(.responseDone(responseId: nil, status: "completed", functionCalls: []))
    // The model tries to commit without any user confirmation.
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "c1", name: "commit_reservation", arguments: #"{"action_token":"\#(token32)"}"#)))
    await waitUntil { !conv.hasRunningToolCalls && sink.count("conversation.item.create") >= 2 }
    XCTAssertEqual(executor.inputs.map(\.toolName), ["prepare_reservation"], "commit never reached the API")
    let last = try JSONValue(jsonString: sink.events.compactMap { $0.json["item"]?["output"]?.stringValue }.last!)
    XCTAssertEqual(last["code"], "CONFIRMATION_REQUIRED")
    XCTAssertTrue(conv.confirmation.state.isAwaitingUser)
  }

  func testAmbiguousUtteranceDoesNotConfirm() async {
    let clock = TestClock()
    let executor = FakeToolExecutor()
    executor.results["prepare_reservation"] = FakeToolExecutor.ok(prepareData())
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: executor, sink: sink)
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "p1", name: "prepare_reservation", arguments: #"{"slot_id":"\#(Fixtures.slotId)"}"#)))
    await waitUntil { conv.confirmation.state.isAwaitingUser }
    conv.handle(.inputTranscriptCompleted(itemId: "u1", transcript: "はい"))
    XCTAssertTrue(conv.confirmation.state.isAwaitingUser)
    conv.handle(.inputTranscriptCompleted(itemId: "u2", transcript: "授業の説明に『申請して』と書いてありました？"))
    XCTAssertTrue(conv.confirmation.state.isAwaitingUser)
  }

  func testVoiceConfirmationThenCommitSucceeds() async throws {
    let clock = TestClock()
    let executor = FakeToolExecutor()
    executor.results["prepare_reservation"] = FakeToolExecutor.ok(prepareData())
    executor.results["commit_reservation"] = FakeToolExecutor.ok(["reservation": ["id": "r1", "status": "pending"]])
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: executor, sink: sink)
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "p1", name: "prepare_reservation", arguments: #"{"slot_id":"\#(Fixtures.slotId)"}"#)))
    await waitUntil { conv.confirmation.state.isAwaitingUser }

    // The transcript arrives after the model's commit call: the bridge waits briefly for it.
    conv.handle(.speechStopped(itemId: "u1"))
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "c1", name: "commit_reservation", arguments: #"{"action_token":"\#(token32)"}"#)))
    conv.handle(.inputTranscriptCompleted(itemId: "u1", transcript: "はい、申請して"))
    await waitUntil { executor.inputs.count == 2 && !conv.hasRunningToolCalls }
    XCTAssertEqual(executor.inputs.map(\.toolName), ["prepare_reservation", "commit_reservation"])
    XCTAssertEqual(executor.inputs[1].arguments["action_token"]?.stringValue, token32)
    XCTAssertEqual(executor.inputs[1].callId, "c1")
    guard case .committed(_, let message) = conv.confirmation.state else { return XCTFail("not committed") }
    XCTAssertEqual(message, "予約を申請しました。現在、担当講師の承認待ちです。")
    XCTAssertFalse(message.contains("確定"), "a pending request is never described as confirmed")
    conv.dismissConfirmationResult()
    XCTAssertEqual(conv.confirmation.state, .none)
  }

  func testExpiredCardRefusesCommit() async throws {
    let clock = TestClock()
    let executor = FakeToolExecutor()
    executor.results["prepare_reservation"] = FakeToolExecutor.ok(prepareData())
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: executor, sink: sink)
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "p1", name: "prepare_reservation", arguments: #"{"slot_id":"\#(Fixtures.slotId)"}"#)))
    await waitUntil { conv.confirmation.state.isAwaitingUser }
    clock.advance(121)
    conv.tick()
    guard case .expired = conv.confirmation.state else { return XCTFail("expected expiry") }
    conv.handle(.inputTranscriptCompleted(itemId: "u1", transcript: "はい、申請して"))
    await conv.confirmByButton()
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "c1", name: "commit_reservation", arguments: #"{"action_token":"\#(token32)"}"#)))
    await waitUntil { !conv.hasRunningToolCalls }
    XCTAssertEqual(executor.inputs.map(\.toolName), ["prepare_reservation"])
  }

  func testButtonConfirmationCommitsOnceAndInformsModel() async throws {
    let clock = TestClock()
    let executor = FakeToolExecutor()
    executor.results["prepare_reservation"] = FakeToolExecutor.ok(prepareData())
    executor.results["commit_reservation"] = FakeToolExecutor.ok(["reservation": ["id": "r1", "status": "pending"]])
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: executor, sink: sink)
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "p1", name: "prepare_reservation", arguments: #"{"slot_id":"\#(Fixtures.slotId)"}"#)))
    await waitUntil { conv.confirmation.state.isAwaitingUser }
    conv.handle(.responseDone(responseId: nil, status: "completed", functionCalls: []))

    async let first: Void = conv.confirmByButton()
    async let second: Void = conv.confirmByButton()  // double tap
    _ = await (first, second)
    let commits = executor.inputs.filter { $0.toolName == "commit_reservation" }
    XCTAssertEqual(commits.count, 1)
    XCTAssertTrue(commits[0].callId.hasPrefix("ui-confirm-"))
    XCTAssertEqual(executor.keys.count, 2)
    XCTAssertTrue(sink.events.contains { $0.json["item"]?["role"] == "system" })
  }

  func testRejectingUtteranceDiscardsCard() async {
    let clock = TestClock()
    let executor = FakeToolExecutor()
    executor.results["prepare_reservation"] = FakeToolExecutor.ok(prepareData())
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: executor, sink: sink)
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "p1", name: "prepare_reservation", arguments: #"{"slot_id":"\#(Fixtures.slotId)"}"#)))
    await waitUntil { conv.confirmation.state.isAwaitingUser }
    conv.handle(.inputTranscriptCompleted(itemId: "u1", transcript: "いいえ、やめます"))
    XCTAssertEqual(conv.confirmation.state, .discarded)
    XCTAssertTrue(conv.entries.contains { $0.text == "申請は送信していません。" })
  }

  func testTeacherVoiceWriteIsRefused() async throws {
    let clock = TestClock()
    let executor = FakeToolExecutor()
    let sink = EventSink()
    let conv = makeConversation(role: .teacher, clock: clock, executor: executor, sink: sink)
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "p1", name: "prepare_reservation", arguments: #"{"slot_id":"\#(Fixtures.slotId)"}"#)))
    await waitUntil { sink.count("response.create") == 1 }
    XCTAssertTrue(executor.inputs.isEmpty)
  }

  func testBargeInCancelsAndClearsAudio() {
    let clock = TestClock()
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: FakeToolExecutor(), sink: sink)
    conv.handle(.responseCreated(responseId: "resp_7"))
    conv.handle(.outputTranscriptDelta(responseId: "resp_7", itemId: "m7", delta: "本日は10時から"))
    conv.handle(.outputAudioStarted(responseId: "resp_7"))
    XCTAssertEqual(conv.uiState, .speaking)
    conv.handle(.speechStarted(itemId: "u9"))
    XCTAssertEqual(sink.events, [.responseCancel(responseId: "resp_7"), .outputAudioBufferClear])
    XCTAssertFalse(conv.assistantSpeaking)
    XCTAssertTrue(conv.entries.first { $0.id == "a-m7" }?.interrupted ?? false)
    // The server's cancellation completes the old response; nothing is replayed.
    conv.handle(.outputAudioCleared(responseId: "resp_7"))
    conv.handle(.responseDone(responseId: "resp_7", status: "cancelled", functionCalls: []))
    XCTAssertEqual(sink.count("response.create"), 0)
    XCTAssertFalse(conv.hasActiveResponse)
  }

  func testTextInputDoesNotStartSecondConcurrentResponse() {
    let clock = TestClock()
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: FakeToolExecutor(), sink: sink)
    conv.sendText("今日の授業を教えて")
    XCTAssertEqual(sink.types, ["conversation.item.create", "response.create"])
    conv.sendText("あと進捗も")
    // A response is pending creation: the second message is added but no second response.create.
    XCTAssertEqual(sink.count("response.create"), 1)
    conv.handle(.responseCreated(responseId: "r1"))
    conv.handle(.responseDone(responseId: "r1", status: "completed", functionCalls: []))
    // The queued user turn is answered next, after the first response finished.
    XCTAssertEqual(sink.count("response.create"), 2)
  }

  func testSilenceAndMaxDurationEndTheSession() {
    let clock = TestClock()
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: FakeToolExecutor(), sink: sink, expiresAt: fixedNow.addingTimeInterval(600))
    clock.advance(59)
    conv.tick()
    XCTAssertNil(conv.endRequest)
    conv.handle(.speechStarted(itemId: "u"))
    clock.advance(59)
    conv.tick()
    XCTAssertNil(conv.endRequest, "speech resets the silence timer")
    clock.advance(61)
    conv.tick()
    XCTAssertEqual(conv.endRequest, .silence)

    let conv2 = makeConversation(clock: clock, executor: FakeToolExecutor(), sink: sink, expiresAt: clock.now.addingTimeInterval(30))
    conv2.handle(.speechStarted(itemId: "x"))
    clock.advance(30)
    conv2.tick()
    XCTAssertEqual(conv2.endRequest, .maxDuration)
  }

  func testMuteAndPushToTalkDriveMicrophone() {
    let clock = TestClock()
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: FakeToolExecutor(), sink: sink)
    conv.setMuted(true)
    conv.setMuted(false)
    conv.setPushToTalk(true)
    XCTAssertEqual(conv.uiState, .idle)
    conv.beginTalking()
    XCTAssertEqual(conv.uiState, .listening)
    conv.endTalking()
    XCTAssertEqual(sink.microphone, [false, true, false, true, false])
    XCTAssertEqual(
      sink.types,
      ["session.update", "input_audio_buffer.clear", "input_audio_buffer.commit", "response.create"])
  }

  func testFinishDiscardsUnconfirmedCard() async {
    let clock = TestClock()
    let executor = FakeToolExecutor()
    executor.results["prepare_reservation"] = FakeToolExecutor.ok(prepareData())
    let sink = EventSink()
    let conv = makeConversation(clock: clock, executor: executor, sink: sink)
    conv.handle(.functionCallArgumentsDone(RealtimeFunctionCall(callId: "p1", name: "prepare_reservation", arguments: #"{"slot_id":"\#(Fixtures.slotId)"}"#)))
    await waitUntil { conv.confirmation.state.isAwaitingUser }
    conv.finish()
    XCTAssertEqual(conv.confirmation.state, .discarded)
  }

  func testCommitMessages() {
    XCTAssertEqual(VoiceConversation.commitMessage(intent: .reserve, data: ["status": "approved"]), "予約が確定しました。")
    XCTAssertEqual(VoiceConversation.commitMessage(intent: .reserve, data: nil), "申請を受け付けました。状態は「自分の予約」で確認できます。")
    XCTAssertEqual(VoiceConversation.commitMessage(intent: .cancel, data: ["reservation": ["status": "cancelled"]]), "予約を取り消しました。")
  }
}

// MARK: - Session controller

final class FakeRealtimeTransport: RealtimeTransport, @unchecked Sendable {
  private let lock = NSLock()
  var connectError: ARMSError?
  private(set) var secrets: [String] = []
  private(set) var micEnabledAtConnect: Bool?
  private(set) var sent: [Data] = []
  private(set) var micStates: [Bool] = []
  private(set) var closed = 0
  private var handler: (@Sendable (RealtimeTransportEvent) -> Void)?

  func connect(clientSecret: String, microphoneEnabled: Bool, onEvent: @escaping @Sendable (RealtimeTransportEvent) -> Void)
    async throws(ARMSError)
  {
    let error: ARMSError? = lock.withLock {
      secrets.append(clientSecret)
      micEnabledAtConnect = microphoneEnabled
      handler = onEvent
      return connectError
    }
    if let error { throw error }
  }

  func send(_ data: Data) -> Bool {
    lock.withLock { sent.append(data) }
    return true
  }

  func setMicrophoneEnabled(_ enabled: Bool) { lock.withLock { micStates.append(enabled) } }
  func close() { lock.withLock { closed += 1 } }

  func emit(_ event: RealtimeTransportEvent) { lock.withLock { handler }?(event) }
}

final class FakeAudioSession: VoiceAudioSession, @unchecked Sendable {
  var permission: MicrophonePermission = .granted
  var grantOnRequest = true
  var activateError: (any Error)?
  private(set) var activations = 0
  private(set) var deactivations = 0
  var handler: (@Sendable (AudioSessionEvent) -> Void)?

  func microphonePermission() -> MicrophonePermission { permission }
  func requestMicrophonePermission() async -> Bool {
    permission = grantOnRequest ? .granted : .denied
    return grantOnRequest
  }
  func activate() throws {
    if let activateError { throw activateError }
    activations += 1
  }
  func deactivate() { deactivations += 1 }
  func setEventHandler(_ handler: (@Sendable (AudioSessionEvent) -> Void)?) { self.handler = handler }
  var currentRouteName: String { "iPhone" }
}

@MainActor
final class VoiceSessionControllerTests: XCTestCase {
  struct Harness {
    let transport: MockTransport
    let realtime: FakeRealtimeTransport
    let audio: FakeAudioSession
    let controller: VoiceSessionController
    let clock: TestClock
  }

  func makeHarness(sessionStatus: Int = 200, sessionJSON: String? = nil) -> Harness {
    let t = MockTransport()
    t.on(
      .post, "/voice/sessions", status: sessionStatus,
      json: sessionJSON
        ?? #"{"session_id":"vs-1","client_secret":"ek_memory_only","expires_at":"2026-10-02T02:10:00Z","model":"gpt-realtime-2.1","voice":"marin"}"#)
    t.on(.post, "/voice/sessions/vs-1/end", json: Fixtures.actionJSON(#"{"daily_used_seconds":180,"daily_quota_seconds":900}"#))
    let realtime = FakeRealtimeTransport()
    let audio = FakeAudioSession()
    let clock = TestClock()
    let controller = VoiceSessionController(
      api: makeClient(t), role: .student, calendar: .tokyo, audio: audio, keyValues: InMemoryKeyValueStore(),
      makeTransport: { realtime }, now: { clock.now }, sleeper: RecordingSleeper(), autoTick: false)
    return Harness(transport: t, realtime: realtime, audio: audio, controller: controller, clock: clock)
  }

  func testStartConnectsWithEphemeralSecretAndEndReportsQuota() async throws {
    let h = makeHarness()
    XCTAssertTrue(h.controller.needsDisclosure)
    h.controller.acknowledgeDisclosure()
    XCTAssertFalse(h.controller.needsDisclosure)
    await h.controller.start()
    XCTAssertEqual(h.controller.phase, .active)
    XCTAssertEqual(h.realtime.secrets, ["ek_memory_only"])
    XCTAssertEqual(h.realtime.micEnabledAtConnect, true)
    XCTAssertEqual(h.audio.activations, 1)
    XCTAssertNotNil(h.transport.requests(.post, "/voice/sessions").first?.header("Idempotency-Key"))
    XCTAssertEqual(h.controller.uiState, .listening)

    h.realtime.emit(.message(Data(#"{"type":"output_audio_buffer.started","response_id":"r"}"#.utf8)))
    await waitUntil { h.controller.uiState == .speaking }
    XCTAssertEqual(h.controller.uiState, .speaking)

    await h.controller.end()
    XCTAssertEqual(h.controller.phase, .ended(.user))
    XCTAssertEqual(h.realtime.closed, 1)
    XCTAssertEqual(h.audio.deactivations, 1)
    XCTAssertEqual(h.transport.requests(.post, "/voice/sessions/vs-1/end").count, 1)
    XCTAssertEqual(h.controller.quota?.labelJa, "3分 / 15分")
  }

  func testQuotaExceededShowsServerMessage() async {
    let h = makeHarness(
      sessionStatus: 429, sessionJSON: Fixtures.errorJSON("VOICE_QUOTA_EXCEEDED", "本日の音声利用上限に達しました。画面から操作してください。"))
    await h.controller.start()
    XCTAssertEqual(h.controller.phase, .failed("本日の音声利用上限に達しました。画面から操作してください。"))
    XCTAssertEqual(h.controller.uiState, .error)
    XCTAssertTrue(h.realtime.secrets.isEmpty)
  }

  func testConnectFailureReleasesServerSession() async {
    let h = makeHarness()
    h.realtime.connectError = .local(code: "VOICE_UNAVAILABLE", messageJa: "x")
    await h.controller.start()
    XCTAssertEqual(h.controller.phase, .failed("現在、音声機能を利用できません。画面から操作してください。"))
    XCTAssertEqual(h.transport.requests(.post, "/voice/sessions/vs-1/end").count, 1)
    XCTAssertEqual(h.audio.deactivations, 1)
  }

  func testMicrophoneDeniedStillAllowsTextConversation() async {
    let h = makeHarness()
    h.audio.permission = .undetermined
    h.audio.grantOnRequest = false
    await h.controller.start()
    XCTAssertEqual(h.controller.phase, .active)
    XCTAssertEqual(h.controller.microphonePermission, .denied)
    XCTAssertEqual(h.realtime.micEnabledAtConnect, false)
    h.controller.sendText("今日の授業を教えて")
    XCTAssertTrue(h.realtime.sent.contains { String(decoding: $0, as: UTF8.self).contains("input_text") })
  }

  func testBackgroundAndInterruptionEndSession() async {
    let h = makeHarness()
    await h.controller.start()
    await h.controller.handleBackground()
    XCTAssertEqual(h.controller.phase, .ended(.background))
    XCTAssertEqual(h.controller.statusMessage, "アプリがバックグラウンドに移動したため、音声を終了しました。")

    let h2 = makeHarness()
    await h2.controller.start()
    h2.audio.handler?(.interruptionBegan)
    await waitUntil { h2.controller.phase == .ended(.interruption) }
    XCTAssertEqual(h2.controller.phase, .ended(.interruption))
    XCTAssertEqual(h2.transport.requests(.post, "/voice/sessions/vs-1/end").count, 1)
  }

  func testSilenceTickEndsSessionAndReconnectGrace() async {
    let h = makeHarness()
    await h.controller.start()
    h.clock.advance(61)
    await h.controller.tick()
    XCTAssertEqual(h.controller.phase, .ended(.silence))

    let h2 = makeHarness()
    await h2.controller.start()
    h2.realtime.emit(.connection(.disconnected))
    await waitUntil { h2.controller.phase == .reconnecting }
    XCTAssertEqual(h2.controller.uiState, .reconnecting)
    h2.realtime.emit(.connection(.connected))
    await waitUntil { h2.controller.phase == .active }
    h2.realtime.emit(.connection(.disconnected))
    await waitUntil { h2.controller.phase == .reconnecting }
    h2.clock.advance(16)
    await h2.controller.tick()
    XCTAssertEqual(h2.controller.phase, .ended(.connectionLost))
  }

  func testEndWhileConnectingDoesNotLeakSession() async {
    let h = makeHarness()
    // Slow session creation so that the user ends the session while it is being created.
    h.transport.on(.post, "/voice/sessions") { _, _ in
      Thread.sleep(forTimeInterval: 0.2)
      return HTTPResponse(
        status: 200,
        body: Data(
          #"{"session_id":"vs-1","client_secret":"ek_memory_only","expires_at":"2026-10-02T02:10:00Z","model":"gpt-realtime-2.1","voice":"marin"}"#
            .utf8))
    }
    let task = Task { await h.controller.start() }
    await waitUntil { h.controller.phase == .connecting }
    await h.controller.end()
    await task.value
    XCTAssertEqual(h.transport.requests(.post, "/voice/sessions/vs-1/end").count, 1)
    XCTAssertTrue(h.realtime.secrets.isEmpty, "never connected after the user ended it")
    XCTAssertEqual(h.controller.phase, .ended(.user))
  }

  func testOfflineStartFailsWithoutRequest() async {
    let t = MockTransport()
    let controller = VoiceSessionController(
      api: makeClient(t), role: .student, calendar: .tokyo, audio: FakeAudioSession(), keyValues: InMemoryKeyValueStore(),
      makeTransport: { FakeRealtimeTransport() }, autoTick: false, isOnline: { false })
    await controller.start()
    XCTAssertEqual(controller.phase, .failed(ARMSError.offline.messageJa))
    XCTAssertTrue(t.requests.isEmpty)
  }
}
