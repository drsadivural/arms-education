import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { TagInput } from "../src/components/ui/TagInput";
import { MultiSelect } from "../src/components/ui/MultiSelect";
import { LineChart } from "../src/components/ui/LineChart";
import { ApiError } from "../src/lib/api";
import { conflictDetail } from "../src/features/admin/errors";
import { eventLabel, eventResult, eventTarget, trainingStatus } from "../src/features/admin/labels";

afterEach(cleanup);

function Tags({ initial = [] as string[], onChange = (_: string[]) => {} }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <label htmlFor="tags">専門分野</label>
      <TagInput
        id="tags"
        value={v}
        onChange={(n) => {
          setV(n);
          onChange(n);
        }}
        maxTags={3}
      />
    </>
  );
}

describe("TagInput", () => {
  it("Enter・読点で追加し、重複は無視、削除ボタンとBackspaceで外せる", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tags onChange={onChange} />);
    const input = screen.getByLabelText("専門分野");
    await user.type(input, "IT基礎{Enter}");
    await user.type(input, "マナー、IT基礎、");
    expect(onChange).toHaveBeenLastCalledWith(["IT基礎", "マナー"]);
    await user.click(screen.getByRole("button", { name: "IT基礎を削除" }));
    expect(onChange).toHaveBeenLastCalledWith(["マナー"]);
    await user.type(input, "{Backspace}");
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("上限件数に達すると入力できない", async () => {
    render(<Tags initial={["a", "b", "c"]} />);
    expect(screen.getByLabelText("専門分野")).toBeDisabled();
    expect(screen.getByPlaceholderText("最大3件です")).toBeInTheDocument();
  });
});

describe("MultiSelect", () => {
  it("チェックボックスで選択し、選択数を凡例に表示する", async () => {
    const user = userEvent.setup();
    function Host() {
      const [v, setV] = useState<string[]>([]);
      return (
        <MultiSelect
          legend="補助講師"
          value={v}
          onChange={setV}
          options={[
            { value: "a", label: "田中 祥司" },
            { value: "b", label: "小山 祐介", disabled: true, description: "停止中" },
          ]}
        />
      );
    }
    render(<Host />);
    const group = screen.getByRole("group", { name: /補助講師/ });
    expect(group).toHaveAccessibleName(/0件選択中/);
    await user.click(within(group).getByRole("checkbox", { name: "田中 祥司" }));
    expect(group).toHaveAccessibleName(/1件選択中/);
    expect(within(group).getByRole("checkbox", { name: /小山 祐介/ })).toBeDisabled();
  });

  it("選択肢が多い場合は絞り込める", async () => {
    const user = userEvent.setup();
    const options = Array.from({ length: 10 }, (_, i) => ({ value: String(i), label: `講師${i}` }));
    render(<MultiSelect legend="補助講師" value={[]} onChange={() => {}} options={options} />);
    await user.type(screen.getByLabelText("補助講師を絞り込む"), "講師9");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });
});

describe("LineChart", () => {
  const props = { title: "研修進捗の推移", labels: ["9月", "10月"], series: [{ key: "a", name: "全体平均", values: [40, null] }, { key: "b", name: "Aクラス", values: [50, 60] }] };

  it("グラフの要約と数値の表を提供し、データなしを文字で示す", () => {
    render(<LineChart {...props} />);
    const group = screen.getByRole("group", { name: /研修進捗の推移/ });
    expect(group).toHaveAccessibleName(/全体平均は9月時点で40%、Aクラスは10月時点で60%/);
    const table = screen.getByRole("table", { name: "研修進捗の推移（表）" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("データなし")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "凡例" })).toHaveTextContent("全体平均");
  });

  it("矢印キーで各月の値を読み上げる", () => {
    render(<LineChart {...props} />);
    const group = screen.getByRole("group", { name: /研修進捗の推移/ });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(screen.getByText("9月: 全体平均 40%、Aクラス 50%")).toBeInTheDocument();
    fireEvent.keyDown(group, { key: "End" });
    expect(screen.getByText("10月: 全体平均 データなし、Aクラス 60%")).toBeInTheDocument();
  });
});

describe("表示ラベル", () => {
  it("監査イベントを日本語名・結果・対象に変換する", () => {
    expect(eventLabel("reservation.approved")).toBe("予約の承認");
    expect(eventLabel("teacher.created")).toBe("講師の登録");
    expect(eventLabel("custom.unknown")).toBe("custom.unknown");
    expect(eventResult("invitation.failed")).toEqual({ label: "失敗", tone: "danger" });
    expect(eventResult("settings.updated").label).toBe("成功");
    expect(eventTarget({ teacher_number: "T001" }, "x")).toBe("T001");
    expect(eventTarget({}, "11111111-2222-3333-4444-555555555555", "11111111-2222-3333-4444-555555555555")).toBe("本人");
    expect(eventTarget({}, "11111111-2222-3333-4444-555555555555")).toBe("ID 11111111");
  });

  it("受講状態を進捗と期限（JSTの今日）から導出する", () => {
    const base = { progress_percent: 50, training_due_on: "2026-10-01", active: true };
    expect(trainingStatus(base, "2026-10-02").label).toBe("期限超過");
    expect(trainingStatus(base, "2026-10-01").label).toBe("受講中");
    expect(trainingStatus({ ...base, progress_percent: 100 }, "2026-10-02").label).toBe("完了");
    expect(trainingStatus({ ...base, progress_percent: null }, "2026-10-02").label).toBe("プログラム未割当");
    expect(trainingStatus({ ...base, active: false }, "2026-10-02").label).toBe("在籍終了");
  });

  it("409の詳細（主担当クラス・今後の授業枠）を説明に変換する", () => {
    const primary = new ApiError(409, { code: "TEACHER_IS_PRIMARY", message_ja: "主担当のクラスがあるため停止できません。", details: { classrooms: [{ id: "1", name: "Aクラス" }, { id: "2", name: "Bクラス" }] } });
    expect(conflictDetail(primary)).toBe("主担当のクラス: Aクラス、Bクラス");
    const slots = new ApiError(409, { code: "TEACHER_HAS_FUTURE_SLOTS", message_ja: "x", details: { upcoming_slot_count: 3 } });
    expect(conflictDetail(slots)).toBe("今後の授業枠: 3件");
    expect(conflictDetail(new Error("x"))).toBeNull();
  });
});
