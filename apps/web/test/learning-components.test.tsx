import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { MonthNavigator, QuickFilterChip } from "../src/components/ui/MonthNavigator";
import { QuizEditor, emptyQuestion, nextChoiceId, toQuizDefinitionInput, type QuizDraft } from "../src/components/ui/QuizEditor";
import { ApiError } from "../src/lib/api";
import { PublishProblems, problemsOf } from "../src/features/learning/PublishProblems";
import { ExportControls } from "../src/features/learning/progress/ExportControls";

afterEach(cleanup);

function QuizHarness({ errors, onDraft }: { errors?: Record<string, string>; onDraft(d: QuizDraft): void }) {
  const [draft, setDraft] = useState<QuizDraft>({ title: "確認テスト", questions: [emptyQuestion()] });
  return (
    <QuizEditor
      value={draft}
      errors={errors}
      onChange={(d) => {
        setDraft(d);
        onDraft(d);
      }}
    />
  );
}

describe("QuizEditor", () => {
  it("edits questions, choices, correct answers and points", () => {
    let latest: QuizDraft | null = null;
    render(<QuizHarness onDraft={(d) => (latest = d)} />);
    expect(screen.getByText("1問・合計10点")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "問1を削除" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/問1の問題文/), { target: { value: "正しいものは？" } });
    fireEvent.change(screen.getByLabelText("問1 選択肢1"), { target: { value: "A" } });
    fireEvent.change(screen.getByLabelText("問1 選択肢2"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "選択肢を追加" }));
    fireEvent.change(screen.getByLabelText("問1 選択肢3"), { target: { value: "C" } });
    fireEvent.click(screen.getByLabelText("問1 選択肢2を正答にする"));
    fireEvent.click(screen.getByLabelText("問1 選択肢3を正答にする"));
    expect(screen.getAllByText("正答")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText(/問1の配点/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "問題を追加" }));
    expect(screen.getByText("2問・合計15点")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "問2を上へ移動" }));
    const body = toQuizDefinitionInput(latest!);
    expect(body.questions).toHaveLength(2);
    expect(body.questions[1]).toEqual({
      prompt: "正しいものは？",
      choices: [
        { id: "c1", label: "A" },
        { id: "c2", label: "B" },
        { id: "c3", label: "C" },
      ],
      correct_option_ids: ["c2", "c3"],
      points: 5,
    });
  });

  it("shows API/Zod errors at their paths", () => {
    render(<QuizHarness errors={{ "questions.0.prompt": "必須項目です。", "questions.0.correct_option_ids": "1件以上指定してください。" }} onDraft={() => undefined} />);
    expect(screen.getByText("必須項目です。")).toBeInTheDocument();
    expect(screen.getByText("1件以上指定してください。")).toBeInTheDocument();
  });

  it("allocates unique choice ids", () => {
    expect(nextChoiceId([{ id: "c1", label: "" }, { id: "c3", label: "" }])).toBe("c4");
    expect(nextChoiceId([{ id: "c2", label: "" }])).toBe("c3");
  });
});

describe("MonthNavigator", () => {
  it("links to the six-month, previous, current and next months", () => {
    render(
      <MemoryRouter>
        <MonthNavigator month="2019-08" current="2026-10" hrefFor={(m) => `/progress?department=開発部&month=${m}`} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "2019年8月" })).toBeInTheDocument();
    const href = (name: RegExp) => screen.getByRole("link", { name }).getAttribute("href");
    expect(href(/^前の6か月/)).toBe("/progress?department=開発部&month=2019-02");
    expect(href(/^先月/)).toBe("/progress?department=開発部&month=2019-07");
    expect(href(/^今月$/)).toBe("/progress?department=開発部&month=2026-10");
    expect(href(/^来月/)).toBe("/progress?department=開発部&month=2019-09");
    expect(href(/^次の6か月/)).toBe("/progress?department=開発部&month=2020-02");
    expect(screen.getByRole("link", { name: /^今月$/ })).not.toHaveAttribute("aria-current");
  });

  it("quick filter chips announce their pressed state", () => {
    const onClick = vi.fn();
    render(
      <QuickFilterChip pressed onClick={onClick}>
        今月の教育
      </QuickFilterChip>,
    );
    const chip = screen.getByRole("button", { name: /今月の教育/ });
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalled();
  });
});

describe("PublishProblems", () => {
  it("shows the Japanese blocker, the next step and each problem", () => {
    const error = new ApiError(503, {
      code: "SCANNER_UNAVAILABLE",
      message_ja: "ファイル検査サービスに接続できないため、教材の公開を停止しています。",
      request_id: "req-9",
      details: { problems: [{ code: "scan_pending", message_ja: "「資料」のファイル検査が完了していません。", material_id: "m1" }] },
    });
    render(<PublishProblems error={error} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("ファイル検査サービスに接続できないため、教材の公開を停止しています。");
    expect(alert).toHaveTextContent("ファイル検査サービスが接続されるまで");
    expect(alert).toHaveTextContent("「資料」のファイル検査が完了していません。");
    expect(alert).toHaveTextContent("問い合わせ番号: req-9");
    expect(problemsOf(new Error("x"))).toEqual([]);
  });
});

const exportJob = (over: Record<string, unknown>) => ({
  id: "11111111-1111-4111-8111-111111111111",
  state: "pending",
  download_url: null,
  expires_at: null,
  format: "csv",
  created_at: "2026-10-02T00:00:00Z",
  row_count: 812,
  filename: null,
  error_code: null,
  ...over,
});

describe("ExportControls", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the current filters, polls a background export and downloads only when ready", async () => {
    vi.useFakeTimers();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:http://localhost/export"), revokeObjectURL: vi.fn() });
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: init.body as string | undefined });
        // The ready file is fetched and saved through a same-origin blob link (no cross-origin navigation).
        if (url.startsWith("https://files.example/")) return new Response("\uFEFF終了予定日\r\n", { status: 200, headers: { "Content-Type": "text/csv" } });
        const job = url.endsWith("/exports/progress") ? exportJob({}) : exportJob({ state: "ready", download_url: "https://files.example/e.csv?sig=1", filename: "社員教育進捗_2026-10.csv" });
        return new Response(JSON.stringify({ data: job, checked_at: "2026-10-02T00:00:00Z" }), { status: 200 });
      }),
    );
    render(<ExportControls filters={{ month: "2026-10", department: "開発部", q: undefined }} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "CSV出力" }));
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ format: "csv", month: "2026-10", department: "開発部" });
    expect(screen.getByText("CSVを作成しています…（812件）")).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(calls[1]!.url).toBe("/api/v1/exports/11111111-1111-4111-8111-111111111111");
    expect(calls[2]!.url).toBe("https://files.example/e.csv?sig=1");
    expect(click).toHaveBeenCalledTimes(1);
    expect((click.mock.contexts[0] as HTMLAnchorElement).href).toBe("blob:http://localhost/export");
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("社員教育進捗_2026-10.csv");
    expect(screen.getByText(/CSV（812件）をダウンロードしました。/)).toBeInTheDocument();
  });

  it("shows EXPORT_TOO_LARGE and failed jobs (PDF_FONT_UNAVAILABLE) in Japanese", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { format: string };
        if (body.format === "csv") {
          return new Response(JSON.stringify({ code: "EXPORT_TOO_LARGE", message_ja: "出力件数が上限（10,000件）を超えています。月や部署で絞り込んでください。", request_id: "r1" }), { status: 422 });
        }
        return new Response(JSON.stringify({ data: exportJob({ state: "failed", format: "pdf", error_code: "PDF_FONT_UNAVAILABLE" }), checked_at: "x" }), { status: 200 });
      }),
    );
    render(<ExportControls filters={{}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "CSV出力" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("出力件数が上限（10,000件）を超えています。");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "PDF出力" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("PDF出力：PDF出力用の日本語フォントが配置されていないため、PDFを作成できません。");
  });
});
