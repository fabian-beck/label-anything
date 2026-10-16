// Performance: a 10 000-element SVG parses and classifies in < 200 ms on Node.

import { describe, expect, it } from "vitest";
import { type ClassRule, classify, parseSvg } from "../src/index.js";

const AUTO: ClassRule[] = [
  { selector: ":background", class: "ignore" },
  { selector: "text", class: "text" },
  { selector: "circle, ellipse, rect:small, use:small, path:small", class: "points" },
  { selector: "path, line, polyline, polygon", class: "lines" },
  { selector: "*", class: "ink" },
];

function circles(n: number): string {
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000">\n<rect width="1000" height="1000" fill="white"/>\n<g class="points">\n',
  ];
  for (let i = 0; i < n; i++) {
    const x = ((i * 37) % 1000) + 0.5;
    const y = ((i * 91) % 1000) + 0.25;
    parts.push(`<circle cx="${x}" cy="${y}" r="3" fill="steelblue" stroke="white" stroke-width="0.5"/>\n`);
  }
  parts.push("</g>\n</svg>\n");
  return parts.join("");
}

function mixed(n: number): string {
  const parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1000" height="1000" viewBox="0 0 500 500">\n' +
      "<style>.m { fill: #1f77b4; stroke: #1f77b4 } text { font-size: 10px }</style>\n" +
      '<defs><path id="mk" d="M 0 3 C 0.8 3 1.56 2.68 2.12 2.12 C 2.68 1.56 3 0.8 3 0 C 3 -0.8 2.68 -1.56 2.12 -2.12 C 1.56 -2.68 0.8 -3 0 -3 C -0.8 -3 -1.56 -2.68 -2.12 -2.12 C -2.68 -1.56 -3 -0.8 -3 0 C -3 0.8 -2.68 1.56 -2.12 2.12 C -1.56 2.68 -0.8 3 0 3 z"/></defs>\n',
  ];
  for (let i = 0; i < n; i++) {
    const x = (i * 37) % 500;
    const y = (i * 91) % 500;
    switch (i % 4) {
      case 0:
        parts.push(`<use xlink:href="#mk" class="m" x="${x}" y="${y}"/>\n`);
        break;
      case 1:
        parts.push(`<path d="M ${x} ${y} l 10 5 l 5 -10" fill="none" stroke="black"/>\n`);
        break;
      case 2:
        parts.push(`<rect x="${x}" y="${y}" width="8" height="4" rx="1"/>\n`);
        break;
      default:
        parts.push(`<text x="${x}" y="${y}" text-anchor="middle">L${i}</text>\n`);
    }
  }
  parts.push("</svg>\n");
  return parts.join("");
}

// Best of several runs: the first ones include JIT tier-up, and shared CI machines are noisy.
const RUNS = 10;
// Shared CI runners (`CI` set) are slower and noisy: there only gross regressions (3×)
// fail; the benchmark's performance targets are the release gate.
const LIMIT_MS = process.env.CI ? 600 : 200;

function time(label: string, svg: string, expectPrims: number): number {
  let best = Infinity;
  for (let k = 0; k < RUNS; k++) {
    const t = performance.now();
    const scene = parseSvg(svg);
    if (!scene.ok) throw new Error(scene.error.message);
    const cl = classify(scene.value, AUTO, "ink");
    const ms = performance.now() - t;
    expect(scene.value.primitives.length).toBe(expectPrims);
    expect(cl.ok).toBe(true);
    best = Math.min(best, ms);
  }
  console.log(`${label}: ${best.toFixed(2)} ms (best of ${RUNS}, parse + classify, ${(svg.length / 1024).toFixed(0)} KiB)`);
  return best;
}

describe("performance", () => {
  it("parses and classifies 10k circles in < 200 ms", () => {
    expect(time("10k circles", circles(10_000), 1 + 20_000)).toBeLessThan(LIMIT_MS);
  });
  it("parses and classifies 10k mixed elements in < 200 ms", () => {
    expect(time("10k mixed", mixed(10_000), 2 * 2500 + 2500 + 2500 + 2500)).toBeLessThan(LIMIT_MS);
  });
});
