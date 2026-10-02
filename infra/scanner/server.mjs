// ARMS malware-scan adapter: implements the scanner HTTP protocol expected by services/api
// (src/integrations/scanner.ts) on top of ClamAV's clamd (INSTREAM). No dependencies; Node ≥ 20.
//
//   POST /scans      {upload_id, download_url, callback_url?, sha256?}  → 202 {scan_id, status: "scanning"}
//   GET  /scans/:id  → {scan_id, status: "scanning" | "clean" | "infected" | "error"}
//   Callback (when callback_url is given): POST callback_url {scan_id, upload_id, status, signature_name?}
//     X-ARMS-Scan-Timestamp: <unix seconds>
//     X-ARMS-Scan-Signature: v1=<hex HMAC-SHA256(SCANNER_API_KEY, timestamp + "." + body)>
//
// Env: SCANNER_API_KEY (required), PORT (9200), CLAMD_HOST (127.0.0.1), CLAMD_PORT (3310), MAX_BYTES (220 MB).
// Results are kept in memory for 24 h; after a restart the API's polling sees 404 and the upload stays pending
// (never "clean") until it is re-submitted. Scan errors are reported as "error", which the API treats as pending.
import { createServer } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { connect } from "node:net";

const API_KEY = process.env.SCANNER_API_KEY ?? "";
const PORT = Number(process.env.PORT ?? 9200);
const CLAMD_HOST = process.env.CLAMD_HOST ?? "127.0.0.1";
const CLAMD_PORT = Number(process.env.CLAMD_PORT ?? 3310);
const MAX_BYTES = Number(process.env.MAX_BYTES ?? 220 * 1024 * 1024);
const TTL_MS = 24 * 60 * 60 * 1000;
if (API_KEY.length < 16) {
  console.error("SCANNER_API_KEY (≥16 chars) is required");
  process.exit(1);
}

/** @type {Map<string, {status: string, uploadId: string, signatureName?: string, at: number}>} */
const scans = new Map();
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, s] of scans) if (s.at < cutoff) scans.delete(id);
}, 60_000).unref();

function authorised(req) {
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${API_KEY}`;
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** Streams bytes to clamd with the INSTREAM command; resolves {status, signatureName}. */
function clamdScan(body) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: CLAMD_HOST, port: CLAMD_PORT });
    let reply = "";
    sock.setTimeout(120_000, () => sock.destroy(new Error("clamd timeout")));
    sock.on("error", reject);
    sock.on("data", (d) => (reply += d.toString("utf8")));
    sock.on("end", () => {
      const line = reply.replace(/\0/g, "").trim(); // e.g. "stream: OK" | "stream: Eicar-Test-Signature FOUND"
      if (/: OK$/.test(line)) resolve({ status: "clean" });
      else if (/ FOUND$/.test(line)) resolve({ status: "infected", signatureName: line.replace(/^stream: /, "").replace(/ FOUND$/, "") });
      else reject(new Error(`unexpected clamd reply: ${line.slice(0, 100)}`));
    });
    sock.on("connect", () => {
      sock.write("zINSTREAM\0");
      const chunk = 64 * 1024;
      for (let i = 0; i < body.length; i += chunk) {
        const part = body.subarray(i, i + chunk);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
    });
  });
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) throw new Error("file too large");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("file too large");
  return buf;
}

async function sendCallback(url, payload) {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `v1=${createHmac("sha256", API_KEY).update(`${ts}.${body}`).digest("hex")}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-ARMS-Scan-Timestamp": ts, "X-ARMS-Scan-Signature": signature }, body });
      if (res.ok) return;
    } catch {
      // retry; the API also polls GET /scans/:id
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function runScan(id, req) {
  const entry = scans.get(id);
  try {
    const result = await clamdScan(await download(req.download_url));
    Object.assign(entry, result, { at: Date.now() });
  } catch (e) {
    Object.assign(entry, { status: "error", at: Date.now() });
    console.error(JSON.stringify({ msg: "scan_failed", scan_id: id, error: String(e.message).slice(0, 200) }));
  }
  console.info(JSON.stringify({ msg: "scan_done", scan_id: id, upload_id: req.upload_id, status: entry.status }));
  if (req.callback_url && entry.status !== "error") {
    await sendCallback(req.callback_url, { scan_id: id, upload_id: req.upload_id, status: entry.status, ...(entry.signatureName ? { signature_name: entry.signatureName } : {}) });
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
    if (!authorised(req)) return json(res, 401, { error: "unauthorized" });
    if (req.method === "POST" && req.url === "/scans") {
      const body = await readJson(req);
      if (typeof body.download_url !== "string" || !/^https?:\/\//.test(body.download_url) || typeof body.upload_id !== "string") {
        return json(res, 422, { error: "upload_id and download_url are required" });
      }
      const id = randomUUID();
      scans.set(id, { status: "scanning", uploadId: body.upload_id, at: Date.now() });
      void runScan(id, body);
      return json(res, 202, { scan_id: id, status: "scanning" });
    }
    const m = /^\/scans\/([0-9a-f-]{36})$/.exec(req.url ?? "");
    if (req.method === "GET" && m) {
      const s = scans.get(m[1]);
      if (!s) return json(res, 404, { error: "not found" });
      return json(res, 200, { scan_id: m[1], status: s.status, ...(s.signatureName ? { signature_name: s.signatureName } : {}) });
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: String(e.message).slice(0, 100) });
  }
}).listen(PORT, () => console.info(JSON.stringify({ msg: "scanner_adapter_listening", port: PORT, clamd: `${CLAMD_HOST}:${CLAMD_PORT}` })));
