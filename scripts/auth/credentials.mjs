// Credentials for local/test tooling that creates accounts directly in PostgreSQL (infra/local bootstrap, E2E setup,
// iOS live-test seeding, load tests), in exactly the formats the API reads:
// - passwords (services/api/src/auth/password.ts): scrypt$ln=14,r=8,p=5$<salt b64url>$<key b64url>, NFKC-normalised
// - administrator TOTP secrets (services/api/src/auth/crypto.ts encryptString): v1.<iv>.<ciphertext+tag>, AES-256-GCM
//   with WEB_SESSION_ENCRYPTION_KEY and AAD "totp:<user id>"
// services/api/test/auth-interop.test.ts proves the API accepts both.
import { createCipheriv, randomBytes, scrypt } from "node:crypto";

export function hashPassword(password) {
  const salt = randomBytes(16);
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, 32, { N: 2 ** 14, r: 8, p: 5, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(`scrypt$ln=14,r=8,p=5$${salt.toString("base64url")}$${key.toString("base64url")}`),
    ),
  );
}

/** Upserts the password of an existing app.users row (owner connection). */
export async function setPassword(client, userId, password) {
  await client.query(
    `INSERT INTO app.user_credentials(user_id, password_hash, password_changed_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = now(),
       failed_login_count = 0, locked_until = NULL, updated_at = now()`,
    [userId, await hashPassword(password)],
  );
}

/** AES-256-GCM in the API's "v1.<iv>.<ct+tag>" format (base64url). `keyBase64` is WEB_SESSION_ENCRYPTION_KEY. */
export function encryptForApi(keyBase64, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}`;
}

/** Stores an enrolled administrator TOTP secret (base32), as if the administrator had registered an authenticator. */
export async function setTotpSecret(client, keyBase64, userId, secretBase32) {
  await client.query(
    `INSERT INTO app.user_credentials(user_id, totp_secret_enc, totp_enrolled_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET totp_secret_enc = EXCLUDED.totp_secret_enc, totp_enrolled_at = now(),
       totp_pending_secret_enc = NULL, totp_pending_created_at = NULL, totp_last_step = NULL, updated_at = now()`,
    [userId, encryptForApi(keyBase64, secretBase32, `totp:${userId}`)],
  );
}

/** A random 160-bit TOTP secret in base32 (RFC 4648, no padding). */
export function newTotpSecret() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of randomBytes(20)) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}
