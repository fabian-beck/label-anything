// Browser tests of the explainer (dist/explain.html): every scene solves with the trace in
// its worker, the WebAssembly engine (the Rust core) gives the same placements, the steps
// can be walked with the keyboard, the timeline and a link, a dragged mark is solved
// again, and an option change gives a new solve.
import { expect, test } from "@playwright/test";
import { startServer } from "./server.mjs";

let server;
let base;

test.beforeAll(async () => {
  ({ server, url: base } = await startServer(0));
});

test.afterAll(() => server?.close());

async function open(page, hash) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}explain.html?t=${encodeURIComponent(hash)}#${hash}`);
  await page.waitForFunction(() => globalThis.explainer?.explained, null, { timeout: 30_000 });
  return errors;
}

const wasmBuilt = async (page) => (await (await page.request.get(`${base}build.json`)).json()).wasm === true;

for (const scene of ["europe", "scatter", "lines", "areas"]) {
  test(`${scene}: a traced solve, the same as WebAssembly's, step by step`, async ({ page }) => {
    const errors = await open(page, `scene=${scene}`);
    const info = await page.evaluate(() => {
      const ex = globalThis.explainer.explained;
      return { events: ex.length, groups: ex.groups.map((g) => g.id), stats: ex.result.stats };
    });
    expect(info.groups.slice(0, 3)).toEqual(["prepare", "candidates", "greedy"]);
    expect(info.groups[info.groups.length - 1]).toBe("verify");
    expect(info.stats.hard_violations).toBe(0);
    expect(info.stats.placed).toBeGreaterThan(0);
    // the narration follows the steps
    await expect(page.locator("#title")).toHaveText("The problem");
    await page.locator("#stage").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#title")).toHaveText("Candidate positions");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#title")).toContainText("Candidates of");
    await page.keyboard.press("End");
    await expect(page.locator("#title")).toContainText("Verified");
    expect(await page.evaluate(() => globalThis.explainer.step)).toBe(info.events - 1);
    // the drawing shows labels at the end
    const painted = await page.evaluate(() => {
      const c = document.getElementById("stage");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 16) if (d[i] < 60 && d[i + 1] < 60 && d[i + 2] < 60) dark++;
      return dark;
    });
    expect(painted).toBeGreaterThan(100);
    if (await wasmBuilt(page)) await expect(page.locator("#verdict")).toContainText("gives the same", { timeout: 20_000 });
    expect(errors).toEqual([]);
  });
}

test("a link opens a step; the timeline seeks; Page Down goes to the next phase", async ({ page }) => {
  const errors = await open(page, "scene=scatter&step=40");
  expect(await page.evaluate(() => globalThis.explainer.step)).toBe(39);
  await expect(page.locator("#phase .on")).toHaveText("Greedy");
  const box = await page.locator("#timeline").boundingBox();
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.7);
  await expect(page.locator("#phase .on")).toHaveText("Local search");
  await expect(page.locator("#title")).toContainText("Move");
  await page.keyboard.press("PageDown");
  await expect(page.locator("#phase .on")).toHaveText("Repairs");
  expect(errors).toEqual([]);
});

test("dragging a mark and changing an option solve again", async ({ page }) => {
  const errors = await open(page, "scene=scatter&step=100");
  await expect(page.locator("#phase .on")).toHaveText("Greedy");
  const first = await page.evaluate(() => JSON.stringify(globalThis.explainer.explained.result.placements.map((p) => p.box)));
  // drag the first point a little to the right
  const at = await page.evaluate(() => {
    const ex = globalThis.explainer.explained;
    const a = ex.trace.items[0].anchor;
    const c = document.getElementById("stage");
    const r = c.getBoundingClientRect();
    const s = Math.min((c.clientWidth - 24) / 640, (c.clientHeight - 24) / 440);
    return [r.left + (c.clientWidth - 640 * s) / 2 + a[0] * s, r.top + (c.clientHeight - 440 * s) / 2 + a[1] * s];
  });
  await page.mouse.move(at[0], at[1]);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(at[0] + 9 * k, at[1] + 5 * k);
  await page.mouse.up();
  await page.waitForFunction(
    (before) => JSON.stringify(globalThis.explainer.explained.result.placements.map((p) => p.box)) !== before,
    first,
    { timeout: 20_000 },
  );
  // the reader stays in the phase they were in
  await expect(page.locator("#phase .on")).toHaveText("Greedy");
  // greedy only: no search
  await page.locator("summary", { hasText: "Algorithm options" }).click();
  await page.locator("#opts-algo .seg button", { hasText: "greedy" }).click();
  await page.waitForFunction(() => !globalThis.explainer.explained.groups.some((g) => g.id === "search"), null, { timeout: 20_000 });
  await expect(page.locator("#problem-json")).toContainText('"strategy": "greedy"');
  expect(errors).toEqual([]);
});
