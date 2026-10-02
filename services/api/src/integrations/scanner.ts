/**
 * Malware scanning service for uploaded files (owned by the learning module).
 *
 * Generic HTTP protocol (MALWARE_SCAN_URL, MALWARE_SCAN_API_KEY — `Authorization: Bearer <key>`):
 *   POST {url}/scans        {"upload_id","download_url","callback_url"?, "sha256"?}
 *        → 200/201/202 {"scan_id": "...", "status": "clean"|"infected"|"malicious"|"blocked"|"pending"|"queued"|"scanning"}
 *   GET  {url}/scans/{scan_id} → {"scan_id": "...", "status": ...}
 *   Callback (optional, asynchronous): POST callback_url with body {"scan_id","status",...} and headers
 *     X-ARMS-Scan-Timestamp: <unix seconds>
 *     X-ARMS-Scan-Signature: v1=<hex HMAC-SHA256(MALWARE_SCAN_API_KEY, timestamp + "." + raw body)>
 * The scanner fetches the file through a short-lived presigned GET of the quarantined object; the API never
 * marks a file clean without a verdict from the scanner. Unknown/error statuses are treated as still pending.
 */
import type { Bindings, Config } from "../env";
import { ApiError } from "../http/errors";

export type ScanVerdict = "clean" | "blocked" | "pending";

export interface ScanSubmission {
  uploadId: string;
  objectKey: string;
  /** Short-lived presigned GET of the quarantined object. */
  downloadUrl: string;
  /** Where the scanner may POST an asynchronous verdict (HMAC-signed). */
  callbackUrl?: string;
  sha256?: string;
}

export interface MalwareScanner {
  /** Submits the object for scanning. Returns the verdict when available synchronously, otherwise "pending". */
  submit(input: ScanSubmission): Promise<{ verdict: ScanVerdict; scanId: string | null }>;
  /** Current verdict of a previously submitted scan (polling fallback when callbacks cannot reach the API). */
  status(scanId: string): Promise<ScanVerdict>;
  /** Verifies the HMAC signature and timestamp of an asynchronous callback (see verifyScanCallback). */
  verifyCallback(input: { timestamp: string | null | undefined; signature: string | null | undefined; rawBody: string; now: Date }): Promise<boolean>;
}

const CLEAN = new Set(["clean", "ok", "passed", "no_threat", "not_infected"]);
const BLOCKED = new Set(["infected", "malicious", "blocked", "suspicious", "threat", "quarantined", "rejected"]);

/** Maps a provider status string onto our verdicts. Anything unknown (incl. "error") stays pending. */
export function mapScanStatus(status: unknown): ScanVerdict {
  const s = typeof status === "string" ? status.trim().toLowerCase() : "";
  if (CLEAN.has(s)) return "clean";
  if (BLOCKED.has(s)) return "blocked";
  return "pending";
}

export interface HttpScannerOptions {
  url: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createHttpScanner(opts: HttpScannerOptions): MalwareScanner {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function request(path: string, init: { method: string; body?: unknown }): Promise<Record<string, unknown>> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          Accept: "application/json",
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: ac.signal,
      });
    } catch (e) {
      throw new ApiError("SCANNER_UNAVAILABLE", { cause: e });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw new ApiError("SCANNER_UNAVAILABLE", { details: { scanner_status: res.status } });
    try {
      const parsed = text ? (JSON.parse(text) as unknown) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new ApiError("SCANNER_UNAVAILABLE", { details: { scanner_status: res.status } });
  }

  return {
    async submit(input) {
      const body = await request("/scans", {
        method: "POST",
        body: {
          upload_id: input.uploadId,
          download_url: input.downloadUrl,
          ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
          ...(input.sha256 ? { sha256: input.sha256 } : {}),
        },
      });
      const scanId = typeof body.scan_id === "string" && body.scan_id.length > 0 && body.scan_id.length <= 200 ? body.scan_id : null;
      const verdict = mapScanStatus(body.status);
      // A pending scan without an id could never be resolved — treat it as a scanner failure.
      if (verdict === "pending" && !scanId) throw new ApiError("SCANNER_UNAVAILABLE");
      return { verdict, scanId };
    },
    async status(scanId) {
      const body = await request(`/scans/${encodeURIComponent(scanId)}`, { method: "GET" });
      return mapScanStatus(body.status);
    },
    verifyCallback(input) {
      return verifyScanCallback({ apiKey: opts.apiKey, ...input });
    },
  };
}

export function createMalwareScanner(env: Bindings, _config: Config): MalwareScanner | null {
  if (!env.MALWARE_SCAN_URL || !env.MALWARE_SCAN_API_KEY) return null;
  return createHttpScanner({ url: env.MALWARE_SCAN_URL, apiKey: env.MALWARE_SCAN_API_KEY });
}

// ---- asynchronous callback verification --------------------------------------------------------

const enc = new TextEncoder();
export const SCAN_CALLBACK_TOLERANCE_SECONDS = 300;

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison (length differences do not short-circuit). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Signature header value for a callback body (used by the scanner side and by tests). */
export async function signScanCallback(apiKey: string, timestamp: string, rawBody: string): Promise<string> {
  return `v1=${await hmacHex(apiKey, `${timestamp}.${rawBody}`)}`;
}

/**
 * Verifies an asynchronous scanner callback: HMAC-SHA256 over `${timestamp}.${rawBody}` with the scanner API key,
 * compared in constant time, and a timestamp within ±5 minutes of `now` (replay protection).
 */
export async function verifyScanCallback(input: {
  apiKey: string;
  timestamp: string | undefined | null;
  signature: string | undefined | null;
  rawBody: string;
  now: Date;
}): Promise<boolean> {
  const { apiKey, timestamp, signature, rawBody, now } = input;
  if (!apiKey || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SCAN_CALLBACK_TOLERANCE_SECONDS) return false;
  const expected = await signScanCallback(apiKey, timestamp, rawBody);
  // Accept several comma-separated signatures (key rotation); each is compared in constant time.
  let ok = false;
  for (const candidate of signature.split(",").map((s) => s.trim())) {
    if (constantTimeEqual(candidate, expected)) ok = true;
  }
  return ok;
}
