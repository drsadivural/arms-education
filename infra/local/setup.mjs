// Generates local-only secrets: GoTrue ES256 signing key (+ HS256 secret for the service_role admin token),
// the web-session encryption key and wrangler .dev.vars. Never use these values outside local development.
import { writeFileSync, existsSync } from "node:fs";
import { webcrypto as crypto, randomBytes, createHmac } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const envFile = join(here, ".env.local");
const devVars = join(root, "services", "api", ".dev.vars");
if (existsSync(envFile) && !process.argv.includes("--force")) {
  console.info("infra/local/.env.local already exists (use --force to regenerate)");
  process.exit(0);
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
const signingKey = { ...jwk, kid: `arms-local-${Date.now()}`, alg: "ES256", use: "sig", key_ops: ["sign", "verify"] };
delete signingKey.ext;
const hsSecret = randomBytes(48).toString("base64url");
const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const now = Math.floor(Date.now() / 1000);
const payload = b64url(JSON.stringify({ role: "service_role", iss: "http://localhost:9999", iat: now, exp: now + 10 * 365 * 24 * 3600 }));
const serviceRoleJwt = `${header}.${payload}.${createHmac("sha256", hsSecret).update(`${header}.${payload}`).digest("base64url")}`;

// Like hosted Supabase: user tokens are signed with the ES256 key; the HS256 secret is a verify-only key that
// lets the local service_role admin token authenticate. The ARMS API itself only accepts asymmetric tokens.
const legacyKey = { kty: "oct", k: Buffer.from(hsSecret).toString("base64url"), alg: "HS256", kid: "arms-local-legacy-hs256", key_ops: ["verify"] };
const scannerKey = randomBytes(32).toString("base64url");
writeFileSync(
  envFile,
  `GOTRUE_JWT_SECRET=${hsSecret}\nGOTRUE_JWT_KEYS=${JSON.stringify([signingKey, legacyKey])}\nGOTRUE_JWT_VALID_METHODS=ES256,HS256\nSCANNER_API_KEY=${scannerKey}\n`,
  { mode: 0o600 },
);
writeFileSync(
  devVars,
  [
    "APP_ENV=development",
    "APP_ORIGIN=http://localhost:5188",
    "DATABASE_URL=postgres://arms_app:arms_app_dev_pw@127.0.0.1:55433/arms",
    "SUPABASE_URL=http://localhost:9999",
    "SUPABASE_AUTH_URL=http://localhost:9999",
    "SUPABASE_AUTH_ISSUER=http://localhost:9999",
    "SUPABASE_AUTH_AUDIENCE=authenticated",
    "SUPABASE_PUBLISHABLE_KEY=local-dev",
    `SUPABASE_ADMIN_SECRET=${serviceRoleJwt}`,
    "AUTH_REDIRECT_URL=http://localhost:5188/auth/callback",
    `WEB_SESSION_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    `DEVICE_TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    "R2_S3_ENDPOINT=http://127.0.0.1:9100",
    "R2_BUCKET_NAME=arms-materials",
    "R2_ACCESS_KEY_ID=arms-minio",
    "R2_SECRET_ACCESS_KEY=arms-minio-dev-pw",
    "MALWARE_SCAN_URL=http://127.0.0.1:9200",
    `MALWARE_SCAN_API_KEY=${scannerKey}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.info("wrote infra/local/.env.local and services/api/.dev.vars");
