import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { createQueryClient } from "../src/lib/query";
import { SessionProvider, useSession } from "../src/lib/session";
import { ToastProvider } from "../src/components/ui/Toast";
import { ProgressPage } from "../src/pages/progress/ProgressPage";
import { ProgramsPage } from "../src/pages/programs/ProgramsPage";

const TEACHER_ID = "22222222-2222-4222-8222-222222222222";

const session = {
  data: {
    user: { id: "11111111-1111-4111-8111-111111111111", display_name: "山田 太郎", email: "admin@example.invalid", role: "admin", active: true },
    csrf_token: "csrf",
    expires_at: "2026-10-03T00:00:00Z",
    organization_name: "テスト組織",
    mfa_required: false,
    mfa_enrolled: true,
  },
  checked_at: "2026-10-01T00:00:00Z",
};

function record(id: string, over: Record<string, unknown>) {
  return {
    id,
    student_id: `s-${id}`,
    teacher_id: TEACHER_ID,
    department_name: "開発部",
    due_date: "2026-10-05",
    content: "技術知識習得",
    notes: "",
    state: "in_progress",
    student_name: "和田 一夫",
    teacher_name: "田中 祥司",
    progress_percent: 76,
    row_version: 1,
    overdue: false,
    employee_number: "E-1",
    classroom_id: null,
    classroom_name: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...over,
  };
}

type Handler = (url: URL) => unknown;
let requests: URL[] = [];

function stubApi(handlers: Record<string, Handler>) {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      requests.push(url);
      const path = url.pathname.replace("/api/v1", "");
      const handler = handlers[path];
      if (!handler) return new Response(JSON.stringify({ items: [], next_cursor: null, checked_at: "2026-10-01T00:00:00Z" }), { status: 200 });
      return new Response(JSON.stringify(handler(url)), { status: 200 });
    }),
  );
}

afterEach(cleanup);

/** Renders the page once the session is authenticated (as RequireAuth does in the app). */
function Authed({ children }: { children: React.ReactNode }) {
  const { state } = useSession();
  return state.status === "authenticated" ? <>{children}</> : null;
}

function Location() {
  const loc = useLocation();
  return <output data-testid="location">{`${loc.pathname}${loc.search}`}</output>;
}

function renderAt(path: string, element: React.ReactNode, routePath: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ToastProvider>
        <SessionProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={routePath} element={<Authed>{element}<Location /></Authed>} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, checked_at: "2026-10-01T03:04:00Z" });

describe("ProgressPage (WEB-11)", () => {
  beforeEach(() => {
    // 2026-09-30 15:30 UTC = 2026-10-01 00:30 JST: the default month must be the JST month.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T15:30:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("defaults to the current JST month, keeps the legacy columns and shows overdue/total/progress", async () => {
    stubApi({
      "/auth/session": () => session,
      "/settings": () => ({ data: { departments: ["営業部", "開発部", "サポート部"] }, checked_at: "x" }),
      "/progress-records": () =>
        page([
          record("r1", {}),
          record("r2", { student_name: "高橋 健太", department_name: "サポート部", due_date: "2026-10-01", overdue: true, progress_percent: null, content: "メールサポート" }),
        ]),
    });
    renderAt("/progress", <ProgressPage />, "/progress");
    expect(await screen.findByRole("heading", { name: "2026年10月" })).toBeInTheDocument();
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["終了予定日", "社員名", "教育担当部署", "教育担当者", "内容", "進捗", "状態", "操作"]);
    const recordCall = requests.find((u) => u.pathname.endsWith("/progress-records"))!;
    expect(recordCall.searchParams.get("month")).toBe("2026-10");
    const overdueRow = within(table).getByRole("row", { name: /高橋 健太/ });
    expect(within(overdueRow).getByText("期限超過")).toBeInTheDocument();
    expect(within(overdueRow).getByText("未設定")).toBeInTheDocument();
    expect(within(overdueRow).getByText("10月1日（木）")).toBeInTheDocument();
    expect(within(table).getByRole("progressbar", { name: "和田 一夫さんの研修進捗" })).toHaveAttribute("aria-valuenow", "76");
    expect(screen.getByText("全2件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /今月の教育/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "サポート部担当" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("link", { name: "和田 一夫さん・10月5日（月）の記録を編集" })).toHaveAttribute("href", "/progress/records/r1?mode=edit");
    expect(screen.getByRole("link", { name: "和田 一夫" })).toHaveAttribute("href", "/progress/students/s-r1");
    expect(screen.getByText("終了予定日・社員名・教育担当部署・教育担当者・内容は、既存データを引き継いで管理できます。")).toBeInTheDocument();
    expect(screen.getByText(/最終取得 10月1日（木）12:04/)).toBeInTheDocument();

    // Filters go to the URL and to the API; the month navigator keeps them.
    fireEvent.click(screen.getByRole("button", { name: "サポート部担当" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/progress?department=%E3%82%B5%E3%83%9D%E3%83%BC%E3%83%88%E9%83%A8"));
    await waitFor(() => expect(requests.some((u) => u.searchParams.get("department") === "サポート部")).toBe(true));
    fireEvent.click(screen.getByRole("link", { name: /^来月/ }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toContain("month=2026-11"));
    expect(screen.getByTestId("location").textContent).toContain("department=");
    expect(await screen.findByRole("heading", { name: "2026年11月" })).toBeInTheDocument();
    await waitFor(() => expect(requests.some((u) => u.searchParams.get("month") === "2026-11" && u.searchParams.get("department") === "サポート部")).toBe(true));
  });

  it("pages with the cursor and states the total only when all rows are loaded", async () => {
    stubApi({
      "/auth/session": () => session,
      "/progress-records": (u) =>
        u.searchParams.get("cursor") === "c1"
          ? page([record("r3", { student_name: "鈴木 大輔", due_date: "2019-08-31" })])
          : page([record("r1", {}), record("r2", { student_name: "加藤 美咲" })], "c1"),
    });
    renderAt("/progress?month=2019-08", <ProgressPage />, "/progress");
    expect(await screen.findByText("2件を表示中（続きがあります）")).toBeInTheDocument();
    expect(requests.find((u) => u.pathname.endsWith("/progress-records"))!.searchParams.get("limit")).toBe("50");
    fireEvent.click(screen.getByRole("button", { name: "さらに読み込む" }));
    expect(await screen.findByText("全3件")).toBeInTheDocument();
    expect(screen.getByText("2019年8月31日（土）")).toBeInTheDocument();
    expect(requests.some((u) => u.searchParams.get("cursor") === "c1")).toBe(true);
    expect(screen.getByText("2019年の記録です。終了予定日は登録された年月日のまま表示しています。")).toBeInTheDocument();
  });

  it("shows the error with retry and the request id", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input, "http://localhost");
        if (url.pathname.endsWith("/auth/session")) return new Response(JSON.stringify(session), { status: 200 });
        if (url.pathname.endsWith("/progress-records")) {
          if (fail) return new Response(JSON.stringify({ code: "FORBIDDEN", message_ja: "この操作を行う権限がありません。", request_id: "req-42" }), { status: 403 });
          return new Response(JSON.stringify(page([record("r1", {})])), { status: 200 });
        }
        return new Response(JSON.stringify(page([])), { status: 200 });
      }),
    );
    renderAt("/progress", <ProgressPage />, "/progress");
    expect(await screen.findByText("この操作を行う権限がありません。")).toBeInTheDocument();
    expect(screen.getByText("問い合わせ番号: req-42")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(await screen.findByText("全1件")).toBeInTheDocument();
  });
});

describe("ProgramsPage (WEB-09)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists programs with counts and keeps filters in the URL", async () => {
    stubApi({
      "/auth/session": () => session,
      "/programs": () =>
        page([
          {
            id: "p1",
            name: "新入社員 基礎研修",
            description: "社会人としての基礎",
            department_name: "",
            archived: false,
            published_version_id: "v1",
            unit_count: 8,
            material_count: 24,
            student_count: 128,
            row_version: 1,
            latest_version: { id: "v2", version_number: 2, state: "draft" },
            draft_version_id: "v2",
            created_at: "2026-04-01T00:00:00Z",
          },
        ]),
    });
    renderAt("/programs?status=draft", <ProgramsPage />, "/programs");
    const card = await screen.findByRole("article", { name: "新入社員 基礎研修" });
    expect(within(card).getByText("8単元 / 24教材")).toBeInTheDocument();
    expect(within(card).getByText("128名")).toBeInTheDocument();
    expect(within(card).getByText("全部署")).toBeInTheDocument();
    expect(within(card).getByText("v2（下書き）")).toBeInTheDocument();
    expect(within(card).getByText("公開中")).toBeInTheDocument();
    expect(within(card).getByText("下書き")).toBeInTheDocument();
    expect(requests.find((u) => u.pathname.endsWith("/programs"))!.searchParams.get("status")).toBe("draft");
    expect(screen.getByLabelText("公開状態")).toHaveValue("draft");
    fireEvent.change(screen.getByLabelText("公開状態"), { target: { value: "archived" } });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/programs?status=archived"));
    expect(screen.getByRole("link", { name: "プログラムを追加" })).toHaveAttribute("href", "/programs/new");
  });
});
