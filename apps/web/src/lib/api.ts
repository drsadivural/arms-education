/**
 * Typed fetch wrapper for /api/v1 (same origin, HttpOnly session cookie).
 * - sends the in-memory CSRF token on state-changing requests (never stored in localStorage)
 * - sends Idempotency-Key for POST/PUT (callers reuse the same key when retrying the same action)
 * - sends If-Match for optimistic concurrency
 * - converts failures into ApiError (Japanese message_ja + request_id) or NetworkError (offline)
 */
import { ERROR_CATALOG, type ApiErrorBody } from "@arms/contracts";

export const API_BASE = "/api/v1";

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

type Listener = (error: ApiError) => void;
const authListeners = new Set<Listener>();
/** Notified when the server says the session is gone (401) so the app can return to the login screen. */
export function onAuthLost(listener: Listener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messageJa: string;
  readonly requestId: string | null;
  readonly fieldErrors: Record<string, string>;
  readonly details: Record<string, unknown>;

  constructor(status: number, body: Partial<ApiErrorBody>) {
    super(body.code ?? `HTTP_${status}`);
    this.status = status;
    this.code = body.code ?? "INTERNAL";
    this.messageJa = body.message_ja ?? ERROR_CATALOG.INTERNAL.message_ja;
    this.requestId = body.request_id ?? null;
    this.fieldErrors = body.field_errors ?? {};
    this.details = body.details ?? {};
  }
}

/** The request never reached the server (offline, DNS, CORS, timeout). The outcome of a mutation is unknown. */
export class NetworkError extends Error {
  readonly messageJa = "通信できませんでした。ネットワーク接続を確認してから再度お試しください。";
}

export type QueryValue = string | number | boolean | null | undefined | readonly string[];

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  idempotencyKey?: string;
  ifMatch?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length) params.set(k, v.join(","));
    } else params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function apiRequest<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (UNSAFE.has(method) && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  if (method === "POST" || method === "PUT") headers["Idempotency-Key"] = opts.idempotencyKey ?? crypto.randomUUID();
  if (opts.ifMatch !== undefined) headers["If-Match"] = `"${opts.ifMatch}"`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}${buildQuery(opts.query)}`, {
      method,
      headers,
      credentials: "same-origin",
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new NetworkError();
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const error = new ApiError(res.status, (parsed ?? {}) as Partial<ApiErrorBody>);
    if (res.status === 401) authListeners.forEach((l) => l(error));
    throw error;
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => apiRequest<T>("GET", path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>("POST", path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>("PUT", path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>("PATCH", path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => apiRequest<T>("DELETE", path, opts),
};

/** User-facing Japanese message for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.messageJa;
  if (error instanceof NetworkError) return error.messageJa;
  return ERROR_CATALOG.INTERNAL.message_ja;
}
