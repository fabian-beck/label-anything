// Summary metrics of the conformance format (conformance/svg/README.md); mirrors the Rust runner.

import type { Geometry, Point } from "../src/index.js";

/** Area covered by `rings` under the fill rule (exact scanline integration). */
export function fillArea(rings: readonly Point[][], evenOdd: boolean): number {
  const edges: [number, number, number, number][] = [];
  for (const r of rings) {
    for (let k = 0; k < r.length; k++) {
      const a = r[k]!;
      const b = r[(k + 1) % r.length]!;
      if (a[1] !== b[1]) edges.push([a[0], a[1], b[0], b[1]]);
    }
  }
  const ys: number[] = [];
  for (const e of edges) ys.push(e[1], e[3]);
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const p = edges[i]!;
      const q = edges[j]!;
      const d = (p[2] - p[0]) * (q[3] - q[1]) - (p[3] - p[1]) * (q[2] - q[0]);
      if (d === 0) continue;
      const t = ((q[0] - p[0]) * (q[3] - q[1]) - (q[1] - p[1]) * (q[2] - q[0])) / d;
      const u = ((q[0] - p[0]) * (p[3] - p[1]) - (q[1] - p[1]) * (p[2] - p[0])) / d;
      if (t > 0 && t < 1 && u > 0 && u < 1) ys.push(p[1] + t * (p[3] - p[1]));
    }
  }
  ys.sort((a, b) => a - b);
  let area = 0;
  for (let k = 1; k < ys.length; k++) {
    const ya = ys[k - 1]!;
    const yb = ys[k]!;
    if (yb === ya) continue;
    const ym = (ya + yb) / 2;
    const xs: [number, number][] = [];
    for (const e of edges) {
      const lo = Math.min(e[1], e[3]);
      const hi = Math.max(e[1], e[3]);
      if (ym > lo && ym < hi) xs.push([e[0] + ((ym - e[1]) * (e[2] - e[0])) / (e[3] - e[1]), e[3] > e[1] ? 1 : -1]);
    }
    xs.sort((a, b) => a[0] - b[0]);
    let wind = 0;
    let len = 0;
    for (let i = 0; i < xs.length; i++) {
      const inside = evenOdd ? wind % 2 !== 0 : wind !== 0;
      if (inside && i > 0) len += xs[i]![0] - xs[i - 1]![0];
      wind += xs[i]![1];
    }
    area += len * (yb - ya);
  }
  return area;
}

export function polylineLength(points: readonly Point[], closed: boolean): number {
  let l = 0;
  for (let k = 1; k < points.length; k++) l += Math.hypot(points[k]![0] - points[k - 1]![0], points[k]![1] - points[k - 1]![1]);
  if (closed && points.length > 1) {
    const a = points[0]!;
    const b = points[points.length - 1]!;
    l += Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  return l;
}

export interface Summary {
  count: number;
  polygons: number;
  polylines: number;
  rects: number;
  fill_area: number;
  stroke_length: number;
  widths: [number, number] | null;
  /** [x0, y0, x1, y1] */
  bbox: [number, number, number, number] | null;
  vertices: number;
}

export function summarize(geoms: Iterable<Geometry>): Summary {
  const s: Summary = { count: 0, polygons: 0, polylines: 0, rects: 0, fill_area: 0, stroke_length: 0, widths: null, bbox: null, vertices: 0 };
  const extend = (p: Point) => {
    if (s.bbox === null) s.bbox = [p[0], p[1], p[0], p[1]];
    else s.bbox = [Math.min(s.bbox[0], p[0]), Math.min(s.bbox[1], p[1]), Math.max(s.bbox[2], p[0]), Math.max(s.bbox[3], p[1])];
  };
  for (const g of geoms) {
    s.count++;
    if (g.type === "polygon") {
      s.polygons++;
      s.fill_area += fillArea(g.rings, g.even_odd);
      for (const r of g.rings) {
        for (const p of r) {
          s.vertices++;
          extend(p);
        }
      }
    } else if (g.type === "polyline") {
      s.polylines++;
      s.stroke_length += polylineLength(g.points, g.closed);
      s.widths = s.widths === null ? [g.width, g.width] : [Math.min(s.widths[0], g.width), Math.max(s.widths[1], g.width)];
      for (const p of g.points) {
        s.vertices++;
        extend(p);
      }
    } else {
      s.rects++;
      extend([g.x, g.y]);
      extend([g.x + g.w, g.y + g.h]);
    }
  }
  return s;
}
