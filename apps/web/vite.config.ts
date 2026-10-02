import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Pins the inline theme bootstrap script in the CSP of public/_headers (no 'unsafe-inline' for scripts). */
function cspInlineScriptHash(): Plugin {
  let outDir = "dist";
  return {
    name: "arms-csp-inline-hash",
    apply: "build",
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
      const hashes = inline.map((s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`).join(" ");
      const headersPath = join(outDir, "_headers");
      writeFileSync(headersPath, readFileSync(headersPath, "utf8").replace("'sha256-REPLACED_AT_BUILD'", hashes));
    },
  };
}

const webPort = Number(process.env.ARMS_WEB_PORT ?? 5188);
const apiPort = Number(process.env.ARMS_API_PORT ?? 8787);

export default defineConfig({
  plugins: [react(), tailwindcss(), cspInlineScriptHash()],
  server: {
    port: webPort,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  build: { sourcemap: false, target: "es2022" },
  test: {
    // globals: Testing Library registers automatic cleanup between tests.
    globals: true,
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
