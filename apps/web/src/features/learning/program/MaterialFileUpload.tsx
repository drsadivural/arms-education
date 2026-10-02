import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UPLOAD_STATE_LABELS } from "@arms/contracts";
import { ScanStateBadge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { FileDropZone, UploadProgress } from "../../../components/ui/FileUpload";
import { InlineError } from "../../../components/ui/Feedback";
import { useIdempotentMutation } from "../../../lib/query";
import { learningKeys, type UploadStatus } from "../api";
import { fileSizeLabel } from "../format";
import {
  MATERIAL_FILE_RULES,
  UploadTransferError,
  acceptFor,
  checkMaterialFile,
  completeUpload,
  getUploadStatus,
  isUploadSettled,
  putFile,
  requestUpload,
  type FileMaterialKind,
} from "../upload";

type View =
  | { phase: "idle" }
  | { phase: "invalid"; fileName: string; message: string }
  | { phase: "uploading"; fileName: string; size: number; fraction: number }
  | { phase: "completing"; fileName: string; size: number }
  | { phase: "done"; fileName: string; size: number; uploadId: string; objectKey: string; scannerConfigured: boolean; initial: UploadStatus }
  | { phase: "error"; fileName: string; error: unknown };

/** The uploaded file a material can reference (scanning or clean). */
export interface ReadyUpload {
  objectKey: string;
  uploadId: string;
  state: UploadStatus["state"];
}

/** Polling interval: every 5 s for the first minute, then every 30 s while the scanner verdict is pending. */
function pollInterval(updates: number): number {
  return updates < 12 ? 5_000 : 30_000;
}

/**
 * Upload flow of a file material: client checks → POST /uploads → PUT with progress → complete → poll the scan
 * state. Reports the usable upload (or null) to the form; nothing is shown as uploaded before the API confirms.
 */
export function MaterialFileUpload({
  kind,
  initialFile,
  onReady,
  label = "ファイル",
  disabled,
}: {
  kind: FileMaterialKind;
  initialFile?: File | null;
  onReady(upload: ReadyUpload | null): void;
  label?: string;
  disabled?: boolean;
}) {
  const [view, setView] = useState<View>({ phase: "idle" });
  const abort = useRef<AbortController | null>(null);
  const started = useRef<File | null>(null);
  const request = useIdempotentMutation((input: { filename: string; content_type: string; size_bytes: number }, key: string) => requestUpload(input, key));
  const rule = MATERIAL_FILE_RULES[kind];

  const status = useQuery({
    queryKey: learningKeys.upload(view.phase === "done" ? view.uploadId : "none"),
    queryFn: () => getUploadStatus((view as Extract<View, { phase: "done" }>).uploadId),
    enabled: view.phase === "done",
    initialData: view.phase === "done" ? { data: view.initial, checked_at: view.initial.created_at } : undefined,
    refetchInterval: (q) => (q.state.data && isUploadSettled(q.state.data.data.state) ? false : pollInterval(q.state.dataUpdateCount)),
  });
  const current = view.phase === "done" ? (status.data?.data ?? view.initial) : null;

  useEffect(() => {
    if (view.phase !== "done" || !current) {
      onReady(null);
      return;
    }
    const usable = current.state === "scanning" || current.state === "clean";
    onReady(usable ? { objectKey: view.objectKey, uploadId: view.uploadId, state: current.state } : null);
  }, [view.phase, current?.state]);

  useEffect(() => () => abort.current?.abort(), []);

  const start = async (file: File) => {
    const check = checkMaterialFile(kind, file);
    if (!check.ok) {
      setView({ phase: "invalid", fileName: file.name, message: check.message });
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setView({ phase: "uploading", fileName: file.name, size: file.size, fraction: 0 });
    try {
      const ticket = await request.mutateAsync({ filename: file.name, content_type: check.contentType, size_bytes: file.size });
      await putFile(ticket.data, file, (fraction) => setView((v) => (v.phase === "uploading" ? { ...v, fraction } : v)), controller.signal);
      setView({ phase: "completing", fileName: file.name, size: file.size });
      const completed = await completeUpload(ticket.data.id);
      setView({
        phase: "done",
        fileName: file.name,
        size: file.size,
        uploadId: ticket.data.id,
        objectKey: ticket.data.object_key,
        scannerConfigured: completed.scanner_configured,
        initial: completed,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setView({ phase: "error", fileName: file.name, error: e });
    }
  };

  useEffect(() => {
    if (initialFile && started.current !== initialFile) {
      started.current = initialFile;
      void start(initialFile);
    }
  }, [initialFile]);

  const reset = () => {
    abort.current?.abort();
    setView({ phase: "idle" });
  };

  const hint = `${rule.label}：${Object.values(rule.types)
    .flat()
    .map((e) => `.${e}`)
    .join("・")}、${rule.maxBytes / 1024 / 1024}MBまで。ファイルは安全性の検査後に公開できます。`;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-bold">{label}</p>
      <div aria-live="polite" className="flex flex-col gap-2">
        {view.phase === "idle" || view.phase === "invalid" || view.phase === "error" ? (
          <FileDropZone title={`${rule.label}ファイルをアップロード`} hint={hint} accept={acceptFor(kind)} disabled={disabled} onFile={(f) => void start(f)}>
            {view.phase === "invalid" ? (
              <p role="alert" className="text-xs font-medium text-danger">
                {view.fileName}：{view.message}
              </p>
            ) : null}
            {view.phase === "error" ? (
              view.error instanceof UploadTransferError ? (
                <p role="alert" className="text-xs font-medium text-danger">
                  {view.fileName}：{view.error.messageJa}
                </p>
              ) : (
                <div className="w-full text-left">
                  <InlineError error={view.error} />
                </div>
              )
            ) : null}
          </FileDropZone>
        ) : null}
        {view.phase === "uploading" ? (
          <div className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-line p-3">
            <p className="text-sm">
              {view.fileName}（{fileSizeLabel(view.size)}）を送信しています
            </p>
            <UploadProgress fraction={view.fraction} label={`${view.fileName}の送信状況`} />
            <div>
              <Button variant="ghost" size="sm" onClick={reset}>
                送信を中止
              </Button>
            </div>
          </div>
        ) : null}
        {view.phase === "completing" ? (
          <p role="status" className="rounded-[var(--radius-control)] border border-line p-3 text-sm">
            {view.fileName}：サーバーでファイルの形式とサイズを確認しています…
          </p>
        ) : null}
        {view.phase === "done" && current ? (
          <div className="flex flex-col gap-2 rounded-[var(--radius-control)] border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium break-all">{view.fileName}</span>
              <span className="text-xs text-muted">{fileSizeLabel(current.size_bytes)}</span>
              <ScanStateBadge state={current.scan_state} />
              <span className="text-xs text-muted">状態：{UPLOAD_STATE_LABELS[current.state]}</span>
            </div>
            {current.state === "scanning" ? (
              <p className="text-xs text-muted">
                {view.scannerConfigured
                  ? "アップロードは完了しました。安全性の検査結果を自動で確認しています。検査が完了するまで教材は公開できません。"
                  : "ファイル検査サービスが接続されていないため「検査待ち」のままです。教材として登録はできますが、検査が完了するまで公開できません。"}
              </p>
            ) : null}
            {current.state === "clean" ? <p className="text-xs text-success">検査が完了しました。教材として公開できます。</p> : null}
            {current.state === "blocked" || current.state === "rejected" || current.state === "expired" ? (
              <p role="alert" className="text-xs font-medium text-danger">
                {current.state === "blocked"
                  ? "検査で問題が検出されたため、このファイルは使用できません。別のファイルを選択してください。"
                  : current.state === "expired"
                    ? "アップロードの有効期限が切れました。もう一度ファイルを選択してください。"
                    : "ファイルの内容が形式と一致しないため拒否されました。別のファイルを選択してください。"}
              </p>
            ) : null}
            <div>
              <Button variant="ghost" size="sm" onClick={reset} disabled={disabled}>
                別のファイルを選択
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
