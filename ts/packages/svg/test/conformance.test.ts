// Runs the language-neutral cases in conformance/svg/*.json (format: conformance/svg/README.md).

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ClassRule,
  type Geometry,
  type ParseOptions,
  type Primitive,
  classify,
  elementById,
  elementGeometry,
  outline,
  parseSvg,
  select,
} from "../src/index.js";
import { fillArea, type Summary, summarize } from "./summary.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const dir = join(repo, "conformance/svg");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

interface Tol {
  area: number;
  length: number;
  bbox: number;
}

const close = (a: number, b: number, rel: number, abs: number) => Math.abs(a - b) <= Math.max(rel * Math.abs(b), abs);

function checkBbox(what: string, actual: [number, number, number, number] | null, e: J, tol: number, errs: string[]): void {
  if (e === null) {
    if (actual !== null) errs.push(`${what}: bbox = ${JSON.stringify(actual)}, expected null`);
    return;
  }
  if (actual === null || !Array.isArray(e) || e.length !== 4 || [0, 1, 2, 3].some((k) => Math.abs(actual[k]! - e[k]) > tol)) {
    errs.push(`${what}: bbox = ${JSON.stringify(actual)}, expected ${JSON.stringify(e)}`);
  }
}

function checkSummary(what: string, s: Summary, e: J, tol: Tol, errs: string[]): void {
  for (const key of ["count", "polygons", "polylines", "rects", "vertices"] as const) {
    if (e[key] !== undefined && e[key] !== s[key]) errs.push(`${what}: ${key} = ${s[key]}, expected ${e[key]}`);
  }
  if (e.fill_area !== undefined && !close(s.fill_area, e.fill_area, tol.area, 0.5)) {
    errs.push(`${what}: fill_area = ${s.fill_area}, expected ${e.fill_area}`);
  }
  if (e.stroke_length !== undefined && !close(s.stroke_length, e.stroke_length, tol.length, 0.05)) {
    errs.push(`${what}: stroke_length = ${s.stroke_length}, expected ${e.stroke_length}`);
  }
  if (e.stroke_width !== undefined) {
    const w = s.widths;
    if (w === null || !close(w[0], e.stroke_width[0], 0.01, 1e-6) || !close(w[1], e.stroke_width[1], 0.01, 1e-6)) {
      errs.push(`${what}: stroke_width = ${JSON.stringify(w)}, expected ${JSON.stringify(e.stroke_width)}`);
    }
  }
  if (e.bbox !== undefined) {
    const b = s.bbox === null ? null : ([s.bbox[0], s.bbox[1], s.bbox[2] - s.bbox[0], s.bbox[3] - s.bbox[1]] as [number, number, number, number]);
    checkBbox(what, b, e.bbox, tol.bbox, errs);
  }
}

const geoms = (prims: Iterable<Primitive>): Geometry[] => [...prims] as Geometry[];

function runCase(c: J): string[] {
  const errs: string[] = [];
  const svg: string = Array.isArray(c.svg) ? c.svg.join("\n") : c.svg;
  const opts: ParseOptions = {};
  if (c.canvas !== undefined) opts.canvas = { width: c.canvas.width, height: c.canvas.height };
  if (c.tolerance !== undefined) opts.tolerance = c.tolerance;
  const ex = c.expect ?? {};
  const tol: Tol = { area: ex.tol?.area ?? 0.01, length: ex.tol?.length ?? 0.01, bbox: ex.tol?.bbox ?? 0.5 };
  const parsed = parseSvg(svg, opts);
  if (!parsed.ok) {
    if (ex.error === parsed.error.code) return [];
    return [`parse failed: ${parsed.error.code}: ${parsed.error.message}`];
  }
  if (ex.error !== undefined) return [`expected error ${ex.error}, parse succeeded`];
  const scene = parsed.value;

  let rules: ClassRule[] = [];
  if (c.classes !== undefined) rules = c.classes;
  else if (c.preset !== undefined) {
    rules = JSON.parse(readFileSync(join(repo, "spec/presets", `${c.preset}.json`), "utf8")).svg_classes;
  }
  const defaultClass: string = c.default_class ?? "ink";

  for (const key of ["width", "height", "canvas_width", "canvas_height"] as const) {
    if (ex[key] !== undefined && Math.abs(scene[key] - ex[key]) > 1e-6 * Math.max(1, Math.abs(ex[key]))) {
      errs.push(`${key} = ${scene[key]}, expected ${ex[key]}`);
    }
  }
  if (ex.element_count !== undefined && ex.element_count !== scene.elements.length) {
    errs.push(`element_count = ${scene.elements.length}, expected ${ex.element_count}`);
  }
  if (ex.warnings !== undefined) {
    const want = [...ex.warnings].sort();
    const got = scene.warnings.map((w) => w.code).sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) errs.push(`warnings = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }

  const cl = classify(scene, rules, defaultClass);
  if (!cl.ok) {
    if (ex.classify_error !== cl.error.code) errs.push(`classify failed: ${cl.error.code}: ${cl.error.message}`);
  } else {
    if (ex.classify_error !== undefined) errs.push(`expected classify error ${ex.classify_error}`);
    const byClass = new Map<string, Geometry[]>();
    for (const x of cl.value) {
      const list = byClass.get(x.class) ?? [];
      list.push(x.primitive as Geometry);
      byClass.set(x.class, list);
    }
    if (ex.classes !== undefined) {
      for (const [name, e] of Object.entries(ex.classes)) {
        checkSummary(`class ${name}`, summarize(byClass.get(name) ?? []), e, tol, errs);
      }
      if (ex.exact_classes ?? true) {
        for (const [name, list] of byClass) {
          if (!(name in ex.classes)) errs.push(`unexpected class ${name} (${list.length} primitives)`);
        }
      }
    }
  }

  if (ex.elements !== undefined) {
    for (const [id, e] of Object.entries<J>(ex.elements)) {
      const i = elementById(scene, id);
      if (i === undefined) {
        errs.push(`element #${id} not found`);
        continue;
      }
      const el = scene.elements[i]!;
      for (const key of ["drawn", "filled", "stroked"] as const) {
        if (e[key] !== undefined && e[key] !== el[key]) errs.push(`#${id}: ${key} = ${el[key]}, expected ${e[key]}`);
      }
      if (e.tag !== undefined && e.tag !== el.tag) errs.push(`#${id}: tag = ${el.tag}, expected ${e.tag}`);
      if (e.bbox !== undefined) {
        const b = el.bbox === null ? null : ([el.bbox.x, el.bbox.y, el.bbox.w, el.bbox.h] as [number, number, number, number]);
        checkBbox(`#${id}`, b, e.bbox, tol.bbox, errs);
      }
    }
  }

  for (const e of ex.select ?? []) {
    const r = select(scene, e.selector);
    if (!r.ok) {
      if (e.error !== r.error.code) errs.push(`select ${JSON.stringify(e.selector)}: ${r.error.code}: ${r.error.message}`);
      continue;
    }
    if (e.error !== undefined) errs.push(`select ${JSON.stringify(e.selector)}: expected an error`);
    checkSummary(`select ${JSON.stringify(e.selector)}`, summarize(geoms(r.value)), e, tol, errs);
    if (e.outline !== undefined) checkSummary(`outline of ${JSON.stringify(e.selector)}`, summarize(outline(r.value)), e.outline, tol, errs);
  }

  for (const e of ex.geometry ?? []) {
    const prims = elementGeometry(scene, e.id);
    if (prims === undefined) {
      if (!e.missing) errs.push(`geometry #${e.id}: no such element`);
      continue;
    }
    checkSummary(`geometry #${e.id}`, summarize(geoms(prims)), e, tol, errs);
    if (e.outline !== undefined) checkSummary(`outline #${e.id}`, summarize(outline(prims)), e.outline, tol, errs);
  }
  return errs;
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort();
const cases = files.map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8"))] as const).filter(([, c]) => c.kind === "svg");

describe("svg conformance", () => {
  it("has cases", () => {
    expect(cases.length).toBeGreaterThan(0);
  });
  for (const [file, c] of cases) {
    it(`${file}: ${c.name}`, () => {
      const errs = runCase(c);
      expect(errs, errs.join("\n")).toEqual([]);
    });
  }
});

describe("fillArea reference", () => {
  it("handles fill rules and self-intersections", () => {
    const sq: [number, number][][] = [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ];
    expect(fillArea(sq, false)).toBeCloseTo(100, 9);
    const donut = [...sq, [[2, 2], [8, 2], [8, 8], [2, 8]] as [number, number][]];
    expect(fillArea(donut, false)).toBeCloseTo(100, 9);
    expect(fillArea(donut, true)).toBeCloseTo(64, 9);
    const donut2 = [...sq, [[2, 2], [2, 8], [8, 8], [8, 2]] as [number, number][]];
    expect(fillArea(donut2, false)).toBeCloseTo(64, 9);
    const bow: [number, number][][] = [
      [
        [0, 0],
        [10, 10],
        [10, 0],
        [0, 10],
      ],
    ];
    expect(fillArea(bow, false)).toBeCloseTo(50, 9);
    expect(fillArea(bow, true)).toBeCloseTo(50, 9);
  });
});
