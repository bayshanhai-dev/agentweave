import { defineConfig } from "@playwright/test";

/**
 * VC-demo v4 recording config.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "vc-pitch-v4.spec.ts",
  outputDir: "output-v4",
  fullyParallel: false,
  workers: 1,
  timeout: 400_000,
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
