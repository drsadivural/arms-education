/** Typed calls for WEB-17 データ移植 (/uploads quarantine pipeline + /imports). */
import type { components, ImportItemFilter } from "@arms/contracts";
import { API_BASE, ApiError, NetworkError, api } from "../../lib/api";

type S = components["schemas"];
export type ImportJob = S["ImportJob"];
export type ImportItem = S["ImportItem"];
export type ImportColumn = S["ImportColumn"];
export type ImportMappingBody = S["ImportMapping"];
type UploadTicket = S["Upload"];
type UploadStatus = S["UploadStatus"];

interface DataResponse<T> {
  data: T;
  checked_at: string;
}
interface PageResponse<T> {
  items: T[];
  next_cursor: string | null;
  checked_at: string;
}

export const importsApi = {
  list: (cursor?: string | null) => api.get<PageResponse<ImportJob>>("/imports", { query: { limit: 20, cursor: cursor ?? undefined } }),
  get: (id: string, errorsCursor?: string | null) =>
    api.get<DataResponse<ImportJob>>(`/imports/${id}`, { query: { errors_limit: 50, errors_cursor: errorsCursor ?? undefined } }),
  items: (id: string, status: ImportItemFilter, cursor?: string | null) =>
    api.get<PageResponse<ImportItem>>(`/imports/${id}/items`, { query: { status, limit: 50, cursor: cursor ?? undefined } }),
  create: (body: ImportMappingBody, idempotencyKey: string) => api.post<DataResponse<ImportJob>>("/imports", body, { idempotencyKey }),
  update: (id: string, body: ImportMappingBody, version: number) => api.patch<DataResponse<ImportJob>>(`/imports/${id}`, body, { ifMatch: version }),
  validate: (id: string) => api.post<DataResponse<ImportJob>>(`/imports/${id}/validate`),
  commit: (id: string, body: { backup_confirmed: true; send_invitations: boolean }, idempotencyKey: string) =>
    api.post<DataResponse<ImportJob>>(`/imports/${id}/commit`, body, { idempotencyKey }),
  rollback: (id: string, idempotencyKey: string) => api.post<DataResponse<ImportJob>>(`/imports/${id}/rollback`, undefined, { idempotencyKey }),
};

/** Content types the upload policy accepts for CSV (Windows browsers report .csv as application/vnd.ms-excel). */
function csvContentType(file: File): string {
  return file.type === "application/vnd.ms-excel" ? file.type : "text/csv";
}

export type UploadOutcome = { kind: "clean"; uploadId: string } | { kind: "unscanned"; uploadId: string } | { kind: "scanning"; uploadId: string };

/**
 * POST /uploads (purpose import) → PUT to the presigned URL with the required headers → POST /uploads/{id}/complete,
 * then waits briefly for the scan verdict. Without a configured scanner the upload never becomes clean.
 */
export async function uploadImportFile(
  file: File,
  idempotencyKey: string,
  opts: { pollIntervalMs?: number; maxPolls?: number; onScanning?: () => void } = {},
): Promise<UploadOutcome> {
  const contentType = csvContentType(file);
  const ticket = await api.post<DataResponse<UploadTicket>>(
    "/uploads",
    { filename: file.name.slice(0, 200), content_type: contentType, size_bytes: file.size, purpose: "import" },
    { idempotencyKey },
  );
  let put: Response;
  try {
    put = await fetch(ticket.data.upload_url, { method: "PUT", headers: ticket.data.required_headers, body: file, credentials: "omit" });
  } catch {
    throw new NetworkError();
  }
  if (!put.ok) {
    throw new ApiError(put.status, { code: "STORAGE_UNAVAILABLE", message_ja: "ファイルを保管サービスへ送信できませんでした。もう一度お試しください。" });
  }
  const completed = await api.post<{ success: boolean; data?: Partial<UploadStatus> & { scanner_configured?: boolean } }>(`/uploads/${ticket.data.id}/complete`);
  const uploadId = ticket.data.id;
  if (completed.data?.state === "clean") return { kind: "clean", uploadId };
  if (completed.data?.scanner_configured === false) return { kind: "unscanned", uploadId };
  opts.onScanning?.();
  const interval = opts.pollIntervalMs ?? 2000;
  for (let i = 0; i < (opts.maxPolls ?? 30); i++) {
    await new Promise((r) => setTimeout(r, interval));
    const status = await api.get<DataResponse<UploadStatus>>(`/uploads/${uploadId}`);
    if (status.data.state === "clean") return { kind: "clean", uploadId };
    if (status.data.state === "blocked" || status.data.state === "rejected") {
      throw new ApiError(409, { code: "IMPORT_UPLOAD_REJECTED", message_ja: "ファイル検査で利用できないと判定されました。別のファイルをアップロードしてください。" });
    }
  }
  return { kind: "scanning", uploadId };
}

/** Downloads GET /imports/{id}/errors.csv through the session cookie and saves it with the server's filename. */
export async function downloadErrorReport(jobId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/imports/${jobId}/errors.csv`, { credentials: "same-origin", headers: { Accept: "text/csv" } });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    throw new ApiError(res.status, body);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `import-${jobId}-errors.csv`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
