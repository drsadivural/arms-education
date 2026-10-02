// Fails when tracked files contain credentials. Run in CI before any push/deploy (AGENTS.md rule 9).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const PATTERNS = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ["OpenAI API key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Resend API key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/],
  ["service_role JWT", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]*cm9sZSI6InNlcnZpY2Vfcm9sZS[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{20,}/],
  ["Cloudflare API token assignment", /CLOUDFLARE_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{30,}/],
  // ARMS's own opaque tokens (services/api/src/auth/tokens.ts): access, refresh and e-mail link tokens.
  ["ARMS token", /\barms_(?:at|rt|lt)_[A-Za-z0-9_-]{43}\b/],
  ["scrypt password hash", /scrypt\$ln=\d+,r=\d+,p=\d+\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}/],
];
const SKIP = [/^design\//, /^assets\//, /\.(png|jpg|jpeg|otf|ttf|woff2?|pdf|ico)$/i, /pnpm-lock\.yaml$/, /^apps\/ios\/.*\.xcassets\//];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const findings = [];
for (const file of files) {
  if (SKIP.some((re) => re.test(file))) continue;
  let text;
  try {
    if (statSync(file).size > 5_000_000) continue;
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const [name, re] of PATTERNS) {
    const m = re.exec(text);
    if (m) findings.push(`${file}: ${name} (${m[0].slice(0, 12)}…)`);
  }
}
if (findings.length) {
  console.error(`Secret scan failed:\n${findings.join("\n")}`);
  process.exit(1);
}
console.info(`Secret scan passed (${files.length} tracked files).`);
