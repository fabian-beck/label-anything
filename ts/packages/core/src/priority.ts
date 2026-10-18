/**
 * The priority function (spec §9): tiers, scores, coverage, ties, bands and keys; port of
 * `rust/crates/la-core/src/priority.rs`.
 *
 * @module
 */

import type { Env } from "./env.js";
import { type Expr, type ExprContext, type Value, evalExpr, parseExpr, termNumber, truthy, valuesEqual } from "./expr/index.js";
import { P, bboxOf } from "./geom/index.js";
import { asArray, asF64, asI64, asStr, asU64, get, isObject, items as itemsOf } from "./json.js";
import { type Variant, labelSizeEm2 } from "./labels.js";
import { cmpF64, cmpStr, ln, ln1p, maxf, minf } from "./math.js";
import { type Item, type Model, labelText } from "./model/index.js";
import { Pcg32 } from "./pcg.js";

/** Resolved priority of one item. */
export interface Prio {
  required: boolean;
  tier: number;
  reserved: boolean;
  score: number;
  /** Per-term contributions (`weight × normalized value`). */
  terms: [string, number][];
  /** Position in the total order (0 = highest). */
  rank: number;
  /** Key level: equal-key items share a level; 0 = highest. */
  key: number;
  /** Weight for `weighted` omission. */
  weight: number;
  /** NDCG gain `1 / log2(rank + 2)`. */
  gain: number;
}

/** Priorities of all items, plus the total order (item indices, highest first). */
export interface Priorities {
  prio: Prio[];
  order: number[];
  nKeys: number;
}

function exprCtxValue(item: Item): Value {
  return item.attrs as Value;
}

function evalItem(expr: Expr, item: Item, attrs: Value): Value {
  const ctx: ExprContext = {
    attrs,
    id: item.id,
    index: item.index,
    text: labelText(item.label),
    priority: item.explicitPriority,
    tier: item.explicitTier,
    x: item.anchor.x,
    y: item.anchor.y,
  };
  return evalExpr(expr, ctx);
}

function tryParse(src: string): Expr | null {
  try {
    return parseExpr(src);
  } catch {
    return null;
  }
}

/** Raw values of a built-in term. */
function builtinValues(name: string, k: number, model: Model, variants: readonly Variant[][]): (number | null)[] {
  const n = model.items.length;
  const out: (number | null)[] = [];
  switch (name) {
    case "input_order":
      for (let i = 0; i < n; i++) out.push(n - i);
      return out;
    case "label_size":
      for (let i = 0; i < n; i++) out.push(labelSizeEm2(model.items[i]!, variants[i]!));
      return out;
    case "mark_size":
      for (const it of model.items) out.push(it.shape.area());
      return out;
    case "centrality": {
      const f = model.focus ?? (model.canvas ?? model.extent).center();
      for (const it of model.items) out.push(-it.anchor.dist(f));
      return out;
    }
    case "degree":
      for (const it of model.items) {
        const d = attrNumber(get(it.attrs, "degree"));
        if (d !== null) {
          out.push(d);
          continue;
        }
        let deg = 0;
        for (const [, p] of model.vector) {
          if (p.kind !== "polyline" || p.points.length === 0) continue;
          for (const e of [p.points[0]!, p.points[p.points.length - 1]!]) {
            if (it.shape.signedDistance(e) <= 0.5) deg += 1;
          }
        }
        out.push(deg);
      }
      return out;
    case "outlierness":
      return knnGaps(model, k > 1 ? k : 1);
    case "isolation":
      return knnGaps(model, 1);
    case "crowding":
      return knnGaps(model, 1).map((d) => -d);
    default:
      for (let i = 0; i < n; i++) out.push(null);
      return out;
  }
}

/** Equivalent radius used for shape-to-shape gap distances. */
function eqRadius(it: Item): number {
  const s = it.shape;
  return s.kind === "circle" ? s.r : Math.sqrt(s.area() / Math.PI);
}

/**
 * k-th nearest-neighbour gap distance of every item among all item marks and the
 * `points`-class discs (spec §4.4 `outlierness`), found exactly in a k-d tree (ADR 0044).
 */
function knnGaps(model: Model, k: number): number[] {
  const pts: Disc[] = model.items.map((it, i) => [it.anchor, eqRadius(it), i]);
  for (const [c, p] of model.vector) {
    if (c === "points" && p.kind === "disc") pts.push([p.c, p.r, null]);
  }
  const bbox = bboxOf(pts.map((p) => p[0]));
  const tree = new KdTree(pts);
  const best: number[] = [];
  const stack: number[] = [];
  const out: number[] = [];
  model.items.forEach((it, i) => {
    tree.smallestGaps(pts, it.anchor, eqRadius(it), i, k, best, stack);
    // fewer neighbours than k: the largest gap, or the extent without any
    out.push(best.length >= k ? best[k - 1]! : best.length > 0 ? best[best.length - 1]! : maxf(bbox.w(), bbox.h()));
  });
  return out;
}

/** A disc: centre, radius, item index (`null` for a `points` obstacle). */
export type Disc = [P, number, number | null];

/** A k-d tree node: its discs `idx[lo..hi]`, their centres' bounding box and largest radius. */
interface KdNode {
  lo: number;
  hi: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  rmax: number;
  /** Children; 0 for a leaf (the root is no child). */
  left: number;
  right: number;
}

/**
 * A k-d tree over disc centres for {@link knnGaps}: nodes split at the median of their
 * wider side, leaves of at most 8 discs.
 */
export class KdTree {
  /** Disc indices; the discs of every node are contiguous. */
  readonly idx: number[];
  readonly nodes: KdNode[] = [];

  constructor(pts: readonly Disc[]) {
    this.idx = pts.map((_, j) => j);
    if (pts.length > 0) this.build(pts, 0, pts.length);
  }

  private build(pts: readonly Disc[], lo: number, hi: number): number {
    let [x0, y0, x1, y1, rmax] = [Infinity, Infinity, -Infinity, -Infinity, 0];
    for (let q = lo; q < hi; q++) {
      const [c, r] = pts[this.idx[q]!]!;
      x0 = minf(x0, c.x);
      y0 = minf(y0, c.y);
      x1 = maxf(x1, c.x);
      y1 = maxf(y1, c.y);
      rmax = maxf(rmax, r);
    }
    const id = this.nodes.length;
    this.nodes.push({ lo, hi, x0, y0, x1, y1, rmax, left: 0, right: 0 });
    if (hi - lo > 8) {
      const byX = x1 - x0 >= y1 - y0;
      const part = this.idx.slice(lo, hi).sort((a, b) => {
        const [pa, pb] = [pts[a]![0], pts[b]![0]];
        const [ka, kb, sa, sb] = byX ? [pa.x, pb.x, pa.y, pb.y] : [pa.y, pb.y, pa.x, pb.x];
        return cmpF64(ka, kb) || cmpF64(sa, sb) || a - b;
      });
      for (let q = lo; q < hi; q++) this.idx[q] = part[q - lo]!;
      const mid = lo + Math.trunc((hi - lo) / 2);
      const left = this.build(pts, lo, mid);
      const right = this.build(pts, mid, hi);
      this.nodes[id]!.left = left;
      this.nodes[id]!.right = right;
    }
    return id;
  }

  /**
   * A lower bound of the gap from (`a`, `ri`) to every disc of node `n`: rounding is
   * monotone, so it never exceeds a gap computed as in {@link KdTree.smallestGaps}.
   */
  private bound(n: number, a: P, ri: number): number {
    const nd = this.nodes[n]!;
    const dx = maxf(maxf(nd.x0 - a.x, a.x - nd.x1), 0);
    const dy = maxf(maxf(nd.y0 - a.y, a.y - nd.y1), 0);
    return Math.sqrt(dx * dx + dy * dy) - nd.rmax - ri;
  }

  /**
   * The `k` smallest gaps `max(|c − a| − r − ri, 0)` from (`a`, `ri`) to the discs other than
   * item `i`, ascending, in `best` (all of them when there are fewer). A node is skipped only
   * when its bound exceeds the k-th smallest gap found, so the values are exactly those of a
   * search over every disc.
   */
  smallestGaps(pts: readonly Disc[], a: P, ri: number, i: number, k: number, best: number[], stack: number[]): void {
    best.length = 0;
    stack.length = 0;
    if (this.nodes.length > 0) stack.push(0);
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (best.length >= k && this.bound(n, a, ri) > best[k - 1]!) continue;
      const nd = this.nodes[n]!;
      if (nd.left === 0) {
        for (let q = nd.lo; q < nd.hi; q++) {
          const [c, r, idx] = pts[this.idx[q]!]!;
          if (idx === i) continue;
          const g = maxf(c.dist(a) - r - ri, 0);
          if (best.length < k || g < best[k - 1]!) {
            let at = best.length;
            while (at > 0 && best[at - 1]! > g) at--;
            best.splice(at, 0, g);
            if (best.length > k) best.length = k;
          }
        }
      } else if (this.bound(nd.left, a, ri) <= this.bound(nd.right, a, ri)) {
        // the nearer child is visited first (pushed last)
        stack.push(nd.right, nd.left);
      } else {
        stack.push(nd.left, nd.right);
      }
    }
  }
}

function attrNumber(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

function transform(v: number, t: string): number | null {
  switch (t) {
    case "log1p":
      return v > -1 ? ln1p(v) : null;
    case "sqrt":
      return v >= 0 ? Math.sqrt(v) : null;
    case "neg":
      return -v;
    case "abs":
      return Math.abs(v);
    default:
      return v;
  }
}

/** Normalize values across items (spec §9.1). Missing values become 0. */
export function normalize(vals: readonly (number | null)[], how: string): number[] {
  const present: [number, number][] = [];
  vals.forEach((v, i) => {
    if (v !== null) present.push([i, v]);
  });
  const out = new Array<number>(vals.length).fill(0);
  if (how === "none") {
    for (const [i, v] of present) out[i] = v;
  } else if (how === "minmax") {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [, v] of present) {
      lo = minf(lo, v);
      hi = maxf(hi, v);
    }
    if (hi > lo) for (const [i, v] of present) out[i] = (v - lo) / (hi - lo);
  } else {
    const n = present.length;
    const sorted = present.slice().sort((a, b) => cmpF64(a[1], b[1]) || a[0] - b[0]);
    let k = 0;
    while (k < n) {
      let e = k;
      while (e + 1 < n && sorted[e + 1]![1] === sorted[k]![1]) e += 1;
      const avg = (k + e) * 0.5;
      const norm = n > 1 ? avg / (n - 1) : 1;
      for (let s = k; s <= e; s++) out[sorted[s]![0]] = norm;
      k = e + 1;
    }
  }
  return out;
}

const cmpBool = (a: boolean, b: boolean): number => (a === b ? 0 : a ? 1 : -1);
const cmpNum = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

export function compute(model: Model, variants: readonly Variant[][], env: Env): Priorities {
  const n = model.items.length;
  const pv = model.priorityValue;
  const attrs: Value[] = model.items.map(exprCtxValue);
  // tiers
  const tierRules: [Expr, number][] = [];
  for (const r of itemsOf(get(pv, "tiers"))) {
    const w = asStr(get(r, "where"));
    if (w === null) continue;
    const e = tryParse(w);
    if (e === null) continue;
    const t = asI64(get(r, "tier"));
    if (t === null) continue;
    tierRules.push([e, t]);
  }
  const tiers: number[] = model.items.map((it, i) => {
    if (it.explicitTier !== null) return it.explicitTier;
    for (const [e, t] of tierRules) if (truthy(evalItem(e, it, attrs[i]!))) return t;
    return 0;
  });
  // scores
  const scores = new Array<number>(n).fill(0);
  const contribs: [string, number][][] = model.items.map(() => []);
  const callback = env.hasPriorityCallback ? env.hasPriorityCallback() : false;
  const terms = asArray(get(pv, "terms"));
  if (callback) {
    model.items.forEach((it, i) => {
      const r = env.priority ? env.priority(it.raw, i) : null;
      if (r !== null && r !== undefined) {
        const [t, s] = r;
        scores[i] = s;
        if (t !== null && it.explicitTier === null) tiers[i] = t;
      }
    });
  } else if (terms !== null) {
    for (const term of terms) {
      const weight = asF64(get(term, "weight")) ?? 1;
      const how = asStr(get(term, "normalize")) ?? "rank";
      const tr = asStr(get(term, "transform")) ?? "none";
      let name: string;
      let raw: (number | null)[];
      const b = asStr(get(term, "builtin"));
      const a = asStr(get(term, "attr"));
      const src = asStr(get(term, "expr"));
      if (b !== null) {
        const k = asU64(get(term, "k")) ?? 5;
        name = b;
        raw = builtinValues(b, k, model, variants);
      } else if (a !== null) {
        name = a;
        raw = model.items.map((it) => attrNumber(get(it.attrs, a)));
      } else if (src !== null) {
        const e = tryParse(src);
        raw = e !== null ? model.items.map((it, i) => termNumber(evalItem(e, it, attrs[i]!))) : new Array(n).fill(null);
        name = src;
      } else continue;
      const transformed = raw.map((v) => {
        if (v === null) return null;
        const x = transform(v, tr);
        return x !== null && Number.isFinite(x) ? x : null;
      });
      const norm = normalize(transformed, how);
      for (let i = 0; i < n; i++) {
        const c = weight * norm[i]!;
        scores[i] += c;
        contribs[i]!.push([name, c]);
      }
    }
  }
  model.items.forEach((it, i) => {
    if (it.explicitPriority !== null) scores[i] = it.explicitPriority;
  });
  // tie keys
  const tie: number[] = new Array<number>(n).fill(0);
  const ties = model.ties;
  if (ties.kind === "random") {
    const rng = new Pcg32(ties.seed);
    for (let i = 0; i < n; i++) tie[i] = rng.nextU32();
  }
  const cmpItems = (a: number, b: number, reserved: readonly boolean[]): number => {
    const ia = model.items[a]!;
    const ib = model.items[b]!;
    let c = cmpBool(ib.required, ia.required);
    if (c !== 0) return c;
    c = cmpNum(tiers[b]!, tiers[a]!);
    if (c !== 0) return c;
    c = cmpBool(reserved[b]!, reserved[a]!);
    if (c !== 0) return c;
    c = cmpF64(scores[b]!, scores[a]!);
    if (c !== 0) return c;
    switch (ties.kind) {
      case "input_order":
        return a - b;
      case "id":
        return cmpStr(ia.id, ib.id) || a - b;
      case "anchor_x":
        return cmpF64(ia.anchor.x, ib.anchor.x) || a - b;
      case "random":
        return cmpNum(tie[a]!, tie[b]!) || a - b;
    }
  };
  // coverage reservation
  const reserved = new Array<boolean>(n).fill(false);
  const cov = get(pv, "coverage");
  if (isObject(cov)) {
    const by = asStr(get(cov, "by"));
    const e = by !== null ? tryParse(by) : null;
    if (e !== null) {
      const m = asU64(get(cov, "min_per_group")) ?? 1;
      const order: number[] = [];
      for (let i = 0; i < n; i++) order.push(i);
      const none = new Array<boolean>(n).fill(false);
      order.sort((a, b) => cmpItems(a, b, none));
      const groups: [Value, number][] = [];
      for (const i of order) {
        const v = evalItem(e, model.items[i]!, attrs[i]!);
        const g = groups.find((g) => valuesEqual(g[0], v));
        if (g !== undefined) {
          if (g[1] < m) {
            g[1] += 1;
            reserved[i] = true;
          }
        } else {
          groups.push([v, 1]);
          reserved[i] = m >= 1;
        }
      }
    }
  }
  // total order
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((a, b) => cmpItems(a, b, reserved));
  // key levels with bands
  const prio: Prio[] = [];
  for (let i = 0; i < n; i++) {
    prio.push({
      required: model.items[i]!.required,
      tier: tiers[i]!,
      reserved: reserved[i]!,
      score: scores[i]!,
      terms: contribs[i]!,
      rank: 0,
      key: 0,
      weight: maxf(scores[i]!, 0) + 1e-6,
      gain: 0,
    });
  }
  let level = 0;
  let bandStart = NaN;
  order.forEach((i, r) => {
    if (r > 0) {
      const p = order[r - 1]!;
      const sameClass = prio[p]!.required === prio[i]!.required && prio[p]!.tier === prio[i]!.tier && prio[p]!.reserved === prio[i]!.reserved;
      const sameBand = model.band > 0 ? scores[i]! >= bandStart - model.band : scores[i] === scores[p];
      if (!(sameClass && sameBand)) {
        level += 1;
        bandStart = scores[i]!;
      }
    } else {
      bandStart = scores[i]!;
    }
    prio[i]!.rank = r;
    prio[i]!.key = level;
    prio[i]!.gain = Math.LN2 / ln(r + 2);
  });
  // keep_with sets carry the best key of their members
  for (const set of keepWithSets(model)) {
    let best = Infinity;
    for (const i of set) best = Math.min(best, prio[i]!.key);
    if (best === Infinity) best = 0;
    for (const i of set) prio[i]!.key = best;
  }
  // a group label carries the best key of its members
  for (const [rep, members] of model.groups) {
    let best = Infinity;
    for (const i of members) best = Math.min(best, prio[i]!.key);
    prio[rep]!.key = best === Infinity ? prio[rep]!.key : best;
  }
  return { prio, order, nKeys: level + 1 };
}

/**
 * The font class of each item (`priority.font_classes`, spec §9.4): each class takes the
 * items of the total order up to its end (cumulative) that no earlier class took; a group
 * label goes by its best-ranked member. `null`: no class (the item keeps its size).
 */
export function fontClasses(model: Model, pri: Priorities): (number | null)[] {
  const n = model.items.length;
  const ends: number[] = [];
  let last = 0;
  for (const c of model.fontClasses) {
    let end: number;
    if (c.first === null) end = n;
    else if (c.first.kind === "count") end = Math.min(c.first.n, n);
    else end = Math.min(maxf(Math.ceil(c.first.f * n - 1e-9), 0), n);
    last = Math.max(last, end);
    ends.push(last);
  }
  const classOf = (r: number): number | null => {
    const k = ends.findIndex((e) => r < e);
    return k < 0 ? null : k;
  };
  const out = pri.prio.map((p) => classOf(p.rank));
  for (const [rep, members] of model.groups) {
    let best = Infinity;
    for (const i of members) best = Math.min(best, pri.prio[i]!.rank);
    out[rep] = classOf(best === Infinity ? pri.prio[rep]!.rank : best);
  }
  return out;
}

/** All-or-none sets (each with ≥ 2 members), members in input order. */
export function keepWithSets(model: Model): number[][] {
  const n = model.items.length;
  const parent: number[] = [];
  for (let i = 0; i < n; i++) parent.push(i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    let y = x;
    while (parent[y] !== r) {
      const nx = parent[y]!;
      parent[y] = r;
      y = nx;
    }
    return r;
  };
  const byName = new Map<string, number>();
  const ids = new Map<string, number>();
  for (const it of model.items) ids.set(it.id, it.index);
  const involved = new Array<boolean>(n).fill(false);
  for (const it of model.items) {
    const kw = it.keepWith;
    if (kw === null) continue;
    if (kw.kind === "set") {
      involved[it.index] = true;
      const first = byName.get(kw.name);
      if (first !== undefined) {
        const a = find(first);
        const b = find(it.index);
        parent[Math.max(a, b)] = Math.min(a, b);
      } else byName.set(kw.name, it.index);
    } else {
      for (const id of kw.ids) {
        const j = ids.get(id);
        if (j === undefined) continue;
        involved[it.index] = true;
        involved[j] = true;
        const a = find(j);
        const b = find(it.index);
        parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
  const sets = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (!involved[i]) continue;
    const r = find(i);
    let v = sets.get(r);
    if (v === undefined) {
      v = [];
      sets.set(r, v);
    }
    v.push(i);
  }
  const keys = Array.from(sets.keys()).sort((a, b) => a - b);
  const out: number[][] = [];
  for (const k of keys) {
    const s = sets.get(k)!;
    if (s.length >= 2) out.push(s);
  }
  return out;
}
