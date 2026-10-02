/**
 * Administrator TOTP (RFC 6238 / RFC 4226): HMAC-SHA1, 6 digits, 30-second steps — the defaults every
 * authenticator app supports. Secrets are 160 random bits (RFC 4226 §4), exchanged as base32 in an otpauth:// URI
 * shown as a QR code. Verification accepts the current step ±1 (clock drift) and only steps newer than the last
 * accepted one, so a code can never be used twice.
 */
import { renderSVG } from "uqr";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD_SECONDS = 30;
const DIGITS = 6;
const DRIFT_STEPS = 1;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** HOTP value for one counter (RFC 4226 §5.3 dynamic truncation). */
export async function hotp(secretBase32: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secretBase32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) | ((mac[offset + 1] as number) << 16) | ((mac[offset + 2] as number) << 8) | (mac[offset + 3] as number);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Returns the matched time step, or null. `lastStep` is the newest step accepted before (replay protection).
 * Every candidate is computed and compared without early exit.
 */
export async function verifyTotp(secretBase32: string, code: string, nowMs: number, lastStep: number | null): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const current = timeStep(nowMs);
  let matched: number | null = null;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
    const expected = await hotp(secretBase32, step);
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) diff |= expected.charCodeAt(i) ^ code.charCodeAt(i);
    if (diff === 0 && (lastStep === null || step > lastStep) && matched === null) matched = step;
  }
  return matched;
}

/** otpauth:// URI (Key Uri Format) shown as the QR code and as text for manual entry. */
export function otpauthUri(secretBase32: string, account: string, issuer = "ARMS"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The URI as an SVG QR code data URL (rendered by the Web app in an <img>; CSP img-src allows data:). */
export function qrCodeDataUrl(text: string): string {
  const svg = renderSVG(text, { ecc: "M", border: 2, pixelSize: 6 });
  const bytes = new TextEncoder().encode(svg);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}
