import Foundation

public enum RealtimeConnectionState: Sendable, Equatable {
  case connecting
  case connected
  /// ICE disconnected: may recover by itself.
  case disconnected
  case failed
  case closed
}

public enum RealtimeTransportEvent: Sendable, Equatable {
  /// A JSON event received on the `oai-events` data channel.
  case message(Data)
  case connection(RealtimeConnectionState)
}

/// Native WebRTC connection to OpenAI Realtime (implemented with the WebRTC framework in the app).
/// The ephemeral client secret is passed in and must only be kept in memory for the SDP exchange.
public protocol RealtimeTransport: AnyObject, Sendable {
  /// Creates the peer connection (microphone track when enabled, `oai-events` data channel),
  /// exchanges SDP with `POST https://api.openai.com/v1/realtime/calls` and returns once the data
  /// channel is open.
  func connect(
    clientSecret: String, microphoneEnabled: Bool, onEvent: @escaping @Sendable (RealtimeTransportEvent) -> Void
  ) async throws(ARMSError)
  /// Sends one client event on the data channel; false when the channel is not open.
  @discardableResult func send(_ data: Data) -> Bool
  /// Enables/disables the microphone track (mute / push-to-talk).
  func setMicrophoneEnabled(_ enabled: Bool)
  /// Closes the data channel and peer connection. Idempotent.
  func close()
}

public enum MicrophonePermission: Sendable, Equatable {
  case undetermined
  case granted
  case denied
}

public enum AudioSessionEvent: Sendable, Equatable {
  /// Phone call, Siri, alarm… (the session is ended; background recording is never kept).
  case interruptionBegan
  case interruptionEnded
  /// Output/input route changed (AirPods connected/removed, speaker…).
  case routeChanged(routeName: String)
  case mediaServicesReset
}

/// `AVAudioSession` configuration (`.playAndRecord` + `.voiceChat`, Bluetooth routes) in the app.
public protocol VoiceAudioSession: AnyObject, Sendable {
  func microphonePermission() -> MicrophonePermission
  func requestMicrophonePermission() async -> Bool
  func activate() throws
  func deactivate()
  func setEventHandler(_ handler: (@Sendable (AudioSessionEvent) -> Void)?)
  var currentRouteName: String { get }
}

/// SDP offer/answer exchange with OpenAI Realtime over HTTPS
/// (`POST /v1/realtime/calls`, `Authorization: Bearer <ephemeral client secret>`,
/// `Content-Type: application/sdp`). The secret is never logged or persisted.
public struct RealtimeCallsClient: Sendable {
  public static let defaultEndpoint = URL(string: "https://api.openai.com/v1/realtime/calls")!

  public let endpoint: URL
  private let transport: any HTTPTransport

  public init(transport: any HTTPTransport, endpoint: URL = RealtimeCallsClient.defaultEndpoint) {
    self.transport = transport
    self.endpoint = endpoint
  }

  /// Returns the SDP answer text.
  public func exchange(offerSDP: String, clientSecret: String) async throws(ARMSError) -> String {
    guard !clientSecret.isEmpty else {
      throw .local(code: "VOICE_UNAVAILABLE", messageJa: ErrorCatalog.message(for: "VOICE_UNAVAILABLE"))
    }
    let request = HTTPRequest(
      url: endpoint, method: .post,
      headers: [
        "Authorization": "Bearer \(clientSecret)",
        "Content-Type": "application/sdp",
        "Accept": "application/sdp",
      ],
      body: Data(offerSDP.utf8), timeout: 20)
    let response: HTTPResponse
    do {
      response = try await transport.send(request)
    } catch {
      throw APIClient.map(error)
    }
    guard (200..<300).contains(response.status), let answer = String(data: response.body, encoding: .utf8),
      answer.hasPrefix("v=")
    else {
      // Provider error bodies are not shown (English, may echo request details).
      throw .local(code: "VOICE_UNAVAILABLE", messageJa: ErrorCatalog.message(for: "VOICE_UNAVAILABLE"))
    }
    return answer
  }
}
