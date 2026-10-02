import { describe, expect, it } from "vitest";
import { encryptForApi, hashPassword as hashFromTooling, newTotpSecret } from "../../../scripts/auth/credentials.mjs";
import { decryptString } from "../src/auth/crypto";
import { base32Decode } from "../src/auth/totp";
import { hashPassword, needsRehash, verifyPassword } from "../src/auth/password";

describe("password hashes", () => {
  it("accepts hashes written by the Node tooling (bootstrap/E2E/seed scripts) and the API's own, NFKC-normalised", async () => {
    const tooling = await hashFromTooling("Ｐａｓｓ-word-2026");
    expect(tooling).toMatch(/^scrypt\$ln=14,r=8,p=5\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword("Pass-word-2026", tooling)).toBe(true);
    expect(await verifyPassword("Pass-word-2027", tooling)).toBe(false);
    expect(needsRehash(tooling)).toBe(false);
    const own = await hashPassword("Pass-word-2026");
    expect(own).not.toBe(tooling);
    expect(await verifyPassword("Ｐａｓｓ-word-2026", own)).toBe(true);
  });

  it("refuses malformed or out-of-range stored hashes and flags older parameters for rehash", async () => {
    expect(await verifyPassword("x", "plain-text")).toBe(false);
    expect(await verifyPassword("x", "scrypt$ln=30,r=8,p=1$AAAA$AAAA")).toBe(false);
    expect(needsRehash("scrypt$ln=13,r=8,p=5$AAAAAAAAAAAAAAAAAAAAAA$AAAA")).toBe(true);
  });

  it("decrypts TOTP secrets written by the tooling with the session key and the user-bound AAD", async () => {
    const key = Buffer.alloc(32, 3).toString("base64");
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    const enc = encryptForApi(key, secret, "totp:user-1");
    expect(await decryptString(key, enc, "totp:user-1")).toBe(secret);
    await expect(decryptString(key, enc, "totp:user-2")).rejects.toThrow();
  });
});
