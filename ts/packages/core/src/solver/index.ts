/**
 * Solver pipeline (spec §10): candidates → greedy with ladder → local search →
 * verification; port of `rust/crates/la-core/src/solver/mod.rs`.
 *
 * @module
 */

import { boundaryCandidates } from "../boundary.js";
import {
  Cand,
  KEEP_BOX,
  Kind,
  type KeepFn,
  adjacent,
  internal,
  internalRank,
  isRectShape,
  labelShape,
  warm,
} from "../candidates.js";
import { Evaluator } from "../cost.js";
import { type Env, envCancelled, envNow } from "../env.js";
import { type P, Rect } from "../geom/index.js";
import { type Measurer, type Variant, ladderVariants } from "../labels.js";
import { distant, distantDirs } from "../leaders.js";
import { cosDeg } from "../detmath.js";
import { cmpF64, minf } from "../math.js";
import { type Model, Models } from "../model/index.js";
import type { Obstacles } from "../obstacles.js";
import type { Priorities } from "../priority.js";
import { StaticIndex } from "../spatial.js";
import { newWindow } from "../grid/occupancy.js";
import { State } from "./state.js";

/** Why an item ended up unplaced. */
export const Reason = {
  OmittedByPriority: 0,
  NoFeasibleCandidate: 1,
  BudgetExhausted: 2,
  KeepWith: 3,
  Grouped: 4,
} as const;
export type Reason = (typeof Reason)[keyof typeof Reason];

const REASON_NAMES = ["omitted_by_priority", "no_feasible_candidate", "budget_exhausted", "keep_with", "grouped"] as const;

/** `Reason::name`. */
export function reasonName(r: Reason): string {
  return REASON_NAMES[r];
}

/** Everything the solver works on. */
export class Solve {
  cands: Cand[] = [];
  /** Candidate ids per item (all generated levels). */
  byItem: number[][];
  /** Index of level-0 candidate bounding boxes (for live counts and lookahead). */
  candIx: StaticIndex;
  nLevel0 = 0;
  /** Models in effect per item (grows with the `distant`/`boundary` steps). */
  models: Models[];
  state: State;
  reasons: (Reason | null)[];
  /** Ladder steps an item went through (placed or not). */
  stepsTried: string[][];
  /** Highest ladder level generated per item. */
  levelDone: number[];
  /** Level-0 distant candidates not generated yet (they are created on demand). */
  distantPending: boolean[];
  /**
   * Candidates of each item dropped during generation because their box covers an item
   * mark (reported as `items` among the blocking classes).
   */
  staticDropped: number[];
  /** The warm-start candidate of each item (see `generateWarm`). */
  warmCand: (number | null)[];
  /**
   * The warm-start candidate of each item for a ladder variant, once computed (see
   * `warmLadderCandidate`): `undefined` = not computed yet.
   */
  warmLadder: (number | null | undefined)[];
  /** Directions of distant candidates (see `distantDirs`). */
  distantDirs: [number, P][];
  /**
   * Statically feasible candidates of unplaced items that the placed-label filter had
   * dropped (see {@link feasibleUnfiltered}); explanations only.
   */
  blockedFeasible: Cand[][];
  iterations = 0;
  timeGuardHit = false;
  /** The host cancelled the solve (sticky once seen; see {@link pollCancel}). */
  cancelled = false;
  /** Static cost evaluation (scratch buffers). */
  readonly evaluator: Evaluator;
  /** Scratch query window of the candidate filter. */
  private readonly window = newWindow();

  constructor(
    readonly model: Model,
    readonly obs: Obstacles,
    readonly env: Env,
    readonly pri: Priorities,
    readonly measurer: Measurer,
    public variants: Variant[][],
    readonly startMs: number,
  ) {
    const n = model.items.length;
    this.byItem = [];
    for (let i = 0; i < n; i++) this.byItem.push([]);
    this.candIx = new StaticIndex([], model.extent, obs.indexCell);
    this.models = model.items.map((it) => it.models);
    this.state = new State(
      n,
      model.extent,
      obs.indexCell,
      pri.prio.map((p) => p.key),
      model.items.map((it) => it.len.clearance),
      model.items.map((it) => it.em()),
      model.leaders.minAngleBetween > 0 ? cosDeg(model.leaders.minAngleBetween) : 1,
    );
    this.reasons = new Array<Reason | null>(n).fill(null);
    this.stepsTried = [];
    for (let i = 0; i < n; i++) this.stepsTried.push([]);
    this.levelDone = new Array<number>(n).fill(0);
    this.distantPending = new Array<boolean>(n).fill(false);
    this.warmCand = new Array<number | null>(n).fill(null);
    this.warmLadder = new Array<number | null | undefined>(n).fill(undefined);
    this.staticDropped = new Array<number>(n).fill(0);
    this.distantDirs = distantDirs(model);
    this.blockedFeasible = [];
    for (let i = 0; i < n; i++) this.blockedFeasible.push([]);
    this.evaluator = new Evaluator(model, obs, env);
  }

  /** Generate and evaluate candidates for `variants[vis]` of item `i` with `models`. */
  generate(i: number, vis: readonly number[], models: Models, level: number): number[] {
    const g = this.model.groupOf[i];
    if (g !== undefined && g !== null && g !== i) return [];
    return this.generateMode(i, vis, models, level, false);
  }

  /**
   * Up to `k` statically feasible candidates of item `i` (or, with the `soft_overlap`
   * step, relaxed-feasible ones) among those that the placed-label filter of
   * {@link generateMode} may have dropped, generated again without that filter, in
   * generation order: the distant candidates and the models added by ladder steps of the
   * item's level-0 variants, and every candidate of its ladder variants. For the
   * explanation of an omitted item (spec §9.3) whose kept candidates all violate a static
   * hard constraint: it was blocked by placed labels when one of these exists.
   */
  feasibleUnfiltered(i: number, k: number): Cand[] {
    const model = this.model;
    const obs = this.obs;
    const item = model.items[i]!;
    const models = this.models[i]!;
    // level-0 variants: their adjacent, slider, internal and boundary candidates were
    // generated before any label was placed (all kept); distant candidates on demand
    const level0 = (models & ~item.models) | (models & Models.DISTANT);
    const softOk = model.ladder.some((st) => st.kind === "soft_overlap");
    const variants = this.variants[i]!;
    const itemOcc = obs.itemOcc;
    const box = KEEP_BOX;
    // the item-mark test of generateMode, without the placed labels
    const keep: KeepFn = (vi) =>
      itemOcc === null || !isRectShape(variants[vi]!.shape) || !itemOcc.blockedBox(box);
    const adjKeep = itemOcc !== null ? keep : null;
    const sliderPerGap = model.placement.sliderPerGap;
    const circleRatio = model.placement.internalCircleRatio;
    const out: Cand[] = [];
    for (let vi = 0; vi < variants.length; vi++) {
      const v = variants[vi]!;
      const m = v.level === 0 ? level0 : models;
      if (m === 0) continue;
      const fresh: Cand[] = [];
      if (item.area !== null) {
        const rank = internalRank(item, v, m, circleRatio);
        if (rank !== null) internal(item, vi, v, rank, fresh);
        adjacent(item, vi, v, sliderPerGap, m, fresh, adjKeep);
      } else {
        adjacent(item, vi, v, sliderPerGap, m, fresh, adjKeep);
        const rank = internalRank(item, v, m, circleRatio);
        if (rank !== null) internal(item, vi, v, rank, fresh);
      }
      if (Models.has(m, Models.DISTANT)) distant(model, obs, item, vi, v, this.distantDirs, keep, fresh);
      if (Models.has(m, Models.BOUNDARY)) boundaryCandidates(model, obs, item, variants, [vi], keep, fresh);
      for (const c of fresh) {
        c.level = v.level;
        c.lshape = labelShape(c.rect, v.shape);
        this.evaluator.eval(c, v, null);
        if (c.feasible || (softOk && c.relaxed)) {
          out.push(c);
          if (out.length === k) return out;
        }
      }
    }
    return out;
  }

  /** Statically evaluate candidate `cid` if it is not evaluated yet. */
  ensureEval(cid: number): void {
    const c = this.cands[cid]!;
    if (c.evaluated) return;
    this.evaluator.eval(c, this.variants[c.item]![c.variant]!, null);
  }

  /** `lazy`: skip static evaluation and pruning (ladder candidates; see `ensureEval`). */
  generateMode(i: number, vis: readonly number[], models: Models, level: number, lazy: boolean): number[] {
    const model = this.model;
    const obs = this.obs;
    const item = model.items[i]!;
    // While labels are placed (ladder steps, on-demand distant candidates), candidates
    // blocked (hard) by a placed label or leader of higher or equal priority are dropped
    // (spec §6.7): they cannot be used while that label stays, and they can never be
    // evict_lower targets or witnesses of a priority inversion (those only involve
    // strictly lower-priority labels). The occupancy grid rejects most of them before
    // their leaders are built; the exact test below decides the rest.
    const keyI = this.pri.prio[i]!.key;
    const filter = this.state.nPlaced > 0;
    const mk = this.state.maxPlacedKey();
    const quick = filter && obs.dynamic.labelLabels.isHard() && mk !== null && mk <= keyI;
    const state = this.state;
    const variants = this.variants[i]!;
    const itemOcc = obs.itemOcc;
    const occ = state.occupancy();
    // both grids cover the model extent with the same cells: one window serves both
    const shared = itemOcc === null || itemOcc.sameCells(occ);
    const win = this.window;
    let dropped = 0;
    // `keep` serves non-internal candidates only (internal labels sit on their mark)
    const box = KEEP_BOX;
    const keep: KeepFn = (vi) => {
      if (!(quick || itemOcc !== null) || !isRectShape(variants[vi]!.shape)) return true;
      const w = occ.windowBox(box, win);
      if (itemOcc !== null) {
        const hit = shared ? w && itemOcc.blockedIn(win) : itemOcc.blockedBox(box);
        if (hit) {
          dropped += 1;
          return false;
        }
      }
      return !(quick && state.nPlaced > 0 && w && occ.blockedIn(win));
    };
    // Rust creates the adjacent and slider candidates and then drops those `keep` rejects;
    // `adjacent` applies the same test to the same boxes in the same order before creating
    // them (internal candidates are exempt either way).
    const adjKeep = quick || itemOcc !== null ? keep : null;
    const fresh: Cand[] = [];
    const sliderPerGap = model.placement.sliderPerGap;
    const circleRatio = model.placement.internalCircleRatio;
    for (const vi of vis) {
      const v = variants[vi]!;
      if (item.area !== null) {
        // area anchors: internal candidates first; external ones around the dot
        const rank = internalRank(item, v, models, circleRatio);
        if (rank !== null) internal(item, vi, v, rank, fresh);
        adjacent(item, vi, v, sliderPerGap, models, fresh, adjKeep);
      } else {
        adjacent(item, vi, v, sliderPerGap, models, fresh, adjKeep);
        const rank = internalRank(item, v, models, circleRatio);
        if (rank !== null) internal(item, vi, v, rank, fresh);
      }
      if (Models.has(models, Models.DISTANT)) distant(model, obs, item, vi, v, this.distantDirs, keep, fresh);
    }
    if (Models.has(models, Models.BOUNDARY)) boundaryCandidates(model, obs, item, variants, vis, keep, fresh);
    this.staticDropped[i] += dropped;
    for (const c of fresh) {
      c.level = level;
      c.lshape = labelShape(c.rect, variants[c.variant]!.shape);
    }
    let kept: Cand[] = fresh;
    if (filter) {
      kept = [];
      for (const c of fresh) if (state.firstConflict(c, this.cands, obs, i, keyI) < 0) kept.push(c);
    }
    if (lazy) {
      const ids: number[] = [];
      for (const c of kept) {
        ids.push(this.cands.length);
        this.cands.push(c);
      }
      for (const id of ids) this.byItem[i]!.push(id);
      return ids;
    }
    const ev = this.evaluator;
    for (const c of kept) ev.eval(c, this.variants[c.item]![c.variant]!, null);
    // keep the k_distant cheapest distant candidates per variant
    const kd = model.placement.kDistant;
    const keepFlags = new Uint8Array(kept.length).fill(1);
    for (const vi of vis) {
      const ds: number[] = [];
      for (let k = 0; k < kept.length; k++) if (kept[k]!.variant === vi && kept[k]!.kind === Kind.Distant) ds.push(k);
      if (ds.length <= kd) continue;
      ds.sort((a, b) => {
        const ca = kept[a]!;
        const cb = kept[b]!;
        const fa = ca.feasible ? 0 : 1;
        const fb = cb.feasible ? 0 : 1;
        return fa - fb || cmpF64(ca.cost, cb.cost) || a - b;
      });
      for (let k = kd; k < ds.length; k++) keepFlags[ds[k]!] = 0;
    }
    // prune expensive feasible candidates
    let best = Infinity;
    for (let k = 0; k < kept.length; k++) if (keepFlags[k] && kept[k]!.feasible) best = minf(best, kept[k]!.cost);
    if (Number.isFinite(best)) {
      const lim = model.placement.pruneFactor * Math.abs(best) + 1 + minf(best, 0);
      for (let k = 0; k < kept.length; k++) {
        const c = kept[k]!;
        if (c.feasible && c.cost > lim) keepFlags[k] = 0;
      }
    }
    const ids: number[] = [];
    const byItem = this.byItem[i]!;
    for (let k = 0; k < kept.length; k++) {
      if (keepFlags[k]) {
        ids.push(this.cands.length);
        byItem.push(this.cands.length);
        this.cands.push(kept[k]!);
      }
    }
    return ids;
  }

  /**
   * Level-0 candidates of all items, then the candidate index. Distant candidates are
   * generated on demand (see {@link ensureDistant}).
   */
  generateLevel0(): void {
    const n = this.model.items.length;
    for (let i = 0; i < n; i++) {
      const vis = range(this.variants[i]!.length);
      const m = this.models[i]!;
      this.distantPending[i] = Models.has(m, Models.DISTANT);
      this.generate(i, vis, m & ~Models.DISTANT, 0);
      this.generateWarm(i);
    }
    // auto preset: enable distant labels when crowded
    const ac = this.model.autoCrowded;
    if (ac !== null) {
      const [frac, crowdedModels] = ac;
      let lacking = 0;
      for (let i = 0; i < n; i++) {
        let ok = false;
        for (const cid of this.byItem[i]!) {
          const c = this.cands[cid]!;
          if (c.feasible && (c.kind === Kind.Adjacent || c.kind === Kind.Slider || c.kind === Kind.Internal)) {
            ok = true;
            break;
          }
        }
        if (!ok) lacking += 1;
      }
      if (n > 0 && lacking > frac * n) {
        for (let i = 0; i < n; i++) {
          const add = crowdedModels & ~this.models[i]!;
          if (add !== 0) {
            this.models[i] = this.models[i]! | add;
            if (Models.has(add, Models.DISTANT)) this.distantPending[i] = true;
            const rest = add & ~Models.DISTANT;
            if (rest !== 0) this.generate(i, range(this.variants[i]!.length), rest, 0);
          }
        }
      }
    }
    this.nLevel0 = this.cands.length;
    this.candIx = new StaticIndex(
      this.cands.map((c) => c.bbox()),
      this.model.extent,
      this.obs.indexCell,
    );
  }

  /**
   * The warm-start box of item `i` as an extra level-0 candidate (kept when statically
   * feasible), for the variant of the same size.
   */
  private generateWarm(i: number): void {
    const item = this.model.items[i]!;
    const b = this.model.warm.get(item.id);
    if (b === undefined || b === null) return;
    const g = this.model.groupOf[i];
    if (g !== undefined && g !== null && g !== i) return;
    const vs = this.variants[i]!;
    const vi = vs.findIndex((v) => Math.abs(v.w - b.w()) <= 0.5 && Math.abs(v.h - b.h()) <= 0.5);
    if (vi < 0) return;
    const v = vs[vi]!;
    const c = warm(this.model, item, vi, v, b);
    if (c === null) return;
    c.level = 0;
    c.lshape = labelShape(c.rect, v.shape);
    this.evaluator.eval(c, v, null);
    if (c.feasible) {
      this.warmCand[i] = this.cands.length;
      this.byItem[i]!.push(this.cands.length);
      this.cands.push(c);
    }
  }

  /** Generate the pending level-0 distant candidates of item `i` (once). */
  ensureDistant(i: number): number[] {
    if (!this.distantPending[i]) return [];
    this.distantPending[i] = false;
    const vis: number[] = [];
    this.variants[i]!.forEach((v, k) => {
      if (v.level === 0) vis.push(k);
    });
    return this.generate(i, vis, Models.DISTANT, 0);
  }

  /** Lower bound of the static cost of any leadered candidate of item `i`. */
  leaderCostBound(i: number): number {
    const w = this.model.weights;
    const it = this.model.items[i]!;
    return w.leader + (w.leaderLength * it.len.leaderMin) / it.em() + w.position;
  }

  /**
   * Run ladder step `si` for item `i`: create its variants/candidates (once) and return
   * the new candidate ids.
   */
  ladderCandidates(i: number, si: number): number[] {
    const level = (si + 1) & 0xff;
    if (this.levelDone[i]! >= level) return this.byItem[i]!.filter((c) => this.cands[c]!.level === level);
    this.levelDone[i] = level;
    const step = this.model.ladder[si]!;
    const item = this.model.items[i]!;
    switch (step.kind) {
      case "alternatives":
      case "wrap":
      case "truncate":
      case "shrink": {
        const fresh = ladderVariants(
          this.measurer,
          item,
          step,
          this.variants[i]!,
          this.model.degrade.minScale,
          this.model.degrade.wrapMaxLines,
        );
        if (fresh.length === 0) return [];
        const vs = this.variants[i]!;
        const start = vs.length;
        for (const v of fresh) {
          v.level = level;
          vs.push(v);
        }
        const vis: number[] = [];
        for (let k = start; k < vs.length; k++) vis.push(k);
        return this.generateMode(i, vis, this.models[i]!, level, true);
      }
      case "distant": {
        if (Models.has(this.models[i]!, Models.DISTANT)) return this.ensureDistant(i);
        this.models[i] = Models.with(this.models[i]!, Models.DISTANT);
        return this.generateMode(i, range(this.variants[i]!.length), Models.DISTANT, level, true);
      }
      case "boundary": {
        if (Models.has(this.models[i]!, Models.BOUNDARY)) return [];
        this.models[i] = Models.with(this.models[i]!, Models.BOUNDARY);
        return this.generateMode(i, range(this.variants[i]!.length), Models.BOUNDARY, level, true);
      }
      default:
        return [];
    }
  }

  /**
   * The warm box of item `i` as a candidate of the ladder variant of its size, when no
   * level-0 variant has that size (the previous solve degraded the label): the ladder
   * steps run in order, as the ladder would run them, until one creates a variant of that
   * size. Like the level-0 warm candidate (`generateWarm`), it is slider-kind or distant
   * with a straight leader, and only statically feasible ones count. Computed once per
   * item.
   */
  warmLadderCandidate(i: number): number | null {
    const known = this.warmLadder[i];
    if (known !== undefined) return known;
    this.warmLadder[i] = null;
    const item = this.model.items[i]!;
    const b = this.model.warm.get(item.id);
    if (b === undefined || b === null) return null;
    const same = (v: Variant) => Math.abs(v.w - b.w()) <= 0.5 && Math.abs(v.h - b.h()) <= 0.5;
    if (this.variants[i]!.some((v) => v.level === 0 && same(v))) return null;
    const steps = this.model.ladder.slice();
    for (let si = 0; si < steps.length; si++) {
      const step = steps[si]!;
      if (step.kind === "omit") break;
      if (step.kind === "evict_lower" || step.kind === "soft_overlap") continue;
      const level = (si + 1) & 0xff;
      this.ladderCandidates(i, si);
      if (step.kind !== "alternatives" && step.kind !== "wrap" && step.kind !== "truncate" && step.kind !== "shrink") {
        continue;
      }
      const vs = this.variants[i]!;
      const vi = vs.findIndex((v) => v.level === level && same(v));
      if (vi < 0) continue;
      const v = vs[vi]!;
      const c = warm(this.model, item, vi, v, b);
      if (c === null) return null;
      c.level = level;
      c.lshape = labelShape(c.rect, v.shape);
      this.evaluator.eval(c, v, null);
      if (!c.feasible) return null;
      const id = this.cands.length;
      this.byItem[i]!.push(id);
      this.cands.push(c);
      this.warmLadder[i] = id;
      return id;
    }
    return null;
  }

  now(): number {
    return envNow(this.env);
  }

  /**
   * Poll the host's cancellation request (`Env.cancelled`); once set it stays set. The
   * solver then stops improving and returns the best valid state so far.
   */
  pollCancel(): boolean {
    if (!this.cancelled && envCancelled(this.env)) this.cancelled = true;
    return this.cancelled;
  }
}

/** `0..n` as an array. */
export function range(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}
