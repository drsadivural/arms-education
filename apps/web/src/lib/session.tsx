import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SessionInfo } from "@arms/contracts";
import { ApiError, api, onAuthLost, setCsrfToken } from "./api";

type Role = "admin" | "teacher" | "student";

export type SessionState =
  | { status: "loading" }
  | { status: "anonymous"; reason?: string }
  | { status: "mfa"; session: SessionInfo }
  | { status: "authenticated"; session: SessionInfo };

interface SessionContextValue {
  state: SessionState;
  login(input: { email: string; password: string; selected_role: Role; organization_id?: string }): Promise<SessionInfo>;
  enrollMfa(): Promise<{ factor_id: string; qr_code: string; uri: string }>;
  verifyMfa(code: string): Promise<void>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionResponse {
  data: SessionInfo;
  checked_at: string;
}

function stateFor(info: SessionInfo): SessionState {
  return info.mfa_required ? { status: "mfa", session: info } : { status: "authenticated", session: info };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const queryClient = useQueryClient();

  const apply = useCallback((info: SessionInfo | null, reason?: string) => {
    setCsrfToken(info?.csrf_token ?? null);
    setState(info ? stateFor(info) : { status: "anonymous", reason });
    if (!info) queryClient.clear();
  }, [queryClient]);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<SessionResponse>("/auth/session");
      apply(res.data);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) apply(null, e.status === 403 ? e.messageJa : undefined);
      else throw e;
    }
  }, [apply]);

  useEffect(() => {
    refresh().catch(() => setState({ status: "anonymous", reason: "サーバーに接続できません。時間をおいて再読み込みしてください。" }));
  }, [refresh]);

  useEffect(
    () =>
      onAuthLost((e) => {
        setCsrfToken(null);
        setState((prev) => (prev.status === "anonymous" ? prev : { status: "anonymous", reason: e.messageJa }));
        queryClient.clear();
      }),
    [queryClient],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      async login(input) {
        const res = await api.post<SessionResponse>("/auth/login", input);
        apply(res.data);
        return res.data;
      },
      async enrollMfa() {
        const res = await api.post<{ data: { factor_id: string; qr_code: string; uri: string } }>("/auth/mfa/enroll");
        return res.data;
      },
      async verifyMfa(code) {
        const res = await api.post<SessionResponse>("/auth/mfa/verify", { code });
        apply(res.data);
      },
      async logout() {
        try {
          await api.post("/auth/logout");
        } finally {
          apply(null);
        }
      },
      refresh,
    }),
    [state, apply, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}

/** The signed-in user (only valid inside authenticated routes). */
export function useCurrentUser() {
  const { state } = useSession();
  if (state.status !== "authenticated") throw new Error("useCurrentUser requires an authenticated session");
  const { user, organization_name } = state.session;
  return { ...user, organizationName: organization_name, isAdmin: user.role === "admin", isTeacher: user.role === "teacher" };
}
