// Browser tests of the built playground (dist/): every scene solves in a worker and draws
// labels without overlaps, the two engines give identical layouts, options and share
// links take effect, labels keep off the controls on the canvas, and the picture scene
// adds labels where it is clicked.
import { expect, test } from "@playwright/test";
import { startServer } from "./server.mjs";

let server;
let base;

test.beforeAll(async () => {
  ({ server, url: base } = await startServer(0));
});

test.afterAll(() => server?.close());

/** Open a scene (a fresh page load) and wait for a solve with at least `minSolves` results. */
async function open(page, scene, minSolves = 1) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}?t=${scene}#${scene}`);
  await page.waitForFunction(
    (n) => globalThis.playground?.result && globalThis.playground.history.length >= n,
    minSolves,
    { timeout: 30_000 },
  );
  return errors;
}

const stats = (page) => page.evaluate(() => globalThis.playground.result.stats);

for (const scene of ["map", "network", "scatter", "lines", "swarm", "picture"]) {
  test(`${scene}: labels placed without overlaps, by the WebAssembly engine`, async ({ page }) => {
    const errors = await open(page, scene);
    const s = await stats(page);
    expect(s.placed).toBeGreaterThan(0);
    expect(s.hard_violations).toBe(0);
    expect(s.leader_crossings).toBe(0);
    expect(s.implementation).toMatch(/^wasm\//);
    // the canvas shows something
    const painted = await page.evaluate(() => {
      const c = document.getElementById("stage");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 16) if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) dark++;
      return dark;
    });
    expect(painted).toBeGreaterThan(100);
    expect(errors).toEqual([]);
  });
}

for (const scene of ["map", "network", "picture"]) {
  test(`${scene}: WebAssembly and TypeScript give identical placements`, async ({ page }) => {
    await open(page, scene);
    const r = await page.evaluate(async () => {
      const app = globalThis.playground;
      app.setPlaying(false);
      const res = await app.compareEngines();
      const strip = (p) => JSON.stringify({ ...p, cost_breakdown: undefined });
      const a = res.wasm.result.placements.map(strip);
      const b = res.ts.result.placements.map(strip);
      return { n: a.length, same: a.filter((p, i) => p === b[i]).length, impl: [res.wasm.result.stats.implementation, res.ts.result.stats.implementation] };
    });
    expect(r.impl[0]).toMatch(/^wasm\//);
    expect(r.impl[1]).toMatch(/^ts\//);
    expect(r.n).toBeGreaterThan(0);
    expect(r.same).toBe(r.n);
  });
}

test("an option changes the problem and the layout", async ({ page }) => {
  await open(page, "network");
  await page.evaluate(() => globalThis.playground.setPlaying(false));
  await page.locator('details[data-section="leaders"] summary').click();
  await page.locator('details[data-section="leaders"] button', { hasText: "curved" }).click();
  await page.waitForFunction(() => globalThis.playground.problem?.leaders?.style === "curved", null, { timeout: 20_000 });
  const s = await stats(page);
  expect(s.hard_violations).toBe(0);
  await expect(page.locator('details[data-section="leaders"] .count')).toHaveText("1 changed");
});

test("moving objects are solved warm-started, then settle", async ({ page }) => {
  await open(page, "swarm", 8);
  const kinds = await page.evaluate(() => globalThis.playground.history.map((s) => s.kind));
  expect(kinds.filter((k) => k === "warm").length).toBeGreaterThan(4);
  const warm = await page.evaluate(() => globalThis.playground.problem.warm_start?.placements?.length ?? 0);
  expect(warm).toBeGreaterThan(0);
  await page.evaluate(() => globalThis.playground.setPlaying(false));
  await page.waitForFunction(() => globalThis.playground.history.at(-1)?.kind === "settle", null, { timeout: 20_000 });
});

test("labels keep off the controls drawn on the canvas, and stay in place while one changes a little", async ({ page }) => {
  await open(page, "network", 3); // the statistics show from the first result on
  const overlay = () =>
    page.evaluate(() => globalThis.playground.problem.obstacles.vector.find((v) => v.class === "overlay")?.rects ?? []);
  const rects = await overlay();
  // the title, the statistics, the transport and the view buttons
  expect(rects.length).toBeGreaterThanOrEqual(4);
  // the middle of the statistics, in canvas px (the chip is redrawn at every solve)
  const [x, y] = await page.evaluate(() => {
    const r = document.querySelector("#hud-stats > *").getBoundingClientRect();
    const c = document.getElementById("stage").getBoundingClientRect();
    return [r.left - c.left + r.width / 2, r.top - c.top + r.height / 2];
  });
  expect(rects.some(([rx, ry, rw, rh]) => rx <= x && x <= rx + rw && ry <= y && y <= ry + rh)).toBe(true);
  // the statistics change at every solve: the obstacle stays when the chip shrinks a little,
  // and grows with it
  const [same, grown, w] = await page.evaluate(() => {
    const app = globalThis.playground;
    const chip = document.querySelector("#hud-stats > *");
    const rectOf = () => app.buildProblem("warm", false).problem.obstacles.vector.find((v) => v.class === "overlay").rects[1];
    const w = chip.getBoundingClientRect().width;
    const before = rectOf();
    chip.style.width = `${w - 12}px`;
    const same = JSON.stringify(rectOf()) === JSON.stringify(before);
    chip.style.width = `${w + 60}px`;
    return [same, rectOf()[2] - before[2], w];
  });
  expect(same).toBe(true);
  expect(grown).toBeGreaterThanOrEqual(56);
  expect(w).toBeGreaterThan(0);
});

test("a share link restores the scene and its options", async ({ page, context }) => {
  await open(page, "lines");
  await page.evaluate(() => {
    globalThis.playground.setValue("leaders.style", "elbow");
    globalThis.playground.setValue("param.mode", "column");
  });
  await page.waitForFunction(() => location.hash.startsWith("#lines:"), null, { timeout: 5000 });
  const hash = await page.evaluate(() => location.hash);
  const other = await context.newPage();
  await other.goto(`${base}?again${hash}`);
  await other.waitForFunction(() => globalThis.playground?.result, null, { timeout: 30_000 });
  const v = await other.evaluate(() => [globalThis.playground.scene.id, globalThis.playground.getValue("leaders.style"), globalThis.playground.getValue("param.mode")]);
  expect(v).toEqual(["lines", "elbow", "column"]);
});

test("clicking the picture adds a label there", async ({ page }) => {
  await open(page, "picture");
  const box = await page.locator("#stage").boundingBox();
  // the middle of the photo (it is centred on the drawing)
  await page.mouse.click(box.x + box.width / 2 + 5, box.y + box.height / 2 + 120);
  await page.waitForFunction(() => globalThis.playground.result.placements.some((p) => p.id === "u1"), null, { timeout: 20_000 });
  const p = await page.evaluate(() => globalThis.playground.result.placements.find((q) => q.id === "u1"));
  expect(p.placed).toBe(true);
});
