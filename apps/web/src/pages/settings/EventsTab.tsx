import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { OUTBOX_STATE_LABELS } from "@arms/contracts";
import { Card } from "../../components/ui/Card";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { DataTable, type ColumnDef } from "../../components/ui/DataTable";
import { Drawer } from "../../components/ui/Drawer";
import { InlineError, LastFetched, Notice } from "../../components/ui/Feedback";
import { Input, Select } from "../../components/ui/Field";
import { FilterBar, FilterItem } from "../../components/ui/FilterBar";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { adminKeys } from "../../features/admin/keys";
import { useCursorList, useUrlFilters } from "../../features/admin/hooks";
import { ListCount, SearchField } from "../../features/admin/components";
import { DELIVERY_STATE_TONES, EVENT_CATEGORIES, deliveryErrorLabel, eventLabel, eventResult, eventTarget } from "../../features/admin/labels";
import type { ActionResult, AuditEvent, Delivery } from "../../features/admin/types";

const FILTER_KEYS = ["q", "type", "from", "to", "delivery"] as const;

/** WEB-19 ログ・イベント: 監査ログ（種別・期間・キーワード、詳細は秘密情報を除去済み）と通知配信の失敗・再送。 */
export function EventsTab() {
  const [filters, setFilters] = useUrlFilters(FILTER_KEYS);
  const query = { q: filters.q, event_type: filters.type, from: filters.from, to: filters.to };
  const list = useCursorList<AuditEvent>(adminKeys.events(query), "/events", query, { limit: 50 });
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const rangeError = filters.from && filters.to && filters.from > filters.to ? "終了日は開始日以降にしてください。" : null;

  const columns = useMemo<ColumnDef<AuditEvent, unknown>[]>(
    () => [
      { id: "at", header: "日時", cell: ({ row }) => <span className="text-xs whitespace-nowrap tabular-nums">{fmt.dateTime(row.original.created_at)}</span> },
      { id: "actor", header: "操作者", cell: ({ row }) => row.original.actor_name },
      {
        id: "event",
        header: "イベント",
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span>{eventLabel(row.original.event_type)}</span>
            <span className="text-[11px] text-muted">{row.original.event_type}</span>
          </span>
        ),
      },
      { id: "target", header: "対象", cell: ({ row }) => eventTarget(row.original.details, row.original.entity_id, row.original.actor_id) },
      {
        id: "result",
        header: "結果",
        cell: ({ row }) => {
          const r = eventResult(row.original.event_type);
          return <Badge tone={r.tone}>{r.label}</Badge>;
        },
      },
      {
        id: "detail",
        header: "詳細",
        cell: ({ row }) => (
          <Button size="sm" variant="secondary" onClick={() => setSelected(row.original)} aria-label={`${fmt.dateTime(row.original.created_at)}の${eventLabel(row.original.event_type)}の詳細を見る`}>
            詳細を見る
          </Button>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <FilterBar label="ログの絞り込み">
          <FilterItem label="期間（開始日）">{(id) => <Input id={id} type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilters({ from: e.target.value })} />}</FilterItem>
          <FilterItem label="期間（終了日）">{(id) => <Input id={id} type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilters({ to: e.target.value })} aria-invalid={!!rangeError} />}</FilterItem>
          <FilterItem label="イベント">
            {(id) => (
              <Select id={id} value={filters.type} onChange={(e) => setFilters({ type: e.target.value })}>
                <option value="">すべて</option>
                {EVENT_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            )}
          </FilterItem>
          <SearchField label="キーワード" value={filters.q} onCommit={(q) => setFilters({ q })} placeholder="イベント種別・操作者名で検索" />
          {filters.from || filters.to || filters.type || filters.q ? (
            <Button variant="ghost" size="sm" className="self-end" onClick={() => setFilters({ from: "", to: "", type: "", q: "" })}>
              条件をクリア
            </Button>
          ) : null}
        </FilterBar>
        {rangeError ? (
          <p role="alert" className="-mt-3 mb-3 text-xs text-danger">
            {rangeError}
          </p>
        ) : null}
        <Card aria-labelledby="events-title">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 id="events-title" className="text-base font-bold">
              操作・処理履歴
            </h2>
            <div className="flex items-center gap-3">
              <ListCount count={list.items?.length} hasMore={list.hasMore} />
              <LastFetched checkedAt={list.checkedAt} />
            </div>
          </div>
          <DataTable
            caption="操作・処理履歴"
            columns={columns}
            data={list.items}
            getRowId={(e) => e.id}
            isLoading={list.isLoading}
            error={list.error}
            onRetry={list.refetch}
            hasMore={list.hasMore}
            loadingMore={list.loadingMore}
            onLoadMore={list.loadMore}
            empty={{ title: "条件に一致する記録はありません", description: "期間やイベントの種類を変更してください。" }}
          />
        </Card>
      </div>

      <Notice>音声全文・パスワード・APIキーなどの秘密情報はログに保存・表示しません。業務操作と処理結果を記録します。</Notice>

      <Deliveries state={filters.delivery} onStateChange={(v) => setFilters({ delivery: v })} />

      <Drawer open={!!selected} onOpenChange={(o) => !o && setSelected(null)} title={selected ? eventLabel(selected.event_type) : "イベントの詳細"} description="秘密情報（パスワード・トークン・会議URLなど）は除去して表示しています。">
        {selected ? <EventDetail event={selected} /> : null}
      </Drawer>
    </div>
  );
}

function EventDetail({ event }: { event: AuditEvent }) {
  const result = eventResult(event.event_type);
  const entries = Object.entries(event.details);
  return (
    <div className="flex flex-col gap-5 text-sm">
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2">
        <dt className="text-xs text-muted">日時</dt>
        <dd>{fmt.dateTime(event.created_at)}</dd>
        <dt className="text-xs text-muted">操作者</dt>
        <dd>{event.actor_name}</dd>
        <dt className="text-xs text-muted">イベント種別</dt>
        <dd className="break-all">{event.event_type}</dd>
        <dt className="text-xs text-muted">結果</dt>
        <dd>
          <Badge tone={result.tone}>{result.label}</Badge>
        </dd>
        <dt className="text-xs text-muted">対象ID</dt>
        <dd className="font-mono text-xs break-all">{event.entity_id ?? "—"}</dd>
      </dl>
      <section aria-labelledby="event-details-title">
        <h3 id="event-details-title" className="mb-2 text-xs font-bold">
          記録内容
        </h3>
        {entries.length === 0 ? (
          <p className="text-xs text-muted">追加の記録はありません。</p>
        ) : (
          <pre className="max-h-[50vh] overflow-auto rounded-[var(--radius-control)] border border-line bg-surface-2 p-3 text-xs leading-relaxed whitespace-pre-wrap break-all">
            {JSON.stringify(event.details, null, 2)}
          </pre>
        )}
      </section>
    </div>
  );
}

function Deliveries({ state, onStateChange }: { state: string; onStateChange(v: string): void }) {
  const online = useOnline();
  const toast = useToast();
  const qc = useQueryClient();
  const effective = state || "failed";
  const query = { state: effective === "all" ? undefined : effective };
  const list = useCursorList<Delivery>(adminKeys.deliveries(query), "/events/deliveries", query, { limit: 50 });
  const retry = useMutation({
    mutationFn: (d: Delivery) => api.post<ActionResult>(`/events/deliveries/${d.id}/retry`),
    onSuccess: (_res, d) => {
      toast.success("通知の再送を受け付けました", `${eventLabel(d.event_type)}の通知を送信待ちに戻しました。`);
      void qc.invalidateQueries({ queryKey: adminKeys.deliveriesAll });
      void qc.invalidateQueries({ queryKey: adminKeys.eventsAll });
    },
    onError: () => void qc.invalidateQueries({ queryKey: adminKeys.deliveriesAll }),
  });
  const columns = useMemo<ColumnDef<Delivery, unknown>[]>(
    () => [
      { id: "created", header: "発生日時", cell: ({ row }) => <span className="text-xs whitespace-nowrap tabular-nums">{fmt.dateTime(row.original.created_at)}</span> },
      { id: "event", header: "通知の種類", cell: ({ row }) => eventLabel(row.original.event_type) },
      { id: "state", header: "状態", cell: ({ row }) => <Badge tone={DELIVERY_STATE_TONES[row.original.state]}>{OUTBOX_STATE_LABELS[row.original.state]}</Badge> },
      { id: "attempts", header: "試行回数", cell: ({ row }) => <span className="tabular-nums">{row.original.attempts}回</span> },
      { id: "error", header: "エラー", cell: ({ row }) => deliveryErrorLabel(row.original.last_error_code) },
      {
        id: "next",
        header: "次回・完了",
        cell: ({ row }) => (
          <span className="text-xs tabular-nums">
            {row.original.delivered_at ? `送信 ${fmt.dateTime(row.original.delivered_at)}` : row.original.state === "failed" ? "—" : fmt.dateTime(row.original.next_attempt_at)}
          </span>
        ),
      },
      {
        id: "actions",
        header: "操作",
        cell: ({ row }) =>
          row.original.state === "failed" ? (
            <Button size="sm" variant="secondary" disabled={!online} loading={retry.isPending && retry.variables?.id === row.original.id} onClick={() => retry.mutate(row.original)} aria-label={`${eventLabel(row.original.event_type)}の通知を再送`}>
              再送
            </Button>
          ) : (
            <span className="text-xs text-muted">—</span>
          ),
      },
    ],
    [online, retry],
  );
  return (
    <Card aria-labelledby="deliveries-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="deliveries-title" className="text-base font-bold">
            通知配信
          </h2>
          <p className="mt-1 text-xs text-muted">メール・Push通知の配信状況です。送信失敗の通知は確認のうえ再送できます。</p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <FilterItem label="配信状態">
            {(id) => (
              <Select id={id} value={effective} onChange={(e) => onStateChange(e.target.value === "failed" ? "" : e.target.value)}>
                <option value="failed">送信失敗</option>
                <option value="pending">送信待ち</option>
                <option value="processing">送信中</option>
                <option value="delivered">送信済み</option>
                <option value="all">すべて</option>
              </Select>
            )}
          </FilterItem>
          <LastFetched checkedAt={list.checkedAt} className="pb-3" />
        </div>
      </div>
      <DataTable
        caption="通知配信"
        columns={columns}
        data={list.items}
        getRowId={(d) => d.id}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={list.refetch}
        hasMore={list.hasMore}
        loadingMore={list.loadingMore}
        onLoadMore={list.loadMore}
        empty={{ title: effective === "failed" ? "送信に失敗した通知はありません" : "該当する通知はありません" }}
      />
      {retry.error ? (
        <div className="mt-3">
          <InlineError error={retry.error} />
        </div>
      ) : null}
    </Card>
  );
}
