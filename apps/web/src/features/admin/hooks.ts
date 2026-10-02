/** Shared data hooks of the admin screens: URL-backed filters, cursor lists and option lists. */
import { useInfiniteQuery, useQuery, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, type QueryValue } from "../../lib/api";
import { useCurrentUser } from "../../lib/session";
import { adminKeys } from "./keys";
import type { Classroom, Page, SettingsResponse, Teacher } from "./types";

/**
 * Filters kept in the URL query string (shareable, survive reload and back/forward).
 * Empty values are removed; changing a filter replaces the history entry. Changes made in quick succession (before
 * the router has re-rendered) are merged on top of each other instead of starting from a stale query string.
 */
export function useUrlFilters<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams();
  const latest = useRef(params);
  useEffect(() => {
    latest.current = params;
  }, [params]);
  const values = useMemo(() => Object.fromEntries(keys.map((k) => [k, params.get(k) ?? ""])) as Record<K, string>, [keys, params]);
  const set = useCallback(
    (patch: Partial<Record<K, string>>) => {
      const next = new URLSearchParams(latest.current);
      for (const [k, v] of Object.entries(patch) as [K, string | undefined][]) {
        if (v === undefined || v === "") next.delete(k);
        else next.set(k, v);
      }
      latest.current = next;
      setParams(next, { replace: true });
    },
    [setParams],
  );
  return [values, set] as const;
}

/** Status filter convention: absent = the default (active) value; 「すべて」 is the explicit value `all`. */
export function statusQuery(value: string, fallback: string): string | undefined {
  if (value === "all") return undefined;
  return value || fallback;
}

/** Cursor-paginated list (100 per page by default) with 「さらに読み込む」. */
export function useCursorList<T>(key: QueryKey, path: string, query: Record<string, QueryValue>, options: { enabled?: boolean; limit?: number } = {}) {
  const q = useInfiniteQuery({
    queryKey: key,
    enabled: options.enabled ?? true,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.get<Page<T>>(path, { query: { ...query, limit: options.limit ?? 100, cursor: pageParam ?? undefined }, signal }),
    getNextPageParam: (last) => last.next_cursor,
  });
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items), [q.data]);
  const checkedAt = q.data?.pages.reduce<string | null>((max, p) => (!max || p.checked_at > max ? p.checked_at : max), null) ?? null;
  return {
    items,
    checkedAt,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
    refetch: () => void q.refetch(),
    hasMore: q.hasNextPage,
    loadingMore: q.isFetchingNextPage,
    loadMore: () => void q.fetchNextPage(),
  };
}

/** Fetches every page of a list (bounded) for select options. */
async function fetchAll<T>(path: string, query: Record<string, QueryValue>, signal?: AbortSignal, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page: Page<T> = await api.get<Page<T>>(path, { query: { ...query, limit: 100, cursor: cursor ?? undefined }, signal });
    out.push(...page.items);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  return out;
}

/** Classrooms for filters and selects (teachers get their own scope from the API). */
export function useClassroomOptions(status: "active" | "all" = "active") {
  return useQuery({
    queryKey: adminKeys.classroomOptions({ status }),
    queryFn: ({ signal }) => fetchAll<Classroom>("/classrooms", { status: status === "all" ? undefined : status }, signal),
    staleTime: 60_000,
  });
}

/** Teachers for filters and selects. */
export function useTeacherOptions(filters: { status?: "active"; classroom_id?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: adminKeys.teacherOptions({ status: filters.status, classroom_id: filters.classroom_id }),
    queryFn: ({ signal }) => fetchAll<Teacher>("/teachers", { status: filters.status, classroom_id: filters.classroom_id }, signal),
    staleTime: 60_000,
    enabled,
  });
}

/**
 * Navigates after a successful save once the form has re-rendered as clean, so the unsaved-changes guard (which
 * evaluates the dirty flag of the last render) does not block the redirect.
 */
export function useNavigateAfterSave() {
  const navigate = useNavigate();
  const [target, setTarget] = useState<{ to: string; state?: unknown } | null>(null);
  useEffect(() => {
    if (!target) return;
    setTarget(null);
    navigate(target.to, { replace: true, state: target.state });
  }, [target, navigate]);
  return useCallback((to: string, state?: unknown) => setTarget({ to, state }), []);
}

/** Organisation settings (admin only; GET /settings is refused for teachers). */
export function useSettings(enabled = true) {
  return useQuery({
    queryKey: adminKeys.settings,
    queryFn: ({ signal }) => api.get<SettingsResponse>("/settings", { signal }),
    enabled,
  });
}

/**
 * Department choices: the configured settings.departments for administrators. Teachers cannot read the settings,
 * and organisations without a configured list get free text input instead (`departments` is empty).
 */
export function useDepartments(): { departments: string[]; isLoading: boolean } {
  const user = useCurrentUser();
  const settings = useSettings(user.isAdmin);
  return { departments: settings.data?.data.departments ?? [], isLoading: user.isAdmin && settings.isLoading };
}
