import { useQuery } from "@tanstack/react-query";
import { Mic, MicOff, PhoneOff, Send } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { VOICE_STATE_LABELS } from "@arms/contracts";
import { PageHeader } from "../../components/ui/PageHeader";
import { Card, CardHeader } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Field";
import { Badge } from "../../components/ui/Badge";
import { InlineError, Notice } from "../../components/ui/Feedback";
import { ApiError, api } from "../../lib/api";
import { useCurrentUser } from "../../lib/session";
import { useOnline } from "../../lib/online";
import { RealtimeVoiceClient, initialSnapshot, type VoiceSnapshot } from "../../features/voice/realtimeClient";

interface QuotaResponse {
  data: { daily_quota_seconds: number; used_seconds: number; remaining_seconds: number; max_session_seconds: number };
  checked_at: string;
}

const minutes = (s: number) => `${Math.floor(s / 60)}分${s % 60 ? `${s % 60}秒` : ""}`;

/** AI音声アシスタント（Web, 講師向け）。受講者はiOSアプリの音声機能を利用する。 */
export function VoicePage() {
  const user = useCurrentUser();
  const online = useOnline();
  const clientRef = useRef<RealtimeVoiceClient | null>(null);
  const [snap, setSnap] = useState<VoiceSnapshot>(initialSnapshot);
  const [text, setText] = useState("");
  const transcriptEnd = useRef<HTMLLIElement | null>(null);
  const isTeacher = user.role === "teacher";

  const quota = useQuery({
    queryKey: ["voice", "quota"],
    queryFn: () => api.get<QuotaResponse>("/voice/quota"),
    enabled: isTeacher,
    refetchInterval: snap.sessionId ? 30_000 : false,
  });

  useEffect(() => {
    if (!isTeacher) return;
    const client = new RealtimeVoiceClient();
    clientRef.current = client;
    const off = client.subscribe(setSnap);
    // Leaving the page or hiding the tab stops recording and ends the session (no background capture).
    const onHidden = () => {
      if (document.visibilityState === "hidden") void client.end();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      off();
      void client.end();
    };
  }, [isTeacher]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView?.({ block: "end" });
  }, [snap.transcript.length]);

  const active = snap.sessionId !== null;
  const onSend = (e: FormEvent) => {
    e.preventDefault();
    clientRef.current?.sendText(text);
    setText("");
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="AI音声アシスタント" crumbs={[{ label: "AI音声アシスタント" }]} description="日本語の音声で、今日の担当授業・担当受講者の進捗・予約状況を確認できます。" />
      {!isTeacher ? (
        <Notice>
          AI音声アシスタントは講師と受講者向けの機能です。管理者の業務は各管理画面から操作してください。受講者はiOSアプリから利用できます。
        </Notice>
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <p className="text-center text-xs text-muted">AIが生成した音声です</p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <Badge tone={snap.status === "error" ? "danger" : snap.status === "idle" ? "neutral" : "info"}>
                <span role="status" aria-live="polite">
                  {VOICE_STATE_LABELS[snap.status]}
                </span>
              </Badge>
              {quota.data ? (
                <span className="text-xs text-muted">
                  本日の残り {minutes(quota.data.data.remaining_seconds)}（1回最大 {minutes(quota.data.data.max_session_seconds)}）
                </span>
              ) : null}
            </div>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {!active ? (
                <Button icon={<Mic className="size-4" aria-hidden />} onClick={() => void clientRef.current?.start()} loading={snap.status === "connecting"} disabled={!online}>
                  音声を開始
                </Button>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    icon={snap.muted ? <MicOff className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}
                    onClick={() => clientRef.current?.setMuted(!snap.muted)}
                    disabled={!snap.micAvailable}
                    aria-pressed={snap.muted}
                  >
                    {snap.muted ? "ミュート解除" : "ミュート"}
                  </Button>
                  <Button variant="danger" icon={<PhoneOff className="size-4" aria-hidden />} onClick={() => void clientRef.current?.end()}>
                    音声を終了
                  </Button>
                </>
              )}
            </div>
            {!snap.micAvailable ? <p className="mt-3 text-center text-xs text-warning">マイクが利用できません。下の入力欄からテキストで質問できます。</p> : null}
            {snap.errorJa ? (
              <div className="mt-4">
                <InlineError error={new ApiError(503, { code: "VOICE_UNAVAILABLE", message_ja: snap.errorJa })} />
              </div>
            ) : null}
          </Card>

          {snap.confirmation ? (
            <Card role="dialog" aria-label="実行内容の確認" className="border-primary">
              <CardHeader title="内容の確認" />
              <p className="text-sm">{snap.confirmation.confirmationJa}</p>
              <div className="mt-4 flex gap-2">
                <Button onClick={() => void clientRef.current?.confirm()}>確定する</Button>
                <Button variant="secondary" onClick={() => clientRef.current?.dismissConfirmation()}>
                  取りやめる
                </Button>
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="会話" description="音声と文字起こしは保存されません。" />
            {snap.transcript.length === 0 ? (
              <p className="text-xs text-muted">「今日の授業を教えて」「和田さんの進捗は？」のように話しかけてください。</p>
            ) : (
              <ol className="flex max-h-[420px] flex-col gap-3 overflow-y-auto" aria-live="polite">
                {snap.transcript.map((t) => (
                  <li key={t.id} className={t.role === "user" ? "self-end rounded-xl bg-primary-soft px-4 py-2 text-sm" : "self-start rounded-xl border border-line bg-surface px-4 py-2 text-sm"}>
                    <span className="sr-only">{t.role === "user" ? "あなた: " : "アシスタント: "}</span>
                    {t.text}
                  </li>
                ))}
                <li ref={transcriptEnd} aria-hidden />
              </ol>
            )}
            <form onSubmit={onSend} className="mt-4 flex gap-2">
              <label htmlFor="voice-text" className="sr-only">
                テキストで質問
              </label>
              <Input id="voice-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="テキストで質問する" disabled={!active} />
              <Button type="submit" variant="secondary" icon={<Send className="size-4" aria-hidden />} disabled={!active || !text.trim()}>
                送信
              </Button>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
