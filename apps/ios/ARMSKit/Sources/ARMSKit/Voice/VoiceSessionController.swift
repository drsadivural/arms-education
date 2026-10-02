import Foundation
import Observation

/// Orchestrates one voice session (IOS-13/14):
/// `POST /voice/sessions` → WebRTC connect with the in-memory client secret → data-channel events →
/// `POST /voice/sessions/{id}/end`. Ends on user request, 60 s silence, the server's `expires_at`,
/// backgrounding, audio interruptions (phone calls) and lost connections. A new session never
/// re-executes an unconfirmed write.
@MainActor
@Observable
public final class VoiceSessionController {
  public enum Phase: Sendable, Equatable {
    case idle
    case connecting
    case active
    case reconnecting
    case ending
    case ended(VoiceEndReason)
    case failed(String)
  }

  public static let reconnectGrace: TimeInterval = 15

  public private(set) var phase: Phase = .idle
  public private(set) var conversation: VoiceConversation?
  public private(set) var microphonePermission: MicrophonePermission = .undetermined
  public private(set) var routeName: String = ""
  /// Today's usage from `GET /voice/quota` (refreshed on demand, after each session and on 429).
  public private(set) var quota: VoiceQuota?
  /// Seconds reserved for the running session (`VoiceSession.max_seconds`).
  public private(set) var sessionLimitSeconds: Int?
  /// 「AIが生成した音声です」 explanation must be acknowledged once before the first session.
  public private(set) var needsDisclosure: Bool

  private let api: APIClient
  private let makeTransport: () -> any RealtimeTransport
  private let audio: any VoiceAudioSession
  private let keyValues: any KeyValueStore
  private let role: Role
  private let calendar: OrgCalendar
  private let now: () -> Date
  private let sleeper: any Sleeper
  private let autoTick: Bool
  private let isOnline: () -> Bool

  private var transport: (any RealtimeTransport)?
  private var sessionId: String?
  private var disconnectedSince: Date?
  private var tickTask: Task<Void, Never>?
  private var generation = 0

  public init(
    api: APIClient, role: Role, calendar: OrgCalendar, audio: any VoiceAudioSession, keyValues: any KeyValueStore,
    makeTransport: @escaping () -> any RealtimeTransport, now: @escaping () -> Date = Date.init,
    sleeper: any Sleeper = TaskSleeper(), autoTick: Bool = true, isOnline: @escaping () -> Bool = { true }
  ) {
    self.api = api
    self.role = role
    self.calendar = calendar
    self.audio = audio
    self.keyValues = keyValues
    self.makeTransport = makeTransport
    self.now = now
    self.sleeper = sleeper
    self.autoTick = autoTick
    self.isOnline = isOnline
    self.needsDisclosure = !keyValues.bool(forKey: StorageKeys.voiceDisclosureShown)
    self.microphonePermission = audio.microphonePermission()
    self.routeName = audio.currentRouteName
  }

  public var isRunning: Bool {
    switch phase {
    case .connecting, .active, .reconnecting: return true
    default: return false
    }
  }

  /// State chip text.
  public var uiState: VoiceUIState {
    switch phase {
    case .idle, .ended, .ending: return .idle
    case .connecting: return .connecting
    case .reconnecting: return .reconnecting
    case .failed: return .error
    case .active: return conversation?.uiState ?? .listening
    }
  }

  public var statusMessage: String? {
    switch phase {
    case .ended(let reason): return reason.messageJa
    case .failed(let message): return message
    default: return nil
    }
  }

  public func acknowledgeDisclosure() {
    keyValues.set(true, forKey: StorageKeys.voiceDisclosureShown)
    needsDisclosure = false
  }

  // MARK: Start / end

  public func start() async {
    guard !isRunning, phase != .ending else { return }
    guard isOnline() else {
      phase = .failed(ARMSError.offline.messageJa)
      return
    }
    generation += 1
    let myGeneration = generation
    phase = .connecting
    conversation = nil

    // Microphone: if denied, the session still works with text input and spoken answers.
    var permission = audio.microphonePermission()
    if permission == .undetermined {
      permission = await audio.requestMicrophonePermission() ? .granted : .denied
    }
    microphonePermission = permission
    guard generation == myGeneration else { return }

    let grant: VoiceSessionGrant
    do {
      grant = try await api.send(API.createVoiceSession(key: IdempotencyKey())).value
    } catch {
      // 429 VOICE_QUOTA_EXCEEDED / 503 VOICE_UNAVAILABLE: show the server's message as is.
      phase = .failed(error.messageJa)
      if error.code == "VOICE_QUOTA_EXCEEDED" { await refreshQuota() }
      return
    }
    guard generation == myGeneration else {
      // Ended while the session was being created: release it on the server immediately.
      await finishOnServer(grant.sessionId)
      return
    }
    sessionId = grant.sessionId
    sessionLimitSeconds = grant.maxSeconds

    do {
      try audio.activate()
    } catch {
      sessionId = nil
      await finishOnServer(grant.sessionId)
      phase = .failed("マイクとスピーカーを準備できませんでした。ほかのアプリの通話や録音を終了してから再度お試しください。")
      return
    }
    audio.setEventHandler { [weak self] event in
      Task { @MainActor [weak self] in self?.handleAudioEvent(event) }
    }

    let transport = makeTransport()
    self.transport = transport
    let conversation = VoiceConversation(
      sessionId: grant.sessionId, role: role, calendar: calendar, expiresAt: grant.expiresAt, serverTools: grant.tools,
      executor: APIVoiceToolExecutor(api: api), now: now, sleeper: sleeper,
      send: { [weak transport] event in transport?.send(event.data) ?? false },
      setMicrophone: { [weak transport] enabled in transport?.setMicrophoneEnabled(enabled) })
    self.conversation = conversation

    do {
      try await transport.connect(clientSecret: grant.clientSecret, microphoneEnabled: permission == .granted) {
        [weak self] event in
        Task { @MainActor [weak self] in self?.handleTransportEvent(event, generation: myGeneration) }
      }
    } catch {
      guard generation == myGeneration else { return }
      transport.close()
      self.transport = nil
      audio.setEventHandler(nil)
      audio.deactivate()
      self.conversation = nil
      await finishOnServer(grant.sessionId)
      sessionId = nil
      phase = .failed(error.code == "OFFLINE" ? error.messageJa : ErrorCatalog.message(for: "VOICE_UNAVAILABLE"))
      return
    }
    guard generation == myGeneration else { return }
    phase = .active
    if permission != .granted { conversation.setMuted(true) }
    routeName = audio.currentRouteName
    if autoTick { startTicking(generation: myGeneration) }
  }

  public func end(reason: VoiceEndReason = .user) async {
    let wasRunning = isRunning
    guard wasRunning || sessionId != nil else { return }
    generation += 1
    tickTask?.cancel()
    tickTask = nil
    conversation?.finish()
    transport?.close()
    transport = nil
    audio.setEventHandler(nil)
    audio.deactivate()
    disconnectedSince = nil
    sessionLimitSeconds = nil
    if let sessionId {
      self.sessionId = nil
      phase = .ending
      await finishOnServer(sessionId)
      phase = .ended(reason)
    } else if wasRunning {
      phase = .ended(reason)
    }
  }

  /// `GET /voice/quota` for the Settings screen and the voice screen. Failures keep the last value.
  public func refreshQuota() async {
    if let fresh = try? await api.send(API.voiceQuota()).value.data { quota = fresh }
  }

  /// Scene moved to background: recording stops and the session ends (no background audio).
  public func handleBackground() async {
    if isRunning { await end(reason: .background) }
  }

  /// One-second housekeeping: silence/max timers, card expiry, reconnect grace.
  public func tick() async {
    guard isRunning, let conversation else { return }
    conversation.tick()
    if let reason = conversation.endRequest {
      await end(reason: reason)
      return
    }
    if phase == .reconnecting, let since = disconnectedSince,
      now().timeIntervalSince(since) >= VoiceSessionController.reconnectGrace
    {
      await end(reason: .connectionLost)
    }
  }

  // MARK: Controls (forwarded to the conversation)

  public func setMuted(_ muted: Bool) {
    guard microphonePermission == .granted else { return }
    conversation?.setMuted(muted)
  }

  public func setPushToTalk(_ enabled: Bool) { conversation?.setPushToTalk(enabled) }
  public func beginTalking() { conversation?.beginTalking() }
  public func endTalking() { conversation?.endTalking() }
  public func sendText(_ text: String) { conversation?.sendText(text) }
  public func confirmByButton() async { await conversation?.confirmByButton() }
  public func requestChange() { conversation?.requestChange() }
  public func dismissConfirmationResult() { conversation?.dismissConfirmationResult() }

  // MARK: Events

  func handleTransportEvent(_ event: RealtimeTransportEvent, generation eventGeneration: Int) {
    guard eventGeneration == generation, let conversation else { return }
    switch event {
    case .message(let data):
      if let parsed = RealtimeServerEvent.parse(data) { conversation.handle(parsed) }
    case .connection(let state):
      switch state {
      case .connected:
        if phase == .reconnecting { phase = .active }
        disconnectedSince = nil
      case .disconnected:
        if phase == .active {
          phase = .reconnecting
          disconnectedSince = now()
        }
      case .failed, .closed:
        if isRunning { Task { await self.end(reason: .connectionLost) } }
      case .connecting:
        break
      }
    }
  }

  func handleAudioEvent(_ event: AudioSessionEvent) {
    switch event {
    case .interruptionBegan, .mediaServicesReset:
      if isRunning { Task { await self.end(reason: .interruption) } }
    case .interruptionEnded:
      break
    case .routeChanged(let name):
      routeName = name
    }
  }

  private func startTicking(generation tickGeneration: Int) {
    tickTask?.cancel()
    let sleeper = self.sleeper
    tickTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        do { try await sleeper.sleep(seconds: 1) } catch { return }
        guard let self, self.generation == tickGeneration else { return }
        await self.tick()
      }
    }
  }

  private func finishOnServer(_ sessionId: String) async {
    do {
      // `data: {session_id, consumed_seconds}`; the daily figures come from GET /voice/quota.
      _ = try await api.send(API.endVoiceSession(id: sessionId))
    } catch {
      // The server reconciles quota at expires_at (unended sessions are charged their maximum),
      // so a failed end call is not surfaced as an error to the user.
    }
    await refreshQuota()
  }
}
