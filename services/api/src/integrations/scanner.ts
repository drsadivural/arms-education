/** Malware scanning service for uploaded files (owned by the learning module). */
import type { Bindings, Config } from "../env";

export type ScanVerdict = "clean" | "blocked" | "pending";

export interface MalwareScanner {
  /** Submits the object for scanning. Returns the verdict when available synchronously, otherwise "pending". */
  submit(input: { uploadId: string; objectKey: string; downloadUrl: string; sha256?: string }): Promise<ScanVerdict>;
}

export function createMalwareScanner(_env: Bindings, _config: Config): MalwareScanner | null {
  return null;
}
