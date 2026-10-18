// Browser tests of the live header of the documentation's home page (dist/hero.js, on a
// page with the markup of docs/_overrides/home.html): the logo keeps its place, every label
// is placed without overlaps and off the header's text, and dragging and clicking work.
import { expect, test } from "@playwright/test";
import { startServer } from "./server.mjs";

let server;
let base;

test.beforeAll(async () => {
  ({ server, url: base } = await startServer(0));
});

test.afterAll(() => server?.close());

// the header's markup (docs/_overrides/home.html), with just enough style to lay it out
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hero</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  .la-hero { position: relative; overflow: hidden; }
  .la-hero__stage { position: absolute; inset: 0; }
  .la-hero__svg { display: block; width: 100%; height: 100%; }
  .la-hero__label text { font-size: 14px; }
  .la-hero__content { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center;
    max-width: 640px; margin: 0 auto; padding: 48px 16px 64px; text-align: center; pointer-events: none; }
  .la-hero__content > * { pointer-events: auto; }
  .la-lockup { position: relative; display: flex; margin: 0 0.95em 0.95em 0; font-size: 40px; line-height: 1.2; }
  .la-lockup__label { position: relative; z-index: 1; padding: 0.18em 0.5em; border-radius: 0.24em; background: #4051b5; color: #fff; }
  .la-lockup__tail { position: absolute; top: 100%; left: 100%; width: 1em; height: 1em; overflow: visible; }
  .la-lockup__tail path { fill: none; stroke: #4051b5; }
  .la-hero.is-live .la-lockup { opacity: 0; pointer-events: none; }
  p, ul, div { width: fit-content; }
  ul { display: flex; gap: 6px; list-style: none; padding: 0; }
</style></head>
<body>
<section class="la-hero" data-la-hero>
  <div class="la-hero__stage" data-la-hero-stage></div>
  <div class="la-hero__content">
    <h1 class="la-lockup" data-la-hero-name>
      <span class="la-lockup__label" data-la-hero-label>Label Anything</span>
      <svg class="la-lockup__tail" viewBox="0 0 100 100" aria-hidden="true">
        <path d="M-12 -12L60 68" stroke-width="12" stroke-linecap="round" data-la-hero-leader />
        <circle cx="60" cy="68" r="22" data-la-hero-dot />
      </svg>
    </h1>
    <p data-la-avoid="text">Put a label on anything.</p>
    <p data-la-avoid="text">A label placement engine for charts, maps and diagrams. Hand it your points and shapes,
      their labels and what must stay visible: it finds a place for every label.</p>
    <ul data-la-avoid="children"><li>Python</li><li>JavaScript</li><li>Java</li><li>Rust</li></ul>
    <div data-la-avoid="children"><a href="#">Try the playground</a> <a href="#">Get started</a></div>
    <p data-la-hero-hint data-la-avoid style="position: absolute; bottom: 8px; left: 0; right: 0; margin: auto">Live <span data-la-hero-stats></span>
      <button type="button" data-la-hero-reset>Reset</button></p>
  </div>
</section>
<script type="module" src="../hero.js"></script>
</body></html>`;

async function open(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(`${base}hero-test/`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: PAGE }));
  await page.goto(`${base}hero-test/`);
  // the first solve, and the one after it (with a warm engine)
  await page.waitForFunction(() => (globalThis.labelAnythingHero?.solves ?? 0) >= 2, null, { timeout: 30_000 });
  return errors;
}

/** Waits for a solve after the current one, with the motion settled. */
async function nextSolve(page, n) {
  await page.waitForFunction((n) => globalThis.labelAnythingHero.solves > n, n, { timeout: 20_000 });
  await page.waitForTimeout(700);
}

const state = (page) =>
  page.evaluate(() => {
    const h = globalThis.labelAnythingHero;
    const root = h.root.getBoundingClientRect();
    // the boxes of the text lines the labels keep off, in the header's coordinates
    const text = [];
    for (const el of h.root.querySelectorAll("[data-la-avoid]")) {
      const range = document.createRange();
      range.selectNodeContents(el);
      for (const r of range.getClientRects()) text.push([r.left - root.left, r.top - root.top, r.width, r.height]);
    }
    const label = h.root.querySelector("[data-la-hero-label]").getBoundingClientRect();
    return {
      solves: h.solves,
      live: h.root.classList.contains("is-live"),
      stats: h.result.stats,
      placements: h.result.placements,
      text,
      label: [label.left - root.left, label.top - root.top, label.width, label.height],
      drawn: h.root.querySelectorAll(".la-hero__label").length,
    };
  });

const overlaps = (a, b) => a[0] < b[0] + b[2] - 0.5 && b[0] < a[0] + a[2] - 0.5 && a[1] < b[1] + b[3] - 0.5 && b[1] < a[1] + a[3] - 0.5;
const boxOf = (p) => [p.box.x, p.box.y, p.box.w, p.box.h];

test("the logo keeps its place, and every label is placed without overlaps and off the text", async ({ page }) => {
  const errors = await open(page);
  const s = await state(page);
  expect(s.live).toBe(true);
  expect(s.stats.implementation).toMatch(/^ts\//);
  expect(s.stats.hard_violations).toBe(0);
  expect(s.stats.leader_crossings).toBe(0);
  expect(s.stats.placed).toBe(s.stats.total);
  expect(s.stats.total).toBeGreaterThan(8);
  // the name stays where the static logo has it, on its leader
  const name = s.placements.find((p) => p.id === "name");
  expect(name.placed).toBe(true);
  expect(name.leader).toBeTruthy();
  boxOf(name).forEach((v, i) => expect(Math.abs(v - s.label[i])).toBeLessThan(1));
  const boxes = s.placements.filter((p) => p.placed).map(boxOf);
  for (const b of boxes) for (const t of s.text) expect(overlaps(b, t)).toBe(false);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j])).toBe(false);
  expect(s.drawn).toBe(boxes.length);
  expect(errors).toEqual([]);
});

test("dragging the logo's dot moves the name, and a click adds a labeled dot", async ({ page }) => {
  await open(page);
  const before = await state(page);
  const dot = await page.locator("[data-la-hero-dot]").boundingBox();
  const [x, y] = [dot.x + dot.width / 2, dot.y + dot.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + i * 18, y + i * 4);
  await page.mouse.up();
  await nextSolve(page, before.solves);
  let s = await state(page);
  const name = s.placements.find((p) => p.id === "name");
  expect(name.placed).toBe(true);
  expect(name.anchor[0]).toBeGreaterThan(before.placements.find((p) => p.id === "name").anchor[0] + 150);
  expect(s.stats.hard_violations).toBe(0);
  // a click on an empty spot: the bottom-left corner of the header
  const hero = await page.locator("[data-la-hero]").boundingBox();
  const n = s.solves;
  await page.mouse.click(hero.x + 40, hero.y + hero.height - 30);
  await nextSolve(page, n);
  s = await state(page);
  expect(s.stats.total).toBe(before.stats.total + 1);
  const added = s.placements.find((p) => p.id === "add0");
  expect(added?.placed).toBe(true);
  expect(s.stats.hard_violations).toBe(0);
  // reset: the dot is gone, the name is back
  const m = s.solves;
  await page.locator("[data-la-hero-reset]").click();
  await nextSolve(page, m);
  s = await state(page);
  expect(s.stats.total).toBe(before.stats.total);
  boxOf(s.placements.find((p) => p.id === "name")).forEach((v, i) => expect(Math.abs(v - s.label[i])).toBeLessThan(1));
});

test("the name always shows: dropped where it has no room, its dot glides back", async ({ page }) => {
  await open(page);
  const hero = await page.locator("[data-la-hero]").boundingBox();
  // down to the bottom-left corner, where the name's label fits nowhere
  const dot = await page.locator("[data-la-hero-dot]").boundingBox();
  const [x, y] = [dot.x + dot.width / 2, dot.y + dot.height / 2];
  const [tx, ty] = [hero.x + 12, hero.y + hero.height - 10];
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + ((tx - x) * i) / 12, y + ((ty - y) * i) / 12);
  await page.mouse.up();
  await page.waitForFunction(
    () => {
      const h = globalThis.labelAnythingHero;
      return h.result.placements.find((p) => p.id === "name")?.placed && !h.root.classList.contains("is-dragging");
    },
    null,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(800);
  const s = await state(page);
  const name = s.placements.find((p) => p.id === "name");
  expect(name.placed).toBe(true);
  expect(s.stats.hard_violations).toBe(0);
});
