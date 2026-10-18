// Playwright configuration of the playground's browser tests (Chromium only), run on the
// built dist/ (npm run test:browser -w @label-anything/playground).
// CHROMIUM_PATH selects a browser executable when the installed Playwright browsers do
// not match the version of @playwright/test.
import { defineConfig } from "@playwright/test";

const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.mjs$/,
  reporter: "list",
  timeout: 90_000,
  workers: 2,
  outputDir: "../test-results",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    launchOptions: executablePath ? { executablePath } : {},
  },
});
