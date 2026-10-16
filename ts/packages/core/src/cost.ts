/**
 * Static candidate cost and hard feasibility (spec §8, §6.7); port of
 * `rust/crates/la-core/src/cost.rs`.
 *
 * @module
 */

import { BLOCK_EDGE, BLOCK_ITEMS, BLOCK_LABELS, type Block, type Cand, Kind, type Leader } from "./candidates.js";
import type { Env } from "./env.js";
import { EPS, P, Rect, segOverlapsRectXY } from "./geom/index.js";
import type { Variant } from "./labels.js";
import { clampf, maxf, minf } from "./math.js";
import type { Model } from "./model/index.js";
import { AvoidKind, type Obstacles, primDistSegment, primOverlapsRect } from "./obstacles.js";
import { IdList } from "./spatial.js";

/** Named cost terms (for `cost_breakdown`), in insertion order. */
export type Breakdown = [string, number][];

class Acc {
  cost = 0;
  feasible = true;
  relaxed = true;
  relaxCost = 0;
  blocked: Block | null = null;
  breakdown: Breakdown | null = null;

  add(name: string, v: number): void {
    if (v === 0) return;
    this.cost += v;
    const b = this.breakdown;
    if (b !== null) {
      const e = b.find((x) => x[0] === name);
      if (e !== undefined) e[1] += v;
      else b.push([name, v]);
    }
  }

  violate(why: Block, relaxable: boolean, extra: number): void {
    if (this.feasible) {
      this.feasible = false;
      this.blocked = why;
    }
    if (relaxable) this.relaxCost += extra;
    else this.relaxed = false;
  }
}

function finish(c: Cand, acc: Acc): void {
  c.evaluated = true;
  c.cost = acc.cost;
  c.feasible = acc.feasible;
  c.relaxed = acc.relaxed;
  c.relaxCost = acc.relaxCost;
  c.blocked = acc.blocked;
}

/** Evaluates static costs. Holds scratch buffers. */
export class Evaluator {
  private readonly buf = new IdList();
  private readonly buf2 = new IdList();

  constructor(
    readonly model: Model,
    readonly obs: Obstacles,
    readonly env: Env,
  ) {}

  /** Fill `c.cost`, `c.feasible`, `c.relaxed`, `c.relaxCost`, `c.blocked`. */
  eval(c: Cand, v: Variant, breakdown: Breakdown | null = null): void {
    const model = this.model;
    const obs = this.obs;
    const i = c.item;
    const item = model.items[i]!;
    const em = item.em();
    const r = c.rect;
    const area = maxf(r.area(), 1e-9);
    const w = model.weights;
    const dy = obs.dynamic;
    const softW = model.degrade.softOverlapWeight;
    const acc = new Acc();
    acc.breakdown = breakdown;

    // 1. label area (canvas_edge)
    const la = obs.labelArea;
    if (la !== null && !la.containsRect(r)) {
      const e = dy.labelEdge;
      if (e.kind === AvoidKind.Hard) acc.violate(BLOCK_EDGE, false, 0);
      else if (e.kind === AvoidKind.Soft) acc.add("canvas_edge", (e.w * (area - la.overlapArea(r))) / area);
    }
    if (!acc.relaxed) return finish(c, acc);
    // 2. items (exact); one query serves the buffer ring and the ambiguity term
    const ring = r.inflate(item.len.buffer);
    const gapGuess = item.len.offset + 0.5 * em;
    const reach = item.len.buffer > gapGuess ? item.len.buffer : gapGuess;
    const buf = this.buf;
    obs.itemIndex.query(r.inflate(reach), buf);
    const labelItemsHard = dy.labelItems.kind === AvoidKind.Hard;
    let otherFound = false;
    for (let q = 0; q < buf.len; q++) {
      const j = buf.get(q);
      const sj = model.items[j]!.shape;
      if (j === i) {
        if (c.kind === Kind.Internal) continue;
        const om = dy.ownMark;
        if (om.kind === "hard") {
          if (c.labelOverlapsShape(sj)) acc.violate(BLOCK_ITEMS, false, 0);
        } else if (om.kind === "partial") {
          if (c.labelOverlapsShape(sj)) {
            const own = obs.own(i);
            const frac = own[1].coveredArea(own[0], r) / maxf(sj.area(), 1e-9);
            if (frac > om.f) acc.violate(BLOCK_ITEMS, false, 0);
          }
        }
        continue;
      }
      otherFound = true;
      if (labelItemsHard && c.labelOverlapsShape(sj)) acc.violate(BLOCK_ITEMS, false, 0);
    }
    if (dy.labelItems.kind === AvoidKind.Soft) acc.add("items", (dy.labelItems.w * obs.otherItemsCovered(i, r)) / area);
    // the ring only sees other items when the item query found any besides the own
    if (dy.bufferItems > 0 && otherFound) {
      const ringArea = maxf(ring.area() - area, 1e-9);
      const cov = maxf(obs.otherItemsCovered(i, ring) - obs.otherItemsCovered(i, r), 0);
      acc.add("buffer:items", (dy.bufferItems * cov) / ringArea);
    }
    if (!acc.relaxed) return finish(c, acc);
    // 3. static classes
    let hardPrimsChecked = false;
    const classes = obs.classes;
    const grid = obs.grid;
    for (let ci = 0; ci < classes.length; ci++) {
      const cl = classes[ci]!;
      const sat = cl.sat;
      if (sat === null) continue;
      const lk = cl.label.kind;
      if (lk === AvoidKind.Hard) {
        let hit = false;
        if (cl.hasRaster) hit = sat.any(grid, r);
        else if (cl.hasPrims) {
          const buf2 = this.buf2;
          if (!hardPrimsChecked) {
            obs.primIndex().query(r, buf2);
            hardPrimsChecked = true;
          }
          const prims = obs.prims();
          for (let q = 0; q < buf2.len; q++) {
            const pr = prims[buf2.get(q)]!;
            if (pr[0] === ci && primOverlapsRect(pr[1], r)) {
              hit = true;
              break;
            }
          }
        }
        if (hit) {
          const extra = (softW * sat.coveredArea(grid, r)) / area;
          acc.violate(ci, cl.relaxable, extra);
        }
      } else if (lk === AvoidKind.Soft) {
        if (sat.any(grid, r)) acc.add(cl.name, (cl.label.w * sat.coveredArea(grid, r)) / area);
      }
      if (cl.buffer > 0 && sat.any(grid, ring)) {
        const ringArea = maxf(ring.area() - area, 1e-9);
        const cov = maxf(sat.coveredArea(grid, ring) - sat.coveredArea(grid, r), 0);
        acc.add(`buffer:${cl.name}`, (cl.buffer * cov) / ringArea);
      }
    }
    if (!acc.relaxed) return finish(c, acc);
    // 4. leaders
    for (const l of c.leaders) this.leaderTerms(i, l, r, acc);
    if (!acc.relaxed) return finish(c, acc);
    // 5. position
    acc.add("position", (w.position * c.rank) / 8);
    // 6. distance from own shape
    const gap = c.kind === Kind.Internal ? 0 : item.shape.distRect(r);
    if (c.leaders.length === 0) acc.add("distance", (w.distance * gap) / em);
    // 7. shape penalty
    acc.add("shape", w.shape * v.penalty);
    // 8. edge proximity
    if (la !== null) {
      const d = minf(minf(r.x0 - la.x0, la.x1 - r.x1), minf(r.y0 - la.y0, la.y1 - r.y1));
      acc.add("edge", w.edge * maxf(0, 1 - maxf(d, 0) / em));
    }
    // 9. ambiguity (the item query above covers the reach of adjacent labels)
    if (w.ambiguity > 0 && c.kind !== Kind.Internal) {
      let amb: number;
      if (c.leaders.length > 0) amb = 0.5 * this.ambiguityPoint(i, c.leaders[0]!.port, em);
      else if (gap <= gapGuess) amb = this.ambiguityRectCached(i, r, gap, em);
      else amb = this.ambiguityRect(i, r, gap, em);
      acc.add("ambiguity", w.ambiguity * amb);
    }
    // 10. stability
    if (w.stability > 0) {
      const b = model.warm.get(item.id);
      if (b !== undefined && b !== null) {
        const d = b.center().dist(r.center());
        acc.add("stability", w.stability * minf(1, d / em));
      }
    }
    // 11. host cost
    if (this.env.hasCostCallback && this.env.hasCostCallback()) {
      acc.add("user", this.env.extraCost ? this.env.extraCost(item.id, r, c.leaders.length > 0) : 0);
    }
    finish(c, acc);
  }

  /** Ambiguity using the items already queried into `buf`. */
  private ambiguityRectCached(i: number, r: Rect, dOwn: number, em: number): number {
    const reach = dOwn + 0.5 * em;
    let dOther = Infinity;
    const buf = this.buf;
    for (let q = 0; q < buf.len; q++) {
      const j = buf.get(q);
      if (j !== i) dOther = minf(dOther, this.model.items[j]!.shape.distRect(r));
    }
    return dOther < reach ? clampf((dOwn - dOther) / em + 0.5, 0, 1) : 0;
  }

  private ambiguityRect(i: number, r: Rect, dOwn: number, em: number): number {
    const reach = dOwn + 0.5 * em;
    const buf = this.buf;
    this.obs.itemIndex.query(r.inflate(reach), buf);
    let dOther = Infinity;
    for (let q = 0; q < buf.len; q++) {
      const j = buf.get(q);
      if (j !== i) dOther = minf(dOther, this.model.items[j]!.shape.distRect(r));
    }
    return dOther < reach ? clampf((dOwn - dOther) / em + 0.5, 0, 1) : 0;
  }

  private ambiguityPoint(i: number, p: P, em: number): number {
    const own = maxf(this.model.items[i]!.shape.signedDistance(p), 0);
    const reach = 2 * em;
    const buf = this.buf;
    this.obs.itemIndex.query(Rect.fromCenter(p, reach, reach), buf);
    let dOther = Infinity;
    for (let q = 0; q < buf.len; q++) {
      const j = buf.get(q);
      if (j !== i) dOther = minf(dOther, maxf(this.model.items[j]!.shape.signedDistance(p), 0));
    }
    return dOther < reach && dOther < own ? clampf(1 - dOther / reach, 0, 1) : 0;
  }

  private leaderTerms(i: number, l: Leader, ownRect: Rect, acc: Acc): void {
    const model = this.model;
    const obs = this.obs;
    const item = model.items[i]!;
    const em = item.em();
    const w = model.weights;
    const dy = obs.dynamic;
    const hw = model.leaders.width * 0.5;
    acc.add("leader", w.leader + (w.leaderLength * l.len) / em + w.bends * l.bends);
    // leaders stay on the canvas
    const ca = obs.leaderArea;
    if (ca !== null && !l.pts.every((p) => ca.containsPoint(p))) acc.violate(BLOCK_EDGE, false, 0);
    const nseg = l.segCount();
    const nMain = l.pts.length > 0 ? l.pts.length - 1 : 0;
    // ownRect.inflate(-0.5)
    const ox0 = ownRect.x0 + 0.5;
    const oy0 = ownRect.y0 + 0.5;
    const ox1 = ownRect.x1 - 0.5;
    const oy1 = ownRect.y1 - 0.5;
    for (let k = 0; k < nseg; k++) {
      const a = l.segA(k);
      const b = l.segB(k);
      // not through the own shape (skip a tiny start piece for tips/boundary starts)
      const a2 = k === 0 ? a.lerp(b, minf(0.5 / maxf(a.dist(b), 1e-9), 0.5)) : a;
      if ((!item.tip || k > 0) && item.shape.distSegment(a2, b) <= EPS) acc.violate(BLOCK_ITEMS, false, 0);
      // not into the own label except at the port (underline is on the label edge)
      if (k < nMain && segOverlapsRectXY(a.x, a.y, b.x, b.y, ox0, oy0, ox1, oy1)) acc.violate(BLOCK_LABELS, false, 0);
    }
    // other items: clearance
    const clearance = item.len.clearance;
    const buf = this.buf;
    obs.itemIndex.query(l.bbox().inflate(clearance), buf);
    const li = dy.leaderItems;
    for (let q = 0; q < buf.len; q++) {
      const j = buf.get(q);
      if (j === i) continue;
      if (li.kind === AvoidKind.Ignore) continue;
      const sj = model.items[j]!.shape;
      let dmin = Infinity;
      for (let k = 0; k < nseg; k++) {
        const a = l.segA(k);
        const b = l.segB(k);
        dmin = minf(dmin, sj.distSegmentXY(a.x, a.y, b.x, b.y));
      }
      if (li.kind === AvoidKind.Hard) {
        if (dmin < clearance - EPS) acc.violate(BLOCK_ITEMS, false, 0);
      } else if (dmin < clearance) {
        const f = clearance > 0 ? 1 - dmin / clearance : 1;
        acc.add("leader:items", li.w * f);
      }
    }
    // static classes
    let primIdsLoaded = false;
    const classes = obs.classes;
    for (let ci = 0; ci < classes.length; ci++) {
      const cl = classes[ci]!;
      const sat = cl.sat;
      if (sat === null) continue;
      const lk = cl.leader.kind;
      if (lk === AvoidKind.Hard) {
        let hit = false;
        if (cl.hasRaster) {
          for (let k = 0; k < nseg && !hit; k++) hit = obs.coveredLen(sat, l.segA(k), l.segB(k)) > 0;
        } else if (cl.hasPrims) {
          const buf2 = this.buf2;
          if (!primIdsLoaded) {
            obs.primIndex().query(l.bbox().inflate(hw + 1), buf2);
            primIdsLoaded = true;
          }
          const prims = obs.prims();
          for (let q = 0; q < buf2.len && !hit; q++) {
            const pr = prims[buf2.get(q)]!;
            if (pr[0] !== ci) continue;
            for (let k = 0; k < nseg; k++) {
              const a = l.segA(k);
              const b = l.segB(k);
              if (primDistSegment(pr[1], a, b) < hw - EPS || (hw <= EPS && primDistSegment(pr[1], a, b) <= EPS)) {
                hit = true;
                break;
              }
            }
          }
        }
        if (hit) {
          let sum = -0;
          for (let k = 0; k < nseg; k++) sum += obs.coveredLen(sat, l.segA(k), l.segB(k));
          const extra = sum / maxf(l.len, 1e-9);
          acc.violate(ci, cl.relaxable, model.degrade.softOverlapWeight * extra);
        }
      } else if (lk === AvoidKind.Soft) {
        let cov = -0;
        for (let k = 0; k < nseg; k++) cov += obs.coveredLen(sat, l.segA(k), l.segB(k));
        acc.add(`leader:${cl.name}`, (cl.leader.w * cov) / maxf(l.len, 1e-9));
      }
    }
  }
}
