// Generates local-only secrets: the web-session encryption key, the scanner and mail-relay API keys, and wrangler
// .dev.vars. Never use these values outside local development.
import { writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
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

const scannerKey = randomBytes(32).toString("base64url");
const mailKey = randomBytes(32).toString("base64url");
writeFileSync(envFile, `SCANNER_API_KEY=${scannerKey}\nMAIL_RELAY_API_KEY=${mailKey}\n`, { mode: 0o600 });
writeFileSync(
  devVars,
  [
    "APP_ENV=development",
    "APP_ORIGIN=http://localhost:5188",
    "DATABASE_URL=postgres://arms_app:arms_app_dev_pw@127.0.0.1:55433/arms",
    `WEB_SESSION_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    `DEVICE_TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    "R2_S3_ENDPOINT=http://127.0.0.1:9100",
    "R2_BUCKET_NAME=arms-materials",
    "R2_ACCESS_KEY_ID=arms-s3", // infra/local/seaweedfs/s3.json
    "R2_SECRET_ACCESS_KEY=arms-s3-local-only",
    "MALWARE_SCAN_URL=http://127.0.0.1:9200",
    `MALWARE_SCAN_API_KEY=${scannerKey}`,
    "MAIL_PROVIDER_URL=http://127.0.0.1:9025",
    `MAIL_PROVIDER_API_KEY=${mailKey}`,
    "MAIL_FROM=ARMS 新入社員研修システム <noreply@arms.local>",
    "",
  ].join("\n"),
  { mode: 0o600 },
);
console.info("wrote infra/local/.env.local and services/api/.dev.vars");
