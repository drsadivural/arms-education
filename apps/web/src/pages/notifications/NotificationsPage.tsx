/**
 * お知らせ (/notifications): the signed-in user's in-app notifications, 未読/すべて filter in the URL, cursor paging,
 * mark-as-read on open, 「すべて既読にする」, deep links mapped to Web routes. Invalidates the top-bar unread badge
 * (query key ["notifications", "unread-count"]) after every read change.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import type { ActionResult, Notification, Page } from "@arms/contracts";
import { api, errorMessage } from "../../lib/api";
import { fmt } from "../../lib/format";
import { useOnline } from "../../lib/online";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { EmptyState, ErrorState, LastFetched, LoadingRows } from "../../components/ui/Feedback";
import { PageHeader } from "../../components/ui/PageHeader";
import { SegmentedRadioGroup } from "../../components/ui/RadioGroup";
import { useToast } from "../../components/ui/Toast";
import { cn } from "../../components/ui/cn";
import { webRouteForDeepLink } from "./deepLinks";

type Filter = "all" | "unread";

const UNREAD_COUNT_KEY = ["notifications", "unread-count"] as const;

function useNotifications(filter: Filter) {
  return useInfiniteQuery({
    queryKey: ["notifications", "list", filter],
    queryFn: ({ pageParam, signal }) => api.get<Page<Notification>>("/notifications", { query: { status: filter, cursor: pageParam, limit: 30 }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: 30_000,
    refetchOnWindowFocus: "always",
  });
}

/** Same query as the top-bar badge (shared cache entry). */
function useUnreadCount() {
  return useQuery({
    queryKey: UNREAD_COUNT_KEY,
    queryFn: () => api.get<Page<Notification>>("/notifications", { query: { status: "unread", limit: 100 } }),
    select: (p) => p.items.length,
  });
}

export function NotificationsPage() {
  const [sp, setSp] = useSearchParams();
  const filter: Filter = sp.get("status") === "unread" ? "unread" : "all";
  const qc = useQueryClient();
  const toast = useToast();
  const online = useOnline();
  const list = useNotifications(filter);
  const unread = useUnreadCount();
  const refresh = () => qc.invalidateQueries({ queryKey: ["notifications"] });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post<ActionResult>(`/notifications/${encodeURIComponent(id)}/read`),
    onError: (e) => toast.error("既読にできませんでした", errorMessage(e)),
    onSettled: refresh,
  });
  const readAll = useMutation({
    mutationFn: () => api.post<ActionResult>("/notifications/read-all"),
    onSuccess: (res) => {
      const n = typeof res.data?.updated === "number" ? res.data.updated : null;
      toast.success("すべて既読にしました", n !== null ? `${n}件のお知らせを既読にしました。` : undefined);
    },
    onError: (e) => toast.error("既読にできませんでした", errorMessage(e)),
    onSettled: refresh,
  });

  const items = list.data?.pages.flatMap((p) => p.items);
  const unreadCount = unread.data ?? 0;

  return (
    <>
      <PageHeader
        title="お知らせ"
        crumbs={[{ label: "お知らせ" }]}
        description="予約の申請・承認・取消などのお知らせです。開くと既読になります。"
        actions={
          <Button
            variant="secondary"
            icon={<CheckCheck className="size-4" aria-hidden />}
            loading={readAll.isPending}
            disabled={!online || unreadCount === 0}
            onClick={() => readAll.mutate()}
          >
            すべて既読にする
          </Button>
        }
      />
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <SegmentedRadioGroup<Filter>
          name="notification-filter"
          legend="表示するお知らせ"
          legendHidden
          options={[
            { value: "all", label: "すべて" },
            { value: "unread", label: `未読（${unreadCount}${unread.data === 100 ? "+" : ""}）` },
          ]}
          value={filter}
          onChange={(v) => setSp(v === "unread" ? { status: "unread" } : {}, { replace: true })}
        />
      </div>
      <Card className="p-0">
        <div className="px-5 pt-5">
          <CardHeader title={filter === "unread" ? "未読のお知らせ" : "すべてのお知らせ"} actions={<LastFetched checkedAt={list.data?.pages[0]?.checked_at} />} />
        </div>
        {list.isLoading && !items ? (
          <div className="px-5 pb-5">
            <LoadingRows rows={4} label="お知らせを読み込み中です" />
          </div>
        ) : !items ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          filter === "unread" ? (
            <EmptyState
              title="未読のお知らせはありません"
              description="すべてのお知らせを確認済みです。"
              action={
                <button type="button" className="text-sm text-primary underline-offset-2 hover:underline" onClick={() => setSp({}, { replace: true })}>
                  すべてのお知らせを表示
                </button>
              }
            />
          ) : (
            <EmptyState title="お知らせはまだありません" description="予約申請の受付や承認・取消があると、ここに表示されます。" />
          )
        ) : (
          <>
            {list.error ? <ErrorState compact error={list.error} onRetry={() => void list.refetch()} /> : null}
            <ul className="divide-y divide-line border-t border-line" aria-label="お知らせ一覧">
              {items.map((n) => {
                const isUnread = n.read_at === null;
                const link = webRouteForDeepLink(n.deep_link);
                return (
                  <li key={n.id} className={cn("flex gap-3 px-5 py-4", isUnread && "bg-primary-soft/40")}>
                    <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", isUnread ? "bg-brand" : "bg-transparent")} />
                    <article className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <h2 className="flex flex-wrap items-center gap-2 text-sm font-bold">
                          {isUnread ? <Badge tone="info">未読</Badge> : null}
                          <span className="break-words">{n.title}</span>
                        </h2>
                        <time dateTime={n.created_at} className="text-[11px] text-muted">
                          {fmt.dateTime(n.created_at)}
                        </time>
                      </div>
                      <p className="mt-1 text-xs break-words whitespace-pre-wrap">{n.body}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                        {link ? (
                          <Link
                            to={link.to}
                            className="font-medium text-primary underline-offset-2 hover:underline"
                            onClick={() => {
                              if (isUnread && online) markRead.mutate(n.id);
                            }}
                          >
                            {link.label} →<span className="sr-only">（{n.title}）</span>
                          </Link>
                        ) : null}
                        {isUnread ? (
                          <button
                            type="button"
                            className="text-primary underline-offset-2 hover:underline disabled:opacity-50"
                            disabled={!online || (markRead.isPending && markRead.variables === n.id)}
                            onClick={() => markRead.mutate(n.id)}
                          >
                            既読にする<span className="sr-only">（{n.title}）</span>
                          </button>
                        ) : (
                          <span className="text-muted">既読 {n.read_at ? fmt.dateTime(n.read_at) : ""}</span>
                        )}
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
            {list.hasNextPage ? (
              <div className="flex justify-center border-t border-line p-4">
                <Button variant="secondary" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  さらに読み込む
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
