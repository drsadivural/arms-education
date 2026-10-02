import { useInfiniteQuery, type QueryKey } from "@tanstack/react-query";
import type { Page } from "@arms/contracts";
import { api, type QueryValue } from "../../lib/api";

/**
 * Cursor-paginated list (keyset pagination of the API): first page on load, 「さらに読み込む」 appends the next
 * page. `checkedAt` is the first page's checked_at (最終取得).
 */
export function useCursorList<T>(queryKey: QueryKey, path: string, query: Record<string, QueryValue>, opts: { limit?: number; enabled?: boolean; refetchInterval?: number | false } = {}) {
  const q = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => api.get<Page<T>>(path, { query: { ...query, limit: opts.limit ?? 50, cursor: pageParam }, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: opts.enabled,
    refetchInterval: opts.refetchInterval,
  });
  const items = q.data?.pages.flatMap((p) => p.items);
  return {
    items,
    checkedAt: q.data?.pages[0]?.checked_at ?? null,
    hasMore: !!q.hasNextPage,
    loadMore: () => void q.fetchNextPage(),
    loadingMore: q.isFetchingNextPage,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: () => void q.refetch(),
  };
}
