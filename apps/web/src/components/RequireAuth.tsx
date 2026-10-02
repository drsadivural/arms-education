import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useSession } from "../lib/session";
import { Skeleton } from "./ui/Feedback";

/** Gate for the authenticated app: loading skeleton, redirect to /login (keeping the target), MFA step. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const location = useLocation();
  if (state.status === "loading") {
    return (
      <div role="status" aria-live="polite" className="flex min-h-screen">
        <span className="sr-only">読み込み中です</span>
        <div className="hidden w-[248px] border-r border-line bg-surface p-5 lg:block">
          <Skeleton className="mb-8 h-10 w-40" />
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="mb-3 h-9 w-full" />
          ))}
        </div>
        <div className="flex-1 p-8">
          <Skeleton className="mb-6 h-8 w-64" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }
  if (state.status !== "authenticated") {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}

/** Hides admin-only screens from teachers (the API enforces the same rule). */
export function RequireRole({ roles, children }: { roles: ("admin" | "teacher")[]; children: ReactNode }) {
  const { state } = useSession();
  if (state.status !== "authenticated") return null;
  if (!roles.includes(state.session.user.role as "admin" | "teacher")) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}
