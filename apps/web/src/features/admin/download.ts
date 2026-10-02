/** File downloads from cookie-authenticated GET endpoints (CSV exports) with Japanese API errors. */
import type { ApiErrorBody } from "@arms/contracts";
import { API_BASE, ApiError, NetworkError, buildQuery, type QueryValue } from "../../lib/api";

/** "attachment; filename="arms-audit-20261002.csv"" → "arms-audit-20261002.csv". */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return fallback;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? fallback;
}

/**
 * Fetches the file first so failures (e.g. EXPORT_TOO_LARGE) can be shown in Japanese on the screen instead of a
 * broken download, then saves it under the server-provided name.
 */
export async function downloadFile(path: string, query: Record<string, QueryValue>, fallbackName: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}${buildQuery(query)}`, { credentials: "same-origin", headers: { Accept: "text/csv, application/json" } });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    let body: Partial<ApiErrorBody> = {};
    try {
      body = (await res.json()) as Partial<ApiErrorBody>;
    } catch {
      // non-JSON error body: keep the generic message
    }
    throw new ApiError(res.status, body);
  }
  const name = filenameFromDisposition(res.headers.get("Content-Disposition"), fallbackName);
  const url = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return name;
}
