// @vitest-environment jsdom
import { select } from "d3-selection";
import { beforeEach, describe, expect, it } from "vitest";
import { labelSelection } from "../src/d3.js";
import { cliEngine, fakeEngine, overlaps } from "./engines.js";

const cities = [
  { name: "Bamberg", x: 40, y: 50, pop: 77 },
  { name: "Nuremberg", x: 60, y: 58, pop: 518 },
  { name: "Erlangen", x: 52, y: 40, pop: 117 },
  { name: "Würzburg", x: 150, y: 120, pop: 127 },
];

function chart(attrs: Record<string, string> = { width: "300", height: "200" }) {
  document.body.innerHTML = "";
  const svg = select(document.body).append("svg");
  for (const [k, v] of Object.entries(attrs)) svg.attr(k, v);
  svg.append("line").attr("x1", 0).attr("y1", 190).attr("x2", 300).attr("y2", 190).attr("stroke", "black");
  svg.append("text").attr("x", 10).attr("y", 15).text("Franconia");
  const dots = svg
    .append("g")
    .selectAll("circle")
    .data(cities)
    .join("circle")
    .attr("cx", (d) => d.x)
    .attr("cy", (d) => d.y)
    .attr("r", 3);
  return { svg, dots };
}

describe("labelSelection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("turns the selection into items and the rest of the SVG into obstacles", () => {
    const { svg, dots } = chart();
    const engine = fakeEngine();
    const result = labelSelection(dots, (d) => d.name, { engine, priority: (d) => d.pop, font: { size: 10 } });
    const { problem } = engine.last;
    expect(problem.canvas).toEqual({ width: 300, height: 200 });
    const near = (v: number) => Math.round(v * 2) / 2;
    expect(problem.items.map((i) => [i.id, near((i.anchor as { x: number }).x), near((i.anchor as { y: number }).y), i.priority])).toEqual([
      ["0", 40, 50, 77],
      ["1", 60, 58, 518],
      ["2", 52, 40, 117],
      ["3", 150, 120, 127],
    ]);
    // the marks got ids in the snapshot (not in the page) for svg_id
    expect(problem.items.every((i) => typeof i.svg_id === "string" && i.svg_id.length > 0)).toBe(true);
    expect(dots.nodes().every((n) => !n.hasAttribute("id"))).toBe(true);
    const source = (problem.obstacles!.svg as { source: string; auto_mark_items: boolean }).source;
    expect((problem.obstacles!.svg as { auto_mark_items: boolean }).auto_mark_items).toBe(true);
    expect(source).toContain("Franconia");
    expect(problem.defaults?.font?.size).toBe(10);
    // drawn into a label group of the same svg
    const texts = svg.selectAll("g[data-la-labels] text").nodes() as SVGTextElement[];
    expect(texts.length).toBe(result.placements.filter((p) => p.placed).length);
    expect(texts[0]!.textContent).toBe("Bamberg");
  });

  it("re-labeling replaces the label group and leaves it out of the background", () => {
    const { svg, dots } = chart();
    const engine = fakeEngine();
    labelSelection(dots, (d) => d.name, { engine });
    labelSelection(dots, (d) => d.name, { engine });
    expect(svg.selectAll("g[data-la-labels]").size()).toBe(1);
    const source = (engine.last.problem.obstacles!.svg as { source: string }).source;
    expect(source).not.toContain("data-la-labels");
  });

  it("maps a viewBox to viewport pixels and draws labels back in user units", () => {
    const { svg, dots } = chart({ width: "600", height: "400", viewBox: "0 0 300 200" });
    const engine = fakeEngine();
    labelSelection(dots, "name", { engine });
    const { problem } = engine.last;
    expect(problem.canvas).toEqual({ width: 600, height: 400 });
    // boxes come from the flattened outline (within the 0.25 px tolerance)
    const a = problem.items[0]!.anchor as { x: number; y: number };
    expect(Math.abs(a.x - 80)).toBeLessThan(0.25);
    expect(Math.abs(a.y - 100)).toBeLessThan(0.25);
    expect(svg.select("g[data-la-labels]").attr("transform")).toBe("matrix(0.5,0,0,0.5,0,0)");
  });

  it("skips data without text and supports draw: false", () => {
    const { svg, dots } = chart();
    const engine = fakeEngine();
    labelSelection(dots, (d) => (d.pop > 100 ? d.name : null), { engine, draw: false });
    expect(engine.last.problem.items.map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect(svg.selectAll("g[data-la-labels]").size()).toBe(0);
  });

  it("background: false keeps only the labeled marks", () => {
    const { dots } = chart();
    const engine = fakeEngine();
    labelSelection(dots, "name", { engine, background: false });
    expect(engine.last.problem.obstacles!.svg).toMatchObject({ classes: [{ selector: "*", class: "ignore" }] });
  });

  it.skipIf(!cliEngine)("solves with the Rust engine", () => {
    const { svg, dots } = chart();
    const result = labelSelection(dots, (d) => d.name, { engine: cliEngine!, priority: (d) => d.pop, preset: "scatter" });
    expect(result.placements.length).toBe(4);
    expect(result.placements.filter((p) => p.placed).length).toBeGreaterThanOrEqual(3);
    expect(overlaps(result)).toEqual([]);
    // labels avoid the title text, a hard obstacle
    const title = { x: 10, y: 15 - 0.8 * 16, w: 9 * 0.55 * 16, h: 16 };
    for (const p of result.placements) {
      if (!p.box) continue;
      const b = p.box;
      expect(b.x < title.x + title.w && title.x < b.x + b.w && b.y < title.y + title.h && title.y < b.y + b.h).toBe(false);
    }
    expect(svg.selectAll("g[data-la-labels] text").size()).toBe(result.placements.filter((p) => p.placed).length);
  });
});
