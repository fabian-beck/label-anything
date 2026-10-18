/**
 * Conformance runner for the `place` cases of `conformance/` (format:
 * `conformance/README.md`); port of `rust/crates/label-anything/tests/conformance.rs`,
 * with the same independent re-checks of the hard guarantees the runner can verify on
 * its own (label overlaps, leader crossings, canvas bounds).
 *
 * ```text
 * node ts/packages/core/dist/conformance/run.js conformance     # npm run conformance
 * ```
 *
 * Node only (reads the case files); not part of the package's main entry.
 *
 * @module
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LabelProblem, LabelResult } from "../api.js";
import { jsonEq } from "../json.js";
import { defaultOf } from "../options.js";
import { place } from "../place.js";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const get = (v: unknown, k: string): unknown => (isObj(v) ? v[k] : undefined);
const f64 = (v: unknown): number | null => (typeof v === "number" ? v : null);
const u64 = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
/** RFC 6901 pointer lookup. */
function pointer(v: unknown, p: string): unknown {
  let cur = v;
  for (const part of p.split("/").slice(1)) {
    const k = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) cur = cur[Number(k)];
    else if (isObj(cur)) cur = cur[k];
    else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}
/** serde_json's `Display` of a value. */
const show = (v: unknown): string => (v === undefined ? "null" : JSON.stringify(v));

function placementOf(r: LabelResult, id: string): Json | undefined {
  return (r.placements as unknown[]).find((p) => get(p, "id") === id) as Json | undefined;
}

function px(v: unknown, em: number): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.trim();
    let num = s;
    let mul = 1;
    if (s.endsWith("px")) num = s.slice(0, -2);
    else if (s.endsWith("pt")) {
      num = s.slice(0, -2);
      mul = 4 / 3;
    } else if (s.endsWith("em")) {
      num = s.slice(0, -2);
      mul = em;
    }
    const x = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(num) ? Number(num) : 0;
    return x * mul;
  }
  return 0;
}

interface BoxR {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxOf(p: Json): BoxR | null {
  const b = get(p, "box");
  const x = f64(get(b, "x"));
  const y = f64(get(b, "y"));
  const w = f64(get(b, "w"));
  const h = f64(get(b, "h"));
  if (x === null || y === null || w === null || h === null) return null;
  return { x0: x, y0: y, x1: x + w, y1: y + h };
}

type Pt = [number, number];

function segCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

/**
 * The leader has an underline (baseline port) that starts at the leader's end, on a side
 * edge of the box, runs horizontally inside the box below its vertical middle.
 */
function underlineAtPort(p: Json): boolean {
  const l = get(p, "leader");
  const pts = get(l, "points");
  const u = get(l, "underline");
  if (!Array.isArray(pts) || !Array.isArray(u) || pts.length === 0 || u.length < 2) return false;
  const xy = (q: unknown): Pt | null =>
    Array.isArray(q) && typeof q[0] === "number" && typeof q[1] === "number" ? [q[0], q[1]] : null;
  const end = xy(pts[pts.length - 1]);
  const a = xy(u[0]);
  const b = xy(u[1]);
  if (end === null || a === null || b === null) return false;
  const bx = get(p, "box");
  const num = (k: string): number => {
    const v = get(bx, k);
    return typeof v === "number" ? v : NaN;
  };
  const [x, y, w, h] = [num("x"), num("y"), num("w"), num("h")];
  const near = (s: number, t: number): boolean => Math.abs(s - t) <= 1e-6;
  return (
    near(end[0], a[0]) &&
    near(end[1], a[1]) &&
    near(a[1], b[1]) &&
    (near(a[0], x) || near(a[0], x + w)) &&
    a[1] > y + h * 0.5 &&
    a[1] < y + h &&
    b[0] >= x - 1e-6 &&
    b[0] <= x + w + 1e-6
  );
}

function leaderSegments(p: Json): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  const ls: unknown[] = [];
  const l = get(p, "leader");
  if (l !== undefined && l !== null) ls.push(l);
  const many = get(p, "leaders");
  if (Array.isArray(many)) ls.push(...many);
  for (const l of ls) {
    const pts: Pt[] = [];
    const raw = get(l, "points");
    if (Array.isArray(raw)) {
      for (const q of raw) {
        if (Array.isArray(q) && typeof q[0] === "number" && typeof q[1] === "number") pts.push([q[0], q[1]]);
      }
    }
    for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i]!, pts[i + 1]!]);
  }
  return out;
}

/** The number of points of every leader of placement `p`. */
function leaderPointCounts(p: Json): number[] {
  const ls: unknown[] = [];
  const l = get(p, "leader");
  if (l !== undefined && l !== null) ls.push(l);
  const many = get(p, "leaders");
  if (Array.isArray(many)) ls.push(...many);
  return ls.map((l) => {
    const raw = get(l, "points");
    return Array.isArray(raw) ? raw.length : 0;
  });
}

/** The solver under test: `place` of `@label-anything/core` by default. */
export type PlaceFn = (problem: unknown) => LabelResult;

const defaultPlace: PlaceFn = (p) => place(p as LabelProblem);

/** Check one case; returns the list of failed expectations. */
export function checkPlace(problem: unknown, exp: unknown, placeFn: PlaceFn = defaultPlace): string[] {
  const f: string[] = [];
  let r: LabelResult;
  try {
    r = placeFn(problem);
  } catch (e) {
    return [`place failed: ${e instanceof Error ? e.message : String(e)}`];
  }
  const st = r.stats as unknown as Json;
  const placements = (r.placements as unknown[]).filter(isObj);
  const placed = placements.filter((p) => p.placed === true);
  const num = (key: string, actual: unknown): void => {
    const e = get(exp, key);
    if (e !== undefined && !jsonEq(e, actual)) f.push(`${key}: expected ${show(e)}, got ${show(actual)}`);
  };
  num("hard_violations", st.hard_violations);
  num("leader_crossings", st.leader_crossings);
  num("priority_inversions", st.priority_inversions);
  num("placed", st.placed);
  const nPlaced = placed.length;
  const pmin = u64(get(exp, "placed_min"));
  if (pmin !== null && nPlaced < pmin) f.push(`placed_min: ${nPlaced} < ${pmin}`);
  const pmax = u64(get(exp, "placed_max"));
  if (pmax !== null && nPlaced > pmax) f.push(`placed_max: ${nPlaced} > ${pmax}`);
  for (const [key, want] of [
    ["placed_ids", true],
    ["unplaced_ids", false],
  ] as const) {
    const ids = get(exp, key);
    for (const idv of Array.isArray(ids) ? ids : []) {
      const id = typeof idv === "string" ? idv : "";
      const p = placementOf(r, id);
      if (p === undefined) f.push(`${key}: no placement for ${id}`);
      else if ((p.placed === true) !== want) f.push(`${key}: ${id} has placed = ${!want}`);
    }
  }
  for (const [key, field] of [
    ["reasons", "reason"],
    ["anchor_side", "anchor_side"],
    ["model", "model"],
  ] as const) {
    const m = get(exp, key);
    if (!isObj(m)) continue;
    for (const id of Object.keys(m)) {
      const want = m[id];
      const p = placementOf(r, id);
      const got = p !== undefined && p[field] !== undefined ? p[field] : null;
      if (!jsonEq(got, want)) f.push(`${key}.${id}: expected ${show(want)}, got ${show(got)}`);
    }
  }
  const oo = get(exp, "omission_order");
  if (oo !== undefined && !jsonEq(st.omission_order, oo)) {
    f.push(`omission_order: expected ${show(oo)}, got ${show(st.omission_order)}`);
  }
  const hl = get(exp, "has_leader");
  if (isObj(hl)) {
    for (const id of Object.keys(hl)) {
      const p = placementOf(r, id);
      const got = p !== undefined ? leaderSegments(p).length > 0 : false;
      if (got !== hl[id]) f.push(`has_leader.${id}: expected ${show(hl[id])}, got ${got}`);
    }
  }
  const mb = get(exp, "max_bends");
  if (typeof mb === "number") {
    for (const p of r.placements as unknown[]) {
      for (const n of leaderPointCounts(p as Json)) {
        if (n > mb + 2) f.push(`max_bends: a leader of ${show(get(p, "id"))} bends ${n - 2} times`);
      }
    }
  }
  const ul = get(exp, "underline");
  if (isObj(ul)) {
    for (const id of Object.keys(ul)) {
      const p = placementOf(r, id);
      const got = p !== undefined && underlineAtPort(p);
      if (got !== ul[id]) f.push(`underline.${id}: expected ${show(ul[id])}, got ${got}`);
    }
  }
  const tl = get(exp, "text_lines");
  if (isObj(tl)) {
    for (const id of Object.keys(tl)) {
      const p = placementOf(r, id);
      const lines = get(get(p, "text"), "lines");
      const got = lines !== undefined ? lines : null;
      if (!jsonEq(got, tl[id])) f.push(`text_lines.${id}: expected ${show(tl[id])}, got ${show(got)}`);
    }
  }
  const fo = get(exp, "font");
  if (isObj(fo)) {
    for (const id of Object.keys(fo)) {
      const want = fo[id];
      const p = placementOf(r, id);
      const size = f64(get(want, "size"));
      if (size !== null) {
        const got = f64(get(get(p, "text"), "font_size")) ?? NaN;
        if (Math.abs(got - size) > 1e-6 || got !== got) f.push(`font.${id}.size: expected ${size}, got ${got}`);
      }
      const w = get(want, "weight");
      if (w !== undefined) {
        const got = get(get(p, "text"), "font_weight");
        if (!jsonEq(got !== undefined ? got : null, w)) f.push(`font.${id}.weight: expected ${show(w)}, got ${show(got)}`);
      }
      const c = get(want, "class");
      if (c !== undefined) {
        const got = get(get(p, "priority"), "font_class");
        if (!jsonEq(got !== undefined ? got : null, c)) f.push(`font.${id}.class: expected ${show(c)}, got ${show(got)}`);
      }
    }
  }
  const bx = get(exp, "box");
  if (isObj(bx)) {
    for (const id of Object.keys(bx)) {
      const want = bx[id];
      const tol = f64(get(want, "tol")) ?? 0.01;
      const got = get(placementOf(r, id), "box");
      for (const k of ["x", "y", "w", "h"]) {
        const a = f64(get(got, k)) ?? NaN;
        const b = f64(get(want, k)) ?? NaN;
        if (Math.abs(a - b) > tol || a !== a || b !== b) f.push(`box.${id}.${k}: expected ${b} ± ${tol}, got ${a}`);
      }
    }
  }
  // independent re-check: no two placed rectangular labels overlap
  const boxes: [string, BoxR][] = [];
  for (const p of placed) {
    const id = p.id;
    const b = boxOf(p);
    if (typeof id === "string" && b !== null) boxes.push([id, b]);
  }
  const ll = pointer(problem, "/avoid/label/labels");
  const labelsHard = ll === undefined ? true : ll === "hard";
  if (labelsHard) {
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]![1];
        const b = boxes[j]![1];
        const e = 1e-6;
        if (a.x0 < b.x1 - e && b.x0 < a.x1 - e && a.y0 < b.y1 - e && b.y0 < a.y1 - e) {
          f.push(`labels ${boxes[i]![0]} and ${boxes[j]![0]} overlap`);
        }
      }
    }
  }
  // independent re-check: no two leaders cross (when crossings are hard, the default)
  const le = pointer(problem, "/avoid/leader/leaders");
  const leadersHard = le === undefined ? true : le === "hard";
  if (leadersHard) {
    const segs = placed.map(leaderSegments);
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const cross = segs[i]!.some(([a, b]) => segs[j]!.some(([c, d]) => segCross(a, b, c, d)));
        if (cross) f.push(`leaders of ${show(placed[i]!.id)} and ${show(placed[j]!.id)} cross`);
      }
    }
  }
  const em = f64(pointer(problem, "/defaults/font/size")) ?? 12;
  if (get(exp, "inside_canvas") === true) {
    const c = get(problem, "canvas");
    if (c !== undefined) {
      const pv = get(c, "padding");
      const pad = pv !== undefined ? px(pv, em) : 0;
      const w = f64(get(c, "width")) ?? 0;
      const h = f64(get(c, "height")) ?? 0;
      for (const [id, b] of boxes) {
        const e = 1e-6;
        if (b.x0 < pad - e || b.y0 < pad - e || b.x1 > w - pad + e || b.y1 > h - pad + e) {
          f.push(`inside_canvas: ${id} at [${b.x0}, ${b.y0}, ${b.x1}, ${b.y1}]`);
        }
      }
    }
  }
  if (get(exp, "prefix") === true) {
    const ranked: [number, boolean][] = [];
    for (const p of placements) {
      if (p.reason === "grouped" || p.reason === "keep_with") continue;
      const rank = u64(get(p.priority, "rank"));
      if (rank !== null) ranked.push([rank, p.placed === true]);
    }
    ranked.sort((a, b) => a[0] - b[0] || Number(a[1]) - Number(b[1]));
    const cut = ranked.findIndex((x) => !x[1]);
    if (cut >= 0 && ranked.slice(cut).some((x) => x[1])) {
      f.push("prefix: a placed item follows an omitted one in priority order");
    }
  }
  const gap = f64(get(exp, "touch_gap_max"));
  if (gap !== null) {
    // point anchors with circle marks: adjacent labels touch the mark inflated by offset
    const ov = pointer(problem, "/placement/offset");
    const offset = ov !== undefined ? px(ov, em) : px(defaultOf("placement.offset", "rust"), em);
    const items = get(problem, "items");
    for (const it of Array.isArray(items) ? items : []) {
      const id = typeof get(it, "id") === "string" ? (get(it, "id") as string) : "";
      const p = placementOf(r, id);
      if (p === undefined || p.model !== "adjacent") continue;
      const b = boxOf(p);
      if (b === null) continue;
      const anchor = get(it, "anchor");
      const ax = f64(get(anchor, "x")) ?? 0;
      const ay = f64(get(anchor, "y")) ?? 0;
      let mark = get(anchor, "mark");
      if (mark === undefined) {
        const dm = pointer(problem, "/defaults/mark");
        mark = dm !== undefined ? dm : defaultOf("defaults.mark", "rust");
      }
      if (get(mark, "shape") !== "circle") continue;
      const rr = f64(get(mark, "r")) ?? 0;
      const dx = Math.max(Math.max(b.x0 - ax, ax - b.x1), 0);
      const dy = Math.max(Math.max(b.y0 - ay, ay - b.y1), 0);
      const d = Math.sqrt(dx * dx + dy * dy) - rr - offset;
      if (d > gap + 1e-9 || d < -1e-6) f.push(`touch_gap_max: ${id} gap ${d}`);
    }
  }
  if (get(exp, "deterministic") === true) {
    const r2 = placeFn(problem);
    if (!jsonEq(r.placements, r2.placements)) f.push("deterministic: two runs differ");
  }
  return f;
}

/** A `place` case file: its name, problem and expectations. */
export interface PlaceCase {
  name: string;
  problem: unknown;
  expect: unknown;
}

/** All `place` cases of a conformance directory, sorted by file name. */
export function loadPlaceCases(conformanceDir: string): PlaceCase[] {
  const dir = join(conformanceDir, "place");
  const out: PlaceCase[] = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith(".json"))
    .sort()) {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as Json;
    if (c.kind !== "place") throw new Error(`${f}: kind is not "place"`);
    let problem = c.problem;
    if (problem === undefined) {
      if (typeof c.problem_file !== "string") throw new Error(`${f}: no problem`);
      problem = JSON.parse(readFileSync(join(dir, c.problem_file), "utf8"));
    }
    out.push({ name: f.replace(/\.json$/, ""), problem, expect: c.expect });
  }
  return out;
}

/** Run all `place` cases; returns the failures as `name: messages`. */
export function runPlaceCases(conformanceDir: string, placeFn: PlaceFn = defaultPlace): { total: number; failures: string[] } {
  const cases = loadPlaceCases(conformanceDir);
  const failures: string[] = [];
  for (const c of cases) {
    const fails = checkPlace(c.problem, c.expect, placeFn);
    if (fails.length > 0) failures.push(`${c.name}: ${fails.join("; ")}`);
  }
  return { total: cases.length, failures };
}

function main(): void {
  const dir = process.argv[2] ?? "conformance";
  const { total, failures } = runPlaceCases(dir);
  for (const f of failures) console.error(f);
  console.log(`${total - failures.length} of ${total} place cases passed`);
  process.exitCode = failures.length === 0 && total >= 20 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
