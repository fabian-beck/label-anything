/**
 * Placement state: placed candidates, dynamic indexes, exact conflicts and dynamic costs;
 * port of `rust/crates/la-core/src/solver/state.rs`.
 *
 * `placed[i]` is the placed candidate id of item `i`, or -1 (Rust `None`).
 *
 * @module
 */

import type { Cand } from "../candidates.js";
import { EPS, P, Rect, segLenInRect, segOverlapsRectXY, segSegDistXY } from "../geom/index.js";
import { Occupancy } from "../grid/occupancy.js";
import { maxf, minf } from "../math.js";
import { AvoidKind, type Obstacles } from "../obstacles.js";
import { DynIndex, IdList } from "../spatial.js";

/** Whether any segment of `c`'s leaders passes through the interior of `r`. */
export function leadersOverlapRect(c: Cand, r: Rect): boolean {
  for (const l of c.leaders) {
    const n = l.segCount();
    for (let k = 0; k < n; k++) {
      const a = l.segA(k);
      const b = l.segB(k);
      if (segOverlapsRectXY(a.x, a.y, b.x, b.y, r.x0, r.y0, r.x1, r.y1)) return true;
    }
  }
  return false;
}

/** Whether segment `(ax, ay)–(bx, by)` intersects any segment of `c`'s leaders (`seg_intersects`). */
export function leadersCrossSeg(c: Cand, ax: number, ay: number, bx: number, by: number): boolean {
  for (const l of c.leaders) {
    const n = l.segCount();
    for (let k = 0; k < n; k++) {
      const p = l.segA(k);
      const q = l.segB(k);
      if (segSegDistXY(ax, ay, bx, by, p.x, p.y, q.x, q.y) <= EPS) return true;
    }
  }
  return false;
}

/** The set of placed labels with spatial indexes. */
export class State {
  /** Placed candidate per item (-1: none). */
  placed: Int32Array;
  /** Item placed with relaxed classes (soft_overlap step). */
  relaxed: Uint8Array;
  private labelIx: DynIndex;
  private segIx: DynIndex;
  /** Leader segments: item and end points. */
  private segItem: number[] = [];
  private segAx: number[] = [];
  private segAy: number[] = [];
  private segBx: number[] = [];
  private segBy: number[] = [];
  private freeSegs: number[] = [];
  private itemSegs: number[][];
  nPlaced = 0;
  labelAreaSum = 0;
  private buf = new IdList();
  private occ: Occupancy;
  /** Priority key level per item, and the number of placed labels per key level. */
  private keys: readonly number[];
  private keyCount: Uint32Array;
  /** Largest key level among placed labels (-1: nothing placed). */
  private maxKey = -1;

  /** `keys`: the priority key level of every item (smaller = more important). */
  constructor(nItems: number, extent: Rect, cell: number, keys: readonly number[]) {
    let nKeys = 0;
    for (const k of keys) if (k + 1 > nKeys) nKeys = k + 1;
    this.placed = new Int32Array(nItems).fill(-1);
    this.relaxed = new Uint8Array(nItems);
    this.labelIx = new DynIndex(extent, cell);
    this.segIx = new DynIndex(extent, cell);
    this.itemSegs = [];
    for (let i = 0; i < nItems; i++) this.itemSegs.push([]);
    this.occ = new Occupancy(extent);
    this.keys = keys;
    this.keyCount = new Uint32Array(nKeys);
  }

  /** The largest key level among placed labels (null when nothing is placed). */
  maxPlacedKey(): number | null {
    return this.maxKey < 0 ? null : this.maxKey;
  }

  /**
   * Quick, exact rejection: the box `r` of a rectangular label overlaps a placed
   * rectangular label (`false` means "unknown", not "free").
   */
  quickBlocked(r: Rect): boolean {
    return this.nPlaced > 0 && this.occ.blocked(r);
  }

  /** The placed-label occupancy grid (its windows serve grids with the same cells). */
  occupancy(): Occupancy {
    return this.occ;
  }

  /** Whether any leader segment is placed. */
  hasSegs(): boolean {
    return this.segItem.length > this.freeSegs.length;
  }

  place(item: number, cid: number, cands: readonly Cand[], relaxed: boolean): void {
    const c = cands[cid]!;
    this.placed[item] = cid;
    this.relaxed[item] = relaxed ? 1 : 0;
    this.labelIx.insert(item, c.rect);
    if (c.lshape === null) this.occ.mark(c.rect, true);
    if (item < this.keys.length) {
      const k = this.keys[item]!;
      this.keyCount[k] += 1;
      if (k > this.maxKey) this.maxKey = k;
    }
    for (const l of c.leaders) {
      const n = l.segCount();
      for (let s = 0; s < n; s++) {
        const a = l.segA(s);
        const b = l.segB(s);
        let id: number;
        if (this.freeSegs.length > 0) id = this.freeSegs.pop()!;
        else {
          id = this.segItem.length;
          this.segItem.push(0);
          this.segAx.push(0);
          this.segAy.push(0);
          this.segBx.push(0);
          this.segBy.push(0);
        }
        this.segItem[id] = item;
        this.segAx[id] = a.x;
        this.segAy[id] = a.y;
        this.segBx[id] = b.x;
        this.segBy[id] = b.y;
        this.segIx.insert(id, new Rect(minf(a.x, b.x), minf(a.y, b.y), maxf(a.x, b.x), maxf(a.y, b.y)));
        this.itemSegs[item]!.push(id);
      }
    }
    this.nPlaced += 1;
    this.labelAreaSum += c.rect.area();
  }

  unplace(item: number, cands: readonly Cand[]): void {
    const cid = this.placed[item]!;
    if (cid < 0) return;
    const c = cands[cid]!;
    if (c.lshape === null) this.occ.mark(c.rect, false);
    if (item < this.keys.length) {
      const k = this.keys[item]!;
      this.keyCount[k] -= 1;
      if (this.maxKey === k && this.keyCount[k] === 0) {
        let m = -1;
        for (let j = k - 1; j >= 0; j--) {
          if (this.keyCount[j]! > 0) {
            m = j;
            break;
          }
        }
        this.maxKey = m;
      }
    }
    this.labelAreaSum -= c.rect.area();
    this.placed[item] = -1;
    this.relaxed[item] = 0;
    this.labelIx.remove(item);
    const segs = this.itemSegs[item]!;
    this.itemSegs[item] = [];
    for (const id of segs) {
      this.segIx.remove(id);
      this.freeSegs.push(id);
    }
    this.nPlaced -= 1;
  }

  /**
   * Placed items whose label or leaders conflict (hard) with candidate `c`, ascending,
   * into `out`. `skip` is ignored (the candidate's own item, or a group).
   */
  conflicts(c: Cand, cands: readonly Cand[], obs: Obstacles, skip: number, out: number[]): void {
    out.length = 0;
    const dy = obs.dynamic;
    const llHard = dy.labelLabels.kind === AvoidKind.Hard;
    const lbHard = dy.leaderLabels.kind === AvoidKind.Hard;
    const leHard = dy.leaderLeaders.kind === AvoidKind.Hard;
    const bb = c.bbox();
    const buf = this.buf;
    // labels near the candidate (label-label, candidate leaders through placed labels)
    this.labelIx.query(bb, buf);
    for (let q = 0; q < buf.len; q++) {
      const j = buf.get(q);
      if (j === skip) continue;
      const pid = this.placed[j]!;
      if (pid < 0) continue;
      const p = cands[pid]!;
      if (llHard && c.labelOverlaps(p)) {
        out.push(j);
        continue;
      }
      if (lbHard && leadersOverlapRect(c, p.rect)) out.push(j);
    }
    // leader segments near the candidate (placed leaders through the candidate label,
    // leader crossings)
    this.segIx.query(bb.inflate(EPS * 2), buf);
    const r = c.rect;
    for (let q = 0; q < buf.len; q++) {
      const s = buf.get(q);
      const j = this.segItem[s]!;
      if (j === skip || out.includes(j)) continue;
      const ax = this.segAx[s]!;
      const ay = this.segAy[s]!;
      const bx = this.segBx[s]!;
      const by = this.segBy[s]!;
      const hitLabel = lbHard && segOverlapsRectXY(ax, ay, bx, by, r.x0, r.y0, r.x1, r.y1);
      const hitCross = leHard && leadersCrossSeg(c, ax, ay, bx, by);
      if (hitLabel || hitCross) out.push(j);
    }
    if (out.length > 1) {
      out.sort((a, b) => a - b);
      let w = 1;
      for (let k = 1; k < out.length; k++) if (out[k] !== out[w - 1]) out[w++] = out[k]!;
      out.length = w;
    }
  }

  /** Whether candidate `c` conflicts with nothing placed (except `skip`). */
  isFree(c: Cand, cands: readonly Cand[], obs: Obstacles, skip: number): boolean {
    return this.firstConflict(c, cands, obs, skip, Infinity) < 0;
  }

  /**
   * The first placed item (in index-query order) that conflicts with `c` and whose key is
   * at most `keyLimit` (`Infinity`: any), or -1.
   */
  firstConflict(c: Cand, cands: readonly Cand[], obs: Obstacles, skip: number, keyLimit: number): number {
    const dy = obs.dynamic;
    const llHard = dy.labelLabels.kind === AvoidKind.Hard;
    const lbHard = dy.leaderLabels.kind === AvoidKind.Hard;
    const leHard = dy.leaderLeaders.kind === AvoidKind.Hard;
    const keys = this.keys;
    const bb = c.bbox();
    const buf = this.buf;
    this.labelIx.query(bb, buf);
    for (let q = 0; q < buf.len; q++) {
      const j = buf.get(q);
      if (j === skip || !(keys[j]! <= keyLimit)) continue;
      const pid = this.placed[j]!;
      if (pid < 0) continue;
      const p = cands[pid]!;
      if (llHard && c.labelOverlaps(p)) return j;
      if (lbHard && leadersOverlapRect(c, p.rect)) return j;
    }
    if (this.hasSegs()) {
      this.segIx.query(bb.inflate(EPS * 2), buf);
      const r = c.rect;
      for (let q = 0; q < buf.len; q++) {
        const s = buf.get(q);
        const j = this.segItem[s]!;
        if (j === skip || !(keys[j]! <= keyLimit)) continue;
        const ax = this.segAx[s]!;
        const ay = this.segAy[s]!;
        const bx = this.segBx[s]!;
        const by = this.segBy[s]!;
        const hitLabel = lbHard && segOverlapsRectXY(ax, ay, bx, by, r.x0, r.y0, r.x1, r.y1);
        const hitCross = leHard && leadersCrossSeg(c, ax, ay, bx, by);
        if (hitLabel || hitCross) return j;
      }
    }
    return -1;
  }

  /** Soft costs of `c` against placed labels and leaders. */
  dynamicCost(
    c: Cand,
    cands: readonly Cand[],
    obs: Obstacles,
    buffer: number,
    clearance: number,
    leaderW: number,
    skip: number,
  ): number {
    const dy = obs.dynamic;
    const llSoft = dy.labelLabels.kind === AvoidKind.Soft;
    const lbSoft = dy.leaderLabels.kind === AvoidKind.Soft;
    const needLabels = llSoft || dy.bufferLabels > 0 || lbSoft;
    const needLeaders = this.hasSegs() && (dy.bufferLeaders > 0 || lbSoft || c.leaders.length > 0);
    if (!needLabels && !needLeaders) return 0;
    let cost = 0;
    const r = c.rect;
    const area = maxf(r.area(), 1e-9);
    const ring = r.inflate(buffer);
    const ringArea = maxf(ring.area() - area, 1e-9);
    const buf = this.buf;
    if (needLabels) {
      this.labelIx.query(ring.union(c.bbox()), buf);
      for (let q = 0; q < buf.len; q++) {
        const j = buf.get(q);
        if (j === skip) continue;
        const pid = this.placed[j]!;
        if (pid < 0) continue;
        const p = cands[pid]!;
        if (llSoft) cost += (dy.labelLabels.w * r.overlapArea(p.rect)) / area;
        if (dy.bufferLabels > 0) {
          cost += (dy.bufferLabels * maxf(ring.overlapArea(p.rect) - r.overlapArea(p.rect), 0)) / ringArea;
        }
        if (lbSoft) {
          const w = dy.leaderLabels.w;
          for (const l of c.leaders) {
            const n = l.segCount();
            for (let k = 0; k < n; k++) cost += (w * segLenInRect(l.segA(k), l.segB(k), p.rect)) / maxf(l.len, 1e-9);
          }
        }
      }
    }
    if (needLeaders) {
      const reach = maxf(buffer, clearance);
      this.segIx.query(c.bbox().inflate(reach), buf);
      const llw = maxf(leaderW, 1);
      const leSoft = dy.leaderLeaders.kind === AvoidKind.Soft;
      for (let q = 0; q < buf.len; q++) {
        const s = buf.get(q);
        const j = this.segItem[s]!;
        if (j === skip) continue;
        const ax = this.segAx[s]!;
        const ay = this.segAy[s]!;
        const bx = this.segBx[s]!;
        const by = this.segBy[s]!;
        if (dy.bufferLeaders > 0 || lbSoft) {
          const a = new P(ax, ay);
          const b = new P(bx, by);
          if (dy.bufferLeaders > 0) {
            const inRing = maxf(segLenInRect(a, b, ring) - segLenInRect(a, b, r), 0);
            cost += (dy.bufferLeaders * inRing * llw) / ringArea;
          }
          if (lbSoft) cost += (dy.leaderLabels.w * segLenInRect(a, b, r) * llw) / area;
        }
        for (const l of c.leaders) {
          const n = l.segCount();
          for (let k = 0; k < n; k++) {
            const p = l.segA(k);
            const pq = l.segB(k);
            const d = segSegDistXY(ax, ay, bx, by, p.x, p.y, pq.x, pq.y);
            if (d <= EPS) {
              if (leSoft) cost += dy.leaderLeaders.w;
            } else if (d < clearance && dy.bufferLeaders > 0) {
              cost += dy.bufferLeaders * (1 - d / clearance);
            }
          }
        }
      }
    }
    return cost;
  }

  /** Ids of placed items whose labels overlap `r` (no conflict semantics). */
  labelsNear(r: Rect, out: IdList): void {
    this.labelIx.query(r, out);
  }
}

