/** Local CSV preview helpers of the import panel (encoding detection, RFC 4180 head reading, file checks). */
import { describe, expect, it } from "vitest";
import { decodeAs, detectEncoding, fileProblem, previewFile, readRecords } from "../src/features/imports/preview";

const utf8 = (s: string) => new TextEncoder().encode(s);
const bom = (s: string) => new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(s)]);
// 「講師番号,氏名\r\nT001,田中\r\n」 in Shift_JIS (CP932).
const SJIS = new Uint8Array([
  0x8d, 0x75, 0x8e, 0x74, 0x94, 0xd4, 0x8d, 0x86, 0x2c, 0x8e, 0x81, 0x96, 0xbc, 0x0d, 0x0a, 0x54, 0x30, 0x30, 0x31, 0x2c, 0x93, 0x63, 0x92, 0x86, 0x0d, 0x0a,
]);

describe("import preview helpers", () => {
  it("detects UTF-8 with/without BOM, Shift_JIS and plain ASCII", () => {
    expect(detectEncoding(bom("社員番号\r\n"))).toBe("utf-8-bom");
    expect(detectEncoding(utf8("社員番号\r\n"))).toBe("utf-8");
    expect(detectEncoding(SJIS)).toBe("cp932");
    expect(detectEncoding(utf8("a,b\r\n"))).toBe("ascii");
    expect(decodeAs(SJIS, "cp932")).toBe("講師番号,氏名\r\nT001,田中\r\n");
    expect(decodeAs(SJIS, "utf-8")).toBeNull();
    expect(decodeAs(bom("x"), "utf-8-bom")).toBe("x");
  });

  it("reads quoted cells with commas, escaped quotes and line breaks", () => {
    expect(readRecords('a,b\r\n"x, y","he said ""hi"""\n"line1\nline2",z', 10)).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
      ["line1\nline2", "z"],
    ]);
    expect(readRecords("h\n1\n2\n3\n", 2)).toEqual([["h"], ["1"]]);
  });

  it("previews the head of a file with the detected or chosen encoding", async () => {
    const file = new File([SJIS], "teachers.csv", { type: "text/csv" });
    const p = await previewFile(file);
    expect(p).toMatchObject({ detected: "cp932", encoding: "cp932", headers: ["講師番号", "氏名"], rows: [["T001", "田中"]], decodeFailed: false });
    expect((await previewFile(file, "utf-8")).decodeFailed).toBe(true);
  });

  it("rejects non-CSV, empty and over-10MB files with Japanese messages", () => {
    expect(fileProblem(new File(["x"], "data.xlsx"))).toContain("CSV");
    expect(fileProblem(new File([], "empty.csv"))).toBe("ファイルが空です。");
    const big = { name: "big.csv", size: 10 * 1024 * 1024 + 1 } as File;
    expect(fileProblem(big)).toContain("10MB");
    expect(fileProblem(new File(["a"], "ok.CSV"))).toBeNull();
  });
});
