// @vitest-environment jsdom
import * as Plot from "@observablehq/plot";
import { describe, expect, it } from "vitest";
import type { LabelResult } from "@label-anything/core";
import { labelAnything } from "../src/plot.js";
import { cliEngine, fakeEngine, overlaps } from "./engines.js";

const cars = [
  { name: "Alfa", power: 110, economy: 30 },
  { name: "Buick", power: 150, economy: 22 },
  { name: "Chevrolet", power: 152, economy: 21.5 },
  { name: "Dodge", power: 200, economy: 15 },
  { name: "Ford", power: 90, economy: 33 },
];

describe("labelAnything (Observable Plot mark)", () => {
  it("labels the data in plot pixels with earlier marks as obstacles", () => {
    const engine = fakeEngine();
    const svg = Plot.plot({
      width: 400,
      height: 300,
      marks: [
        Plot.dot(cars, { x: "power", y: "economy", r: 4 }),
        labelAnything(cars, { x: "power", y: "economy", text: "name", r: 4, engine, priority: (d) => d.power }),
      ],
    }) as unknown as SVGSVGElement;
    const { problem } = engine.last;
    expect(problem.canvas).toEqual({ width: 400, height: 300 });
    expect(problem.items.length).toBe(5);
    expect(problem.items[0]).toMatchObject({ id: "0", label: { type: "text", text: "Alfa" }, priority: 110, anchor: { mark: { shape: "circle", r: 4 } } });
    const dots = Array.from(svg.querySelectorAll("circle"));
    const x0 = Number(dots[0]!.getAttribute("cx") ?? 0);
    expect((problem.items[0]!.anchor as { x: number }).x).toBeCloseTo(x0 + translateX(dots[0]!), 6);
    // the dots (and axes) drawn before are in the background
    const source = (problem.obstacles!.svg as { source: string }).source;
    expect(source.match(/<circle/g)?.length).toBe(5);
    expect(problem.defaults?.font).toMatchObject({ family: "system-ui, sans-serif", size: 10 });
    expect(svg.querySelectorAll("g[aria-label=labels] text").length).toBe(engine.calls.length && 5 - countUnplaced(engine));
  });

  it("fills in labels when an asynchronous engine answers", async () => {
    const fake = fakeEngine();
    const engine = { place: (p: never, o: never) => Promise.resolve(fake.place(p, o)) };
    let got: LabelResult | undefined;
    const svg = Plot.plot({
      marks: [labelAnything(cars, { x: "power", y: "economy", text: "name", engine, onResult: (r) => (got = r) })],
    }) as unknown as SVGSVGElement;
    expect(svg.querySelectorAll("g[aria-label=labels] text").length).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toBeDefined();
    expect(svg.querySelectorAll("g[aria-label=labels] text").length).toBeGreaterThan(0);
  });

  it.skipIf(!cliEngine)("solves with the Rust engine", () => {
    let result: LabelResult | undefined;
    Plot.plot({
      width: 400,
      height: 300,
      marks: [
        Plot.dot(cars, { x: "power", y: "economy" }),
        labelAnything(cars, { x: "power", y: "economy", text: "name", engine: cliEngine!, onResult: (r) => (result = r) }),
      ],
    });
    expect(result!.placements.filter((p) => p.placed).length).toBe(5);
    expect(overlaps(result!)).toEqual([]);
  });
});

function translateX(el: Element): number {
  let x = 0;
  for (let e: Element | null = el; e; e = e.parentElement) {
    const m = /translate\(([-\d.e]+)/.exec(e.getAttribute("transform") ?? "");
    if (m) x += Number(m[1]);
  }
  return x;
}

function countUnplaced(engine: ReturnType<typeof fakeEngine>): number {
  return engine.place(engine.last.problem, engine.last.options).placements.filter((p) => !p.placed).length;
}
