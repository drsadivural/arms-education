/** Test harness for the admin pages: providers + a data router + a fetch mock routed by "METHOD /path". */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { vi } from "vitest";
import { installJapaneseErrors } from "@arms/contracts";
import { SessionProvider, useSession } from "../src/lib/session";
import { ThemeProvider } from "../src/lib/theme";
import { ToastProvider } from "../src/components/ui/Toast";

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}
type Handler = (req: MockRequest) => { status?: number; body?: unknown } | undefined;

export const CHECKED_AT = "2026-10-02T03:00:00.000Z";

export function sessionBody(role: "admin" | "teacher") {
  return {
    data: {
      user: { id: role === "admin" ? "00000000-0000-4000-8000-0000000000a0" : "00000000-0000-4000-8000-0000000000b0", display_name: role === "admin" ? "山田 太郎" : "田中 祥司", email: `${role}@example.invalid`, role, active: true },
      csrf_token: "csrf",
      expires_at: "2026-10-03T00:00:00.000Z",
      organization_name: "H&A研修センター",
      mfa_required: false,
      mfa_enrolled: true,
    },
    checked_at: CHECKED_AT,
  };
}

/** Installs a fetch mock. Unknown routes answer 404 NOT_FOUND so missing stubs are visible. */
export function mockApi(role: "admin" | "teacher", routes: Record<string, Handler>) {
  const calls: MockRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const req: MockRequest = { method, path, query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers };
    calls.push(req);
    let res: { status?: number; body?: unknown } | undefined;
    if (method === "GET" && path === "/auth/session") res = { body: sessionBody(role) };
    else if (method === "GET" && path === "/notifications") res = { body: { items: [], next_cursor: null, checked_at: CHECKED_AT } };
    else res = routes[`${method} ${path}`]?.(req);
    if (!res) res = { status: 404, body: { code: "NOT_FOUND", message_ja: "対象が見つかりません。削除されたか、閲覧権限がありません。", request_id: "req-test" } };
    return new Response(JSON.stringify(res.body ?? {}), { status: res.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function Gate({ children }: { children: ReactNode }) {
  const { state } = useSession();
  return state.status === "authenticated" ? <>{children}</> : <p>セッション確認中</p>;
}

/**
 * react-router's data router builds a `Request` for every navigation with an AbortSignal from jsdom, which Node's
 * native Request (undici) rejects ("Expected signal to be an instance of AbortSignal"), so navigations silently fail
 * under jsdom. The test Request drops a foreign signal; nothing in these pages aborts navigations.
 */
function installJsdomSafeRequest() {
  const NativeRequest = globalThis.Request;
  class JsdomSafeRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (init?.signal) {
        const { signal: _signal, ...rest } = init;
        super(input, rest);
      } else super(input, init);
    }
  }
  vi.stubGlobal("Request", JsdomSafeRequest);
}

/** Renders `element` at `url` (route pattern `path`) inside the app providers. */
export function renderPage(element: ReactNode, { path, url }: { path: string; url: string }) {
  installJapaneseErrors();
  installJsdomSafeRequest();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter(
    [
      { path, element: <Gate>{element}</Gate> },
      { path: "*", element: <p>別の画面</p> },
    ],
    { initialEntries: [url] },
  );
  const utils = render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <ToastProvider>
          <SessionProvider>
            <RouterProvider router={router} />
          </SessionProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router };
}

export const page = <T,>(items: T[]) => ({ items, next_cursor: null, checked_at: CHECKED_AT });
