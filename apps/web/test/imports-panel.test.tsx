/**
 * WEB-17 ImportPanel with a mocked fetch: upload (presigned PUT with the required headers) → mapping → dry run with
 * Japanese row errors and the error CSV, unscanned uploads, history → commit (backup confirmation, continuation)
 * → rollback with confirmation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IMPORT_FIELDS, type ImportEntity } from "@arms/contracts";
import { createQueryClient } from "../src/lib/query";
import { ToastProvider } from "../src/components/ui/Toast";
import { ImportPanel } from "../src/features/imports/ImportPanel";
import type { ImportItem, ImportJob } from "../src/features/imports/api";

const NOW = "2026-10-02T05:00:00.000Z";
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";

function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  const entity: ImportEntity = overrides.entity ?? "teachers";
  return {
    id: JOB_ID,
    state: "uploaded",
    entity,
    source_system: "旧社員教育進捗管理",
    encoding: "utf-8-bom",
    detected_encoding: null,
    encoding_mismatch: false,
    upload_id: UPLOAD_ID,
    filename: "teachers.csv",
    mapping: { 講師番号: "teacher_number", 氏名: "display_name", メール: "email" },
    headers: [],
    columns: IMPORT_FIELDS[entity].map((d) => ({
      field: d.field,
      label_ja: d.label,
      required: d.required,
      source_header: d.label,
      empty_meaning_ja: d.empty,
      empty_count: 0,
      error_count: 0,
    })),
    total_rows: 0,
    valid_rows: 0,
    error_rows: 0,
    new_rows: 0,
    update_rows: 0,
    skip_rows: 0,
    warning_rows: 0,
    blank_rows: 0,
    committed_rows: 0,
    conflict_rows: 0,
    reverted_rows: 0,
    manual_review_rows: 0,
    options: null,
    invitations: null,
    failure: null,
    errors: [],
    errors_next_cursor: null,
    created_by_name: "山田 太郎",
    created_at: NOW,
    updated_at: NOW,
    validated_at: null,
    committed_at: null,
    rolled_back_at: null,
    rollback_started: false,
    row_version: 1,
    ...overrides,
  };
}

function makeItem(overrides: Partial<ImportItem> = {}): ImportItem {
  return {
    row: 2,
    action: "create",
    key: "T001",
    entity_kind: "teacher",
    entity_id: null,
    values: { teacher_number: "T001", display_name: "田中 祥司", email: "tanaka@example.invalid", active: true },
    before: null,
    changed_fields: [],
    errors: [],
    warnings: [],
    commit_state: null,
    commit_message_ja: null,
    rollback_state: null,
    rollback_message_ja: null,
    ...overrides,
  };
}

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
type Handler = (call: RecordedCall) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const page = <T,>(items: T[], next: string | null = null) => ({ items, next_cursor: next, checked_at: NOW });
const data = <T,>(d: T) => ({ data: d, checked_at: NOW });

/** fetch mock: the first route whose "METHOD url-prefix" matches answers; every call is recorded. */
function mockFetch(routes: [string, Handler][]) {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init.method ?? "GET").toUpperCase();
      let body: unknown = init.body;
      if (typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const call: RecordedCall = { method, url, headers: (init.headers ?? {}) as Record<string, string>, body };
      calls.push(call);
      for (const [pattern, handler] of routes) {
        const [m, prefix] = pattern.split(" ") as [string, string];
        if (m === method && url.startsWith(prefix)) return handler(call);
      }
      return json({ code: "NOT_FOUND", message_ja: "対象が見つかりません。", request_id: "test" }, 404);
    }),
  );
  return calls;
}

function renderPanel() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ToastProvider>
        <ImportPanel />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const TEACHERS_CSV = "\uFEFF講師番号,氏名,ふりがな,メール,部署,状態\r\nT001,田中 祥司,たなか しょうじ,tanaka@example.invalid,開発部,有効\r\nT002,別府 悦子,べっぷ えつこ,beppu@example.invalid,営業部,有効\r\n";

beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:report"), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ImportPanel: upload → mapping → dry run", () => {
  it("uploads through the presigned URL, suggests the mapping and shows Japanese row errors", async () => {
    const validated = makeJob({
      state: "validated",
      headers: ["講師番号", "氏名", "ふりがな", "メール", "部署", "状態"],
      mapping: { 講師番号: "teacher_number", 氏名: "display_name", ふりがな: "kana", メール: "email", 部署: "department_name", 状態: "active" },
      total_rows: 2,
      valid_rows: 1,
      error_rows: 1,
      new_rows: 1,
      detected_encoding: "utf-8-bom",
      errors: [{ row: 3, field: "email", label_ja: "メール", header: "メール", message_ja: "メール「beppu@example.invalid」は既に別のアカウントで使われています。" }],
      row_version: 2,
    });
    const calls = mockFetch([
      ["GET /api/v1/imports?", () => json(page([]))],
      ["POST /api/v1/uploads/" + UPLOAD_ID + "/complete", () => json({ success: true, checked_at: NOW, data: { state: "clean", scan_state: "clean", scanner_configured: true } })],
      [
        "POST /api/v1/uploads",
        () =>
          json(
            data({ id: UPLOAD_ID, upload_url: "https://storage.test.invalid/put?sig=1", object_key: `quarantine/org/${UPLOAD_ID}`, expires_at: NOW, required_headers: { "Content-Type": "text/csv" } }),
          ),
      ],
      ["PUT https://storage.test.invalid/put", () => new Response(null, { status: 200 })],
      ["POST /api/v1/imports/" + JOB_ID + "/validate", () => json(data(validated))],
      ["POST /api/v1/imports", () => json(data(makeJob()))],
      ["GET /api/v1/imports/" + JOB_ID + "/items", () => json(page([makeItem({ row: 3, action: "error", errors: [validated.errors[0] as never] })]))],
      ["GET /api/v1/imports/" + JOB_ID + "/errors.csv", () => new Response("\uFEFF\"行番号\"\r\n", { status: 200, headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="import-teachers-errors.csv"' } })],
      ["GET /api/v1/imports/" + JOB_ID, () => json(data(validated))],
    ]);
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByText("移行の履歴はまだありません")).toBeInTheDocument();

    await user.upload(screen.getByLabelText(/CSVファイル/), new File([TEACHERS_CSV], "teachers.csv", { type: "text/csv" }));
    expect(await screen.findByText("判定結果: UTF-8（BOM付き）")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "田中 祥司" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "アップロードして次へ" }));
    expect(await screen.findByRole("heading", { name: "項目の対応（講師）" })).toBeInTheDocument();
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.headers).toEqual({ "Content-Type": "text/csv" });
    const presign = calls.find((c) => c.method === "POST" && c.url === "/api/v1/uploads");
    expect(presign?.body).toMatchObject({ filename: "teachers.csv", content_type: "text/csv", purpose: "import" });
    expect(presign?.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    // Suggested from the Japanese headers; the empty-cell meaning is shown per field.
    expect(screen.getByLabelText("講師番号に対応する列")).toHaveValue("講師番号");
    expect(screen.getByLabelText("メールに対応する列")).toHaveValue("メール");
    expect(screen.getByText("空欄＝有効（有効／無効で指定。登録済み講師の状態は変更しない）")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "ドライランを実行" }));
    expect(await screen.findByRole("heading", { name: "移行前の検証" })).toBeInTheDocument();
    const create = calls.find((c) => c.method === "POST" && c.url === "/api/v1/imports");
    expect(create?.body).toEqual({
      source_system: "旧社員教育進捗管理",
      encoding: "utf-8-bom",
      entity: "teachers",
      upload_id: UPLOAD_ID,
      columns: { 講師番号: "teacher_number", 氏名: "display_name", ふりがな: "kana", メール: "email", 部署: "department_name", 状態: "active" },
    });
    expect(screen.getByText("3行目にエラーがあります。元データを修正して再アップロードするか、項目の対応を修正してから移行を確定してください。")).toBeInTheDocument();
    const errorTable = screen.getByRole("table", { name: "行ごとのエラー" });
    expect(within(errorTable).getByText("メール「beppu@example.invalid」は既に別のアカウントで使われています。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移行確定へ進む" })).toBeDisabled();

    // jsdom cannot navigate: capture the download link instead of following it.
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    await user.click(screen.getByRole("button", { name: "エラー明細をダウンロード" }));
    await waitFor(() => expect(downloads).toEqual(["import-teachers-errors.csv"]));
    click.mockRestore();
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(calls.some((c) => c.url === `/api/v1/imports/${JOB_ID}/errors.csv`)).toBe(true);
  });

  it("explains that file scanning must be configured when the upload cannot be scanned", async () => {
    mockFetch([
      ["GET /api/v1/imports?", () => json(page([]))],
      ["POST /api/v1/uploads/" + UPLOAD_ID + "/complete", () => json({ success: true, checked_at: NOW, data: { state: "scanning", scan_state: "pending", scanner_configured: false } })],
      ["POST /api/v1/uploads", () => json(data({ id: UPLOAD_ID, upload_url: "https://storage.test.invalid/put", object_key: "k", expires_at: NOW, required_headers: {} }))],
      ["PUT https://storage.test.invalid/put", () => new Response(null, { status: 200 })],
    ]);
    const user = userEvent.setup();
    renderPanel();
    await user.upload(screen.getByLabelText(/CSVファイル/), new File([TEACHERS_CSV], "teachers.csv", { type: "text/csv" }));
    await user.click(await screen.findByRole("button", { name: "アップロードして次へ" }));
    expect(await screen.findByText(/ファイル検査（マルウェアスキャン）サービスが設定されていない/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /項目の対応/ })).not.toBeInTheDocument();
  });

  it("rejects a non-CSV file before uploading and requires mapped required fields", async () => {
    const calls = mockFetch([["GET /api/v1/imports?", () => json(page([]))]]);
    const user = userEvent.setup({ applyAccept: false });
    renderPanel();
    await user.upload(screen.getByLabelText(/CSVファイル/), new File(["x"], "teachers.xlsx"));
    expect(await screen.findByText(/CSVファイル（.csv）を選択してください/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "アップロードして次へ" })).toBeDisabled();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

describe("ImportPanel: history → commit → rollback", () => {
  it("confirms the backup, continues a commit that hit the time budget and rolls back with confirmation", async () => {
    const validated = makeJob({ entity: "progress", state: "validated", filename: "progress.csv", total_rows: 2, valid_rows: 2, new_rows: 1, update_rows: 1, row_version: 3 });
    const committing = { ...validated, state: "committing" as const, committed_rows: 1, row_version: 4 };
    const completed = { ...validated, state: "completed" as const, committed_rows: 2, committed_at: NOW, options: { send_invitations: false }, row_version: 5 };
    const rolledBack = { ...completed, state: "rolled_back" as const, rollback_started: true, reverted_rows: 1, manual_review_rows: 1, rolled_back_at: NOW, row_version: 7 };
    let current: ImportJob = validated;
    const commits: number[] = [];
    const calls = mockFetch([
      ["GET /api/v1/imports?", () => json(page([current]))],
      [
        "POST /api/v1/imports/" + JOB_ID + "/commit",
        () => {
          commits.push(commits.length);
          current = commits.length === 1 ? committing : completed;
          return json(data(current));
        },
      ],
      [
        "POST /api/v1/imports/" + JOB_ID + "/rollback",
        () => {
          current = rolledBack;
          return json(data(current));
        },
      ],
      ["GET /api/v1/imports/" + JOB_ID + "/items", () => json(page([makeItem({ entity_kind: "progress_record", action: "update", rollback_state: current.state === "rolled_back" ? "manual" : null })]))],
      ["GET /api/v1/imports/" + JOB_ID, () => json(data(current))],
    ]);
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: /の移行を開く$/ }));
    expect(await screen.findByRole("heading", { name: "移行前の検証" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "移行確定へ進む" }));
    await user.click(await screen.findByRole("button", { name: "移行を確定" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/新規 1件・更新 1件を反映します/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "確定する" }));
    expect(await within(dialog).findByText("移行前にバックアップを取得したことを確認してください。")).toBeInTheDocument();
    expect(commits).toHaveLength(0);
    await user.click(within(dialog).getByLabelText("移行前にデータベースのバックアップを取得しました"));
    await user.click(within(dialog).getByRole("button", { name: "確定する" }));

    await waitFor(() => expect(commits).toHaveLength(2));
    const commitCalls = calls.filter((c) => c.url.endsWith("/commit"));
    expect(commitCalls.map((c) => c.body)).toEqual([
      { backup_confirmed: true, send_invitations: false },
      { backup_confirmed: true, send_invitations: false },
    ]);
    expect(commitCalls[0]?.headers["Idempotency-Key"]).toBe(commitCalls[1]?.headers["Idempotency-Key"]);
    expect(await screen.findByText("反映済み")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "この移行を取り消す" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("移行後に編集された行は変更せず「手動照合が必要」として残します。")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "取り消す" }));
    expect(await screen.findByText(/1 件は元に戻していません/)).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith("/rollback"))).toHaveLength(1);
  });
});
