/** WebCrypto helpers (available in Workers and Node ≥ 20). */
const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Cryptographically random token, base64url (default 32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings of equal expected length. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function aesKey(base64Key: string): Promise<CryptoKey> {
  let k = keyCache.get(base64Key);
  if (!k) {
    k = crypto.subtle.importKey("raw", base64UrlDecode(base64Key), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    keyCache.set(base64Key, k);
  }
  return k;
}

/** AES-256-GCM; output "v1.<iv>.<ciphertext>" (base64url). `aad` binds the ciphertext to its owner. */
export async function encryptString(base64Key: string, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(base64Key), enc.encode(plaintext));
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ct))}`;
}

export async function decryptString(base64Key: string, payload: string, aad: string): Promise<string> {
  const [version, ivText, ctText] = payload.split(".");
  if (version !== "v1" || !ivText || !ctText) throw new Error("Unsupported ciphertext");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(ivText), additionalData: enc.encode(aad) },
    await aesKey(base64Key),
    base64UrlDecode(ctText),
  );
  return dec.decode(pt);
}
