import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the local stack (infra/local/compose.yaml): real Supabase Auth (GoTrue),
 * the Worker API under wrangler dev and the Vite dev server. global-setup seeds an isolated organisation.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "../../tests/results/e2e-web.json" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:5188",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }, testMatch: /responsive\.spec\.ts/ },
    ...(process.env.E2E_ALL_BROWSERS ? [{ name: "firefox", use: { ...devices["Desktop Firefox"] } }, { name: "webkit", use: { ...devices["Desktop Safari"] } }] : []),
  ],
  webServer: [
    {
      command: "pnpm --filter @arms/api exec wrangler dev --port 8787 --ip 127.0.0.1",
      url: "http://127.0.0.1:8787/api/v1/health",
      reuseExistingServer: true,
      timeout: 120_000,
      cwd: "../..",
    },
    { command: "pnpm exec vite --host 127.0.0.1", url: "http://localhost:5188", reuseExistingServer: true, timeout: 60_000 },
  ],
});
