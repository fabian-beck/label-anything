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
import { type Spacing, candLeadersConflict, leaderHitsLabel } from "../leaders.js";
import { maxf, minf } from "../math.js";
import type { Shape } from "../geom/shape.js";
import { AvoidKind, type Dynamic, type Obstacles } from "../obstacles.js";
import { DynIndex, IdList, StaticIndex } from "../spatial.js";

/**
 * Whether a leader of `c` hits the label box `r`: passes through its interior, or, for a
 * stub, comes closer than `gap` (spec §6.9).
 */
export function leadersHitLabel(c: Cand, r: Rect, gap: number): boolean {
  for (const l of c.leaders) if (leaderHitsLabel(l, r, gap)) return true;
  return false;
}


/**
 * The marks a label may cover when they belong to less important items
 * (`avoid.label.lower_items` given and not hard, spec §4.4): such a label conflicts with
 * every label of the item whose mark it covers.
 */
export class LowerMarks {
  readonly index: StaticIndex;

  /** `groupOf`: the group representative of every item (a group's label may cover its members). */
  constructor(
    readonly marks: readonly Shape[],
    readonly groupOf: readonly (number | null)[],
    extent: Rect,
    cell: number,
  ) {
    this.index = new StaticIndex(
      marks.map((m) => m.bbox()),
      extent,
      cell,
    );
  }
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
  /**
   * Label boxes placed (`pendAdd` 1) or removed (0) since {@link occ} was last brought up
   * to date: only candidate generation reads the grid, so local search, exact search and
   * repair, which place and remove labels all the time, never pay for marking it. A box
   * placed and removed again before that cancels out (`pendAt`: the pending placement of
   * each item, -1 for none). The grid counts boxes per cell, so applying the remaining
   * changes later (in order) gives the same grid.
   */
  private pend: (Rect | null)[] = [];
  private pendAdd: number[] = [];
  private pendItem: number[] = [];
  private pendAt: Int32Array;
  /** Priority key level per item, and the number of placed labels per key level. */
  private keys: readonly number[];
  private keyCount: Uint32Array;
  /** Largest key level among placed labels (-1: nothing placed). */
  private maxKey = -1;
  /**
   * Leader spacing rules: clearance and font size per item, the cosine of
   * `leaders.min_angle_between`, and how far they reach beyond a candidate's box.
   */
  private clr: readonly number[];
  private em: readonly number[];
  /**
   * The space each item's label keeps from other labels and stubs (its spacing, at least its
   * margin, spec §4.4) and the largest.
   */
  private margin: readonly number[];
  private marginMaxV: number;
  /** How far stubs reach beyond a label's box (the largest such space with stubs, else 0). */
  private stubGap = 0;
  private cosMin: number;
  private reach: number;
  /** Placed items already tested by a conflict query. */
  private seen: number[] = [];
  /** Marks of less important items that labels may cover (see {@link LowerMarks}). */
  private lower: LowerMarks | null;
  private lbuf = new IdList();

  /**
   * `keys`: the priority key level of every item (smaller = more important); `clr` and
   * `em`: the leader clearance and font size of every item; `margin`: the space the label of
   * every item keeps from other labels; `cosMin`: the cosine of `leaders.min_angle_between`.
   */
  constructor(
    nItems: number,
    extent: Rect,
    cell: number,
    keys: readonly number[],
    clr: readonly number[],
    em: readonly number[],
    margin: readonly number[],
    cosMin: number,
    lower: LowerMarks | null = null,
  ) {
    let nKeys = 0;
    for (const k of keys) if (k + 1 > nKeys) nKeys = k + 1;
    let reach = 0;
    for (const v of clr) reach = maxf(reach, v);
    if (cosMin < 1) for (const v of em) reach = maxf(reach, v);
    let marginMax = 0;
    for (const v of margin) marginMax = maxf(marginMax, v);
    this.margin = margin;
    this.marginMaxV = marginMax;
    this.clr = clr;
    this.em = em;
    this.cosMin = cosMin;
    this.reach = reach;
    this.placed = new Int32Array(nItems).fill(-1);
    this.relaxed = new Uint8Array(nItems);
    this.labelIx = new DynIndex(extent, cell);
    this.segIx = new DynIndex(extent, cell);
    this.itemSegs = [];
    for (let i = 0; i < nItems; i++) this.itemSegs.push([]);
    this.occ = new Occupancy(extent);
    this.pendAt = new Int32Array(nItems).fill(-1);
    this.keys = keys;
    this.keyCount = new Uint32Array(nKeys);
    this.lower = lower;
  }

  /**
   * Conflicts of `c` by the `lower_items` rule (in this order): placed items of lower key
   * whose mark the label of `c` covers, then placed items of higher key whose label covers
   * the mark of `c`'s item; only items with key at most `keyLimit`, other than `skip` and
   * `other`. With `first`, stops at the first one.
   */
  private lowerConflicts(c: Cand, cands: readonly Cand[], skip: number, keyLimit: number, first: boolean, out: number[], other = -1): void {
    const lw = this.lower;
    if (lw === null) return;
    const i = c.item;
    const keys = this.keys;
    const buf = this.lbuf;
    lw.index.query(c.rect, buf);
    for (let q = 0; q < buf.len; q++) {
      const j = buf.get(q);
      if (j === i || j === skip || j === other || this.placed[j]! < 0 || keys[j]! <= keys[i]! || (lw.groupOf[j] ?? null) === i || !(keys[j]! <= keyLimit)) continue;
      if (c.labelOverlapsShape(lw.marks[j]!)) {
        out.push(j);
        if (first) return;
      }
    }
    const mark = lw.marks[i]!;
    this.labelIx.query(mark.bbox(), buf);
    for (let q = 0; q < buf.len; q++) {
      const j = buf.get(q);
      if (j === i || j === skip || j === other || keys[j]! >= keys[i]! || (lw.groupOf[i] ?? null) === j || !(keys[j]! <= keyLimit)) continue;
      const pid = this.placed[j]!;
      if (pid < 0) continue;
      if (cands[pid]!.labelOverlapsShape(mark)) {
        out.push(j);
        if (first) return;
      }
    }
  }

  /** The less important items whose marks the label of `c` covers (see {@link LowerMarks}), in index-query order. */
  lowerCovered(c: Cand, out: number[]): void {
    out.length = 0;
    const lw = this.lower;
    if (lw === null) return;
    const i = c.item;
    const keys = this.keys;
    const buf = this.lbuf;
    lw.index.query(c.rect, buf);
    for (let q = 0; q < buf.len; q++) {
      const j = buf.get(q);
      if (j !== i && keys[j]! > keys[i]! && (lw.groupOf[j] ?? null) !== i && c.labelOverlapsShape(lw.marks[j]!)) out.push(j);
    }
  }

  /** The bounding box of item `i`'s mark (when labels may cover less important marks), else null. */
  markBBox(i: number): Rect | null {
    return this.lower === null ? null : this.lower.marks[i]!.bbox();
  }

  /** Whether labels may cover the marks of less important items (see {@link LowerMarks}). */
  hasLower(): boolean {
    return this.lower !== null;
  }

  /**
   * Whether the labels of `a` and `b` (different items) exclude each other by the
   * `lower_items` rule: one covers the mark of the other's, less important, item.
   */
  pairLower(a: Cand, b: Cand): boolean {
    const lw = this.lower;
    if (lw === null) return false;
    const i = a.item;
    const j = b.item;
    const keys = this.keys;
    return (
      (keys[j]! > keys[i]! && (lw.groupOf[j] ?? null) !== i && a.labelOverlapsShape(lw.marks[j]!)) ||
      (keys[i]! > keys[j]! && (lw.groupOf[i] ?? null) !== j && b.labelOverlapsShape(lw.marks[i]!))
    );
  }

  /** The largest label margin: how far label-label conflicts reach beyond a box. */
  /**
   * With stubs (spec §6.9), which keep the margin from other labels, conflict queries reach
   * that far for them.
   */
  withStubs(stubs: boolean): State {
    if (stubs) this.stubGap = this.marginMaxV;
    return this;
  }

  marginMax(): number {
    return this.marginMaxV;
  }

  /**
   * How far leader conflicts reach beyond a candidate's bounding box when leaders may not
   * come close (`avoid.leader.leaders` hard): the largest clearance, and the largest font
   * size with the angle rule.
   */
  leaderReach(obs: Obstacles): number {
    return obs.dynamic.leaderLeaders.kind === AvoidKind.Hard ? this.reach : 0;
  }

  /** Spacing rules between the leaders of items `i` and `j`. */
  spacing(i: number, j: number): Spacing {
    return {
      clr: maxf(this.clr[i]!, this.clr[j]!),
      near: maxf(this.em[i]!, this.em[j]!),
      cosMin: this.cosMin,
      gap: maxf(this.margin[i]!, this.margin[j]!),
    };
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
    return this.nPlaced > 0 && this.occupancy().blocked(r);
  }

  /** The placed-label occupancy grid (its windows serve grids with the same cells). */
  occupancy(): Occupancy {
    const pend = this.pend;
    if (pend.length > 0) {
      for (let k = 0; k < pend.length; k++) {
        const r = pend[k]!;
        if (r !== null) this.occ.mark(r, this.pendAdd[k] === 1);
      }
      const items = this.pendItem;
      for (let k = 0; k < items.length; k++) if (items[k]! < this.pendAt.length) this.pendAt[items[k]!] = -1;
      pend.length = 0;
      this.pendAdd.length = 0;
      items.length = 0;
    }
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
    if (c.lshape === null) {
      if (item < this.pendAt.length) this.pendAt[item] = this.pend.length;
      this.pend.push(c.rect);
      this.pendAdd.push(1);
      this.pendItem.push(item);
      if (this.pend.length > 4 * this.pendAt.length + 1024) this.occupancy();
    }
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
    if (c.lshape === null) {
      const at = item < this.pendAt.length ? this.pendAt[item]! : -1;
      if (at >= 0 && this.pend[at] === c.rect) {
        // placed since the last update: nothing to undo in the grid
        this.pend[at] = null;
        this.pendAt[item] = -1;
        // (searches undo in LIFO order: drop cancelled entries at the end)
        while (this.pend.length > 0 && this.pend[this.pend.length - 1] === null) {
          this.pend.pop();
          this.pendAdd.pop();
          this.pendItem.pop();
        }
      } else {
        this.pend.push(c.rect);
        this.pendAdd.push(0);
        this.pendItem.push(item);
        // bounded log: bring the grid up to date now and then
        if (this.pend.length > 4 * this.pendAt.length + 1024) this.occupancy();
      }
    }
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
    const bb = c.bbox();
    const buf = this.buf;
    // labels near the candidate (label-label, candidate leaders through placed labels)
    this.labelIx.query(bb.inflate(this.marginMaxV), buf);
    for (let q = 0; q < buf.len; q++) {
      const j = buf.get(q);
      if (j === skip) continue;
      const pid = this.placed[j]!;
      if (pid < 0) continue;
      const p = cands[pid]!;
      const gap = maxf(this.margin[c.item]!, this.margin[j]!);
      if (llHard && c.labelOverlapsGap(p, gap)) {
        out.push(j);
        continue;
      }
      if (lbHard && leadersHitLabel(c, p.rect, gap)) out.push(j);
    }
    // leaders near the candidate (placed leaders through the candidate label or stubs
    // closer than the margin, leaders crossing or coming closer than the clearance)
    const reach = c.leaders.length === 0 ? this.stubGap : maxf(this.leaderReach(obs), this.stubGap);
    this.segIx.query(bb.inflate(EPS * 2 + reach), buf);
    const seen = this.seen;
    seen.length = 0;
    for (let q = 0; q < buf.len; q++) {
      const j = this.segItem[buf.get(q)]!;
      if (j === skip || out.includes(j) || seen.includes(j)) continue;
      seen.push(j);
      if (this.leadersHit(c, cands[this.placed[j]!]!, dy, j)) out.push(j);
    }
    this.lowerConflicts(c, cands, skip, Infinity, false, out);
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
   * The first placed item (in index-query order) other than `skip` and `other` that
   * conflicts with `c` and whose key is at most `keyLimit` (`Infinity`: any), or -1.
   */
  firstConflict(c: Cand, cands: readonly Cand[], obs: Obstacles, skip: number, keyLimit: number, other = -1): number {
    const dy = obs.dynamic;
    const llHard = dy.labelLabels.kind === AvoidKind.Hard;
    const lbHard = dy.leaderLabels.kind === AvoidKind.Hard;
    const keys = this.keys;
    const bb = c.bbox();
    // scans in query order that stop at the first conflict
    const lix = this.labelIx;
    lix.scanStart(bb, this.marginMaxV);
    for (let j = lix.scanNext(); j >= 0; j = lix.scanNext()) {
      if (j === skip || j === other || !(keys[j]! <= keyLimit)) continue;
      const pid = this.placed[j]!;
      if (pid < 0) continue;
      const p = cands[pid]!;
      const gap = maxf(this.margin[c.item]!, this.margin[j]!);
      if (llHard && c.labelOverlapsGap(p, gap)) return j;
      if (lbHard && leadersHitLabel(c, p.rect, gap)) return j;
    }
    if (this.hasSegs()) {
      // segments near bb grown by 2 EPS and the leader reach (and the stubs' margin)
      const reach = c.leaders.length === 0 ? this.stubGap : maxf(this.leaderReach(obs), this.stubGap);
      const six = this.segIx;
      six.scanStart(bb, EPS * 2 + reach);
      const seen = this.seen;
      seen.length = 0;
      for (let s = six.scanNext(); s >= 0; s = six.scanNext()) {
        const j = this.segItem[s]!;
        if (j === skip || j === other || !(keys[j]! <= keyLimit) || seen.includes(j)) continue;
        seen.push(j);
        if (this.leadersHit(c, cands[this.placed[j]!]!, dy, j)) return j;
      }
    }
    if (this.lower !== null) {
      const hit: number[] = [];
      this.lowerConflicts(c, cands, skip, keyLimit, true, hit, other);
      if (hit.length > 0) return hit[0]!;
    }
    return -1;
  }

  /**
   * Whether the placed candidate `p` of item `j` has a leader through the label of `c` (or a
   * stub closer than the margin), or a leader that conflicts with a leader of `c`.
   */
  private leadersHit(c: Cand, p: Cand, dy: Dynamic, j: number): boolean {
    const gap = maxf(this.margin[c.item]!, this.margin[j]!);
    if (dy.leaderLabels.kind === AvoidKind.Hard && leadersHitLabel(p, c.rect, gap)) return true;
    return (
      dy.leaderLeaders.kind === AvoidKind.Hard &&
      c.leaders.length > 0 &&
      candLeadersConflict(c, p, this.spacing(c.item, j))
    );
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
    // covered em² and em, as the static terms (spec §8)
    const em = this.em[c.item]!;
    const em2 = em * em;
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
        if (llSoft) cost += (dy.labelLabels.w * r.overlapArea(p.rect)) / em2;
        if (dy.bufferLabels > 0) {
          cost += (dy.bufferLabels * maxf(ring.overlapArea(p.rect) - r.overlapArea(p.rect), 0)) / ringArea;
        }
        if (lbSoft) {
          const w = dy.leaderLabels.w;
          for (const l of c.leaders) {
            const n = l.segCount();
            for (let k = 0; k < n; k++) cost += (w * segLenInRect(l.segA(k), l.segB(k), p.rect)) / em;
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
          if (lbSoft) cost += (dy.leaderLabels.w * segLenInRect(a, b, r) * llw) / em2;
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

