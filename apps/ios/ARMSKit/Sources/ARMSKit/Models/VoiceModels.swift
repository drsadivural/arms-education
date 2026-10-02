import Foundation

/// Contract `VoiceSession` (`POST /voice/sessions`).
///
/// `clientSecret` is a short-lived OpenAI credential. It lives only in memory: this type is not
/// `Encodable`, and its textual/debug/reflection representations redact the secret so it can never
/// reach logs, crash reports or caches by accident.
public struct VoiceSessionGrant: Decodable, Sendable, Equatable {
  public let sessionId: String
  public let clientSecret: String
  public let expiresAt: Date
  public let model: String
  public let voice: String

  public init(sessionId: String, clientSecret: String, expiresAt: Date, model: String, voice: String) {
    self.sessionId = sessionId
    self.clientSecret = clientSecret
    self.expiresAt = expiresAt
    self.model = model
    self.voice = voice
  }

  enum CodingKeys: String, CodingKey {
    case sessionId = "session_id"
    case clientSecret = "client_secret"
    case expiresAt = "expires_at"
    case model
    case voice
  }
}

extension VoiceSessionGrant: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String {
    "VoiceSessionGrant(sessionId: \(sessionId), clientSecret: <redacted>, expiresAt: \(expiresAt), model: \(model), voice: \(voice))"
  }

  public var debugDescription: String { description }

  public var customMirror: Mirror {
    Mirror(
      self,
      children: [
        "sessionId": sessionId, "clientSecret": "<redacted>", "expiresAt": expiresAt, "model": model, "voice": voice,
      ])
  }
}

/// Contract `VoiceToolInput` (`POST /voice/tool-calls`).
public struct VoiceToolInput: Codable, Sendable, Equatable {
  public let sessionId: String
  public let callId: String
  public let toolName: String
  public let arguments: JSONValue

  public init(sessionId: String, callId: String, toolName: String, arguments: JSONValue) {
    self.sessionId = sessionId
    self.callId = callId
    self.toolName = toolName
    self.arguments = arguments
  }

  enum CodingKeys: String, CodingKey {
    case sessionId = "session_id"
    case callId = "call_id"
    case toolName = "tool_name"
    case arguments
  }
}
