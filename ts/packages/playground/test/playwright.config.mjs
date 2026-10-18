// Playwright configuration of the playground's browser tests (Chromium only), run on the
// built dist/ (npm run test:browser -w @label-anything/playground).
// CHROMIUM_PATH selects a browser executable when the installed Playwright browsers do
// not match the version of @playwright/test.
// The explainer's tests run after the playground's: the playground compares the two
// engines, which agree only while no wall-clock guard fires (ADR 0042), and the
// explainer's solves running beside them would take the CPU they need.
import { defineConfig } from "@playwright/test";

const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.pw\.mjs$/,
  reporter: "list",
  timeout: 90_000,
  workers: 2,
  outputDir: "../test-results",
  projects: [
    { name: "playground", testMatch: /playground\.pw\.mjs$/ },
    { name: "explainer", testMatch: /explain\.pw\.mjs$/, dependencies: ["playground"] },
  ],
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    launchOptions: executablePath ? { executablePath } : {},
  },
});
