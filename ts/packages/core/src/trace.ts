/**
 * Solve traces: what the solver decided, step by step, for the explainer of the
 * playground (ADR 0041). TypeScript only; the Rust core has no counterpart.
 *
 * A {@link Tracer} attached to a solve (`placeTraced` in `index.ts`) is called at the
 * solver's decisions: candidate generation, the greedy pass (bands, the item taken next,
 * the scores of its free candidates, placements and the candidates they rule out, ladder
 * steps, evictions, omissions), every local-search move, and the passes after the search.
 * It only reads the solver's state: it never changes it and never draws a random number,
 * so a traced solve makes exactly the decisions of an untraced one (test/trace.test.ts).
 * Every event carries the net change of the placement since the previous event, so
 * replaying the changes in order gives the placement after any event.
 *
 * Candidates are numbered by the trace in the order it first sees them (the solver reuses
 * the ids of candidates it drops again, as a fan column it undoes). Their costs, the
 * per-term breakdown and the label texts of the variants are read when the solve ends.
 *
 * @module
 */

import { type Cand, Kind, kindName, sideName } from "./candidates.js";
import { type Breakdown } from "./cost.js";
import { type Models, Models as M, labelText } from "./model/index.js";
import { blockName, leaderJson, shapeJson, textJson } from "./result.js";
import { type Solve, reasonName } from "./solver/index.js";
import type { Verification } from "./solver/verify.js";

/** The phases of a solve, in order (`exact` runs only for small problems with a large budget). */
export type TracePhase = "prepare" | "candidates" | "greedy" | "local" | "exact" | "fan" | "boundary" | "uncross" | "repair" | "verify";

/** A change of the placement: the item and the trace candidate it has now (-1: no label). */
export type TraceChange = [item: number, cand: number];

/**
 * What became of a candidate when it was generated: kept; dropped because a placed label
 * of higher or equal priority blocks it (`blocked`); dropped as one of the more expensive
 * distant candidates beyond `k_distant` (`k_distant`); or dropped for costing more than
 * `prune_factor` times the item's best (`pruned`).
 */
export type TraceFate = "kept" | "blocked" | "k_distant" | "pruned";

export interface TraceCandidate {
  item: number;
  /** Index into the item's {@link TraceItem.variants}. */
  variant: number;
  /** 0, or the ladder step (1-based) that created it. */
  level: number;
  model: string;
  side: string;
  /** Label box `[x, y, w, h]`. */
  box: [number, number, number, number];
  /** Leaders, as in the result (`points`, `style`, `port`, …). */
  leaders: Record<string, unknown>[];
  /** Static cost, or null when the solver never needed it (ladder candidates are evaluated lazily). */
  cost: number | null;
  /** Statically feasible (no hard constraint violated by the candidate alone); null when never evaluated. */
  feasible: boolean | null;
  /** The first hard constraint that makes it infeasible (`canvas_edge`, `items`, a class name). */
  blocked: string | null;
  /** The previous solve's box (warm start). */
  warm: boolean;
  fate: TraceFate;
  /** The static cost per term (`cost_breakdown` of the result); null when never evaluated. */
  breakdown: [string, number][] | null;
}

export interface TraceVariant {
  /** 0, or the ladder step (1-based) that created it. */
  level: number;
  /** The ladder steps it embodies (`wrap`, `alternatives`, `shrink:0.85`, …). */
  steps: string[];
  w: number;
  h: number;
  /** The text layout, as `text` of a placement; null for labels without text. */
  text: Record<string, unknown> | null;
}

export interface TraceItem {
  id: string;
  text: string;
  /** The resolved mark, as `item_shape` of a placement (for an area anchor: the dot at its pole). */
  shape: Record<string, unknown>;
  /** The polygon of an area anchor (as `shape`), or null. */
  area: Record<string, unknown> | null;
  anchor: [number, number];
  /** Priority key level (0 = most important; equal keys form a band of the greedy pass). */
  key: number;
  /** Position in the total priority order (0 = first). */
  rank: number;
  score: number;
  tier: number;
  required: boolean;
  /** Candidate models in effect at the end (ladder steps can add `distant` and `boundary`). */
  models: string[];
  variants: TraceVariant[];
  /** Why the item has no label at the end, or null. */
  reason: string | null;
}

/** Why a local-search iteration made no move. */
export type TraceIdle =
  /** relocate: drew an item without a label */
  | "unlabeled"
  /** relocate: the item has a single candidate */
  | "single"
  /** relocate: drew the current candidate, or one the item may not use */
  | "same"
  /** insertion: drew an item that has a label */
  | "labeled"
  /** insertion: the item belongs to a keep_with set or a group, or ran out of budget */
  | "excluded"
  /** insertion: the label cap is reached */
  | "cap"
  /** insertion: it failed before and nothing changed since */
  | "known";

/** The outcome of a local-search move. */
export type TraceOutcome =
  /** no move (see {@link TraceIdle}) */
  | "idle"
  /** the cost dropped (or stayed): always accepted */
  | "improved"
  /** the cost rose, accepted by the Metropolis rule */
  | "accepted"
  /** the cost rose, rejected by the Metropolis rule */
  | "rejected"
  /** relocate: labels block the target */
  | "blocked"
  /** swap: the blocker has no free candidate */
  | "no_room"
  /** insertion: the item got a label */
  | "inserted"
  /** insertion: no candidate could be freed */
  | "not_inserted";

export type TraceMoveKind = "none" | "relocate" | "swap" | "insert";

interface Base {
  /** The placement changes since the previous event. */
  changes: TraceChange[];
}

export type TraceEvent = Base &
  (
    | { type: "phase"; phase: TracePhase }
    | {
        /** Candidates of an item were generated (`skipped`: positions the occupancy grid rejected before building them). */
        type: "generate";
        item: number;
        level: number;
        cands: number[];
        skipped: number;
      }
    | { type: "crowded"; lacking: number; total: number }
    | { type: "band"; key: number; items: number[] }
    | {
        /** The greedy pass takes `item` next: `level0` most constrained first (`live` free candidates), `ladder` the band's leftovers in priority order, `ordered` in priority order (caps, prefix omission). */
        type: "pick";
        item: number;
        live: number;
        pass: "level0" | "ladder" | "ordered";
      }
    | {
        /** The free level-0 candidates of `item`, scored: static + dynamic cost (+ lookahead for the cheapest eight). */
        type: "score";
        item: number;
        options: { cand: number; cost: number; dynamic: number; lookahead: number | null }[];
        chosen: number | null;
      }
    | {
        /** `item` got label `cand`; `killed`: level-0 candidates of waiting items that conflict with it. */
        type: "place";
        item: number;
        cand: number;
        killed: number[];
      }
    | { type: "defer"; item: number }
    | { type: "ladder"; item: number; step: string; cands: number[]; chosen: number | null }
    | { type: "evict"; item: number; evicted: number[] }
    | { type: "omit"; item: number; reason: string }
    | { type: "anneal"; iterations: number; t0: number; cost: number }
    | {
        type: "move";
        it: number;
        kind: TraceMoveKind;
        item: number;
        from: number;
        to: number;
        /** swap: the item whose label was in the way, and its new candidate */
        other: number;
        otherTo: number;
        /** relocate: the number of labels in the way */
        blockers: number;
        delta: number | null;
        temp: number;
        outcome: TraceOutcome;
        idle: TraceIdle | null;
        /** total cost of the placement after the move, and the best seen since the last insertion */
        cost: number;
        best: number;
      }
    | {
        /** A pass after the search changed the placement (`what`: `restore`, `exact`, `fan`, `boundary`, `fill`, `uncross`, `repair`). */
        type: "pass";
        phase: TracePhase;
        what: string;
        items: number[];
        kept: boolean;
      }
    | { type: "verify"; violations: number; crossings: number; inversions: number; repaired: number[] }
  );

/** The trace of one solve. */
export interface SolveTrace {
  items: TraceItem[];
  candidates: TraceCandidate[];
  events: TraceEvent[];
  /** The obstacle classes of the problem, in order. */
  classes: string[];
  /** The number of local-search moves of the budget, and the strategy that ran. */
  iterations: number;
  strategy: string;
}

/** Distributes a union over its members (so `Omit` keeps the discriminant). */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const MODEL_NAMES: [number, string][] = [
  [M.ADJACENT, "adjacent"],
  [M.SLIDER, "slider"],
  [M.INTERNAL, "internal"],
  [M.DISTANT, "distant"],
  [M.BOUNDARY, "boundary"],
];

function modelNames(m: Models): string[] {
  return MODEL_NAMES.filter(([b]) => (m & b) !== 0).map(([, n]) => n);
}

/** Records the decisions of one solve (see the module comment). */
export class Tracer {
  readonly events: TraceEvent[] = [];
  private s: Solve | null = null;
  /** The candidate object placed per item at the last event. */
  private shadow: (Cand | null)[] = [];
  private ids = new Map<Cand, number>();
  private objs: Cand[] = [];
  private fates: TraceFate[] = [];
  private strategy = "greedy";
  /** The local-search moves of the budget (set when local search starts). */
  iterations = 0;

  /** Attach to a solve before its candidates are generated. */
  begin(s: Solve): void {
    this.s = s;
    this.shadow = new Array<Cand | null>(s.model.items.length).fill(null);
    this.phase("prepare");
  }

  /** The trace number of candidate `c` (numbered on first sight). */
  cid(c: Cand, fate: TraceFate = "kept"): number {
    let id = this.ids.get(c);
    if (id === undefined) {
      id = this.objs.length;
      this.ids.set(c, id);
      this.objs.push(c);
      this.fates.push(fate);
    }
    return id;
  }

  /** The trace number of the solver's candidate `id` (-1 for none). */
  private sid(id: number): number {
    return id < 0 ? -1 : this.cid(this.s!.cands[id]!);
  }

  private emit(e: DistOmit<TraceEvent, "changes">): void {
    const s = this.s!;
    const changes: TraceChange[] = [];
    const placed = s.state.placed;
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i]!;
      const c = p >= 0 ? s.cands[p]! : null;
      if (c !== this.shadow[i]) {
        this.shadow[i] = c;
        changes.push([i, c === null ? -1 : this.cid(c)]);
      }
    }
    this.events.push({ ...e, changes } as TraceEvent);
  }

  phase(phase: TracePhase): void {
    this.emit({ type: "phase", phase });
  }

  /** The strategy that ran (`stats.strategy_used`). */
  setStrategy(strategy: string): void {
    this.strategy = strategy;
  }

  /**
   * Candidates of item `i` were generated: `fresh` all that were built, `kept` those no
   * placed label blocks, `flags` which of `kept` stayed (null: all, the lazy ladder
   * candidates), `lim` the pruning limit, `skipped` the positions rejected before they
   * were built.
   */
  generated(i: number, level: number, fresh: readonly Cand[], kept: readonly Cand[], flags: Uint8Array | null, lim: number, skipped: number): void {
    const keptAt = new Map<Cand, number>();
    kept.forEach((c, k) => keptAt.set(c, k));
    const cands: number[] = [];
    for (const c of fresh) {
      const k = keptAt.get(c);
      let fate: TraceFate = "kept";
      if (k === undefined) fate = "blocked";
      else if (flags !== null && flags[k] === 0) fate = c.feasible && c.cost > lim ? "pruned" : c.kind === Kind.Distant ? "k_distant" : "pruned";
      cands.push(this.cid(c, fate));
    }
    this.emit({ type: "generate", item: i, level, cands, skipped });
  }

  crowded(lacking: number, total: number): void {
    this.emit({ type: "crowded", lacking, total });
  }

  band(key: number, items: readonly number[]): void {
    this.emit({ type: "band", key, items: items.slice() });
  }

  pick(i: number, live: number, pass: "level0" | "ladder" | "ordered"): void {
    this.emit({ type: "pick", item: i, live, pass });
  }

  /**
   * The scored candidates of `bestLevel0`: solver ids and their static + dynamic cost, the
   * lookahead of the cheapest (`laIds`, `laVals`), and the choice.
   */
  scored(i: number, ids: readonly number[], totals: readonly number[], laIds: readonly number[] | null, laVals: readonly number[] | null, chosen: number | null): void {
    const s = this.s!;
    const options = ids.map((c, k) => {
      const cost = s.cands[c]!.cost;
      const q = laIds === null ? -1 : laIds.indexOf(c);
      return { cand: this.sid(c), cost, dynamic: totals[k]! - cost, lookahead: q >= 0 ? laVals![q]! : null };
    });
    this.emit({ type: "score", item: i, options, chosen: chosen === null ? null : this.sid(chosen) });
  }

  placed(i: number, c: number, killed: readonly number[]): void {
    this.emit({ type: "place", item: i, cand: this.sid(c), killed: killed.map((k) => this.sid(k)) });
  }

  deferred(i: number): void {
    this.emit({ type: "defer", item: i });
  }

  ladder(i: number, step: string, ids: readonly number[], chosen: number | null): void {
    this.emit({ type: "ladder", item: i, step, cands: ids.map((c) => this.sid(c)), chosen: chosen === null ? null : this.sid(chosen) });
  }

  evicted(i: number, items: readonly number[]): void {
    this.emit({ type: "evict", item: i, evicted: items.slice() });
  }

  omitted(i: number): void {
    const r = this.s!.reasons[i];
    this.emit({ type: "omit", item: i, reason: r === null || r === undefined ? "" : reasonName(r) });
  }

  anneal(iterations: number, t0: number, cost: number): void {
    this.emit({ type: "anneal", iterations, t0, cost });
  }

  /** A local-search iteration (solver candidate ids, -1 for none). */
  move(
    it: number,
    kind: TraceMoveKind,
    item: number,
    from: number,
    to: number,
    other: number,
    otherTo: number,
    blockers: number,
    delta: number | null,
    temp: number,
    outcome: TraceOutcome,
    idle: TraceIdle | null,
    cost: number,
    best: number,
  ): void {
    this.emit({
      type: "move",
      it,
      kind,
      item,
      from: this.sid(from),
      to: this.sid(to),
      other,
      otherTo: this.sid(otherTo),
      blockers,
      delta,
      temp,
      outcome,
      idle,
      cost,
      best,
    });
  }

  /** A pass after the search: an event when it changed the placement (or `always`). */
  pass(phase: TracePhase, what: string, items: readonly number[], kept = true, always = false): void {
    const s = this.s!;
    let changed = false;
    for (let i = 0; i < this.shadow.length && !changed; i++) {
      const p = s.state.placed[i]!;
      changed = (p >= 0 ? s.cands[p]! : null) !== this.shadow[i];
    }
    if (changed || always) this.emit({ type: "pass", phase, what, items: items.slice(), kept });
  }

  verified(v: Verification): void {
    this.emit({
      type: "verify",
      violations: v.hardViolations,
      crossings: v.leaderCrossings,
      inversions: v.priorityInversions,
      repaired: v.repaired.slice(),
    });
  }

  /** The trace, once the solve is complete. */
  finish(): SolveTrace {
    const s = this.s!;
    const model = s.model;
    const items: TraceItem[] = model.items.map((it, i) => {
      const p = s.pri.prio[i]!;
      const r = s.state.placed[i]! >= 0 ? null : s.reasons[i];
      return {
        id: it.id,
        text: labelText(it.label),
        shape: shapeJson(it.shape) as Record<string, unknown>,
        area: it.area === null ? null : (shapeJson(it.area.shape) as Record<string, unknown>),
        anchor: [it.anchor.x, it.anchor.y],
        key: p.key,
        rank: p.rank,
        score: p.score,
        tier: p.tier,
        required: p.required,
        models: modelNames(s.models[i]!),
        variants: s.variants[i]!.map((v) => ({
          level: v.level,
          steps: v.steps.slice(),
          w: v.w,
          h: v.h,
          text: v.text === null ? null : (textJson(v.text, it.font.family, it.font.weight) as Record<string, unknown>),
        })),
        reason: r === null || r === undefined ? null : reasonName(r),
      };
    });
    const candidates: TraceCandidate[] = this.objs.map((c, k) => {
      let breakdown: [string, number][] | null = null;
      if (c.evaluated) {
        const bd: Breakdown = [];
        s.evaluator.eval(c.clone(), s.variants[c.item]![c.variant]!, bd);
        breakdown = bd.map(([n, v]) => [n, v]);
      }
      return {
        item: c.item,
        variant: c.variant,
        level: c.level,
        model: kindName(c.kind),
        side: sideName(c.side),
        box: [c.rect.x0, c.rect.y0, c.rect.w(), c.rect.h()],
        leaders: c.leaders.map((l) => leaderJson(l, s) as Record<string, unknown>),
        cost: c.evaluated ? c.cost : null,
        feasible: c.evaluated ? c.feasible : null,
        blocked: c.evaluated && !c.feasible && c.blocked !== null ? blockName(s, c.blocked) : null,
        warm: c.warm,
        fate: this.fates[k]!,
        breakdown,
      };
    });
    return {
      items,
      candidates,
      events: this.events,
      classes: s.obs.classes.map((c) => c.name),
      iterations: this.iterations,
      strategy: this.strategy,
    };
  }
}
