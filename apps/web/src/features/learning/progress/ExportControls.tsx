import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { errorMessageJa } from "@arms/contracts";
import { Button } from "../../../components/ui/Button";
import { InlineError } from "../../../components/ui/Feedback";
import { api } from "../../../lib/api";
import { useOnline } from "../../../lib/online";
import type { DataResponse, ExportJob } from "../api";

export type ExportFilters = { month?: string; department?: string; teacher_id?: string; classroom_id?: string; status?: string; q?: string };

type State =
  | { phase: "idle" }
  | { phase: "working"; format: "csv" | "pdf"; job?: ExportJob }
  | { phase: "ready"; format: "csv" | "pdf"; job: ExportJob }
  | { phase: "failed"; format: "csv" | "pdf"; message: string }
  | { phase: "error"; format: "csv" | "pdf"; error: unknown };

const POLL_MS = 2_000;
const POLL_LIMIT = 90; // ~3 minutes; larger exports keep running and can be fetched again.

const FORMAT_LABEL = { csv: "CSV", pdf: "PDF" } as const;

/**
 * Saves a ready export (5-minute presigned URL). The file is fetched and saved through a same-origin blob link:
 * navigating to the cross-origin URL can make some engines (WebKit) render the CSV in place of the app instead of
 * downloading it. Falls back to navigation only if the fetch itself is not possible (e.g. storage CORS missing).
 */
export async function triggerDownload(url: string, filename: string | null): Promise<void> {
  let blob: Blob | null = null;
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (res.ok) blob = await res.blob();
  } catch {
    blob = null;
  }
  if (!blob) {
    window.location.assign(url);
    return;
  }
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename ?? "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

/**
 * CSV/PDF出力 with the list's current filters: POST /exports/progress → (pending) poll GET /exports/{id} → download.
 * Large exports (> 500 rows) are generated in the background; EXPORT_TOO_LARGE / PDF_FONT_UNAVAILABLE are shown in
 * Japanese. Nothing is reported as downloaded before the API says the file is ready.
 */
export function ExportControls({ filters }: { filters: ExportFilters }) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const online = useOnline();
  const cancelled = useRef(false);
  useEffect(() => {
    // Re-armed on every mount (StrictMode mounts twice in development).
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const settle = (format: "csv" | "pdf", job: ExportJob) => {
    if (job.state === "ready" && job.download_url) {
      setState({ phase: "ready", format, job });
      void triggerDownload(job.download_url, job.filename);
      return true;
    }
    if (job.state === "failed") {
      setState({ phase: "failed", format, message: job.error_code ? errorMessageJa(job.error_code) : "ファイルを作成できませんでした。" });
      return true;
    }
    if (job.state === "expired") {
      setState({ phase: "failed", format, message: "ファイルの保存期限（24時間）が過ぎました。もう一度出力してください。" });
      return true;
    }
    return false;
  };

  const run = async (format: "csv" | "pdf") => {
    setState({ phase: "working", format });
    try {
      const body = Object.fromEntries(Object.entries({ format, ...filters }).filter(([, v]) => v !== undefined && v !== ""));
      let job = (await api.post<DataResponse<ExportJob>>("/exports/progress", body)).data;
      for (let i = 0; i < POLL_LIMIT && !cancelled.current; i++) {
        if (settle(format, job)) return;
        setState({ phase: "working", format, job });
        await new Promise((r) => setTimeout(r, POLL_MS));
        job = (await api.get<DataResponse<ExportJob>>(`/exports/${job.id}`)).data;
      }
      if (!cancelled.current && !settle(format, job)) {
        setState({ phase: "failed", format, message: "作成に時間がかかっています。しばらくしてからもう一度出力してください。" });
      }
    } catch (e) {
      setState({ phase: "error", format, error: e });
    }
  };

  const busy = state.phase === "working";
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {(["csv", "pdf"] as const).map((f) => (
          <Button
            key={f}
            variant="secondary"
            size="sm"
            icon={<Download className="size-3.5" aria-hidden />}
            loading={busy && state.format === f}
            disabled={busy || !online}
            onClick={() => run(f)}
          >
            {FORMAT_LABEL[f]}出力
          </Button>
        ))}
      </div>
      <div aria-live="polite" className="text-right text-xs">
        {state.phase === "working" ? (
          <p className="text-muted">
            {FORMAT_LABEL[state.format]}を作成しています…{state.job?.row_count ? `（${state.job.row_count}件）` : ""}
          </p>
        ) : null}
        {state.phase === "ready" ? (
          <p className="text-success">
            {FORMAT_LABEL[state.format]}（{state.job.row_count ?? 0}件）をダウンロードしました。
            {state.job.download_url ? (
              <button type="button" className="ml-1 underline" onClick={() => void triggerDownload(state.job.download_url as string, state.job.filename)}>
                もう一度ダウンロード
              </button>
            ) : null}
          </p>
        ) : null}
        {state.phase === "failed" ? (
          <p role="alert" className="font-medium text-danger">
            {FORMAT_LABEL[state.format]}出力：{state.message}
          </p>
        ) : null}
      </div>
      {state.phase === "error" ? (
        <div className="max-w-md">
          <InlineError error={state.error} />
        </div>
      ) : null}
    </div>
  );
}
