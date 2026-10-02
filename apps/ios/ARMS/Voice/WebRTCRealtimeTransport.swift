import ARMSKit
import AVFAudio
import Foundation
import WebRTC

/// Native WebRTC connection to OpenAI Realtime (stasel/WebRTC binary, no WebView).
///
/// Flow: microphone track (when permitted) + data channel `oai-events` → SDP offer →
/// `POST https://api.openai.com/v1/realtime/calls` (`Authorization: Bearer <ephemeral secret>`,
/// `Content-Type: application/sdp`) → remote answer → wait for the data channel to open.
/// The model's audio track is played by WebRTC's audio device module. The ephemeral secret is only
/// passed through to the SDP exchange and is never stored, logged or kept after `connect`.
final class WebRTCRealtimeTransport: NSObject, RealtimeTransport, @unchecked Sendable {
  private static let factory: RTCPeerConnectionFactory = {
    RTCInitializeSSL()
    let config = RTCAudioSessionConfiguration.webRTC()
    config.category = AVAudioSession.Category.playAndRecord.rawValue
    config.mode = AVAudioSession.Mode.voiceChat.rawValue
    config.categoryOptions = AudioSessionManager.categoryOptions
    RTCAudioSessionConfiguration.setWebRTC(config)
    return RTCPeerConnectionFactory()
  }()

  private let callsClient: RealtimeCallsClient
  private let lock = NSLock()
  private var peerConnection: RTCPeerConnection?
  private var dataChannel: RTCDataChannel?
  private var audioTrack: RTCAudioTrack?
  private var onEvent: (@Sendable (RealtimeTransportEvent) -> Void)?
  private var openContinuation: CheckedContinuation<Void, Never>?
  private var gatheringContinuation: CheckedContinuation<Void, Never>?
  private var isClosed = false
  /// `.closed` is only reported for a session that finished connecting (a failed `connect`
  /// reports its error by throwing instead).
  private var didConnect = false

  init(callsClient: RealtimeCallsClient) {
    self.callsClient = callsClient
    super.init()
  }

  // MARK: RealtimeTransport

  func connect(
    clientSecret: String, microphoneEnabled: Bool, onEvent: @escaping @Sendable (RealtimeTransportEvent) -> Void
  ) async throws(ARMSError) {
    let unavailable = ARMSError.local(code: "VOICE_UNAVAILABLE", messageJa: ErrorCatalog.message(for: "VOICE_UNAVAILABLE"))
    let factory = Self.factory
    let configuration = RTCConfiguration()
    configuration.sdpSemantics = .unifiedPlan
    configuration.continualGatheringPolicy = .gatherOnce
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard let pc = factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
      throw unavailable
    }
    lock.withLock {
      self.onEvent = onEvent
      self.peerConnection = pc
      self.isClosed = false
      self.didConnect = false
    }
    onEvent(.connection(.connecting))

    if microphoneEnabled {
      let source = factory.audioSource(with: constraints)
      let track = factory.audioTrack(with: source, trackId: "arms-microphone")
      _ = pc.add(track, streamIds: ["arms"])
      lock.withLock { audioTrack = track }
    } else {
      // Receive-only audio: the user types, the assistant still speaks.
      _ = pc.addTransceiver(of: .audio)
    }

    let channelConfig = RTCDataChannelConfiguration()
    channelConfig.isOrdered = true
    guard let channel = pc.dataChannel(forLabel: "oai-events", configuration: channelConfig) else {
      close()
      throw unavailable
    }
    channel.delegate = self
    lock.withLock { dataChannel = channel }

    do {
      let offer = try await createOffer(pc)
      try await setLocalDescription(pc, offer)
      await waitForIceGathering(pc, timeout: 2)
      let localSDP = pc.localDescription?.sdp ?? offer.sdp
      let answer = try await callsClient.exchange(offerSDP: localSDP, clientSecret: clientSecret)
      try await setRemoteDescription(pc, RTCSessionDescription(type: .answer, sdp: answer))
    } catch let error as ARMSError {
      close()
      throw error
    } catch {
      close()
      throw unavailable
    }

    guard await waitForDataChannelOpen(timeout: 15) else {
      close()
      throw unavailable
    }
    lock.withLock { didConnect = true }
    onEvent(.connection(.connected))
  }

  @discardableResult
  func send(_ data: Data) -> Bool {
    guard let channel = lock.withLock({ dataChannel }), channel.readyState == .open else { return false }
    return channel.sendData(RTCDataBuffer(data: data, isBinary: false))
  }

  func setMicrophoneEnabled(_ enabled: Bool) {
    lock.withLock { audioTrack?.isEnabled = enabled }
  }

  func close() {
    let (pc, channel, alreadyClosed) = lock.withLock { () -> (RTCPeerConnection?, RTCDataChannel?, Bool) in
      let result = (peerConnection, dataChannel, isClosed)
      isClosed = true
      peerConnection = nil
      dataChannel = nil
      audioTrack = nil
      return result
    }
    guard !alreadyClosed else { return }
    channel?.close()
    pc?.close()
    resumeOpen()
    resumeGathering()
    let (handler, connected) = lock.withLock { (onEvent, didConnect) }
    if connected { handler?(.connection(.closed)) }
    lock.withLock { onEvent = nil }
  }

  // MARK: Helpers

  private func createOffer(_ pc: RTCPeerConnection) async throws -> RTCSessionDescription {
    let constraints = RTCMediaConstraints(
      mandatoryConstraints: ["OfferToReceiveAudio": "true", "OfferToReceiveVideo": "false"], optionalConstraints: nil)
    return try await withCheckedThrowingContinuation { continuation in
      pc.offer(for: constraints) { sdp, error in
        if let sdp {
          continuation.resume(returning: sdp)
        } else {
          continuation.resume(throwing: error ?? URLError(.unknown))
        }
      }
    }
  }

  private func setLocalDescription(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      pc.setLocalDescription(sdp) { error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      }
    }
  }

  private func setRemoteDescription(_ pc: RTCPeerConnection, _ sdp: RTCSessionDescription) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
      pc.setRemoteDescription(sdp) { error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      }
    }
  }

  /// Waits (bounded) for ICE gathering so the offer carries host/srflx candidates.
  private func waitForIceGathering(_ pc: RTCPeerConnection, timeout: TimeInterval) async {
    if pc.iceGatheringState == .complete { return }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      lock.withLock { gatheringContinuation = continuation }
      if pc.iceGatheringState == .complete { resumeGathering() }
      DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in self?.resumeGathering() }
    }
  }

  private func waitForDataChannelOpen(timeout: TimeInterval) async -> Bool {
    if lock.withLock({ dataChannel?.readyState == .open }) { return true }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      lock.withLock { openContinuation = continuation }
      if lock.withLock({ dataChannel?.readyState == .open }) { resumeOpen() }
      DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in self?.resumeOpen() }
    }
    return lock.withLock { dataChannel?.readyState == .open }
  }

  private func resumeOpen() {
    let continuation = lock.withLock { () -> CheckedContinuation<Void, Never>? in
      defer { openContinuation = nil }
      return openContinuation
    }
    continuation?.resume()
  }

  private func resumeGathering() {
    let continuation = lock.withLock { () -> CheckedContinuation<Void, Never>? in
      defer { gatheringContinuation = nil }
      return gatheringContinuation
    }
    continuation?.resume()
  }

  private func emit(_ event: RealtimeTransportEvent) {
    let handler = lock.withLock { onEvent }
    handler?(event)
  }
}

// MARK: - RTCPeerConnectionDelegate

extension WebRTCRealtimeTransport: RTCPeerConnectionDelegate {
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    switch newState {
    case .disconnected: emit(.connection(.disconnected))
    case .connected, .completed: emit(.connection(.connected))
    case .failed: emit(.connection(.failed))
    default: break
    }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
    if newState == .complete { resumeGathering() }
  }

  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

// MARK: - RTCDataChannelDelegate

extension WebRTCRealtimeTransport: RTCDataChannelDelegate {
  func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
    switch dataChannel.readyState {
    case .open: resumeOpen()
    case .closed:
      resumeOpen()
      if lock.withLock({ !isClosed && didConnect }) { emit(.connection(.failed)) }
    default: break
    }
  }

  func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
    guard !buffer.isBinary else { return }
    emit(.message(buffer.data))
  }
}
