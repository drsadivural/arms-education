import Foundation

/// A completed function call emitted by the model.
public struct RealtimeFunctionCall: Sendable, Hashable {
  public let callId: String
  public let name: String
  /// Raw JSON text of the arguments, exactly as streamed by the model.
  public let arguments: String
  public let itemId: String?
  public let responseId: String?

  public init(callId: String, name: String, arguments: String, itemId: String? = nil, responseId: String? = nil) {
    self.callId = callId
    self.name = name
    self.arguments = arguments
    self.itemId = itemId
    self.responseId = responseId
  }
}

/// Server → client events on the `oai-events` data channel (OpenAI Realtime GA event names,
/// with the beta aliases accepted for transcript/text deltas).
public enum RealtimeServerEvent: Sendable, Equatable {
  case sessionCreated
  case sessionUpdated
  case speechStarted(itemId: String?)
  case speechStopped(itemId: String?)
  case inputTranscriptDelta(itemId: String, delta: String)
  case inputTranscriptCompleted(itemId: String, transcript: String)
  case inputTranscriptFailed(itemId: String)
  case responseCreated(responseId: String)
  /// `response.done`: status (`completed`/`cancelled`/`failed`/`incomplete`) and function calls in `output`.
  case responseDone(responseId: String?, status: String?, functionCalls: [RealtimeFunctionCall])
  case outputTranscriptDelta(responseId: String?, itemId: String, delta: String)
  case outputTranscriptDone(responseId: String?, itemId: String, transcript: String)
  case functionCallArgumentsDone(RealtimeFunctionCall)
  /// WebRTC only: assistant audio started / fully drained / cleared (interrupted).
  case outputAudioStarted(responseId: String?)
  case outputAudioStopped(responseId: String?)
  case outputAudioCleared(responseId: String?)
  case error(code: String?, message: String, eventId: String?)
  case ignored(type: String)

  public static func parse(_ data: Data) -> RealtimeServerEvent? {
    guard let json = try? JSONValue(jsonData: data), let type = json["type"]?.stringValue else { return nil }
    return parse(json: json, type: type)
  }

  static func parse(json: JSONValue, type: String) -> RealtimeServerEvent {
    func str(_ key: String) -> String? { json[key]?.stringValue }
    switch type {
    case "session.created": return .sessionCreated
    case "session.updated": return .sessionUpdated
    case "input_audio_buffer.speech_started": return .speechStarted(itemId: str("item_id"))
    case "input_audio_buffer.speech_stopped": return .speechStopped(itemId: str("item_id"))
    case "conversation.item.input_audio_transcription.delta":
      return .inputTranscriptDelta(itemId: str("item_id") ?? "", delta: str("delta") ?? "")
    case "conversation.item.input_audio_transcription.completed":
      return .inputTranscriptCompleted(itemId: str("item_id") ?? "", transcript: str("transcript") ?? "")
    case "conversation.item.input_audio_transcription.failed":
      return .inputTranscriptFailed(itemId: str("item_id") ?? "")
    case "response.created":
      return .responseCreated(responseId: json["response"]?["id"]?.stringValue ?? "")
    case "response.done":
      let response = json["response"]
      var calls: [RealtimeFunctionCall] = []
      for item in response?["output"]?.arrayValue ?? [] where item["type"]?.stringValue == "function_call" {
        if let callId = item["call_id"]?.stringValue, let name = item["name"]?.stringValue {
          calls.append(
            RealtimeFunctionCall(
              callId: callId, name: name, arguments: item["arguments"]?.stringValue ?? "{}",
              itemId: item["id"]?.stringValue, responseId: response?["id"]?.stringValue))
        }
      }
      return .responseDone(
        responseId: response?["id"]?.stringValue, status: response?["status"]?.stringValue, functionCalls: calls)
    case "response.output_audio_transcript.delta", "response.audio_transcript.delta", "response.output_text.delta",
      "response.text.delta":
      return .outputTranscriptDelta(responseId: str("response_id"), itemId: str("item_id") ?? "", delta: str("delta") ?? "")
    case "response.output_audio_transcript.done", "response.audio_transcript.done":
      return .outputTranscriptDone(
        responseId: str("response_id"), itemId: str("item_id") ?? "", transcript: str("transcript") ?? "")
    case "response.output_text.done", "response.text.done":
      return .outputTranscriptDone(responseId: str("response_id"), itemId: str("item_id") ?? "", transcript: str("text") ?? "")
    case "response.function_call_arguments.done":
      guard let callId = str("call_id"), let name = str("name") else { return .ignored(type: type) }
      return .functionCallArgumentsDone(
        RealtimeFunctionCall(
          callId: callId, name: name, arguments: str("arguments") ?? "{}", itemId: str("item_id"),
          responseId: str("response_id")))
    case "output_audio_buffer.started": return .outputAudioStarted(responseId: str("response_id"))
    case "output_audio_buffer.stopped": return .outputAudioStopped(responseId: str("response_id"))
    case "output_audio_buffer.cleared": return .outputAudioCleared(responseId: str("response_id"))
    case "error":
      let err = json["error"]
      return .error(
        code: err?["code"]?.stringValue, message: err?["message"]?.stringValue ?? "",
        eventId: err?["event_id"]?.stringValue)
    default:
      return .ignored(type: type)
    }
  }
}

/// Client → server events. Built as JSON text for the data channel.
public enum RealtimeClientEvent: Sendable, Equatable {
  /// Returns a tool result to the model.
  case functionCallOutput(callId: String, output: String)
  /// Asks the model to respond (one active response at a time).
  case responseCreate
  case responseCancel(responseId: String?)
  /// WebRTC only: cut off the assistant audio that is still buffered.
  case outputAudioBufferClear
  case inputAudioBufferClear
  case inputAudioBufferCommit
  /// Typed user message (text fallback).
  case userText(String)
  /// Short system message (e.g. the user confirmed on screen).
  case systemText(String)
  /// Toggles server VAD (nil = push-to-talk).
  case setTurnDetection(serverVAD: Bool)

  public var json: JSONValue {
    switch self {
    case .functionCallOutput(let callId, let output):
      return [
        "type": "conversation.item.create",
        "item": ["type": "function_call_output", "call_id": .string(callId), "output": .string(output)],
      ]
    case .responseCreate:
      return ["type": "response.create"]
    case .responseCancel(let responseId):
      if let responseId { return ["type": "response.cancel", "response_id": .string(responseId)] }
      return ["type": "response.cancel"]
    case .outputAudioBufferClear:
      return ["type": "output_audio_buffer.clear"]
    case .inputAudioBufferClear:
      return ["type": "input_audio_buffer.clear"]
    case .inputAudioBufferCommit:
      return ["type": "input_audio_buffer.commit"]
    case .userText(let text):
      return [
        "type": "conversation.item.create",
        "item": ["type": "message", "role": "user", "content": [["type": "input_text", "text": .string(text)]]],
      ]
    case .systemText(let text):
      return [
        "type": "conversation.item.create",
        "item": ["type": "message", "role": "system", "content": [["type": "input_text", "text": .string(text)]]],
      ]
    case .setTurnDetection(let serverVAD):
      let detection: JSONValue =
        serverVAD
        ? ["type": "server_vad", "create_response": true, "interrupt_response": true]
        : .null
      return [
        "type": "session.update",
        "session": ["type": "realtime", "audio": ["input": ["turn_detection": detection]]],
      ]
    }
  }

  public var data: Data { json.jsonData() }
}
