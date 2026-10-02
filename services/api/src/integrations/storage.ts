/** Private R2 object storage for materials, submissions and import files (owned by the learning module). */
import type { Bindings, Config } from "../env";

export interface ObjectStorage {
  /** Short-lived presigned PUT URL for direct client upload into the quarantine prefix. */
  presignPut(key: string, contentType: string, sizeBytes: number, expiresSeconds: number): Promise<{ url: string; headers: Record<string, string> }>;
  /** Short-lived presigned GET URL (served only after the API has authorised the caller). */
  presignGet(key: string, expiresSeconds: number, opts?: { filename?: string; contentType?: string }): Promise<string>;
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  /** Reads a byte range (used for magic-byte verification). */
  readRange(key: string, offset: number, length: number): Promise<Uint8Array | null>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array | string, contentType: string): Promise<void>;
  copy(fromKey: string, toKey: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createObjectStorage(_env: Bindings, _config: Config): ObjectStorage | null {
  return null;
}
