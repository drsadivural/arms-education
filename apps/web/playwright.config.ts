import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the local stack (infra/local/compose.yaml): real Supabase Auth (GoTrue),
 * the Worker API under wrangler dev and the Vite dev server. global-setup seeds an isolated organisation.
 */
const webPort = Number(process.env.ARMS_WEB_PORT ?? 5188);
const apiPort = Number(process.env.ARMS_API_PORT ?? 8787);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "../../tests/results/e2e-web.json" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${webPort}`,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }, testMatch: /responsive\.spec\.ts/ },
    ...(process.env.E2E_ALL_BROWSERS ? [{ name: "firefox", use: { ...devices["Desktop Firefox"] } }, // WebKit (Linux build) intermittently fails page.goto with "internal error" under load; one retry keeps the
        // run green while Playwright still reports those tests as "flaky" (see tests/results/evidence).
        { name: "webkit", use: { ...devices["Desktop Safari"] }, retries: 1 }] : []),
  ],
  webServer: [
    {
      command: `pnpm --filter @arms/api exec wrangler dev --port ${apiPort} --inspector-port ${apiPort + 1000} --ip 127.0.0.1 --var APP_ORIGIN:http://localhost:${webPort}`,
      url: `http://127.0.0.1:${apiPort}/api/v1/health`,
      reuseExistingServer: true,
      timeout: 120_000,
      cwd: "../..",
    },
    { command: "pnpm exec vite --host 127.0.0.1", url: `http://localhost:${webPort}`, reuseExistingServer: true, timeout: 60_000 },
  ],
});
