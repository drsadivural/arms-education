import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";
import type { Reservation } from "@arms/contracts";
import { createQueryClient } from "../src/lib/query";
import { ToastProvider } from "../src/components/ui/Toast";
import { RejectDialog, RemoveDialog } from "../src/features/booking/decisions";
import { ReservationTable } from "../src/features/booking/ReservationTable";

const reservation: Reservation = {
  id: "55555555-5555-4555-8555-555555555555",
  slot_id: "44444444-4444-4444-8444-444444444444",
  student_id: "66666666-6666-4666-8666-666666666666",
  status: "pending",
  starts_at: "2026-10-05T05:00:00.000Z",
  ends_at: "2026-10-05T06:30:00.000Z",
  expires_at: "2026-10-03T05:20:00.000Z",
  row_version: 4,
  reason: null,
  student_name: "和田 一夫",
  employee_number: "E-001",
  slot_title: "IT基礎",
  teacher_id: "22222222-2222-4222-8222-222222222222",
  teacher_name: "田中 祥司",
  classroom_id: "11111111-1111-4111-8111-111111111111",
  classroom_name: "Aクラス",
  meeting_url: null,
  cancel_deadline: "2026-10-04T05:00:00.000Z",
  created_at: "2026-10-02T05:20:00.000Z",
  updated_at: "2026-10-02T05:20:00.000Z",
  checked_at: "2026-10-02T05:21:00.000Z",
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];
let respond: (call: Call) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

beforeEach(() => {
  calls = [];
  respond = () => ({ status: 200, body: { ...reservation, status: "approved", row_version: 5 } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call: Call = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const r = await respond(call);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(ui: ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ToastProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const posts = () => calls.filter((c) => c.method === "POST");

describe("却下 dialog", () => {
  it("requires a 1〜1,000 character reason before calling the API", async () => {
    const user = userEvent.setup();
    wrap(<RejectDialog reservation={reservation} open onOpenChange={() => undefined} />);
    expect(screen.getByRole("dialog", { name: "予約申請を却下" })).toBeInTheDocument();
    expect(screen.getByText("和田 一夫")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "却下する" }));
    expect(screen.getByRole("alert")).toHaveTextContent("理由を入力してください（1〜1,000文字）。");
    await user.type(screen.getByLabelText(/却下の理由/), "   ");
    await user.click(screen.getByRole("button", { name: "却下する" }));
    expect(posts()).toHaveLength(0);
  });

  it("sends expected_version, the trimmed reason and an Idempotency-Key, and closes after the API confirms", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    respond = () => ({ status: 200, body: { ...reservation, status: "rejected", reason: "日程変更のため", row_version: 5 } });
    wrap(<RejectDialog reservation={reservation} open onOpenChange={onOpenChange} />);
    await user.type(screen.getByLabelText(/却下の理由/), "  日程変更のため ");
    await user.click(screen.getByRole("button", { name: "却下する" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const [call] = posts();
    expect(call?.url).toBe(`/api/v1/reservations/${reservation.id}/reject`);
    expect(call?.body).toEqual({ expected_version: 4, reason: "日程変更のため" });
    expect(call?.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText("予約申請を却下しました", { selector: "div" })).toBeInTheDocument();
  });

  it("keeps the dialog open with the Japanese message when the hold expired", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    respond = () => ({
      status: 409,
      body: { code: "RESERVATION_EXPIRED", message_ja: "申請の保持期限が切れたため、この操作はできません。", request_id: "req-1", details: { status: "expired", row_version: 5 } },
    });
    wrap(<RejectDialog reservation={reservation} open onOpenChange={onOpenChange} />);
    await user.type(screen.getByLabelText(/却下の理由/), "日程変更のため");
    await user.click(screen.getByRole("button", { name: "却下する" }));
    expect(await screen.findByText("申請の保持期限が切れたため、この操作はできません。 最新の状態を表示しています。")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.queryByText("予約申請を却下しました")).not.toBeInTheDocument();
  });
});

describe("削除 dialog", () => {
  it("states that the history is kept, requires a reason and posts remove", async () => {
    const user = userEvent.setup();
    const onRemoved = vi.fn();
    respond = () => ({ status: 200, body: { ...reservation, status: "removed", row_version: 5 } });
    wrap(<RemoveDialog reservation={{ ...reservation, status: "approved" }} open onOpenChange={() => undefined} onRemoved={onRemoved} />);
    const dialog = screen.getByRole("alertdialog", { name: "予約を削除" });
    expect(dialog).toHaveTextContent("予約を削除し、履歴を保持します。");
    await user.click(screen.getByRole("button", { name: "削除する" }));
    expect(screen.getByRole("alert")).toHaveTextContent("理由を入力してください（1〜1,000文字）。");
    expect(posts()).toHaveLength(0);
    await user.type(screen.getByLabelText(/削除の理由/), "欠席連絡のため");
    await user.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(posts()[0]?.url).toBe(`/api/v1/reservations/${reservation.id}/remove`);
    expect(posts()[0]?.body).toEqual({ expected_version: 4, reason: "欠席連絡のため" });
  });

  it("is seeded with the reason typed on the detail page", () => {
    wrap(<RemoveDialog reservation={reservation} open onOpenChange={() => undefined} initialReason="重複申請のため" />);
    expect(screen.getByLabelText(/削除の理由/)).toHaveValue("重複申請のため");
  });
});

describe("承認 from the list", () => {
  const table = (rows: Reservation[]) => (
    <ReservationTable
      variant="requests"
      caption="予約申請の一覧"
      rows={rows}
      isLoading={false}
      error={null}
      onRetry={() => undefined}
      hasMore={false}
      loadingMore={false}
      onLoadMore={() => undefined}
      empty={{ title: "なし" }}
    />
  );

  it("approves once with expected_version even when clicked twice, and only shows success after the API confirms", async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    respond = () => new Promise((resolve) => (release = () => resolve({ status: 200, body: { ...reservation, status: "approved", row_version: 5 } })));
    wrap(table([reservation]));
    const approve = screen.getByRole("button", { name: /^承認/ });
    await user.click(approve);
    await user.click(approve);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.url).toBe(`/api/v1/reservations/${reservation.id}/approve`);
    expect(posts()[0]?.body).toEqual({ expected_version: 4 });
    expect(screen.queryByText("予約を承認しました")).not.toBeInTheDocument();
    release();
    expect(await screen.findByText("予約を承認しました", { selector: "div" })).toBeInTheDocument();
  });

  it("shows actions by state: pending → 承認/却下/詳細, approved → 詳細/削除, rejected → 理由を見る/詳細", () => {
    wrap(
      table([
        reservation,
        { ...reservation, id: "77777777-7777-4777-8777-777777777777", student_name: "高橋 健太", status: "approved" },
        { ...reservation, id: "88888888-8888-4888-8888-888888888888", student_name: "鈴木 大輔", status: "rejected", reason: "日程変更" },
      ]),
    );
    const rows = screen.getAllByRole("row").slice(1);
    const names = (row: HTMLElement) =>
      [...row.querySelectorAll("button, a")].map((el) => (el.textContent ?? "").replace(/（.*）$/, ""));
    expect(names(rows[0]!)).toEqual(["承認", "却下", "詳細"]);
    expect(names(rows[1]!)).toEqual(["詳細", "削除"]);
    expect(names(rows[2]!)).toEqual(["理由を見る", "詳細"]);
    // Colour is never the only signal: every status has its Japanese label.
    expect(rows[0]).toHaveTextContent("承認待ち");
    expect(rows[2]).toHaveTextContent("却下");
  });
});
