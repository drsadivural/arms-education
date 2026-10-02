import { afterEach, describe, expect, it, vi } from "vitest";
import { MATERIAL_FILE_RULES, UploadTransferError, acceptFor, checkMaterialFile, isUploadSettled, kindForFile, putFile } from "../src/features/learning/upload";

const MB = 1024 * 1024;
const file = (name: string, type: string, size: number) => ({ name, type, size });

describe("client-side material file checks (mirror of the server limits)", () => {
  it("accepts allowed types within the per-kind limits (PDF 20MB, 動画 200MB, 画像 10MB)", () => {
    expect(checkMaterialFile("pdf", file("manual.pdf", "application/pdf", 20 * MB))).toEqual({ ok: true, contentType: "application/pdf" });
    expect(checkMaterialFile("video", file("intro.mp4", "video/mp4", 200 * MB))).toEqual({ ok: true, contentType: "video/mp4" });
    expect(checkMaterialFile("image", file("photo.JPG", "image/jpeg", 10 * MB))).toEqual({ ok: true, contentType: "image/jpeg" });
    expect(MATERIAL_FILE_RULES.pdf.maxBytes).toBe(20 * MB);
  });

  it("rejects oversized files with a Japanese message", () => {
    expect(checkMaterialFile("pdf", file("big.pdf", "application/pdf", 20 * MB + 1))).toEqual({ ok: false, message: "PDFのファイルサイズは20MB以下にしてください。" });
    expect(checkMaterialFile("image", file("big.png", "image/png", 10 * MB + 1))).toEqual({ ok: false, message: "画像のファイルサイズは10MB以下にしてください。" });
    expect(checkMaterialFile("video", file("big.webm", "video/webm", 200 * MB + 1))).toEqual({ ok: false, message: "動画のファイルサイズは200MB以下にしてください。" });
  });

  it("rejects disallowed types, extension mismatches, empty files and unsafe names", () => {
    expect(checkMaterialFile("pdf", file("memo.txt", "text/plain", 10)).ok).toBe(false);
    expect(checkMaterialFile("image", file("photo.png", "image/jpeg", 10))).toEqual({ ok: false, message: "拡張子がファイル形式と一致しません（.jpg・.jpeg）。" });
    expect(checkMaterialFile("pdf", file("empty.pdf", "application/pdf", 0))).toEqual({ ok: false, message: "空のファイルはアップロードできません。" });
    expect(checkMaterialFile("pdf", file(" lead.pdf", "application/pdf", 10)).ok).toBe(false);
  });

  it("falls back to the extension when the browser reports no type (e.g. .mov)", () => {
    expect(checkMaterialFile("video", file("clip.mov", "", 5 * MB))).toEqual({ ok: true, contentType: "video/quicktime" });
    expect(kindForFile({ name: "clip.mov", type: "" })).toBe("video");
    expect(kindForFile({ name: "doc.pdf", type: "application/pdf" })).toBe("pdf");
    expect(kindForFile({ name: "sheet.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBeNull();
    expect(acceptFor("image")).toBe("image/png,image/jpeg,.png,.jpg,.jpeg");
  });

  it("treats scanning/awaiting uploads as unsettled for polling", () => {
    expect(isUploadSettled("scanning")).toBe(false);
    expect(isUploadSettled("awaiting_upload")).toBe(false);
    expect(isUploadSettled("clean")).toBe(true);
    expect(isUploadSettled("blocked")).toBe(true);
  });
});

class FakeXhr {
  static last: FakeXhr | null = null;
  status = 0;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
}

describe("presigned PUT with progress", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends exactly the required headers and reports byte progress", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const progress: number[] = [];
    const blob = new Blob(["%PDF-1.4"]);
    const done = putFile({ upload_url: "https://storage.example/quarantine/x?sig=1", required_headers: { "Content-Type": "application/pdf" } }, blob, (f) => progress.push(f));
    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe("https://storage.example/quarantine/x?sig=1");
    expect(xhr.headers).toEqual({ "Content-Type": "application/pdf" });
    expect(xhr.body).toBe(blob);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 8 });
    xhr.status = 200;
    xhr.onload?.();
    await done;
    expect(progress).toEqual([0.5, 1]);
  });

  it("fails with a Japanese message when storage rejects the upload or the network fails", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const rejected = putFile({ upload_url: "https://s/x", required_headers: {} }, new Blob(["x"]), () => undefined);
    FakeXhr.last!.status = 403;
    FakeXhr.last!.onload?.();
    await expect(rejected).rejects.toThrow(UploadTransferError);
    await expect(rejected).rejects.toMatchObject({ messageJa: "ファイルの送信に失敗しました（保管サービスの応答 403）。もう一度ファイルを選択してください。" });

    const offline = putFile({ upload_url: "https://s/x", required_headers: {} }, new Blob(["x"]), () => undefined);
    FakeXhr.last!.onerror?.();
    await expect(offline).rejects.toMatchObject({ messageJa: "ファイルを送信できませんでした。ネットワーク接続を確認して、もう一度お試しください。" });
  });

  it("can be aborted", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const ac = new AbortController();
    const p = putFile({ upload_url: "https://s/x", required_headers: {} }, new Blob(["x"]), () => undefined, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
