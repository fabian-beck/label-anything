// Playwright configuration of the browser smoke test (Chromium only).
// CHROMIUM_PATH selects a browser executable when the installed Playwright browsers do
// not match the version of @playwright/test.
import { defineConfig } from "@playwright/test";

const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.mjs$/,
  reporter: "list",
  timeout: 60_000,
  outputDir: "../test-results",
  use: {
    browserName: "chromium",
    headless: true,
    launchOptions: executablePath ? { executablePath } : {},
  },
});
