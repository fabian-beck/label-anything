// Browser smoke test: Chromium loads the package from a tiny static server, places a
// problem and checks the result. Run: npm run test:browser -w @label-anything/wasm
// (needs `npm run build:wasm` first; CHROMIUM_PATH overrides the browser executable).
import { expect, test } from "@playwright/test";
import { startServer } from "./server.mjs";

let server;
let base = "";

test.beforeAll(async () => {
  ({ server, url: base } = await startServer(0));
});

test.afterAll(async () => {
  await new Promise((ok) => server.close(ok));
});

test("places a problem in Chromium", async ({ page }) => {
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`${m.type()}: ${m.text()}`);
  });
  await page.goto(`${base}/`);
  const r = await page.evaluate(() => window.smokeResult);
  expect(r.error).toBeUndefined();
  expect(r.beforeInit).toMatch(/not initialized: call `await init\(\)`/);
  expect(r.initialized).toBe(true);
  expect(r.version).toBe("0.1.0");
  expect(r.features).toContain("svg");
  expect(r.placed).toBe(r.total);
  expect(r.total).toBe(20);
  expect(r.hardViolations).toBe(0);
  expect(r.svgStart).toBe("<svg");
  expect(r.valid).toBe(true);
  expect(r.measured).toBeGreaterThan(0);
  expect(r.measuredHardViolations).toBe(0);
  expect(r.rasterHardViolations).toBe(0);
  expect(r.rasterBox.x >= 40 || r.rasterBox.y >= 30).toBe(true); // avoids the black block
  // instantiateStreaming worked (no MIME-type fallback warning), no errors
  expect(problems).toEqual([]);
});
