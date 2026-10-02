/**
 * Real S3 SigV4 presign path against the local S3 service (SeaweedFS) from infra/local/compose.yaml (stands in for R2).
 * Skipped only when it is unreachable (the skip reason is printed). Override with TEST_S3_ENDPOINT etc.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createObjectStorage, createS3Storage, isR2Endpoint, type ObjectStorage } from "../../src/integrations/storage";
import { loadConfig } from "../../src/env";
import { SAMPLE } from "../helpers/learning-fakes";

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:9100";
const BUCKET = process.env.TEST_S3_BUCKET ?? "arms-materials";
const KEY_ID = process.env.TEST_S3_ACCESS_KEY_ID ?? "arms-s3";
const SECRET = process.env.TEST_S3_SECRET_ACCESS_KEY ?? "arms-s3-local-only";

async function reachable(): Promise<boolean> {
  try {
    // Any HTTP answer (an unsigned request is refused with 403) means the S3 endpoint is up.
    await fetch(`${ENDPOINT}/`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

const available = await reachable();
if (!available) console.warn(`[storage-s3] S3 service not reachable at ${ENDPOINT} — real presign tests skipped`);

describe.skipIf(!available)("S3 presigned URLs against the local S3 service", () => {
  let storage: ObjectStorage;
  const org = crypto.randomUUID();

  beforeAll(() => {
    storage = createS3Storage({ endpoint: ENDPOINT, bucket: BUCKET, accessKeyId: KEY_ID, secretAccessKey: SECRET });
  });

  it("uploads through a presigned PUT whose Content-Type and Content-Length are signed", async () => {
    const key = `quarantine/${org}/${crypto.randomUUID()}`;
    const bytes = SAMPLE.pdf();
    const { url, headers } = await storage.presignPut(key, "application/pdf", bytes.length, 900);
    expect(url).toContain("X-Amz-Expires=900");
    expect(decodeURIComponent(url)).toContain("X-Amz-SignedHeaders=content-length;content-type;host");
    expect(url).not.toContain(SECRET);

    // A different size or type than declared is refused by the storage service itself.
    const wrongType = await fetch(url, { method: "PUT", headers: { "Content-Type": "text/html" }, body: bytes });
    expect(wrongType.status).toBe(403);
    const longer = new Uint8Array(bytes.length + 5);
    const wrongSize = await fetch(url, { method: "PUT", headers, body: longer });
    expect(wrongSize.status).toBe(403);

    const put = await fetch(url, { method: "PUT", headers, body: bytes });
    expect(put.status).toBe(200);
    expect(await storage.head(key)).toEqual({ size: bytes.length, contentType: "application/pdf" });
    expect(new TextDecoder().decode(await storage.readRange(key, 0, 5) ?? new Uint8Array())).toBe("%PDF-");
    expect((await storage.readRange(key, 1, 3))?.length).toBe(3);

    const moved = `materials/${org}/${crypto.randomUUID()}`;
    await storage.copy(key, moved);
    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
    expect((await storage.head(moved))?.size).toBe(bytes.length);

    const getUrl = await storage.presignGet(moved, 300, { filename: "情報セキュリティ基本ガイド.pdf", contentType: "application/pdf", disposition: "attachment" });
    expect(getUrl).toContain("X-Amz-Expires=300");
    const got = await fetch(getUrl);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("application/pdf");
    expect(got.headers.get("content-disposition")).toContain("filename*=UTF-8''%E6%83%85%E5%A0%B1");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    // Tampering with the signed query (e.g. extending the expiry) invalidates the URL.
    const tampered = await fetch(getUrl.replace("X-Amz-Expires=300", "X-Amz-Expires=3000"));
    expect(tampered.status).toBe(403);
    // Unsigned access to the private bucket is refused.
    expect((await fetch(`${ENDPOINT}/${BUCKET}/${moved}`)).status).toBe(403);
    await storage.delete(moved);
  });

  it("puts and streams server-side objects (exports) and reports missing objects as null", async () => {
    const key = `exports/${org}/${crypto.randomUUID()}.csv`;
    await storage.put(key, "﻿\"終了予定日\"\r\n", "text/csv; charset=utf-8");
    const stream = await storage.get(key);
    expect(new TextDecoder("utf-8", { ignoreBOM: true, fatal: false }).decode(new Uint8Array(await new Response(stream).arrayBuffer()))).toBe("﻿\"終了予定日\"\r\n");
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
    expect(await storage.readRange(key, 0, 4)).toBeNull();
    await storage.delete(key); // idempotent
  });

  it("is built from Worker configuration and is null when not configured", () => {
    const config = loadConfig({ APP_ENV: "test" });
    expect(createObjectStorage({}, config)).toBeNull();
    expect(createObjectStorage({ R2_S3_ENDPOINT: ENDPOINT, R2_BUCKET_NAME: BUCKET, R2_ACCESS_KEY_ID: KEY_ID }, config)).toBeNull();
    expect(createObjectStorage({ R2_S3_ENDPOINT: ENDPOINT, R2_BUCKET_NAME: BUCKET, R2_ACCESS_KEY_ID: KEY_ID, R2_SECRET_ACCESS_KEY: SECRET }, config)).not.toBeNull();
    expect(isR2Endpoint("https://abc123.r2.cloudflarestorage.com")).toBe(true);
    expect(isR2Endpoint(ENDPOINT)).toBe(false);
  });
});
