/**
 * Browser client for the ARMS voice assistant (docs/05): OpenAI Realtime over WebRTC with a short-lived client
 * secret issued by POST /api/v1/voice/sessions. Tool calls are never executed in the browser: completed function
 * calls are forwarded to POST /api/v1/voice/tool-calls and the server's JSON result is returned to the model.
 * The client secret lives only in this object's memory and is dropped once the SDP exchange is done.
 */
import { api, ApiError } from "../../lib/api";

export type VoiceStatus = "idle" | "connecting" | "listening" | "confirming" | "speaking" | "reconnecting" | "error";

export interface TranscriptEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  final: boolean;
}

export interface ConfirmationCard {
  callId: string;
  tool: "prepare_reservation" | "prepare_cancellation";
  actionToken: string;
  confirmationJa: string;
  expiresAt: string;
  card: Record<string, unknown>;
}

export interface VoiceSnapshot {
  status: VoiceStatus;
  muted: boolean;
  micAvailable: boolean;
  transcript: TranscriptEntry[];
  confirmation: ConfirmationCard | null;
  errorJa: string | null;
  sessionId: string | null;
  endsAt: string | null;
}

interface SessionResponse {
  session_id: string;
  client_secret: string;
  expires_at: string;
  model: string;
}

interface ToolResponse {
  success: boolean;
  checked_at: string;
  data?: Record<string, unknown>;
}

const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const SILENCE_TIMEOUT_MS = 60_000;

export const initialSnapshot: VoiceSnapshot = {
  status: "idle",
  muted: false,
  micAvailable: true,
  transcript: [],
  confirmation: null,
  errorJa: null,
  sessionId: null,
  endsAt: null,
};

type RealtimeEvent = { type: string; [k: string]: unknown };

/** Pure state transitions for server events (unit-tested separately from WebRTC). */
export function applyServerEvent(s: VoiceSnapshot, e: RealtimeEvent): VoiceSnapshot {
  switch (e.type) {
    case "session.created":
    case "session.updated":
      return s.status === "connecting" || s.status === "reconnecting" ? { ...s, status: "listening" } : s;
    case "input_audio_buffer.speech_started":
      return { ...s, status: "listening" };
    case "conversation.item.input_audio_transcription.completed": {
      const text = String(e.transcript ?? "").trim();
      if (!text) return s;
      return { ...s, transcript: [...s.transcript, { id: String(e.item_id ?? crypto.randomUUID()), role: "user", text, final: true }] };
    }
    case "response.output_audio_transcript.delta":
    case "response.output_text.delta": {
      const id = String(e.item_id ?? e.response_id ?? "assistant");
      const delta = String(e.delta ?? "");
      const idx = s.transcript.findIndex((t) => t.id === id);
      if (idx === -1) return { ...s, status: s.status === "confirming" ? s.status : "speaking", transcript: [...s.transcript, { id, role: "assistant", text: delta, final: false }] };
      const next = s.transcript.slice();
      const cur = next[idx] as TranscriptEntry;
      next[idx] = { ...cur, text: cur.text + delta };
      return { ...s, transcript: next };
    }
    case "response.output_audio_transcript.done":
    case "response.output_text.done": {
      const id = String(e.item_id ?? e.response_id ?? "assistant");
      return { ...s, transcript: s.transcript.map((t) => (t.id === id ? { ...t, text: String(e.transcript ?? e.text ?? t.text), final: true } : t)) };
    }
    case "output_audio_buffer.started":
      return { ...s, status: "speaking" };
    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
    case "response.done":
      return s.status === "speaking" ? { ...s, status: s.confirmation ? "confirming" : "listening" } : s;
    case "error":
      // Provider error text is English/internal; show a Japanese fallback instead.
      return { ...s, errorJa: "音声サービスでエラーが発生しました。もう一度話しかけるか、画面から操作してください。" };
    default:
      return s;
  }
}

export class RealtimeVoiceClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private snapshot: VoiceSnapshot = initialSnapshot;
  private listeners = new Set<(s: VoiceSnapshot) => void>();
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private handledCalls = new Set<string>();

  subscribe(listener: (s: VoiceSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private set(next: VoiceSnapshot) {
    this.snapshot = next;
    this.listeners.forEach((l) => l(next));
  }

  get state(): VoiceSnapshot {
    return this.snapshot;
  }

  async start(): Promise<void> {
    if (this.pc) return;
    this.set({ ...initialSnapshot, status: "connecting" });
    let session: SessionResponse;
    try {
      session = await api.post<SessionResponse>("/voice/sessions");
    } catch (e) {
      this.set({ ...this.snapshot, status: "error", errorJa: e instanceof ApiError ? e.messageJa : "現在、音声機能を利用できません。画面から操作してください。" });
      return;
    }
    this.set({ ...this.snapshot, sessionId: session.session_id, endsAt: session.expires_at });
    try {
      const pc = new RTCPeerConnection();
      this.pc = pc;
      // A single <audio> sink: model audio can never play twice even across reconnects.
      this.audio = this.audio ?? Object.assign(document.createElement("audio"), { autoplay: true });
      pc.ontrack = (ev) => {
        if (this.audio) this.audio.srcObject = ev.streams[0] ?? null;
      };
      try {
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        for (const track of this.mic.getAudioTracks()) pc.addTrack(track, this.mic);
      } catch {
        // Microphone denied/unavailable: continue text-only (receive audio, type questions).
        this.set({ ...this.snapshot, micAvailable: false });
        pc.addTransceiver("audio", { direction: "recvonly" });
      }
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (m) => this.onEvent(JSON.parse(String(m.data)) as RealtimeEvent);
      dc.onclose = () => {
        if (this.pc) this.set({ ...this.snapshot, status: "error", errorJa: "音声サービスとの接続が切れました。もう一度開始してください。" });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") this.set({ ...this.snapshot, status: "error", errorJa: "音声サービスに接続できませんでした。画面から操作してください。" });
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch(REALTIME_CALLS_URL, {
        method: "POST",
        body: offer.sdp ?? "",
        headers: { Authorization: `Bearer ${session.client_secret}`, "Content-Type": "application/sdp" },
      });
      if (!res.ok) throw new Error(`realtime ${res.status}`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
      this.armTimers();
    } catch {
      await this.end("現在、音声機能を利用できません。画面から操作してください。");
    }
  }

  private armTimers() {
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.snapshot.endsAt) {
      const ms = new Date(this.snapshot.endsAt).getTime() - Date.now();
      this.endTimer = setTimeout(() => void this.end("利用時間の上限に達したため、音声を終了しました。"), Math.max(0, ms));
    }
    this.touch();
  }

  /** 60 s without speech or response ends the session (cost control, docs/05). */
  private touch() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => void this.end("60秒間発話がなかったため、音声を終了しました。"), SILENCE_TIMEOUT_MS);
  }

  private send(event: Record<string, unknown>) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(event));
  }

  private onEvent(e: RealtimeEvent) {
    if (e.type === "input_audio_buffer.speech_started" || e.type === "response.created") this.touch();
    this.set(applyServerEvent(this.snapshot, e));
    if (e.type === "response.function_call_arguments.done") {
      void this.handleFunctionCall(String(e.call_id), String(e.name), String(e.arguments ?? "{}"));
    }
  }

  private async handleFunctionCall(callId: string, name: string, rawArgs: string) {
    if (this.handledCalls.has(callId) || !this.snapshot.sessionId) return;
    this.handledCalls.add(callId);
    this.set({ ...this.snapshot, status: "confirming" });
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      args = {};
    }
    let output: ToolResponse;
    try {
      output = await api.post<ToolResponse>("/voice/tool-calls", { session_id: this.snapshot.sessionId, call_id: callId, tool_name: name, arguments: args });
    } catch (e) {
      output = { success: false, checked_at: new Date().toISOString(), data: { error_code: e instanceof ApiError ? e.code : "NETWORK", message_ja: e instanceof ApiError ? e.messageJa : "通信できませんでした。" } };
    }
    const data = output.data ?? {};
    if (output.success && (name === "prepare_reservation" || name === "prepare_cancellation") && typeof data.action_token === "string") {
      this.set({
        ...this.snapshot,
        confirmation: {
          callId,
          tool: name,
          actionToken: data.action_token,
          confirmationJa: String(data.confirmation_ja ?? ""),
          expiresAt: String(data.expires_at ?? ""),
          card: (data.card as Record<string, unknown>) ?? {},
        },
      });
    }
    if (name === "commit_reservation" || name === "commit_cancellation") this.set({ ...this.snapshot, confirmation: null });
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) } });
    this.send({ type: "response.create" });
  }

  /** Explicit on-screen confirmation (button): commits the prepared action and tells the model what happened. */
  async confirm(): Promise<void> {
    const c = this.snapshot.confirmation;
    if (!c || !this.snapshot.sessionId) return;
    const tool = c.tool === "prepare_reservation" ? "commit_reservation" : "commit_cancellation";
    const res = await api.post<ToolResponse>("/voice/tool-calls", { session_id: this.snapshot.sessionId, call_id: `ui-${crypto.randomUUID()}`, tool_name: tool, arguments: { action_token: c.actionToken } });
    this.set({ ...this.snapshot, confirmation: null });
    const message = String(res.data?.message_ja ?? "");
    this.sendText(`（画面のボタンで確定しました。結果: ${res.success ? message : `失敗 — ${message}`}）`);
  }

  dismissConfirmation(): void {
    this.set({ ...this.snapshot, confirmation: null });
    this.sendText("（画面で取りやめました。実行しないでください。）");
  }

  /** Typed question (text fallback for no microphone / noisy places). */
  sendText(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.touch();
    this.set({ ...this.snapshot, transcript: [...this.snapshot.transcript, { id: crypto.randomUUID(), role: "user", text: t, final: true }] });
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } });
    this.send({ type: "response.create" });
  }

  setMuted(muted: boolean): void {
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.set({ ...this.snapshot, muted });
  }

  /** Stops audio capture, closes WebRTC and settles the session on the server. */
  async end(reasonJa?: string): Promise<void> {
    const sessionId = this.snapshot.sessionId;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    const pc = this.pc;
    this.pc = null;
    this.dc?.close();
    this.dc = null;
    pc?.close();
    if (this.audio) this.audio.srcObject = null;
    this.handledCalls.clear();
    this.set({ ...this.snapshot, status: reasonJa ? "error" : "idle", errorJa: reasonJa ?? null, confirmation: null, sessionId: null });
    if (sessionId) await api.post(`/voice/sessions/${sessionId}/end`).catch(() => undefined);
  }
}
