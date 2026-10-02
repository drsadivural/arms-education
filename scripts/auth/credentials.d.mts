/** Types for credentials.mjs (local/test tooling; formats verified by services/api/test/auth-interop.test.ts). */
interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}
export function hashPassword(password: string): Promise<string>;
export function setPassword(client: Queryable, userId: string, password: string): Promise<void>;
export function encryptForApi(keyBase64: string, plaintext: string, aad: string): string;
export function setTotpSecret(client: Queryable, keyBase64: string, userId: string, secretBase32: string): Promise<void>;
export function newTotpSecret(): string;
