import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError, api, buildQuery, onAuthLost, setCsrfToken } from "../src/lib/api";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe("api client", () => {
  it("sends CSRF, Idempotency-Key and If-Match headers on mutations", async () => {
    const fetchMock = mockFetch(200, { success: true });
    setCsrfToken("csrf-123");
    await api.post("/reservations", { slot_id: "x" }, { idempotencyKey: "11111111-1111-4111-8111-111111111111" });
    await api.patch("/teachers/1", { a: 1 }, { ifMatch: 3 });
    const [, postInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const postHeaders = postInit.headers as Record<string, string>;
    expect(postHeaders["X-CSRF-Token"]).toBe("csrf-123");
    expect(postHeaders["Idempotency-Key"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(postInit.credentials).toBe("same-origin");
    const [, patchInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((patchInit.headers as Record<string, string>)["If-Match"]).toBe('"3"');
  });

  it("does not send the CSRF token on GET", async () => {
    const fetchMock = mockFetch(200, { items: [] });
    setCsrfToken("csrf-123");
    await api.get("/teachers", { query: { q: "田中", status: undefined, ids: ["a", "b"] } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/teachers?q=%E7%94%B0%E4%B8%AD&ids=a%2Cb");
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });

  it("raises ApiError with the Japanese message, request id and field errors", async () => {
    mockFetch(422, { code: "VALIDATION_FAILED", message_ja: "入力内容を確認してください。", request_id: "req-1", field_errors: { email: "必須項目です。" } });
    const err = (await api.post("/teachers", {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.messageJa).toBe("入力内容を確認してください。");
    expect(err.requestId).toBe("req-1");
    expect(err.fieldErrors.email).toBe("必須項目です。");
  });

  it("notifies listeners when the session is lost", async () => {
    mockFetch(401, { code: "SESSION_EXPIRED", message_ja: "セッションの有効期限が切れました。", request_id: "r" });
    const listener = vi.fn();
    const off = onAuthLost(listener);
    await api.get("/me").catch(() => undefined);
    off();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("maps fetch failures to NetworkError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(api.get("/me")).rejects.toBeInstanceOf(NetworkError);
  });

  it("builds query strings without empty values", () => {
    expect(buildQuery({ a: "", b: null, c: 0, d: false })).toBe("?c=0&d=false");
  });
});
