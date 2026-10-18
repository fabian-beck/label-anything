/**
 * The explainer's view of a solve trace (`placeTraced` of `@label-anything/core`): its
 * events grouped into the phases the page shows, the placement after any event (replayed
 * from the events' changes, with checkpoints), when each candidate was generated and ruled
 * out, and the events that concern each item. Nothing here decides anything: every number
 * comes from the trace.
 */
import type { LabelResult, SolveTrace, TraceEvent, TracePhase } from "@label-anything/core";

export type GroupId = "prepare" | "candidates" | "greedy" | "search" | "repairs" | "verify";

export interface Group {
  id: GroupId;
  title: string;
  phases: readonly TracePhase[];
  /** Events `[start, end)` of the group. */
  start: number;
  end: number;
}

export const GROUP_DEFS: { id: GroupId; title: string; phases: TracePhase[] }[] = [
  { id: "prepare", title: "Prepare", phases: ["prepare"] },
  { id: "candidates", title: "Candidates", phases: ["candidates"] },
  { id: "greedy", title: "Greedy", phases: ["greedy"] },
  { id: "search", title: "Local search", phases: ["local", "exact"] },
  { id: "repairs", title: "Repairs", phases: ["fan", "boundary", "uncross", "repair"] },
  { id: "verify", title: "Verify", phases: ["verify"] },
];

const CHECKPOINT = 256;
const NEVER = 0x7fffffff;

export type Move = Extract<TraceEvent, { type: "move" }>;

export class Explained {
  readonly groups: Group[];
  /** The phase of each event. */
  readonly phaseOf: TracePhase[];
  /** The event that generated each candidate (-1: none, e.g. a fan or uncross candidate). */
  readonly genAt: Int32Array;
  /** The event whose placement ruled each level-0 candidate out (NEVER: none). */
  readonly killedAt: Int32Array;
  /** The item whose placement ruled each candidate out (-1: none). */
  readonly killedBy: Int32Array;
  /** Events that concern each item (its own events, and those that change its label). */
  readonly itemEvents: number[][];
  /** Candidates of each item, in trace order. */
  readonly candsOf: number[][];
  /** The band (0-based) of each item and the number of bands. */
  readonly bandOf: number[];
  readonly bands: number;
  /** Event indices of the local-search moves (in iteration order). */
  readonly moves: number[];
  private checkpoints: Int32Array[] = [];
  /** The last replayed state, for cheap stepping forward. */
  private cursor = -1;
  private state: Int32Array;

  constructor(
    readonly trace: SolveTrace,
    readonly result: LabelResult,
  ) {
    const n = trace.items.length;
    const ev = trace.events;
    this.phaseOf = [];
    let phase: TracePhase = "prepare";
    for (const e of ev) {
      if (e.type === "phase") phase = e.phase;
      this.phaseOf.push(phase);
    }
    this.groups = [];
    for (const g of GROUP_DEFS) {
      let start = -1;
      let end = -1;
      this.phaseOf.forEach((p, k) => {
        if (!g.phases.includes(p)) return;
        if (start < 0) start = k;
        end = k + 1;
      });
      if (start >= 0) this.groups.push({ ...g, start, end });
    }
    const nc = trace.candidates.length;
    this.genAt = new Int32Array(nc).fill(-1);
    this.killedAt = new Int32Array(nc).fill(NEVER);
    this.killedBy = new Int32Array(nc).fill(-1);
    this.itemEvents = Array.from({ length: n }, () => []);
    this.candsOf = Array.from({ length: n }, () => []);
    trace.candidates.forEach((c, k) => this.candsOf[c.item]!.push(k));
    this.moves = [];
    ev.forEach((e, k) => {
      const touched = new Set<number>();
      for (const [i] of e.changes) touched.add(i);
      switch (e.type) {
        case "generate":
          for (const c of e.cands) if (this.genAt[c]! < 0) this.genAt[c] = k;
          touched.add(e.item);
          break;
        case "place":
          for (const c of e.killed) {
            if (this.killedAt[c] === NEVER) {
              this.killedAt[c] = k;
              this.killedBy[c] = e.item;
            }
          }
          touched.add(e.item);
          break;
        case "move":
          this.moves.push(k);
          if (e.item >= 0 && e.outcome !== "idle") touched.add(e.item);
          if (e.other >= 0) touched.add(e.other);
          break;
        case "pick":
        case "score":
        case "defer":
        case "ladder":
        case "omit":
          touched.add(e.item);
          break;
        case "evict":
          touched.add(e.item);
          for (const j of e.evicted) touched.add(j);
          break;
        case "pass":
          for (const j of e.items) touched.add(j);
          break;
        default:
          break;
      }
      for (const i of touched) this.itemEvents[i]!.push(k);
    });
    const keys = [...new Set(trace.items.map((it) => it.key))].sort((a, b) => a - b);
    this.bandOf = trace.items.map((it) => keys.indexOf(it.key));
    this.bands = keys.length;
    // checkpoints: the placement after events CHECKPOINT·m - 1
    const placed = new Int32Array(n).fill(-1);
    ev.forEach((e, k) => {
      if (k % CHECKPOINT === 0) this.checkpoints.push(placed.slice());
      for (const [i, c] of e.changes) placed[i] = c;
    });
    this.state = new Int32Array(n).fill(-1);
  }

  get length(): number {
    return this.trace.events.length;
  }

  event(k: number): TraceEvent {
    return this.trace.events[k]!;
  }

  groupAt(k: number): Group {
    for (const g of this.groups) if (k >= g.start && k < g.end) return g;
    return this.groups[this.groups.length - 1]!;
  }

  group(id: GroupId): Group | undefined {
    return this.groups.find((g) => g.id === id);
  }

  /** The placed candidate of every item after event `k` (-1: no label). Do not keep the array. */
  placementAt(k: number): Int32Array {
    const ev = this.trace.events;
    k = Math.max(0, Math.min(ev.length - 1, k));
    if (k < this.cursor || this.cursor < 0 || k - this.cursor > CHECKPOINT) {
      const m = Math.floor(k / CHECKPOINT);
      this.state.set(this.checkpoints[m]!);
      this.cursor = m * CHECKPOINT - 1;
    }
    for (let t = this.cursor + 1; t <= k; t++) for (const [i, c] of ev[t]!.changes) this.state[i] = c;
    this.cursor = k;
    return this.state;
  }

  /** Whether candidate `c` is still free of placed labels before event `k` (the greedy pass's live candidates). */
  aliveAt(c: number, k: number): boolean {
    return this.killedAt[c]! >= k;
  }

  /**
   * The level-0 candidates of item `i` the greedy pass counts as live just before event
   * `k`: generated in the candidates phase, kept, statically feasible, not yet ruled out.
   */
  liveAt(i: number, k: number): number[] {
    const cand = this.group("candidates");
    const end = cand ? cand.end : 0;
    return this.candsOf[i]!.filter((c) => {
      const t = this.trace.candidates[c]!;
      const g = this.genAt[c]!;
      return g >= 0 && g < end && t.fate === "kept" && t.feasible === true && this.killedAt[c]! >= k;
    });
  }

  /** The candidates of item `i` generated up to event `k`. */
  generatedBy(i: number, k: number): number[] {
    return this.candsOf[i]!.filter((c) => {
      const g = this.genAt[c]!;
      return g >= 0 && g <= k;
    });
  }

  /** The total cost after each local-search move (for the chart), and the temperatures. */
  searchSeries(): { cost: Float64Array; best: Float64Array; temp: Float64Array; accepted: Uint8Array } {
    const m = this.moves.length;
    const cost = new Float64Array(m);
    const best = new Float64Array(m);
    const temp = new Float64Array(m);
    const accepted = new Uint8Array(m);
    this.moves.forEach((k, j) => {
      const e = this.trace.events[k] as Move;
      cost[j] = e.cost;
      best[j] = e.best;
      temp[j] = e.temp;
      accepted[j] = e.outcome === "improved" || e.outcome === "accepted" || e.outcome === "inserted" ? 1 : 0;
    });
    return { cost, best, temp, accepted };
  }

  /**
   * The next (`dir` 1) or previous (-1) "decision" from event `k`: a placement, an omission
   * or a ladder step in the greedy pass, a move that changed the placement in the search,
   * any event elsewhere.
   */
  nextMajor(k: number, dir: 1 | -1): number {
    const ev = this.trace.events;
    for (let t = k + dir; t >= 0 && t < ev.length; t += dir) {
      const e = ev[t]!;
      if (e.type === "phase") return t;
      const g = this.groupAt(t).id;
      if (g === "search") {
        if (e.type !== "move" || e.changes.length > 0) return t;
      } else if (g === "greedy" || g === "candidates") {
        if (e.type === "pick" || e.type === "generate" || e.type === "band") return t;
      } else return t;
    }
    return dir > 0 ? ev.length - 1 : 0;
  }
}

/** The label text of an item and its candidate's variant (alternatives and wraps differ). */
export function candText(trace: SolveTrace, c: number): string {
  const t = trace.candidates[c]!;
  const v = trace.items[t.item]!.variants[t.variant];
  const lines = (v?.text as { lines?: string[] } | null)?.lines;
  return lines ? lines.join(" ") : trace.items[t.item]!.text;
}
