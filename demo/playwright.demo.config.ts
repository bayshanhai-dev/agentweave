import { defineConfig } from "@playwright/test";

/**
 * VC-demo recording config.
 * - 1920x1080, video always on (webm, later converted to mp4)
 * - Runs against the local demo stack: dashboard :5173, control-api :3000
 * - Uses Playwright's bundled Chromium (the system Chromium blocks
 *   localhost via Local Network Access checks in this sandbox).
 * - Run headed under xvfb for a visible cursor:
 *     xvfb-run -a npx playwright test -c demo/playwright.demo.config.ts --headed
 */
export default defineConfig({
  testDir: ".",
  outputDir: "output",
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  reporter: [["line"]],
  use: {
    baseURL: process.env.DEMO_BASE_URL ?? "http://127.0.0.1:5173",
    video: { mode: "on", size: { width: 1920, height: 1080 } },
    viewport: { width: 1920, height: 1080 },
    launchOptions: {
      args: ["--no-sandbox", "--disable-gpu"],
    },
  },
});
