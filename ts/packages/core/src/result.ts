/**
 * Building the result JSON (spec §11, `result.v1.json`); port of
 * `rust/crates/la-core/src/result.rs`.
 *
 * Objects are built with the key order of the Rust result (serde_json with
 * `preserve_order`). Non-finite numbers become `null`, as in serde_json.
 *
 * @module
 */

import {
  BLOCK_EDGE,
  BLOCK_ITEMS,
  BLOCK_LABELS,
  BLOCK_LEADERS,
  BLOCK_REGIONS,
  type Block,
  type Cand,
  type Leader,
  kindName,
  sideName,
} from "./candidates.js";
import { type Breakdown } from "./cost.js";
import { atan2Deg } from "./detmath.js";
import type { P } from "./geom/index.js";
import type { Shape } from "./geom/shape.js";
import { type TextLayout, type Variant, partKindName } from "./labels.js";
import { cmpF64, cmpStr } from "./math.js";
import { leaderStyleName, stepName } from "./model/index.js";
import { EXPLAIN_CANDIDATES } from "./solver/greedy.js";
import { Reason, type Solve, reasonName } from "./solver/index.js";
import type { Verification } from "./solver/verify.js";
import { VERSION } from "./version.js";

type Json = Record<string, unknown>;

/** A float as serde_json writes it (`null` when not finite). */
function num(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

function pt(p: P): (number | null)[] {
  return [num(p.x), num(p.y)];
}

export function leaderJson(l: Leader, s: Solve): Json {
  const m: Json = {};
  m.points = l.pts.map(pt);
  m.style = leaderStyleName(l.style);
  m.port = pt(l.port);
  if (l.underline !== null) m.underline = [pt(l.underline[0]), pt(l.underline[1])];
  if (l.curve !== null) m.curve = [pt(l.curve[0]), pt(l.curve[1]), pt(l.curve[2])];
  if (l.member !== null) m.member = s.model.items[l.member]!.id;
  return m;
}

export function textJson(t: TextLayout, family: string, weight: number): Json {
  return {
    lines: t.lines.slice(),
    used: t.used,
    truncated: t.truncated,
    baseline_offsets: t.baselines.map(num),
    line_widths: t.widths.map(num),
    x_offset: num(t.xOffset),
    font_size: num(t.fontSize),
    font_family: family,
    font_weight: weight,
    scale: num(t.scale),
  };
}

function boxJson(x0: number, y0: number, w: number, h: number): Json {
  return { x: num(x0), y: num(y0), w: num(w), h: num(h) };
}

function partsJson(v: Variant, c: Cand, family: string, weight: number): Json[] {
  return v.parts.map((p) => {
    const r = p.rect.translate({ x: c.rect.x0, y: c.rect.y0 } as P);
    const m: Json = {};
    m.type = partKindName(p.kind);
    m.box = boxJson(r.x0, r.y0, r.w(), r.h());
    if (p.text !== null) {
      const tj = textJson(p.text, family, weight);
      // part baselines are relative to the label box; report them relative to the part
      tj.baseline_offsets = p.text.baselines.map((b) => num(b - p.rect.y0));
      tj.x_offset = 0;
      m.text = tj;
    }
    return m;
  });
}

export function blockName(s: Solve, b: Block): string {
  switch (b) {
    case BLOCK_EDGE:
      return "canvas_edge";
    case BLOCK_ITEMS:
      return "items";
    case BLOCK_LABELS:
      return "labels";
    case BLOCK_LEADERS:
      return "leaders";
    case BLOCK_REGIONS:
      return "regions";
    default:
      return s.obs.classes[b]!.name;
  }
}

function priorityJson(s: Solve, i: number): Json {
  const p = s.pri.prio[i]!;
  const terms = new Map<string, number>();
  for (const [n, v] of p.terms) terms.set(n, (terms.get(n) ?? 0) + v);
  const m: Json = {};
  if (p.required) m.required = true;
  m.tier = p.tier;
  if (p.reserved) m.reserved = true;
  m.score = num(p.score);
  m.rank = p.rank;
  const fc = s.model.fontClass[i];
  if (fc !== null && fc !== undefined) m.font_class = fc;
  if (terms.size > 0) {
    const t: Json = {};
    for (const [k, v] of terms) setKey(t, k, num(v));
    m.terms = t;
  }
  return m;
}

/** `o[k] = v` that also works for the key `__proto__`. */
function setKey(o: Json, k: string, v: unknown): void {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  else o[k] = v;
}

/** Build the result JSON. */
export function build(s: Solve, ver: Verification, phases: readonly [string, number][], runtimeMs: number, strategy: string): Json {
  const model = s.model;
  const n = model.items.length;
  const placements: Json[] = [];
  let totalCost = 0;
  const degraded = new Map<string, number>();
  const bump = (k: string, by = 1): void => {
    degraded.set(k, (degraded.get(k) ?? 0) + by);
  };
  // moved, added, removed, displacement sum, displacement count
  let fMoved = 0;
  let fAdded = 0;
  let fRemoved = 0;
  let fSum = 0;
  let fCount = 0;
  const buf: number[] = [];
  for (let i = 0; i < n; i++) {
    const item = model.items[i]!;
    const m: Json = {};
    m.id = item.id;
    const cid = s.state.placed[i]!;
    if (cid >= 0) {
      const c = s.cands[cid]!;
      const v = s.variants[i]![c.variant]!;
      m.placed = true;
      m.box = boxJson(c.rect.x0, c.rect.y0, c.rect.w(), c.rect.h());
      const a = item.shape.reference();
      m.anchor = [a.x, a.y];
      m.anchor_side = sideName(c.side);
      m.model = kindName(c.kind);
      const fam = item.font.family;
      if (v.text !== null) m.text = textJson(v.text, fam, item.font.weight);
      if (v.parts.length > 0) m.parts = partsJson(v, c, fam, item.font.weight);
      if (c.leaders.length === 0) m.leader = null;
      else if (c.leaders.length === 1) m.leader = leaderJson(c.leaders[0]!, s);
      else {
        m.leader = leaderJson(c.leaders[0]!, s);
        m.leaders = c.leaders.map((l) => leaderJson(l, s));
      }
      const dynamic = s.state.dynamicCost(c, s.cands, s.obs, item.len.buffer, item.len.clearance, model.leaders.width, i);
      const relax = s.state.relaxed[i] === 1 ? c.relaxCost : 0;
      const cost = c.cost + dynamic + relax;
      totalCost += cost;
      m.cost = num(cost);
      if (model.output.costBreakdown) {
        const bd: Breakdown = [];
        const cc = c.clone();
        s.evaluator.eval(cc, v, bd);
        const bm: Json = {};
        for (const [k, val] of bd) setKey(bm, k, num(val));
        if (dynamic !== 0) bm.dynamic = num(dynamic);
        if (relax !== 0) bm.soft_overlap = num(relax);
        m.cost_breakdown = bm;
      }
      const steps = v.steps.slice();
      if (s.state.relaxed[i] === 1) steps.push("soft_overlap");
      if (c.level > 0) {
        const st = stepName(model.ladder[c.level - 1]!);
        if (!steps.includes(st) && (st === "distant" || st === "boundary" || st === "evict_lower")) steps.push(st);
      }
      for (const st of steps) {
        let k: string;
        if (st.startsWith("shrink")) k = "shrunk";
        else {
          switch (st) {
            case "wrap":
              k = "wrapped";
              break;
            case "alternatives":
              k = "alternative";
              break;
            case "truncate":
              k = "truncated";
              break;
            case "soft_overlap":
              k = "soft_overlap";
              break;
            case "distant":
              k = "distant";
              break;
            case "boundary":
              k = "boundary";
              break;
            default:
              k = "other";
          }
        }
        bump(k);
      }
      if (v.lines() > 1 && !steps.includes("wrap")) bump("wrapped");
      m.degrade_steps = steps;
      m.priority = priorityJson(s, i);
      const members = model.groupMembers(i);
      if (members.length >= 2) {
        m.members = members.map((k) => model.items[k]!.id);
        const t = m.text as Json | undefined;
        if (t !== undefined) t.used = "group";
      }
      if (model.output.itemShape) m.item_shape = shapeJson(item.shape);
      if (model.warm.has(item.id)) {
        const prev = model.warm.get(item.id)!;
        if (prev !== null) {
          const d = prev.center().dist(c.rect.center());
          m.displacement = num(d);
          if (d > 0.5) fMoved += 1;
          fSum += d;
          fCount += 1;
        } else fAdded += 1;
      } else if (model.warm.size > 0) fAdded += 1;
    } else {
      m.placed = false;
      const reason = s.reasons[i] ?? Reason.OmittedByPriority;
      m.reason = reasonName(reason);
      // blocking classes, most frequent first
      const counts = new Map<string, number>();
      const add = (k: string, by: number): void => {
        counts.set(k, (counts.get(k) ?? 0) + by);
      };
      const blockers: number[] = [];
      const feasCost: number[] = [];
      const feasId: number[] = [];
      // ladder candidates are evaluated lazily: evaluate the item's never evaluated ones
      for (const cid2 of s.byItem[i]!) s.ensureEval(cid2);
      for (const cid2 of s.byItem[i]!) {
        const c = s.cands[cid2]!;
        if (c.blocked !== null) add(blockName(s, c.blocked), 1);
        else {
          feasCost.push(c.cost);
          feasId.push(cid2);
        }
      }
      if (s.staticDropped[i]! > 0) add("items", s.staticDropped[i]!);
      const fidx: number[] = [];
      for (let k = 0; k < feasId.length; k++) fidx.push(k);
      fidx.sort((a, b) => cmpF64(feasCost[a]!, feasCost[b]!) || feasId[a]! - feasId[b]!);
      const probes: Cand[] = [];
      if (fidx.length === 0) {
        // no kept feasible candidate: the feasible ones the placed labels had blocked while
        // they were generated (ties in generation order)
        const u = s.blockedFeasible[i]!;
        const order = u.map((_, k) => k);
        order.sort((a, b) => cmpF64(u[a]!.cost, u[b]!.cost) || a - b);
        for (const k of order) probes.push(u[k]!);
      } else {
        for (let t = 0; t < fidx.length && t < EXPLAIN_CANDIDATES; t++) probes.push(s.cands[feasId[fidx[t]!]!]!);
      }
      for (const c of probes) {
        s.state.conflicts(c, s.cands, s.obs, i, buf);
        for (const j of buf) {
          const jc = s.cands[s.state.placed[j]!]!;
          add(jc.rect.overlaps(c.rect) ? "labels" : "leaders", 1);
          if (!blockers.includes(j)) blockers.push(j);
        }
      }
      const cv = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]));
      m.blocking = cv.map((x) => x[0]);
      blockers.sort((a, b) => s.pri.prio[a]!.rank - s.pri.prio[b]!.rank);
      m.blocked_by = blockers.map((j) => model.items[j]!.id);
      m.priority = priorityJson(s, i);
      if (s.stepsTried[i]!.length > 0) m.degrade_steps = s.stepsTried[i]!.slice();
      const prev = model.warm.get(item.id);
      if (prev !== undefined && prev !== null) fRemoved += 1;
    }
    placements.push(m);
  }
  // stats
  const placed = s.state.nPlaced;
  let gainAll = -0;
  for (const p of s.pri.prio) gainAll += p.gain;
  let gainPlaced = -0;
  for (let i = 0; i < n; i++) if (s.state.placed[i]! >= 0) gainPlaced += s.pri.prio[i]!.gain;
  const omitted: number[] = [];
  for (let i = 0; i < n; i++) if (s.state.placed[i]! < 0) omitted.push(i);
  omitted.sort((a, b) => s.pri.prio[b]!.rank - s.pri.prio[a]!.rank);
  let requiredPlaced = true;
  for (let i = 0; i < n; i++) if (model.items[i]!.required && s.state.placed[i]! < 0) requiredPlaced = false;
  const phasesM: Json = {};
  for (const [k, v] of phases) phasesM[k] = num(v);
  const degradedJ: Json = {};
  for (const k of Array.from(degraded.keys()).sort(cmpStr)) degradedJ[k] = degraded.get(k)!;
  const stats: Json = {
    placed,
    total: n,
    placed_weighted: num(gainAll > 0 ? gainPlaced / gainAll : 1),
    required_placed: requiredPlaced,
    hard_violations: ver.hardViolations,
    leader_crossings: ver.leaderCrossings,
    runtime_ms: num(runtimeMs),
    phases_ms: phasesM,
    strategy_used: strategy,
    seed: model.solver.seed,
    iterations: s.iterations,
    time_guard_hit: s.timeGuardHit,
    cancelled: s.cancelled,
    candidates: s.cands.length,
    omission_order: omitted.map((i) => model.items[i]!.id),
    priority_inversions: ver.priorityInversions,
    total_cost: num(totalCost),
    degraded: degradedJ,
    grid: {
      cell: num(s.obs.grid.cell),
      cols: s.obs.grid.cols,
      rows: s.obs.grid.rows,
      classes: s.obs.classes.map((c) => c.name),
    },
    implementation: `ts/${VERSION}`,
  };
  if (model.warm.size > 0) {
    stats.flicker = {
      moved: fMoved,
      added: fAdded,
      removed: fRemoved,
      mean_displacement: num(fCount > 0 ? fSum / fCount : 0),
    };
  }
  const out: Json = {
    version: "1",
    placements,
    stats,
    debug_svg: null,
  };
  if (model.warnings.length > 0) {
    out.warnings = model.warnings.map((w) => ({ pointer: w.pointer, code: w.code, message: w.message }));
  }
  if (model.output.candidates) {
    out.candidates = s.cands.map((c) => ({
      id: model.items[c.item]!.id,
      box: boxJson(c.rect.x0, c.rect.y0, c.rect.w(), c.rect.h()),
      model: kindName(c.kind),
      anchor_side: sideName(c.side),
      variant: c.variant,
      level: c.level,
      cost: num(c.cost),
      feasible: c.feasible,
      leader: c.leaders.length > 0 ? leaderJson(c.leaders[0]!, s) : null,
    }));
  }
  return out;
}

/** Resolved item geometry for `output.item_shape`. */
export function shapeJson(s: Shape): Json {
  switch (s.kind) {
    case "circle":
      return { shape: "circle", x: num(s.c.x), y: num(s.c.y), r: num(s.r) };
    case "ellipse":
      return { shape: "ellipse", x: num(s.c.x), y: num(s.c.y), rx: num(s.rx), ry: num(s.ry), rotation: num(atan2Deg(s.sin, s.cos)) };
    case "roundRect":
      return {
        shape: "rect",
        x: num(s.c.x),
        y: num(s.c.y),
        w: num(s.hw * 2),
        h: num(s.hh * 2),
        corner_radius: num(s.r),
        rotation: num(atan2Deg(s.sin, s.cos)),
      };
    case "polygon":
      return {
        shape: "polygon",
        x: num(s.poly.reference.x),
        y: num(s.poly.reference.y),
        rings: s.poly.rings.map((r) => r.map(pt)),
      };
  }
}
