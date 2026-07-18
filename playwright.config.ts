import { defineConfig, devices } from "@playwright/test";

/**
 * Dogfood e2e harness config. Drives the VITE WEB BUILD of the shell headlessly
 * so the dogfood loop can catch render-path regressions (blank screen, console
 * errors, broken streams) that unit tests + `tsc` miss.
 *
 * Reuses a vite dev server already on :1420 if one is running (vite's strictPort
 * — note :3000 is the separate next.js web twin, NOT this shell); otherwise boots
 * one via `npm run dev`. The web build is
 * tauri-gated in places (invoke() rejects), so the harness treats
 * "tauri runtime unavailable" rejections as benign — see e2e/dogfood.spec.ts.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    headless: true,
    viewport: { width: 1440, height: 900 },
    screenshot: "off", // we screenshot explicitly into the dogfood shots dir
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
