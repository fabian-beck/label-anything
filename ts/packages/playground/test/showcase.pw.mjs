// Browser tests of the live examples of the documentation's home page (dist/showcase.js, on
// a page with figures marked as docs/index.md marks them): each takes the place of its
// static picture with the labels of that picture (the problems are those of
// examples/showcase), a hover makes an item stand out and names it, the chart's variables
// can be changed, the map panned and zoomed, the graph's nodes dragged, the photograph's
// margins and leaders chosen.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";

const SHOWCASE = fileURLToPath(new URL("../../../../examples/showcase/", import.meta.url));
const committed = (name) => JSON.parse(readFileSync(`${SHOWCASE}${name}.json`, "utf8"));

let server;
let base;

test.beforeAll(async () => {
  ({ server, url: base } = await startServer(0));
});

test.afterAll(() => server?.close());

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const figure = (name) => `<figure data-la-example="${name}"><p><a href="#"><img alt="${name}" src="${PIXEL}" width="960" height="600"></a></p><figcaption>${name}</figcaption></figure>`;
// the figures as docs/index.md has them, with just enough style to lay them out
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>showcase</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  figure { margin: 16px auto; width: 960px; }
  [hidden] { display: none !important; }
  .la-example__stage { position: relative; }
  .la-example__svg { display: block; width: 100%; height: auto; }
  .la-example__svg text { font-family: "LA Noto Sans", sans-serif; white-space: pre; }
  .la-example__tip, .la-example__zoom, .la-example__note { position: absolute; }
  .la-example__zoom { top: 4px; right: 4px; }
</style></head>
<body>
${["economies", "europe", "retina", "modules"].map(figure).join("\n")}
<script type="module" src="../showcase.js"></script>
</body></html>`;

/** Opens the page and waits for an example to be live and at rest. */
async function open(page, name) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "warning" && errors.push(m.text()));
  await page.route(`${base}showcase-test/`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: PAGE }));
  await page.goto(`${base}showcase-test/`);
  const fig = page.locator(`[data-la-example="${name}"]`);
  await fig.scrollIntoViewIfNeeded();
  await page.waitForFunction((n) => globalThis.labelAnythingShowcase?.stages[n]?.live, name, { timeout: 30_000 });
  await rest(page, name);
  await fig.locator(".la-example__svg").scrollIntoViewIfNeeded();
  return { fig, errors };
}

/** Waits until nothing is being solved and nothing moves. */
async function rest(page, name) {
  await page.waitForTimeout(100);
  await page.waitForFunction((n) => globalThis.labelAnythingShowcase.stages[n].idle, name, { timeout: 20_000 });
}

/** The latest result of an example: its placed labels (id, box, leader points, lines), and the labels drawn. */
const state = (page, name) =>
  page.evaluate((n) => {
    const s = globalThis.labelAnythingShowcase.stages[n];
    return {
      total: s.result.stats.total,
      placed: s.result.placements.filter((p) => p.placed).map((p) => ({ id: p.id, box: p.box, leader: p.leader?.points ?? null, lines: p.text?.lines ?? [] })),
      drawn: [...s.labels.querySelectorAll(".la-item")].map((e) => e.getAttribute("data-id")),
      solves: s.solves,
    };
  }, name);

/** A point of the drawing, in the page's client coordinates. */
const client = (page, name, x, y) =>
  page.evaluate(([n, x, y]) => {
    const p = new DOMPoint(x, y).matrixTransform(globalThis.labelAnythingShowcase.stages[n].svg.getScreenCTM());
    return [p.x, p.y];
  }, [name, x, y]);

const anchor = (page, name, id) => page.evaluate(([n, id]) => [...globalThis.labelAnythingShowcase.examples[n].anchors().get(id)], [name, id]);

function expectDisjoint(placed) {
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i].box;
      const b = placed[j].box;
      const apart = a.x + a.w <= b.x + 0.01 || b.x + b.w <= a.x + 0.01 || a.y + a.h <= b.y + 0.01 || b.y + b.h <= a.y + 0.01;
      expect(apart, `${placed[i].id} and ${placed[j].id} overlap`).toBe(true);
    }
  }
}

test("each example takes the place of its static picture, with every placed label drawn", async ({ page }) => {
  for (const name of ["economies", "europe", "retina", "modules"]) {
    const { fig, errors } = await open(page, name);
    await expect(fig.locator("img")).toBeHidden();
    await expect(fig.locator(".la-example__svg")).toBeVisible();
    const s = await state(page, name);
    expect(s.placed.length).toBeGreaterThan(0);
    expect(new Set(s.drawn)).toEqual(new Set(s.placed.map((p) => p.id)));
    expectDisjoint(s.placed);
    await expect(fig.locator(".la-example__status")).toHaveText(new RegExp(`^${s.placed.length} of ${s.total} labels`));
    expect(errors).toEqual([]);
  }
});

test("the examples start from the problems of the static figures", async ({ page }) => {
  // the chart: the SVG the engine reads, and the bubbles, are those of economies.py
  await open(page, "economies");
  const chart = await page.evaluate(() => globalThis.labelAnythingShowcase.examples.economies.problem());
  const eco = committed("economies");
  expect(chart.obstacles.svg.source).toBe(readFileSync(`${SHOWCASE}economies-chart.svg`, "utf8"));
  expect(chart.items.map((it) => [it.id, it.anchor, it.priority])).toEqual(eco.items.map((it) => [it.id, it.anchor, it.priority]));
  expect({ ...chart, items: 0, obstacles: 0 }).toEqual({ ...eco, items: 0, obstacles: 0 });
  // the map: the countries' outlines and the capitals are those of europe.py
  await open(page, "europe");
  const map = await page.evaluate(() => globalThis.labelAnythingShowcase.examples.europe.problem());
  expect(map.items.map((it) => [it.id, it.anchor])).toEqual(committed("europe").items.map((it) => [it.id, it.anchor]));
  // the graph: the very problem
  await open(page, "modules");
  expect(await page.evaluate(() => globalThis.labelAnythingShowcase.examples.modules.problem())).toEqual(committed("modules"));
});

test("hovering a mark or a label makes it stand out and names it, also without a label", async ({ page }) => {
  const { fig } = await open(page, "economies");
  const tip = fig.locator(".la-example__tip");
  await expect(tip).toBeHidden();
  // India's bubble
  await page.mouse.move(...(await client(page, "economies", ...(await anchor(page, "economies", "IND")))));
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("India");
  await expect(tip).toContainText("GDP per person");
  await expect(fig.locator(".la-example")).toHaveClass(/has-hover/);
  await expect(fig.locator('.la-item.is-hover[data-id="IND"]')).toHaveCount(1);
  expect(await fig.locator(".la-item.is-hover").count()).toBe(1);
  // its label
  const s = await state(page, "economies");
  const jpn = s.placed.find((p) => p.id === "JPN").box;
  await page.mouse.move(...(await client(page, "economies", jpn.x + jpn.w / 2, jpn.y + jpn.h / 2)));
  await expect(tip).toContainText("Japan");
  // a bubble whose label was left out still tells its name
  const id = await page.evaluate(() => globalThis.labelAnythingShowcase.stages.economies.result.placements.find((p) => !p.placed).id);
  await page.mouse.move(...(await client(page, "economies", ...(await anchor(page, "economies", id)))));
  await expect(tip).toBeVisible();
  expect(await fig.locator(".la-item.is-hover").count()).toBe(0);
  expect((await tip.locator("strong").innerText()).length).toBeGreaterThan(2);
  await page.mouse.move(2, 2);
  await expect(tip).toBeHidden();
  await expect(fig.locator(".la-example")).not.toHaveClass(/has-hover/);
});

test("the chart's variables can be changed: the bubbles move and the labels are placed again", async ({ page }) => {
  const { fig, errors } = await open(page, "economies");
  const before = await anchor(page, "economies", "RUS");
  const solves = (await state(page, "economies")).solves;
  await fig.locator("select").nth(1).selectOption("area");
  await rest(page, "economies");
  const after = await anchor(page, "economies", "RUS");
  expect(after[0]).toBeCloseTo(before[0], 1); // across: unchanged
  expect(Math.abs(after[1] - before[1])).toBeGreaterThan(20); // up: by area now
  const s = await state(page, "economies");
  expect(s.solves).toBeGreaterThan(solves);
  expect(s.placed.length).toBeGreaterThan(80);
  expectDisjoint(s.placed);
  await expect(fig.locator("svg")).toContainText("Area (km², log scale)");
  // the same variable on both axes: they swap
  await fig.locator("select").nth(0).selectOption("area");
  await rest(page, "economies");
  expect(await page.evaluate(() => globalThis.labelAnythingShowcase.examples.economies.state)).toEqual({ x: "area", y: "gdppc", size: "gdp" });
  // the bubbles' area: the largest country by population is the largest bubble now
  await fig.locator("select").nth(2).selectOption("pop");
  await rest(page, "economies");
  await expect(fig.locator("svg")).toContainText("Area: Population");
  expect(errors).toEqual([]);
});

test("the map zooms and pans: more cities come, and the whole map has its first labels again", async ({ page }) => {
  const { fig, errors } = await open(page, "europe");
  const first = await state(page, "europe");
  expect(first.placed.some((p) => p.id.startsWith("city-"))).toBe(false);
  await fig.getByRole("button", { name: "Zoom in" }).click();
  await rest(page, "europe");
  const view = () => page.evaluate(() => ({ ...globalThis.labelAnythingShowcase.examples.europe.view }));
  const zoomed = await view();
  expect(zoomed.k).toBeGreaterThan(1.5);
  const s = await state(page, "europe");
  expect(s.placed.some((p) => p.id.startsWith("city-"))).toBe(true);
  expectDisjoint(s.placed);
  // a zoomed view is a window on the map: what lies a little beyond it is labeled as well,
  // and a label at its border is cut there, not moved inside
  const canvas = await page.evaluate(() => globalThis.labelAnythingShowcase.examples.europe.problem().canvas);
  expect(canvas.overscan).toBeGreaterThan(0);
  expect(canvas.region[2]).toBeCloseTo(canvas.width * zoomed.k, 1);
  const inView = (b) => b.x < canvas.width && b.y < canvas.height && b.x + b.w > 0 && b.y + b.h > 0;
  const cut = (b) => inView(b) && (b.x < 0 || b.y < 0 || b.x + b.w > canvas.width || b.y + b.h > canvas.height);
  expect(s.placed.filter((p) => cut(p.box)).length).toBeGreaterThan(0);
  // where the labels are on the map (px of the map at zoom 1)
  const onMap = async () => {
    const v = await view();
    const placed = (await state(page, "europe")).placed;
    return new Map(placed.map((p) => [p.id, { x: (p.box.x - v.x) / v.k, y: (p.box.y - v.y) / v.k, shown: inView(p.box) }]));
  };
  const before = await onMap();
  // a drag pans the zoomed map
  const [x, y] = await client(page, "europe", 440, 440);
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x - i * 12, y - i * 6);
  await page.mouse.up();
  await rest(page, "europe");
  const panned = await view();
  expect(panned.k).toBeCloseTo(zoomed.k, 6);
  expect(panned.x).toBeLessThan(zoomed.x - 50);
  expect(panned.y).toBeLessThan(zoomed.y - 20);
  expectDisjoint((await state(page, "europe")).placed);
  // the labels stayed where they were on the map, those at the border too
  const after = await onMap();
  const both = [...before].filter(([id, a]) => after.has(id) && (a.shown || after.get(id).shown));
  expect(both.length).toBeGreaterThan(15);
  const stayed = both.filter(([id, a]) => Math.hypot(after.get(id).x - a.x, after.get(id).y - a.y) * panned.k < 1);
  expect(stayed.length / both.length).toBeGreaterThan(0.85);
  // Ctrl + wheel zooms about the pointer; the wheel alone scrolls the page
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await rest(page, "europe");
  expect((await view()).k).toBeGreaterThan(panned.k);
  await page.mouse.wheel(0, 1);
  await expect(fig.locator(".la-example__note")).toBeVisible();
  // back to the whole map: the labels of the first view
  await fig.getByRole("button", { name: "Whole map" }).click();
  await rest(page, "europe");
  expect(await view()).toEqual({ k: 1, x: 0, y: 0 });
  const back = await state(page, "europe");
  expect(back.placed.map((p) => [p.id, p.box])).toEqual(first.placed.map((p) => [p.id, p.box]));
  expect(errors).toEqual([]);
});

test("a node of the graph can be dragged: its edges follow, the labels make room, reset restores", async ({ page }) => {
  const { fig, errors } = await open(page, "modules");
  const first = await state(page, "modules");
  const at = await anchor(page, "modules", "core/index");
  const [x, y] = await client(page, "modules", ...at);
  // hovering it names it and keeps its neighbours' labels readable
  await page.mouse.move(x, y);
  await expect(fig.locator(".la-example__tip")).toContainText("Imported by");
  expect(await fig.locator(".la-item.is-related").count()).toBeGreaterThan(5);
  const reset = fig.getByRole("button", { name: "Reset the layout" });
  await expect(reset).toBeDisabled();
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + i * 8, y - i * 6);
  await page.mouse.up();
  await rest(page, "modules");
  const moved = await anchor(page, "modules", "core/index");
  expect(moved[0]).toBeGreaterThan(at[0] + 60);
  expect(moved[1]).toBeLessThan(at[1] - 40);
  const s = await state(page, "modules");
  expect(s.solves).toBeGreaterThan(first.solves);
  expectDisjoint(s.placed);
  // an edge of the node ends where the node is now
  const problem = await page.evaluate(() => globalThis.labelAnythingShowcase.examples.modules.problem());
  const ends = problem.obstacles.vector[0].polylines.flatMap((l) => [l[0], l.at(-1)]);
  expect(ends.some(([ex, ey]) => Math.abs(ex - moved[0]) < 0.1 && Math.abs(ey - moved[1]) < 0.1)).toBe(true);
  await expect(reset).toBeEnabled();
  await reset.click();
  await rest(page, "modules");
  expect(await anchor(page, "modules", "core/index")).toEqual(at);
  expect((await state(page, "modules")).placed.map((p) => [p.id, p.box])).toEqual(first.placed.map((p) => [p.id, p.box]));
  expect(errors).toEqual([]);
});

test("the photograph's names go to the chosen margins, on the chosen leaders", async ({ page }) => {
  const { fig, errors } = await open(page, "retina");
  const first = await state(page, "retina");
  expect(first.placed.length).toBe(first.total);
  expect(first.placed.some((p) => p.box.x > 480)).toBe(true); // a name on the right
  await fig.getByRole("button", { name: "left", exact: true }).click();
  await rest(page, "retina");
  let s = await state(page, "retina");
  expect(s.placed.length).toBe(s.total);
  for (const p of s.placed) expect(p.box.x + p.box.w, p.id).toBeLessThan(480);
  expect(s.placed.every((p) => p.leader.length === 2)).toBe(true);
  await fig.getByRole("button", { name: "right angles" }).click();
  await rest(page, "retina");
  s = await state(page, "retina");
  expect(s.placed.some((p) => p.leader.length === 3)).toBe(true);
  expectDisjoint(s.placed);
  // hovering a part shows its outline and what it is
  await page.mouse.move(...(await client(page, "retina", ...(await anchor(page, "retina", "macula")))));
  await expect(fig.locator(".la-example__tip")).toContainText("Macula lutea");
  expect(await fig.locator(".la-ex-hover path").count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
