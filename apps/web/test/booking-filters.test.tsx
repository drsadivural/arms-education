import { describe, expect, it } from "vitest";
import { periodLabel, periodQuery, readId, readList, readPeriod, readSearch, withParam, writePeriod } from "../src/features/booking/filters";

const sp = (q: string) => new URLSearchParams(q);

describe("period filters (URL ↔ API)", () => {
  it("falls back to the tab default when the URL has no period", () => {
    expect(readPeriod(sp(""), "upcoming")).toEqual({ mode: "upcoming" });
    expect(readPeriod(sp(""), "all")).toEqual({ mode: "all" });
  });

  it("reads month, range and explicit modes; ignores invalid values", () => {
    expect(readPeriod(sp("month=2026-10"), "upcoming")).toEqual({ mode: "month", month: "2026-10" });
    expect(readPeriod(sp("month=2026-13"), "upcoming")).toEqual({ mode: "upcoming" });
    expect(readPeriod(sp("period=range&from=2026-10-01&to=2026-10-31"), "upcoming")).toEqual({ mode: "range", from: "2026-10-01", to: "2026-10-31" });
    expect(readPeriod(sp("from=2026-02-30"), "upcoming")).toEqual({ mode: "upcoming" });
    // A range being entered (no dates yet) stays in range mode.
    expect(readPeriod(sp("period=range"), "upcoming")).toEqual({ mode: "range", from: undefined, to: undefined });
    expect(readPeriod(sp("period=all"), "upcoming")).toEqual({ mode: "all" });
    expect(readPeriod(sp("period=bogus"), "all")).toEqual({ mode: "all" });
  });

  it("respects the modes a tab allows (slots have no 「すべての期間」)", () => {
    expect(readPeriod(sp("period=all"), "upcoming", ["upcoming", "month", "range"])).toEqual({ mode: "upcoming" });
  });

  it("writes only the keys that apply and omits the default", () => {
    const p = sp("q=山田&period=range&from=2026-10-01");
    writePeriod(p, { mode: "month", month: "2026-11" }, "upcoming");
    expect(p.toString()).toBe(`q=${encodeURIComponent("山田")}&month=2026-11`);
    writePeriod(p, { mode: "upcoming" }, "upcoming");
    expect(p.has("month")).toBe(false);
    expect(p.has("period")).toBe(false);
    writePeriod(p, { mode: "all" }, "upcoming");
    expect(p.get("period")).toBe("all");
    writePeriod(p, { mode: "range", from: "2026-10-01" }, "upcoming");
    expect(p.get("period")).toBe("range");
    expect(p.get("from")).toBe("2026-10-01");
    expect(p.has("to")).toBe(false);
  });

  it("converts to API query parameters with the organisation-local today", () => {
    expect(periodQuery({ mode: "upcoming" }, "2026-10-02")).toEqual({ from: "2026-10-02" });
    expect(periodQuery({ mode: "month", month: "2026-10" }, "2026-10-02")).toEqual({ month: "2026-10" });
    expect(periodQuery({ mode: "range", from: "2026-10-05", to: "2026-10-09" }, "2026-10-02")).toEqual({ from: "2026-10-05", to: "2026-10-09" });
    expect(periodQuery({ mode: "all" }, "2026-10-02")).toEqual({});
  });

  it("labels periods in Japanese", () => {
    expect(periodLabel({ mode: "upcoming" })).toBe("今日以降");
    expect(periodLabel({ mode: "month", month: "2026-10" })).toBe("2026年10月");
    expect(periodLabel({ mode: "range", from: "2026-10-01", to: "2026-10-31" })).toBe("10月1日（木）〜10月31日（土）");
    expect(periodLabel({ mode: "all" })).toBe("すべての期間");
  });
});

describe("list, id and search parameters", () => {
  it("keeps only allow-listed statuses in their canonical order", () => {
    expect(readList(sp("status=approved,bogus,pending"), "status", ["pending", "approved", "rejected"] as const)).toEqual(["pending", "approved"]);
    expect(readList(sp(""), "status", ["pending"] as const)).toEqual([]);
  });

  it("accepts only UUIDs for id filters", () => {
    expect(readId(sp("teacher=3F2504E0-4F89-41D3-9A0C-0305E82C3301"), "teacher")).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    expect(readId(sp("teacher=1;DROP"), "teacher")).toBeUndefined();
  });

  it("trims search text to the API limit and sets/removes params", () => {
    expect(readSearch(sp(`q=${"あ".repeat(120)}`))).toHaveLength(100);
    const p = withParam(sp("a=1"), "status", ["pending", "approved"]);
    expect(p.get("status")).toBe("pending,approved");
    expect(withParam(p, "status", []).has("status")).toBe(false);
    expect(withParam(p, "a", null).has("a")).toBe(false);
  });
});
