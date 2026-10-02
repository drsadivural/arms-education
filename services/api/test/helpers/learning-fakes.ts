/**
 * Test doubles for the learning integrations. They implement the production interfaces (ObjectStorage,
 * MalwareScanner) so the API code paths are identical; only the transport is in-memory.
 */
import type { ObjectStorage } from "../../src/integrations/storage";
import { ApiError } from "../../src/http/errors";
import { verifyScanCallback, type MalwareScanner, type ScanSubmission, type ScanVerdict } from "../../src/integrations/scanner";

export const TEST_STORAGE_HOST = "https://storage.test.invalid";

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

async function toBytes(body: ReadableStream<Uint8Array> | Uint8Array | string): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** In-memory ObjectStorage. `clientPut` simulates the browser/iOS PUT to the presigned URL. */
export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, StoredObject>();
  readonly presigned: { method: "GET" | "PUT"; key: string; expiresSeconds: number; contentType?: string; sizeBytes?: number; disposition?: string }[] = [];
  readonly deleted: string[] = [];
  failCopy = false;
  /** Number of upcoming put/delete calls that fail (transient storage outage). */
  failPuts = 0;
  failDeletes = 0;

  async presignPut(key: string, contentType: string, sizeBytes: number, expiresSeconds: number) {
    this.presigned.push({ method: "PUT", key, expiresSeconds, contentType, sizeBytes });
    return {
      url: `${TEST_STORAGE_HOST}/${key}?X-Amz-Expires=${expiresSeconds}&X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost&X-Amz-Signature=test`,
      headers: { "Content-Type": contentType },
    };
  }

  async presignGet(key: string, expiresSeconds: number, opts: { filename?: string; contentType?: string; disposition?: "inline" | "attachment" } = {}) {
    this.presigned.push({ method: "GET", key, expiresSeconds, contentType: opts.contentType, disposition: opts.disposition });
    return `${TEST_STORAGE_HOST}/${key}?X-Amz-Expires=${expiresSeconds}&X-Amz-Signature=test`;
  }

  clientPut(key: string, bytes: Uint8Array | string, contentType: string): void {
    this.objects.set(key, { bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes, contentType });
  }

  async head(key: string) {
    const o = this.objects.get(key);
    return o ? { size: o.bytes.length, contentType: o.contentType } : null;
  }

  async readRange(key: string, offset: number, length: number) {
    const o = this.objects.get(key);
    return o ? o.bytes.slice(offset, offset + length) : null;
  }

  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) return null;
    return new Response(o.bytes).body as ReadableStream<Uint8Array>;
  }

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array | string, contentType: string) {
    if (this.failPuts > 0) {
      this.failPuts--;
      throw new ApiError("STORAGE_UNAVAILABLE");
    }
    this.objects.set(key, { bytes: await toBytes(body), contentType });
  }

  async copy(fromKey: string, toKey: string) {
    if (this.failCopy) throw new Error("copy failed");
    const o = this.objects.get(fromKey);
    if (!o) throw new Error(`missing ${fromKey}`);
    this.objects.set(toKey, { bytes: o.bytes, contentType: o.contentType });
  }

  async delete(key: string) {
    if (this.failDeletes > 0) {
      this.failDeletes--;
      throw new Error("delete failed");
    }
    this.deleted.push(key);
    this.objects.delete(key);
  }

  text(key: string): string | null {
    const o = this.objects.get(key);
    return o ? new TextDecoder().decode(o.bytes) : null;
  }

  keys(prefix: string): string[] {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
}

export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/**
 * Scanner double: verdict comes from the actual bytes (EICAR test string → blocked) unless `mode` forces
 * asynchronous ("pending") behaviour; pending verdicts are resolved via `resolve()` + status polling or callbacks.
 */
export class FakeScanner implements MalwareScanner {
  readonly apiKey = "test-scan-api-key";
  readonly submissions: ScanSubmission[] = [];
  readonly verdicts = new Map<string, ScanVerdict>();
  mode: "sync" | "async" | "down" = "sync";
  private seq = 0;

  constructor(private readonly storage: MemoryObjectStorage) {}

  private inspect(key: string): ScanVerdict {
    const text = this.storage.text(key) ?? "";
    return text.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "blocked" : "clean";
  }

  async submit(input: ScanSubmission) {
    if (this.mode === "down") throw new Error("scanner unreachable");
    this.submissions.push(input);
    const scanId = `scan-${++this.seq}`;
    const verdict = this.inspect(input.objectKey);
    if (this.mode === "async") {
      this.verdicts.set(scanId, "pending");
      this.pendingKeys.set(scanId, verdict);
      return { verdict: "pending" as const, scanId };
    }
    this.verdicts.set(scanId, verdict);
    return { verdict, scanId };
  }

  /** Verdict the scanner will report once the asynchronous scan "finishes". */
  readonly pendingKeys = new Map<string, ScanVerdict>();

  finish(scanId: string): ScanVerdict {
    const v = this.pendingKeys.get(scanId) ?? "clean";
    this.verdicts.set(scanId, v);
    return v;
  }

  async status(scanId: string) {
    if (this.mode === "down") throw new Error("scanner unreachable");
    return this.verdicts.get(scanId) ?? "pending";
  }

  verifyCallback(input: { timestamp: string | null | undefined; signature: string | null | undefined; rawBody: string; now: Date }) {
    return verifyScanCallback({ apiKey: this.apiKey, ...input });
  }
}

// ---- sample file bytes ------------------------------------------------------------------------

const enc = new TextEncoder();
function concat(...parts: (Uint8Array | number[] | string)[]): Uint8Array {
  const arrays = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

export const SAMPLE = {
  pdf: () => concat("%PDF-1.7\n%âãÏÓ\n1 0 obj << /Type /Catalog >> endobj\n", "trailer << >>\n%%EOF\n"),
  png: () => concat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR", new Uint8Array(17)),
  jpeg: () => concat([0xff, 0xd8, 0xff, 0xe0, 0, 16], "JFIF\0", new Uint8Array(20)),
  mp4: () => concat([0, 0, 0, 0x18], "ftypisom", [0, 0, 2, 0], "isomiso2", new Uint8Array(32)),
  mov: () => concat([0, 0, 0, 0x14], "ftypqt  ", [0, 0, 2, 0], "qt  ", new Uint8Array(32)),
  webm: () => concat([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84], "webm", new Uint8Array(16)),
  csvUtf8: () => concat([0xef, 0xbb, 0xbf], "社員番号,氏名\r\nE-1,和田 一夫\r\n"),
  csvCp932: () => concat("E-1,", [0x98, 0x61, 0x93, 0x63], "\r\n"),
  exe: () => concat("MZ", new Uint8Array(64)),
  eicarPdf: () => concat("%PDF-1.4\n", EICAR, "\n%%EOF\n"),
};
