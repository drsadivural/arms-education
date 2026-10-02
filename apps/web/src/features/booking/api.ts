/**
 * Booking data layer (WEB-13〜15): query keys, fetchers and polling policy.
 *
 * 予約可視化5秒以内 (docs/01): reservation and slot queries refetch every 5 s while the tab is visible
 * (TanStack pauses intervals for hidden documents) and always refetch when the window regains focus.
 */
import { useInfiniteQuery, useQuery, type QueryClient } from "@tanstack/react-query";
import type { Classroom, LessonSlot, Page, Reservation, Teacher, Unit, components } from "@arms/contracts";
import { api, type QueryValue } from "../../lib/api";

export type AttendanceRoster = components["schemas"]["AttendanceRoster"];
export type AttendanceRosterItem = components["schemas"]["AttendanceRosterItem"];
export type ReservationHistoryItem = NonNullable<Reservation["history"]>[number];
export type ReservationStatus = Reservation["status"];
export type SlotState = LessonSlot["state"];

export interface DataEnvelope<T> {
  data: T;
  checked_at: string;
}

export const POLL_INTERVAL_MS = 5_000;

/** Polling options for data whose changes must be visible within 5 seconds. */
export const livePolling = {
  refetchInterval: POLL_INTERVAL_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: "always",
} as const;

export const bookingKeys = {
  all: ["booking"] as const,
  reservationLists: () => ["booking", "reservations"] as const,
  reservations: (query: Record<string, QueryValue>) => ["booking", "reservations", query] as const,
  pendingCount: () => ["booking", "pending-count"] as const,
  reservation: (id: string) => ["booking", "reservation", id] as const,
  slotLists: () => ["booking", "slots"] as const,
  slots: (query: Record<string, QueryValue>) => ["booking", "slots", query] as const,
  week: (monday: string, teacherId: string | undefined) => ["booking", "week", monday, teacherId ?? ""] as const,
  slot: (id: string) => ["booking", "slot", id] as const,
  attendance: (slotId: string) => ["booking", "attendance", slotId] as const,
  classrooms: () => ["booking", "options", "classrooms"] as const,
  classroom: (id: string) => ["booking", "options", "classroom", id] as const,
  classroomTeachers: (id: string) => ["booking", "options", "classroom-teachers", id] as const,
  teachers: () => ["booking", "options", "teachers"] as const,
  units: (versionIds: readonly string[]) => ["booking", "options", "units", ...versionIds] as const,
  settings: () => ["booking", "options", "settings"] as const,
};

/** Refreshes every booking view (lists, counts, remaining seats) after a confirmed change. */
export function invalidateBooking(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: bookingKeys.all, predicate: (q) => q.queryKey[1] !== "options" });
}

const PAGE_SIZE = 30;

/** Cursor-paged reservation list (GET /reservations) with live polling. */
export function useReservationList(query: Record<string, QueryValue>) {
  return useInfiniteQuery({
    queryKey: bookingKeys.reservations(query),
    queryFn: ({ pageParam, signal }) => api.get<Page<Reservation>>("/reservations", { query: { ...query, cursor: pageParam, limit: PAGE_SIZE }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    ...livePolling,
  });
}

/** Number of 承認待ち reservations in the caller's scope (badge on the 予約申請 tab). */
export function usePendingCount() {
  return useQuery({
    queryKey: bookingKeys.pendingCount(),
    queryFn: ({ signal }) => api.get<Page<Reservation>>("/reservations", { query: { status: "pending", limit: 100 }, signal }),
    select: (p) => ({ count: p.items.length, more: p.next_cursor !== null }),
    ...livePolling,
  });
}

export function useReservation(id: string) {
  return useQuery({
    queryKey: bookingKeys.reservation(id),
    queryFn: ({ signal }) => api.get<Reservation>(`/reservations/${encodeURIComponent(id)}`, { signal }),
    ...livePolling,
  });
}

/** Cursor-paged slot list (GET /lesson-slots) with live polling (remaining seats). */
export function useSlotList(query: Record<string, QueryValue>) {
  return useInfiniteQuery({
    queryKey: bookingKeys.slots(query),
    queryFn: ({ pageParam, signal }) => api.get<Page<LessonSlot>>("/lesson-slots", { query: { ...query, cursor: pageParam, limit: PAGE_SIZE }, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    ...livePolling,
  });
}

const WEEK_MAX_PAGES = 10;

/** Every slot of one week (all states), following cursors so the calendar is complete. */
export function useWeekSlots(monday: string, sunday: string, teacherId: string | undefined) {
  return useQuery({
    queryKey: bookingKeys.week(monday, teacherId),
    queryFn: async ({ signal }) => {
      const items: LessonSlot[] = [];
      let cursor: string | undefined;
      let checkedAt = "";
      let truncated = false;
      for (let i = 0; i < WEEK_MAX_PAGES; i++) {
        const page = await api.get<Page<LessonSlot>>("/lesson-slots", {
          query: { from: monday, to: sunday, status: "open,closed,cancelled", teacher_id: teacherId, cursor, limit: 100 },
          signal,
        });
        items.push(...page.items);
        if (!checkedAt) checkedAt = page.checked_at;
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
        if (i === WEEK_MAX_PAGES - 1) truncated = true;
      }
      return { items, checked_at: checkedAt, truncated };
    },
    ...livePolling,
  });
}

export function useSlot(id: string | undefined) {
  return useQuery({
    queryKey: bookingKeys.slot(id ?? ""),
    queryFn: ({ signal }) => api.get<DataEnvelope<LessonSlot>>(`/lesson-slots/${encodeURIComponent(id ?? "")}`, { signal }),
    enabled: !!id,
    // Polling would fight with the edit form; refresh on focus only (the form re-syncs explicitly on conflicts).
    refetchOnWindowFocus: "always",
  });
}

export function useAttendance(slotId: string, enabled: boolean) {
  return useQuery({
    queryKey: bookingKeys.attendance(slotId),
    queryFn: ({ signal }) => api.get<DataEnvelope<AttendanceRoster>>(`/lesson-slots/${encodeURIComponent(slotId)}/attendance`, { signal }),
    enabled,
    refetchOnWindowFocus: "always",
  });
}

// ---- options for filters and forms ---------------------------------------------------------

export function useClassroomOptions(enabled = true) {
  return useQuery({
    queryKey: bookingKeys.classrooms(),
    queryFn: ({ signal }) => api.get<Page<Classroom>>("/classrooms", { query: { status: "active", limit: 100 }, signal }),
    enabled,
    staleTime: 60_000,
  });
}

export function useClassroom(id: string) {
  return useQuery({
    queryKey: bookingKeys.classroom(id),
    queryFn: ({ signal }) => api.get<DataEnvelope<Classroom>>(`/classrooms/${encodeURIComponent(id)}`, { signal }),
    enabled: !!id,
    staleTime: 60_000,
  });
}

/** Active teachers assigned to the classroom (GET /classrooms/{id}/teachers, primary first). */
export function useClassroomTeachers(classroomId: string) {
  return useQuery({
    queryKey: bookingKeys.classroomTeachers(classroomId),
    queryFn: ({ signal }) => api.get<Page<Teacher>>(`/classrooms/${encodeURIComponent(classroomId)}/teachers`, { signal }),
    enabled: !!classroomId,
    staleTime: 60_000,
  });
}

export function useTeacherOptions(enabled: boolean) {
  return useQuery({
    queryKey: bookingKeys.teachers(),
    queryFn: ({ signal }) => api.get<Page<Teacher>>("/teachers", { query: { status: "active", limit: 100 }, signal }),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Units of the classroom's programme versions (GET /program-versions/{id}/units). The learning area may not be
 * deployed yet: callers treat an error as "unit selection unavailable" instead of blocking the form.
 */
export function useUnitOptions(versions: readonly { id: string; name: string; version_number: number }[]) {
  const ids = versions.map((v) => v.id);
  return useQuery({
    queryKey: bookingKeys.units(ids),
    queryFn: async ({ signal }) => {
      const out: { unit: Unit; label: string }[] = [];
      for (const v of versions) {
        const page = await api.get<Page<Unit>>(`/program-versions/${encodeURIComponent(v.id)}/units`, { query: { limit: 100 }, signal });
        for (const u of [...page.items].sort((a, b) => a.position - b.position)) out.push({ unit: u, label: `${v.name} v${v.version_number} / ${u.title}` });
      }
      return out;
    },
    enabled: ids.length > 0,
    staleTime: 60_000,
    retry: false,
  });
}

export function useOrgSettings(enabled: boolean) {
  return useQuery({
    queryKey: bookingKeys.settings(),
    queryFn: ({ signal }) => api.get<DataEnvelope<components["schemas"]["Settings"]>>("/settings", { signal }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}
