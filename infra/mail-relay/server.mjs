// Local/CI mail relay: implements the Resend-compatible API the Worker uses (services/api/src/integrations/mail.ts)
// and hands every message to Mailpit's HTTP send API, so invitation, password-reset and notification e-mails can be
// read at http://localhost:8025. Development only — production uses a real transactional mail provider.
//
//   POST /emails  Authorization: Bearer <MAIL_RELAY_API_KEY>  Idempotency-Key: <key>
//                 {"from": "Name <addr>", "to": ["addr"], "subject": "…", "text": "…"} → 200 {"id": "…"}
//   GET  /health  → 200 when Mailpit answers
//
// Env: MAIL_RELAY_API_KEY (required, ≥16 chars), PORT (9025), MAILPIT_URL (http://mailpit:8025).
// Idempotency keys are remembered for 24 h, like the real provider, so outbox retries never send twice.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const API_KEY = process.env.MAIL_RELAY_API_KEY ?? "";
const PORT = Number(process.env.PORT ?? 9025);
const MAILPIT = (process.env.MAILPIT_URL ?? "http://mailpit:8025").replace(/\/+$/, "");
if (API_KEY.length < 16) {
  console.error("MAIL_RELAY_API_KEY (≥16 chars) is required");
  process.exit(1);
}

/** @type {Map<string, {id: string, at: number}>} */
const sent = new Map();
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [k, v] of sent) if (v.at < cutoff) sent.delete(k);
}, 60_000).unref();

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function authorised(req) {
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${API_KEY}`;
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** "Name <addr@example>" or "addr@example" → Mailpit address object. */
function address(value) {
  const m = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  return m ? { Name: m[1].replace(/^"|"$/g, ""), Email: m[2] } : { Email: value.trim() };
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      const up = await fetch(`${MAILPIT}/api/v1/info`).then((r) => r.ok, () => false);
      return json(res, up ? 200 : 503, { ok: up });
    }
    if (req.method !== "POST" || req.url !== "/emails") return json(res, 404, { message: "not found" });
    if (!authorised(req)) return json(res, 401, { message: "invalid api key" });
    const body = await readJson(req);
    const to = Array.isArray(body.to) ? body.to : [body.to];
    if (typeof body.from !== "string" || !to.length || to.some((t) => typeof t !== "string" || !t.includes("@")) || typeof body.subject !== "string") {
      return json(res, 422, { message: "from, to and subject are required" });
    }
    const key = req.headers["idempotency-key"];
    if (typeof key === "string" && sent.has(key)) return json(res, 200, { id: sent.get(key).id });
    const r = await fetch(`${MAILPIT}/api/v1/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ From: address(body.from), To: to.map(address), Subject: body.subject, Text: String(body.text ?? "") }),
    });
    if (!r.ok) return json(res, 502, { message: `mailpit ${r.status}` });
    const { ID: id } = await r.json();
    if (typeof key === "string") sent.set(key, { id, at: Date.now() });
    // Addresses are not logged.
    console.info(JSON.stringify({ msg: "mail_relayed", id, recipients: to.length }));
    return json(res, 200, { id });
  } catch (e) {
    return json(res, 500, { message: e instanceof Error ? e.message : "error" });
  }
}).listen(PORT, () => console.info(JSON.stringify({ msg: "mail_relay_listening", port: PORT })));
