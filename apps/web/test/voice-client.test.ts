import { describe, expect, it } from "vitest";
import { applyServerEvent, initialSnapshot, type VoiceSnapshot } from "../src/features/voice/realtimeClient";

const connecting: VoiceSnapshot = { ...initialSnapshot, status: "connecting", sessionId: "s1" };

describe("voice client event handling", () => {
  it("moves from connecting to listening when the session is created", () => {
    expect(applyServerEvent(connecting, { type: "session.created" }).status).toBe("listening");
  });

  it("appends the user's transcription and streams the assistant transcript", () => {
    let s = applyServerEvent(connecting, { type: "session.created" });
    s = applyServerEvent(s, { type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "今日の授業を教えて" });
    s = applyServerEvent(s, { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "本日は" });
    expect(s.status).toBe("speaking");
    s = applyServerEvent(s, { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "10時から" });
    s = applyServerEvent(s, { type: "response.output_audio_transcript.done", item_id: "a1", transcript: "本日は10時からビジネスマナーです。" });
    expect(s.transcript).toEqual([
      { id: "u1", role: "user", text: "今日の授業を教えて", final: true },
      { id: "a1", role: "assistant", text: "本日は10時からビジネスマナーです。", final: true },
    ]);
    s = applyServerEvent(s, { type: "output_audio_buffer.stopped" });
    expect(s.status).toBe("listening");
  });

  it("returns to confirming (not listening) while a confirmation card is open", () => {
    const s: VoiceSnapshot = {
      ...initialSnapshot,
      status: "speaking",
      sessionId: "s1",
      confirmation: { callId: "c", tool: "prepare_reservation", actionToken: "t".repeat(43), confirmationJa: "申請してよろしいですか？", expiresAt: "", card: {} },
    };
    expect(applyServerEvent(s, { type: "output_audio_buffer.stopped" }).status).toBe("confirming");
  });

  it("never surfaces raw provider error text", () => {
    const s = applyServerEvent(connecting, { type: "error", error: { message: "Internal server error: xyz" } });
    expect(s.errorJa).not.toContain("xyz");
    expect(s.errorJa).toMatch(/画面から操作/);
  });
});
