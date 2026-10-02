import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { IMPORT_STATE_LABELS, type ImportEncoding, type ImportEntity } from "@arms/contracts";
import { Badge, type Tone } from "../../components/ui/Badge";
import { cn } from "../../components/ui/cn";
import type { ImportJob } from "./api";

export type Step = 1 | 2 | 3 | 4;
export const STEP_LABELS: Record<Step, string> = { 1: "ファイル選択", 2: "項目の対応", 3: "検証結果", 4: "移行確定" };

/** What the mapping step needs, either from the freshly uploaded file or from an existing job. */
export interface Draft {
  entity: ImportEntity;
  sourceSystem: string;
  encoding: ImportEncoding;
  uploadId: string;
  filename: string;
  headers: string[];
  /** First data rows of the local preview (empty when the job was opened from the history). */
  sample: string[][];
}

export function draftFromJob(job: ImportJob): Draft {
  return {
    entity: job.entity,
    sourceSystem: job.source_system,
    encoding: job.encoding,
    uploadId: job.upload_id,
    filename: job.filename,
    headers: job.headers.length > 0 ? job.headers : Object.keys(job.mapping),
    sample: [],
  };
}

export function stepOfJob(job: ImportJob): Step {
  if (job.state === "uploaded") return 2;
  if (job.state === "validated") return 3;
  return 4;
}

/** 1 ファイル選択 / 2 項目の対応 / 3 検証結果 / 4 移行確定 (design 17-import). */
export function StepIndicator({ step }: { step: Step }) {
  return (
    <ol aria-label="移行の手順" className="mb-6 grid grid-cols-2 gap-2 rounded-[var(--radius-card)] border border-line bg-surface p-3 sm:grid-cols-4">
      {([1, 2, 3, 4] as Step[]).map((s) => (
        <li
          key={s}
          aria-current={s === step ? "step" : undefined}
          className={cn(
            "flex items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-2 py-2 text-xs font-bold",
            s === step ? "bg-primary-soft text-primary" : s < step ? "text-fg" : "text-muted",
          )}
        >
          {s < step ? <Check className="size-3.5 text-success" aria-hidden /> : null}
          <span>
            {s} {STEP_LABELS[s]}
          </span>
          {s < step ? <span className="sr-only">（完了）</span> : null}
        </li>
      ))}
    </ol>
  );
}

const STATE_TONES: Record<ImportJob["state"], Tone> = {
  uploaded: "neutral",
  validated: "info",
  committing: "warning",
  completed: "success",
  failed: "danger",
  rolled_back: "neutral",
};

export function ImportStateBadge({ job }: { job: Pick<ImportJob, "state" | "rollback_started" | "manual_review_rows"> }) {
  if (job.rollback_started && job.state !== "rolled_back") return <Badge tone="warning">取り消し処理中</Badge>;
  if (job.state === "rolled_back" && job.manual_review_rows > 0) return <Badge tone="warning">取り消し済み（要手動照合）</Badge>;
  return <Badge tone={STATE_TONES[job.state]}>{IMPORT_STATE_LABELS[job.state]}</Badge>;
}

/** Large number + label (design: 28 対象レコード / 26 移行可能 / 2 要確認). */
export function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warning" }) {
  return (
    <div className="min-w-[96px]">
      <p className={cn("text-3xl font-bold tabular-nums", tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-fg")}>
        {value.toLocaleString("ja-JP")}
      </p>
      <p className="mt-1 text-xs text-muted">{label}</p>
    </div>
  );
}

export function SimpleTable({ caption, head, children }: { caption: string; head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="bg-surface-2">
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-3 text-left text-xs font-medium whitespace-nowrap text-muted first:rounded-l-lg last:rounded-r-lg">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const td = "border-b border-line px-3 py-3 align-top";
