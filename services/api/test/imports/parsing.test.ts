/** Unit tests: RFC 4180 parsing, formula escaping, encoding detection and strict legacy value parsing. */
import { describe, expect, it } from "vitest";
import { CsvSyntaxError, csvLine, escapeFormula, parseCsv } from "../../src/domain/imports/csv";
import { decodeImportFile } from "../../src/domain/imports/encoding";
import { parseActive, parseCount, parseImportDate, parseProgressState } from "../../src/domain/imports/values";
import { ApiError } from "../../src/http/errors";
import { cp932, utf8, withBom } from "../helpers/imports-fixtures";

describe("parseCsv (RFC 4180)", () => {
  it("handles quotes, escaped quotes, commas, CRLF/LF/CR and line breaks inside quoted cells", () => {
    const text = 'a,b,c\r\n"x, y","he said ""hi""","line1\r\nline2"\nplain,,=SUM(A1)\r"",last,\r\n';
    const { records, truncated } = parseCsv(text, 100);
    expect(truncated).toBe(false);
    expect(records.map((r) => r.cells)).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "line1\r\nline2"],
      ["plain", "", "=SUM(A1)"],
      ["", "last", ""],
    ]);
    // Physical line where each record starts (the quoted line break moves the next record down).
    expect(records.map((r) => r.line)).toEqual([1, 2, 4, 5]);
  });

  it("does not create a record for the trailing line break and keeps a final empty cell", () => {
    expect(parseCsv("a,b\r\n1,2\r\n", 10).records).toHaveLength(2);
    expect(parseCsv("a,b\n1,", 10).records[1]?.cells).toEqual(["1", ""]);
    expect(parseCsv("", 10).records).toEqual([]);
  });

  it("reports an unterminated quote and text after a closing quote with the line number", () => {
    expect(() => parseCsv('a\n"open\nstill open', 10)).toThrow(CsvSyntaxError);
    try {
      parseCsv('a\nok\n"x"y', 10);
    } catch (e) {
      expect(e).toMatchObject({ line: 3, reason: "text_after_quote" });
    }
  });

  it("stops after the record limit and reports truncation", () => {
    const { records, truncated } = parseCsv("h\n1\n2\n3\n", 2);
    expect(records).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});

describe("formula injection escaping", () => {
  it("prefixes cells starting with = + - @ TAB CR with a single quote and quotes every cell", () => {
    for (const v of ["=1+1", "+81-3", "-2", "@SUM(A1)", "\tx", "\rx"]) expect(escapeFormula(v)).toBe(`'${v}`);
    expect(escapeFormula("田中 祥司")).toBe("田中 祥司");
    expect(csvLine([3, '=HYPERLINK("http://x")', null, "a,b"])).toBe('"3","\'=HYPERLINK(""http://x"")","","a,b"\r\n');
  });
});

describe("decodeImportFile", () => {
  const text = "社員番号,氏名\r\nE001,和田 一夫\r\n";

  it("reads UTF-8 with and without BOM and flags only a BOM difference as a mismatch", () => {
    expect(decodeImportFile(withBom(text), "utf-8-bom")).toEqual({ text, detected: "utf-8-bom", mismatch: false });
    expect(decodeImportFile(utf8(text), "utf-8")).toEqual({ text, detected: "utf-8", mismatch: false });
    expect(decodeImportFile(withBom(text), "utf-8")).toMatchObject({ text, detected: "utf-8-bom", mismatch: true });
    expect(decodeImportFile(utf8("a,b\r\n1,2\r\n"), "cp932")).toMatchObject({ detected: "ascii", mismatch: false });
  });

  it("decodes CP932 including NEC special characters and full-width symbols", () => {
    const sjis = "講師番号,氏名\r\nT001,髙橋 ①～－\r\n";
    expect(decodeImportFile(cp932(sjis), "cp932")).toEqual({ text: sjis, detected: "cp932", mismatch: false });
  });

  it("rejects a declared encoding that contradicts the content with a Japanese message", () => {
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as ApiError;
      }
      throw new Error("expected an error");
    };
    const a = err(() => decodeImportFile(cp932(text), "utf-8"));
    expect(a.code).toBe("IMPORT_ENCODING_MISMATCH");
    expect(a.message_ja).toContain("Shift_JIS（CP932）");
    expect(a.details).toEqual({ declared: "utf-8", detected: "cp932" });
    expect(err(() => decodeImportFile(withBom(text), "cp932")).code).toBe("IMPORT_ENCODING_MISMATCH");
    const gaiji = err(() => decodeImportFile(new Uint8Array([0x61, 0x0a, 0xf0, 0x40]), "cp932"));
    expect(gaiji.code).toBe("IMPORT_ENCODING_UNSUPPORTED");
    expect(gaiji.message_ja).toContain("2行目");
    expect(err(() => decodeImportFile(new Uint8Array([0x61, 0x00, 0x62]), "utf-8")).code).toBe("IMPORT_ENCODING_UNSUPPORTED");
    expect(err(() => decodeImportFile(new Uint8Array([0x82]), "cp932")).code).toBe("IMPORT_ENCODING_UNSUPPORTED");
  });
});

describe("legacy values", () => {
  it("parses dates strictly and keeps the original year", () => {
    expect(parseImportDate("2019-08-31")).toEqual({ ok: true, value: "2019-08-31" });
    expect(parseImportDate("2019/8/31")).toEqual({ ok: true, value: "2019-08-31" });
    expect(parseImportDate("2019/08/31 0:00")).toEqual({ ok: true, value: "2019-08-31" });
    expect(parseImportDate("2019年8月31日")).toEqual({ ok: true, value: "2019-08-31" });
    expect(parseImportDate("２０１９年８月３１日（土）")).toEqual({ ok: true, value: "2019-08-31" });
    expect(parseImportDate("2019年8月31日(土曜日)")).toEqual({ ok: true, value: "2019-08-31" });
    expect(parseImportDate("2019年8月31日（日）")).toEqual({ ok: false, reason: "weekday" });
    expect(parseImportDate("2026-02-30")).toEqual({ ok: false, reason: "nonexistent" });
    expect(parseImportDate("2019年2月29日")).toEqual({ ok: false, reason: "nonexistent" });
    expect(parseImportDate("8月31日")).toEqual({ ok: false, reason: "format" });
    expect(parseImportDate("31/08/2019")).toEqual({ ok: false, reason: "format" });
    expect(parseImportDate("2019-08-31T10:00")).toEqual({ ok: false, reason: "format" });
  });

  it("maps legacy states without ever inferring completion from an empty cell", () => {
    expect(parseProgressState("")).toBe("unverified");
    expect(parseProgressState("未確認")).toBe("unverified");
    expect(parseProgressState("完了")).toBe("completed");
    expect(parseProgressState("受講中")).toBe("in_progress");
    expect(parseProgressState("たぶん完了")).toBeNull();
  });

  it("parses active flags and counts", () => {
    expect(parseActive("有効")).toBe(true);
    expect(parseActive("在籍終了")).toBe(false);
    expect(parseActive("?")).toBeNull();
    expect(parseCount("３０名", 1, 10000)).toBe(30);
    expect(parseCount("0", 1, 10000)).toBeNull();
    expect(parseCount("1.5", 1, 10000)).toBeNull();
  });
});
