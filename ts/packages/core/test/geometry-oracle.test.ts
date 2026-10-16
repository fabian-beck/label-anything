// Differential test against the Rust geometry kernel: conformance/geometry/core-geometry.json
// holds inputs and the outputs of rust/crates/la-core (written by
// rust/crates/la-core/examples/geom_oracle.rs). Every output is recomputed here and must be
// bit-identical (Object.is: -0 differs from +0, NaN equals NaN).
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sinCosDeg } from "../src/detmath.js";
import {
  Affine,
  P,
  Rect,
  bboxOf,
  clipSegRect,
  closestOnSeg,
  distPointSeg,
  distSegRect,
  orient,
  segCrossProper,
  segIntersects,
  segLenInRect,
  segOverlapsRect,
  segSegDist,
  type AffineCoeffs,
} from "../src/geom/index.js";
import { flatten, PathError } from "../src/geom/path.js";
import * as polygon from "../src/geom/polygon.js";
import { Shape, shapesOverlap, signDir } from "../src/geom/shape.js";
import { distanceTransform, dtMaxima } from "../src/grid/dt.js";
import { GridSpec, Sat, quantize } from "../src/grid/index.js";
import { MaskRaster } from "../src/grid/raster.js";
import { ceilFast, clampf, cmpF64, floorFast, len2d, maxf, minf, signEps } from "../src/math.js";
import { DynIndex, IdList, StaticIndex } from "../src/spatial.js";

const FIXTURE = fileURLToPath(new URL("../../../../conformance/geometry/core-geometry.json", import.meta.url));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

interface Case {
  in: Json;
  out: Json;
}

const doc = JSON.parse(readFileSync(FIXTURE, "utf8")) as { kind: string; sections: Record<string, Case[]> };

// ---- decoding (fixture → values) and encoding (values → fixture representation) ----

function f(v: Json): number {
  if (typeof v === "number") return v;
  if (v === "inf") return Infinity;
  if (v === "-inf") return -Infinity;
  if (v === "nan") return NaN;
  throw new Error(`not a float: ${JSON.stringify(v)}`);
}

const pt = (v: Json): P => new P(f(v[0]), f(v[1]));
const pts = (v: Json): P[] => (v as Json[]).map(pt);
const rings = (v: Json): P[][] => (v as Json[]).map(pts);
const rect = (v: Json): Rect => new Rect(f(v[0]), f(v[1]), f(v[2]), f(v[3]));

function num(x: number): Json {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  return x;
}

const ptJ = (p: P): Json => [num(p.x), num(p.y)];
const ptsJ = (ps: readonly P[]): Json => ps.map(ptJ);
const rectJ = (r: Rect): Json => [num(r.x0), num(r.y0), num(r.x1), num(r.y1)];
const numsJ = (xs: ArrayLike<number>): Json => Array.from(xs, num);

function gridOf(v: Json): GridSpec {
  return new GridSpec(f(v.ox), f(v.oy), f(v.cell), v.cols, v.rows);
}

function gridJ(g: GridSpec): Json {
  return { ox: num(g.ox), oy: num(g.oy), cell: num(g.cell), cols: g.cols, rows: g.rows };
}

function bytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** FNV-1a (32-bit) of the little-endian bytes of the coordinates (as the oracle's `digest`). */
function digest(ps: readonly P[]): Json {
  const view = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  for (const p of ps) {
    for (const v of [p.x, p.y]) {
      view.setFloat64(0, v, true);
      for (let i = 0; i < 8; i++) h = Math.imul(h ^ view.getUint8(i), 0x01000193) >>> 0;
    }
  }
  return {
    n: ps.length,
    first: ps.length > 0 ? ptJ(ps[0]!) : null,
    last: ps.length > 0 ? ptJ(ps[ps.length - 1]!) : null,
    fnv1a32: h.toString(16).padStart(8, "0"),
  };
}

function buildShape(d: Json): Shape {
  switch (d.kind) {
    case "circle":
      return Shape.circle(pt(d.c), f(d.r));
    case "ellipse":
      return Shape.ellipse(pt(d.c), f(d.rx), f(d.ry), f(d.rotation));
    case "rect":
      return Shape.rect(pt(d.c), f(d.w), f(d.h), f(d.corner_radius), f(d.rotation));
    case "polygon":
      return Shape.polygon(rings(d.rings), d.even_odd, pt(d.reference));
    default:
      throw new Error(`unknown shape ${d.kind}`);
  }
}

function shapeFields(s: Shape): Json {
  switch (s.kind) {
    case "circle":
      return { kind: "circle", c: ptJ(s.c), r: num(s.r) };
    case "ellipse":
      return { kind: "ellipse", c: ptJ(s.c), rx: num(s.rx), ry: num(s.ry), cos: num(s.cos), sin: num(s.sin) };
    case "roundRect":
      return {
        kind: "roundRect",
        c: ptJ(s.c),
        hw: num(s.hw),
        hh: num(s.hh),
        r: num(s.r),
        cos: num(s.cos),
        sin: num(s.sin),
      };
    case "polygon":
      return { kind: "polygon", hull: ptsJ(s.poly.hull), bbox: rectJ(s.poly.bbox) };
  }
}

// ---- comparison ----

interface Tally {
  values: number;
  failures: string[];
}

/** Deep comparison; numbers (and booleans, strings) must be identical (`Object.is`). */
function compare(got: Json, want: Json, path: string, t: Tally): void {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) {
      t.failures.push(`${path}: got ${JSON.stringify(got)?.slice(0, 200)}, want ${JSON.stringify(want).slice(0, 200)}`);
      return;
    }
    for (let i = 0; i < want.length; i++) compare(got[i], want[i], `${path}[${i}]`, t);
    return;
  }
  if (want !== null && typeof want === "object") {
    if (got === null || typeof got !== "object" || Array.isArray(got)) {
      t.failures.push(`${path}: got ${JSON.stringify(got)?.slice(0, 200)}, want an object`);
      return;
    }
    const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
    for (const k of keys) {
      if (!(k in want) || !(k in got)) {
        t.failures.push(`${path}.${k}: missing on the ${k in want ? "TypeScript" : "Rust"} side`);
        continue;
      }
      compare(got[k], want[k], `${path}.${k}`, t);
    }
    return;
  }
  t.values += 1;
  if (!Object.is(got, want)) t.failures.push(`${path}: got ${String(got)}, want ${String(want)}`);
}

const totals: Record<string, number> = {};

function runSection(name: string, compute: (input: Json) => Json): void {
  it(name, () => {
    const cases = doc.sections[name];
    expect(cases, `section ${name}`).toBeDefined();
    const t: Tally = { values: 0, failures: [] };
    cases!.forEach((c, i) => {
      let got: Json;
      try {
        got = compute(c.in);
      } catch (e) {
        t.failures.push(`${name}[${i}]: threw ${String(e)}`);
        return;
      }
      compare(got, c.out, `${name}[${i}]`, t);
    });
    totals[name] = t.values;
    expect(t.failures.slice(0, 20), `${t.failures.length} mismatches of ${t.values} values`).toEqual([]);
    expect(t.values).toBeGreaterThan(0);
  });
}

// ---- sections ----

describe("geometry oracle (bit parity with rust/crates/la-core)", () => {
  it("fixture header", () => {
    expect(doc.kind).toBe("geometry");
  });

  runSection("math", (i) => {
    if (i.floor_ceil !== undefined) {
      const xs = (i.floor_ceil as Json[]).map(f);
      return { floor_fast: numsJ(xs.map(floorFast)), ceil_fast: numsJ(xs.map(ceilFast)) };
    }
    const a = f(i.a);
    const b = f(i.b);
    return {
      minf: num(minf(a, b)),
      maxf: num(maxf(a, b)),
      clampf: num(clampf(a, b, 2)),
      sign_eps: num(signEps(a, Math.abs(b))),
      cmp_f64: cmpF64(a, b),
      len2d: num(len2d(a, b)),
    };
  });

  runSection("point", (i) => {
    const a = pt(i.a);
    const b = pt(i.b);
    const t = f(i.t);
    const s = f(i.s);
    const [sin, cos] = sinCosDeg(f(i.deg));
    return {
      sin_cos: numsJ([sin, cos]),
      dot: num(a.dot(b)),
      cross: num(a.cross(b)),
      len: num(a.len()),
      len2: num(a.len2()),
      norm: ptJ(a.norm()),
      perp: ptJ(a.perp()),
      dist: num(a.dist(b)),
      lerp: ptJ(a.lerp(b, t)),
      rotate: ptJ(a.rotate(cos, sin)),
      unrotate: ptJ(a.unrotate(cos, sin)),
      add: ptJ(a.add(b)),
      sub: ptJ(a.sub(b)),
      mul: ptJ(a.mul(s)),
      neg: ptJ(a.neg()),
      is_finite: a.isFinite(),
      sign_dir: numsJ(signDir(a)),
    };
  });

  runSection("rect", (i) => {
    const a = rect(i.a);
    const b = rect(i.b);
    const p = pt(i.p);
    const d = f(i.d);
    return {
      w: num(a.w()),
      h: num(a.h()),
      area: num(a.area()),
      center: ptJ(a.center()),
      is_empty: a.isEmpty(),
      inflate: rectJ(a.inflate(d)),
      translate: rectJ(a.translate(p)),
      union: rectJ(a.union(b)),
      add_point: rectJ(a.addPoint(p)),
      overlaps: a.overlaps(b),
      touches: a.touches(b),
      intersection: rectJ(a.intersection(b)),
      overlap_area: num(a.overlapArea(b)),
      contains_point: a.containsPoint(p),
      contains_rect: a.containsRect(b),
      dist_point: num(a.distPoint(p)),
      closest_point: ptJ(a.closestPoint(p)),
      dist_rect: num(a.distRect(b)),
      corners: ptsJ(a.corners()),
      xywh: rectJ(Rect.xywh(p.x, p.y, d, d * 2)),
      from_center: rectJ(Rect.fromCenter(p, d, -d)),
    };
  });

  runSection("affine", (i) => {
    const a = new Affine((i.a as Json[]).map(f) as unknown as AffineCoeffs);
    const b = new Affine((i.b as Json[]).map(f) as unknown as AffineCoeffs);
    const p = pt(i.p);
    return { apply: ptJ(a.apply(p)), then: numsJ(a.then(b).m), is_identity: a.isIdentity() };
  });

  runSection("segment", (i) => {
    const [a, b, c, d, p] = [pt(i.a), pt(i.b), pt(i.c), pt(i.d), pt(i.p)];
    const r = rect(i.r);
    const clip = clipSegRect(a, b, r);
    return {
      orient: num(orient(a, b, c)),
      dist_point_seg: num(distPointSeg(p, a, b)),
      closest_on_seg: ptJ(closestOnSeg(p, a, b)),
      seg_intersects: segIntersects(a, b, c, d),
      seg_cross_proper: segCrossProper(a, b, c, d),
      seg_seg_dist: num(segSegDist(a, b, c, d)),
      seg_len_in_rect: num(segLenInRect(a, b, r)),
      clip_seg_rect: clip === null ? null : numsJ(clip),
      seg_overlaps_rect: segOverlapsRect(a, b, r),
      dist_seg_rect: num(distSegRect(a, b, r)),
      bbox_of: rectJ(bboxOf([a, b, c, d, p])),
    };
  });

  runSection("polygon", (i) => {
    if (i.hull_of !== undefined) return { convex_hull: ptsJ(polygon.convexHull(pts(i.hull_of))) };
    const rs = rings(i.rings);
    const all = rs.flat();
    const bbox = bboxOf(all);
    const points = pts(i.points);
    const rects = (i.rects as Json[]).map(rect);
    const pad = f(i.pad);
    const precision = f(i.precision);
    const perRect = (eo: boolean): Json =>
      rects.map((r) => [
        polygon.overlapsRect(rs, eo, bbox, r),
        polygon.containsRect(rs, eo, r, pad),
        num(polygon.distRect(rs, eo, bbox, r)),
      ]);
    const pole = (eo: boolean): Json => {
      const [p, d] = polygon.polylabel(rs, eo, precision);
      return [ptJ(p), num(d)];
    };
    return {
      signed_area: numsJ(rs.map((r) => polygon.signedArea(r))),
      area_even_odd: num(polygon.area(rs, true)),
      area_nonzero: num(polygon.area(rs, false)),
      ring_centroid: ptJ(polygon.ringCentroid(rs[0]!)),
      convex_hull: ptsJ(polygon.convexHull(all)),
      winding: points.map((p) => polygon.winding(rs[0]!, p)),
      contains_even_odd: points.map((p) => polygon.contains(rs, true, p)),
      contains_nonzero: points.map((p) => polygon.contains(rs, false, p)),
      dist_boundary: numsJ(points.map((p) => polygon.distBoundary(rs, p))),
      rects_even_odd: perRect(true),
      rects_nonzero: perRect(false),
      polylabel_even_odd: pole(true),
      polylabel_nonzero: pole(false),
    };
  });

  runSection("shape", (i) => {
    const s = buildShape(i.shape);
    const dirs = pts(i.dirs);
    const offset = f(i.offset);
    const points = pts(i.points);
    const rects = (i.rects as Json[]).map(rect);
    const segs = (i.segs as Json[]).map((v) => [pt(v[0]), pt(v[1]), f(v[2])] as const);
    const step = f(i.step);
    const pad = f(i.pad);
    const inner = (i.inner as Json[]).map(rect);
    const moved = s.translated(pt(i.delta));
    return {
      fields: shapeFields(s),
      bbox: rectJ(s.bbox()),
      area: num(s.area()),
      reference: ptJ(s.reference()),
      is_circle: s.isCircle(),
      support: ptsJ(dirs.map((d) => s.support(d))),
      support_inflated: ptsJ(dirs.map((d) => s.supportInflated(d, offset))),
      signed_distance: numsJ(points.map((p) => s.signedDistance(p))),
      contains: points.map((p) => s.contains(p)),
      overlaps_rect: rects.map((r) => s.overlapsRect(r)),
      dist_rect: numsJ(rects.map((r) => s.distRect(r))),
      dist_segment: numsJ(segs.map(([a, b]) => s.distSegment(a, b))),
      near_segment: segs.map(([a, b, c]) => s.nearSegment(a, b, c)),
      covered_len: numsJ(segs.map(([a, b]) => s.coveredLen(a, b, step))),
      boundary_point: ptsJ(dirs.map((d) => s.boundaryPoint(d))),
      contains_rect: inner.map((r) => s.containsRect(r, pad)),
      outline: digest(s.outline()),
      outline_rings: s.outlineRings().length,
      translated: {
        bbox: rectJ(moved.bbox()),
        reference: ptJ(moved.reference()),
        support: ptJ(moved.support(dirs[0]!)),
        signed_distance: num(moved.signedDistance(points[0]!)),
      },
    };
  });

  runSection("shape_pairs", (i) => {
    const a = buildShape(i.a);
    const moved = buildShape(i.b).translated(pt(i.delta));
    return { overlap: shapesOverlap(a, moved), overlap_rev: shapesOverlap(moved, a) };
  });

  runSection("path", (i) => {
    try {
      const subs = flatten(i.d, f(i.tol));
      return { subpaths: subs.map((s) => ({ closed: s.closed, points: ptsJ(s.points) })) };
    } catch (e) {
      if (!(e instanceof PathError)) throw e;
      return { error: { offset: e.offset, message: e.message } };
    }
  });

  runSection("grid", (i) => {
    const g = GridSpec.covering(rect(i.extent), f(i.cell));
    const p = pt(i.p);
    return {
      grid: gridJ(g),
      cells: g.cells(),
      to_cell: numsJ(g.toCell(p)),
      cell_rect: rectJ(g.cellRect(i.col, i.row)),
      cell_center: ptJ(g.cellCenter(i.col, i.row)),
      extent: rectJ(g.extent()),
      quantize: (i.quantize as Json[]).map((v) => quantize(f(v))),
    };
  });

  runSection("raster", (i) => {
    const m = new MaskRaster(gridOf(i.grid));
    for (const prim of i.prims as Json[]) {
      if (prim.disc) m.disc(pt(prim.disc[0]), f(prim.disc[1]));
      else if (prim.rect) {
        const r = rect(prim.rect);
        m.rect(r.x0, r.y0, r.x1, r.y1);
      } else if (prim.capsule) m.capsule(pt(prim.capsule[0]), pt(prim.capsule[1]), f(prim.capsule[2]));
      else if (prim.polygon) m.polygon(rings(prim.polygon[0]), prim.polygon[1]);
      else if (prim.shape) m.shape(buildShape(prim.shape));
      else if (prim.touch) m.touchSegment(pt(prim.touch[0]), pt(prim.touch[1]));
      else throw new Error(`unknown primitive ${JSON.stringify(prim)}`);
    }
    return { coverage: Buffer.from(m.intoCoverage()).toString("base64") };
  });

  runSection("sat", (i) => {
    const g = gridOf(i.grid);
    const sat = Sat.fromCoverage(g.cols, g.rows, bytes(i.coverage));
    const rects = (i.rects as Json[]).map(rect);
    return {
      nonempty: sat.nonempty,
      integral: numsJ(rects.map((r) => sat.integral(g, r))),
      covered_area: numsJ(rects.map((r) => sat.coveredArea(g, r))),
      any: rects.map((r) => sat.any(g, r)),
      cell_range: rects.map((r) => g.cellRange(r)),
      block: (i.blocks as number[][]).map((b) => sat.block(b[0]!, b[1]!, b[2]!, b[3]!)),
      cell: (i.cells as number[][]).map((q) => sat.cell(q[0]!, q[1]!)),
    };
  });

  runSection("dt", (i) => {
    const g = gridOf(i.grid);
    const occ = bytes(i.occupied);
    const dt = distanceTransform(g, (k) => occ[k] !== 0);
    const maxima = (mv: number): Json => dtMaxima(g, dt, mv).map(([p, v, c, r]) => [ptJ(p), num(v), c, r]);
    return { dt: numsJ(dt), maxima: (i.min_v as Json[]).map((v) => maxima(f(v))) };
  });

  runSection("index", (i) => {
    const extent = rect(i.extent);
    const cell = f(i.cell);
    const out = new IdList(4);
    if (i.type === "static") {
      const ix = new StaticIndex((i.boxes as Json[]).map(rect), extent, cell);
      return {
        len: ix.len(),
        results: (i.queries as Json[]).map((q) => {
          ix.query(rect(q), out);
          return out.toArray();
        }),
      };
    }
    const ix = new DynIndex(extent, cell);
    const results: Json[] = [];
    for (const op of i.ops as Json[]) {
      if (op[0] === "insert") ix.insert(op[1], rect(op[2]));
      else if (op[0] === "remove") ix.remove(op[1]);
      else if (op[0] === "get") {
        const r = ix.get(op[1]);
        results.push(r === null ? null : rectJ(r));
      } else {
        ix.query(rect(op[1]), out);
        results.push(out.toArray());
      }
    }
    return { results };
  });

  it("covers every section with many values", () => {
    const names = Object.keys(doc.sections);
    for (const n of names) expect(totals[n], `section ${n} not checked`).toBeGreaterThan(0);
    const total = Object.values(totals).reduce((a, b) => a + b, 0);
    console.log(`geometry oracle: ${total} values bit-identical`, totals);
    expect(total).toBeGreaterThan(10000);
  });
});
