/**
 * Password hashing with scrypt (node:crypto; available in Workers through nodejs_compat and in Node).
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet equivalent for a 16 MiB budget: N=2^14, r=8, p=5
 * (Workers isolates cannot allocate the 128 MiB that N=2^17 needs). About 170 ms of CPU per hash, so the Worker
 * needs the Workers Paid CPU limit. Stored format (PHC-like, parameters embedded so they can be raised later):
 *   scrypt$ln=14,r=8,p=5$<salt base64url>$<key base64url>
 * Passwords are NFKC-normalised before hashing so the same password typed on different keyboards matches.
 */
import { scrypt, timingSafeEqual } from "node:crypto";
import { base64UrlDecode, base64UrlEncode } from "./crypto";

const CURRENT = { ln: 14, r: 8, p: 5 } as const;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MAX_MEMORY = 64 * 1024 * 1024;

interface Params {
  ln: number;
  r: number;
  p: number;
}

function derive(password: string, salt: Uint8Array, params: Params): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N: 2 ** params.ln, r: params.r, p: params.p, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(new Uint8Array(key)),
    );
  });
}

function parse(stored: string): { params: Params; salt: Uint8Array; key: Uint8Array } | null {
  const m = /^scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) return null;
  const params = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  // Refuse parameters outside what this Worker can compute (corrupt or tampered rows).
  if (params.ln < 10 || params.ln > 16 || params.r < 1 || params.r > 16 || params.p < 1 || params.p > 16) return null;
  return { params, salt: base64UrlDecode(m[4] as string), key: base64UrlDecode(m[5] as string) };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const key = await derive(password, salt, CURRENT);
  return `scrypt$ln=${CURRENT.ln},r=${CURRENT.r},p=${CURRENT.p}$${base64UrlEncode(salt)}$${base64UrlEncode(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.params);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

/** True when the stored hash uses older parameters and should be replaced after a successful sign-in. */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !parsed || parsed.params.ln !== CURRENT.ln || parsed.params.r !== CURRENT.r || parsed.params.p !== CURRENT.p;
}

let dummy: Promise<string> | null = null;
/**
 * Spends the same work as a real verification for unknown e-mail addresses and accounts without a password, so
 * response timing does not reveal which addresses are registered.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword("arms-timing-equaliser-0");
  await verifyPassword(password, await dummy);
}
