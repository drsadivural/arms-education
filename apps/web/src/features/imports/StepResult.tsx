import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Download, Pencil, ArrowRight } from "lucide-react";
import { IMPORT_ACTION_LABELS, IMPORT_COMMIT_STATE_LABELS, IMPORT_ENCODING_LABELS, IMPORT_ITEM_FILTERS, IMPORT_ROLLBACK_STATE_LABELS, type ImportItemFilter } from "@arms/contracts";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { EmptyState, ErrorState, InlineError, LastFetched, LoadingRows, Notice } from "../../components/ui/Feedback";
import { Select } from "../../components/ui/Field";
import { importsApi, downloadErrorReport, type ImportItem, type ImportJob } from "./api";
import { SimpleTable, Stat, td } from "./common";

const FILTER_LABELS: Record<ImportItemFilter, string> = {
  all: "すべて",
  create: "新規",
  update: "更新",
  skip: "変更なし",
  error: "エラー",
  warning: "警告あり",
  conflict: "確定時の競合",
  manual: "手動照合が必要",
};

const ACTION_TONES: Record<ImportItem["action"], Tone> = { create: "info", update: "warning", skip: "neutral", error: "danger" };

export function ErrorReportButton({ jobId }: { jobId: string }) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        variant="secondary"
        icon={<Download className="size-4" aria-hidden />}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await downloadErrorReport(jobId);
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        エラー明細をダウンロード
      </Button>
      {error ? <InlineError error={error} /> : null}
    </div>
  );
}

function valueText(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "有効" : "無効";
  return String(v);
}

/** Planned rows (dry run) or results (commit / rollback) with a status filter and paging. */
export function ItemsTable({ job, initialFilter = "all" }: { job: ImportJob; initialFilter?: ImportItemFilter }) {
  const [filter, setFilter] = useState<ImportItemFilter>(initialFilter);
  const query = useInfiniteQuery({
    queryKey: ["imports", job.id, "items", filter, job.row_version],
    queryFn: ({ pageParam }) => importsApi.items(job.id, filter, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  });
  const rows = query.data?.pages.flatMap((p) => p.items);
  const columns = job.columns.filter((c) => c.source_header !== null).map((c) => c.field);
  const shown = columns.length > 0 ? columns.slice(0, 6) : [];
  return (
    <section aria-labelledby={`items-${job.id}`} className="mt-6">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h3 id={`items-${job.id}`} className="text-sm font-bold">
          行ごとの内容
        </h3>
        <label className="flex items-center gap-2 text-xs text-muted">
          表示
          <Select value={filter} onChange={(e) => setFilter(e.target.value as ImportItemFilter)} className="h-9 w-auto">
            {IMPORT_ITEM_FILTERS.map((f) => (
              <option key={f} value={f}>
                {FILTER_LABELS[f]}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {query.isLoading ? (
        <LoadingRows rows={3} />
      ) : query.error && !rows ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows && rows.length === 0 ? (
        <EmptyState title={`${FILTER_LABELS[filter]}の行はありません`} />
      ) : (
        <>
          <SimpleTable caption="行ごとの移行内容" head={["行", "判定", ...shown.map((f) => job.columns.find((c) => c.field === f)?.label_ja ?? f), "メッセージ"]}>
            {(rows ?? []).map((item) => (
              <tr key={item.row}>
                <td className={`${td} tabular-nums`}>{item.row}</td>
                <td className={td}>
                  <div className="flex flex-col items-start gap-1">
                    <Badge tone={ACTION_TONES[item.action]}>{IMPORT_ACTION_LABELS[item.action]}</Badge>
                    {item.commit_state ? <Badge tone={item.commit_state === "conflict" ? "danger" : "success"}>{IMPORT_COMMIT_STATE_LABELS[item.commit_state]}</Badge> : null}
                    {item.rollback_state ? <Badge tone={item.rollback_state === "manual" ? "warning" : "neutral"}>{IMPORT_ROLLBACK_STATE_LABELS[item.rollback_state]}</Badge> : null}
                  </div>
                </td>
                {shown.map((f) => {
                  const changed = item.changed_fields.includes(f);
                  return (
                    <td key={f} className={`${td} max-w-[220px] whitespace-pre-line`}>
                      {changed && item.before ? <span className="block text-[11px] text-muted line-through">{valueText(item.before[f])}</span> : null}
                      <span className={changed ? "font-bold" : undefined}>{valueText(item.values[f])}</span>
                    </td>
                  );
                })}
                <td className={`${td} min-w-[240px] text-xs`}>
                  <ul className="space-y-1">
                    {item.errors.map((e, i) => (
                      <li key={`e${i}`} className="text-danger">
                        {e.label_ja}: {e.message_ja}
                      </li>
                    ))}
                    {item.warnings.map((e, i) => (
                      <li key={`w${i}`} className="text-warning">
                        {e.label_ja}: {e.message_ja}
                      </li>
                    ))}
                    {item.commit_message_ja ? <li className="text-danger">{item.commit_message_ja}</li> : null}
                    {item.rollback_message_ja ? <li className="text-fg">{item.rollback_message_ja}</li> : null}
                  </ul>
                </td>
              </tr>
            ))}
          </SimpleTable>
          {query.hasNextPage ? (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                さらに読み込む
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

interface Props {
  job: ImportJob;
  checkedAt?: string;
  loadingMoreErrors: boolean;
  onMoreErrors?: () => void;
  errors: ImportJob["errors"];
  onEditMapping(): void;
  onProceed(): void;
}

/** 3 検証結果: counts, column status, Japanese row errors, error report, preview table. */
export function StepResult({ job, checkedAt, errors, loadingMoreErrors, onMoreErrors, onEditMapping, onProceed }: Props) {
  const errorRows = [...new Set(errors.map((e) => e.row))];
  return (
    <Card aria-labelledby="import-step3">
      <CardHeader id="import-step3" title="移行前の検証" description="ドライランの結果です。データはまだ変更していません。" actions={<LastFetched checkedAt={checkedAt} />} />
      <div className="flex flex-wrap gap-6">
        <Stat label="対象レコード" value={job.total_rows} />
        <Stat label="移行可能" value={job.valid_rows} />
        <Stat label="要確認（エラー）" value={job.error_rows} tone={job.error_rows > 0 ? "danger" : undefined} />
        <Stat label="新規" value={job.new_rows} />
        <Stat label="更新" value={job.update_rows} />
        <Stat label="変更なし" value={job.skip_rows} />
        <Stat label="警告" value={job.warning_rows} tone={job.warning_rows > 0 ? "warning" : undefined} />
      </div>
      {job.blank_rows > 0 ? <p className="mt-2 text-xs text-muted">空行 {job.blank_rows} 行は読み飛ばしました。</p> : null}
      {job.encoding_mismatch && job.detected_encoding ? (
        <div className="mt-4">
          <Notice tone="warning">
            指定した文字コード（{IMPORT_ENCODING_LABELS[job.encoding]}）とファイルの文字コード（{IMPORT_ENCODING_LABELS[job.detected_encoding]}）が異なりますが、内容は読み取れました。
          </Notice>
        </div>
      ) : null}

      <div className="mt-6">
        <SimpleTable caption="旧システム項目とARMS項目の対応" head={["旧システム項目", "ARMS項目", "空欄の場合", "空欄", "状態"]}>
          {job.columns.map((c) => (
            <tr key={c.field}>
              <td className={td}>{c.source_header ?? <span className="text-muted">（対応なし）</span>}</td>
              <td className={td}>
                {c.label_ja}
                {c.required ? <span className="ml-1 text-danger">*</span> : null}
              </td>
              <td className={`${td} text-xs text-muted`}>{c.empty_meaning_ja}</td>
              <td className={`${td} tabular-nums`}>{c.empty_count === null ? "—" : `${c.empty_count}件`}</td>
              <td className={td}>
                {c.source_header === null ? (
                  <Badge tone="neutral">未対応</Badge>
                ) : c.error_count ? (
                  <Badge tone="warning">要確認 {c.error_count}件</Badge>
                ) : (
                  <Badge tone="success">対応済み</Badge>
                )}
              </td>
            </tr>
          ))}
        </SimpleTable>
      </div>

      {job.error_rows > 0 ? (
        <section aria-labelledby="import-errors" className="mt-6">
          <div className="mb-3">
            <Notice tone="warning">
              {errorRows.slice(0, 5).map((r) => `${r}行目`).join("・")}
              {job.error_rows > 5 ? ` ほか（計${job.error_rows}行）` : ""}
              にエラーがあります。元データを修正して再アップロードするか、項目の対応を修正してから移行を確定してください。
            </Notice>
          </div>
          <h3 id="import-errors" className="mb-2 text-sm font-bold">
            エラーの内容
          </h3>
          <SimpleTable caption="行ごとのエラー" head={["行", "項目", "列（見出し）", "内容"]}>
            {errors.map((e, i) => (
              <tr key={`${e.row}-${i}`}>
                <td className={`${td} tabular-nums`}>{e.row}行目</td>
                <td className={td}>{e.label_ja}</td>
                <td className={td}>{e.header ?? "—"}</td>
                <td className={`${td} text-danger`}>{e.message_ja}</td>
              </tr>
            ))}
          </SimpleTable>
          {onMoreErrors ? (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" size="sm" loading={loadingMoreErrors} onClick={onMoreErrors}>
                エラーをさらに表示
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      <ItemsTable job={job} initialFilter={job.error_rows > 0 ? "error" : "all"} />

      <div className="mt-6 flex flex-wrap items-start justify-end gap-2">
        <ErrorReportButton jobId={job.id} />
        <Button variant="secondary" icon={<Pencil className="size-4" aria-hidden />} onClick={onEditMapping}>
          項目の対応を修正
        </Button>
        <Button icon={<ArrowRight className="size-4" aria-hidden />} disabled={job.error_rows > 0} onClick={onProceed}>
          移行確定へ進む
        </Button>
      </div>
      {job.error_rows > 0 ? <p className="mt-2 text-right text-xs text-muted">エラーが0件になると確定できます。</p> : null}
    </Card>
  );
}
