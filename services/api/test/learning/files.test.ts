import { describe, expect, it } from "vitest";
import { SAMPLE } from "../helpers/learning-fakes";
import { checkUploadDeclaration, isValidCp932, isValidUtf8, sniffContentType, verifyTextFile } from "../../src/domain/learning/files";
import { contentDisposition } from "../../src/integrations/storage";
import { scoreQuiz } from "../../src/domain/learning/quiz";

describe("magic bytes", () => {
  it("recognises each allowed type only by its real signature", () => {
    expect(sniffContentType("application/pdf", SAMPLE.pdf())).toBe("application/pdf");
    expect(sniffContentType("image/png", SAMPLE.png())).toBe("image/png");
    expect(sniffContentType("image/jpeg", SAMPLE.jpeg())).toBe("image/jpeg");
    expect(sniffContentType("video/mp4", SAMPLE.mp4())).toBe("video/mp4");
    expect(sniffContentType("video/quicktime", SAMPLE.mov())).toBe("video/quicktime");
    expect(sniffContentType("video/webm", SAMPLE.webm())).toBe("video/webm");
    expect(sniffContentType("Application/PDF; charset=binary", SAMPLE.pdf())).toBe("application/pdf");
  });

  it("rejects mismatches, truncated headers and unknown types", () => {
    expect(sniffContentType("application/pdf", SAMPLE.exe())).toBeNull();
    expect(sniffContentType("application/pdf", new TextEncoder().encode("%PD"))).toBeNull();
    expect(sniffContentType("image/png", SAMPLE.jpeg())).toBeNull();
    expect(sniffContentType("image/jpeg", SAMPLE.png())).toBeNull();
    expect(sniffContentType("video/mp4", SAMPLE.mov())).toBeNull();
    expect(sniffContentType("video/quicktime", SAMPLE.mp4())).toBeNull();
    expect(sniffContentType("video/webm", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, ...new TextEncoder().encode("matroska")]))).toBeNull();
    expect(sniffContentType("text/html", new TextEncoder().encode("<html>"))).toBeNull();
    expect(sniffContentType("image/png", new Uint8Array(0))).toBeNull();
  });
});

describe("text verification (CSV)", () => {
  it("accepts UTF-8 (with/without BOM) and CP932, rejects NUL and invalid sequences", () => {
    expect(verifyTextFile(SAMPLE.csvUtf8())).toEqual({ encoding: "utf-8" });
    expect(verifyTextFile(new TextEncoder().encode("a,b\n"))).toEqual({ encoding: "utf-8" });
    expect(verifyTextFile(SAMPLE.csvCp932())).toEqual({ encoding: "cp932" });
    expect(verifyTextFile(new Uint8Array([0xb1, 0xb2, 0x0a]))).toEqual({ encoding: "cp932" }); // half-width katakana
    expect(verifyTextFile(new Uint8Array([0x41, 0x00, 0x42]))).toBeNull();
    expect(verifyTextFile(new Uint8Array([0x81]))).toBeNull(); // lead byte without trail
    expect(verifyTextFile(new Uint8Array([0x98, 0x0a]))).toBeNull(); // invalid trail byte
    expect(verifyTextFile(new Uint8Array([0x80, 0x41]))).toBeNull();
    expect(isValidUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toBe(false); // surrogate
    expect(isValidCp932(new Uint8Array([0xfd]))).toBe(false);
  });
});

describe("upload declarations", () => {
  it("checks filename characters, type allowlist per purpose, extension and the smaller of type/purpose limits", () => {
    expect(checkUploadDeclaration({ filename: "資料.pdf", content_type: "application/pdf", size_bytes: 1, purpose: "material" })).toBeNull();
    expect(checkUploadDeclaration({ filename: "a/b.pdf", content_type: "application/pdf", size_bytes: 1, purpose: "material" })?.field_errors.filename).toBeTruthy();
    expect(checkUploadDeclaration({ filename: "a\\b.pdf", content_type: "application/pdf", size_bytes: 1, purpose: "material" })?.field_errors.filename).toBeTruthy();
    expect(checkUploadDeclaration({ filename: "a\u0000.pdf", content_type: "application/pdf", size_bytes: 1, purpose: "material" })?.field_errors.filename).toBeTruthy();
    expect(checkUploadDeclaration({ filename: "noext", content_type: "application/pdf", size_bytes: 1, purpose: "material" })?.field_errors.filename).toContain(".pdf");
    expect(checkUploadDeclaration({ filename: "a.csv", content_type: "text/csv", size_bytes: 1, purpose: "material" })?.field_errors.content_type).toBeTruthy();
    const img = checkUploadDeclaration({ filename: "a.png", content_type: "image/png", size_bytes: 10 * 1024 * 1024 + 1, purpose: "assignment" });
    expect(img?.tooLarge).toBe(true);
    expect(img?.field_errors.size_bytes).toBe("ファイルサイズは10MB以下にしてください。");
  });

  it("builds RFC 5987 Content-Disposition values for Japanese filenames", () => {
    expect(contentDisposition("attachment", "社員教育進捗_2026-10.csv")).toBe(
      `attachment; filename="_______2026-10.csv"; filename*=UTF-8''%E7%A4%BE%E5%93%A1%E6%95%99%E8%82%B2%E9%80%B2%E6%8D%97_2026-10.csv`,
    );
    expect(contentDisposition("inline", 'a"b.pdf')).toContain(`filename="a_b.pdf"`);
    expect(contentDisposition("inline")).toBe("inline");
  });
});

describe("quiz scoring", () => {
  const questions = [
    { id: "11111111-1111-4111-8111-111111111111", prompt: "Q1", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], answer_key: ["b"], points: 3 },
    { id: "22222222-2222-4222-8222-222222222222", prompt: "Q2", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], answer_key: ["a", "c"], points: 1 },
  ];
  it("awards points only for exact answer sets and computes earned/total × 100", () => {
    expect(scoreQuiz(questions, [{ question_id: questions[0]!.id, selected_option_ids: ["b"] }])).toMatchObject({ earned: 3, total: 4, correct: 1, score: 75 });
    expect(scoreQuiz(questions, [{ question_id: questions[1]!.id, selected_option_ids: ["c", "a"] }]).score).toBe(25);
    expect(scoreQuiz(questions, [{ question_id: questions[1]!.id, selected_option_ids: ["a", "b", "c"] }]).score).toBe(0);
    expect(scoreQuiz(questions, []).score).toBe(0);
    const third = [{ ...questions[0]!, points: 1 }, { ...questions[1]!, points: 2 }];
    expect(scoreQuiz(third, [{ question_id: questions[0]!.id, selected_option_ids: ["b"] }]).score).toBe(33.33);
  });
  it("rejects duplicate questions and options with field errors", () => {
    expect(() => scoreQuiz(questions, [
      { question_id: questions[0]!.id, selected_option_ids: ["b"] },
      { question_id: questions[0]!.id, selected_option_ids: ["a"] },
    ])).toThrow(expect.objectContaining({ field_errors: { "answers.1.question_id": "同じ問題への回答が重複しています。" } }));
    expect(() => scoreQuiz(questions, [{ question_id: questions[1]!.id, selected_option_ids: ["a", "a"] }])).toThrow(
      expect.objectContaining({ field_errors: { "answers.0.selected_option_ids": "同じ選択肢が重複しています。" } }),
    );
  });
});
