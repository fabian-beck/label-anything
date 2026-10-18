/**
 * What each step of a trace means, in words: a title and a short explanation built from
 * the numbers of the event (costs, counts, temperatures) and the names of the items.
 */
import type { TraceCandidate, TraceEvent } from "@label-anything/core";
import { type Explained, type Move, candText } from "./model.js";

export interface Narration {
  title: string;
  /** HTML (names are escaped). */
  html: string;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const fmtCost = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? "–" : (Math.abs(v) < 0.005 ? 0 : v).toFixed(2));
const fmtInt = (n: number): string => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`): string => `${fmtInt(n)} ${n === 1 ? one : many}`;

const DIRS = ["right", "bottom-right", "bottom", "bottom-left", "left", "top-left", "top", "top-right"];
const ARROWS = ["→", "↘", "↓", "↙", "←", "↖", "↑", "↗"];

/** The direction from an item's anchor to the center of a candidate box (index into `DIRS`). */
function direction(ex: Explained, c: TraceCandidate): number {
  const a = ex.trace.items[c.item]!.anchor;
  const dx = c.box[0] + c.box[2] / 2 - a[0];
  const dy = c.box[1] + c.box[3] / 2 - a[1];
  const ang = Math.atan2(dy, dx);
  return ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
}

/** A short name of a candidate's position: `top-right`, `near top (slider)`, `leader ↗`, `inside`. */
export function where(ex: Explained, cid: number): string {
  const c = ex.trace.candidates[cid]!;
  switch (c.model) {
    case "adjacent":
      return c.side;
    case "slider":
      return `near ${c.side}`;
    case "internal":
      return "inside";
    case "distant":
      return `leader ${ARROWS[direction(ex, c)]}`;
    case "boundary":
      return "in the margin";
    case "fan":
      return `fan ${ARROWS[direction(ex, c)]}`;
    default:
      return c.model;
  }
}

/** A longer description: `top-right of its mark`, `away from it on a leader to the bottom-left`. */
function whereLong(ex: Explained, cid: number): string {
  const c = ex.trace.candidates[cid]!;
  switch (c.model) {
    case "adjacent":
      return `at the ${c.side}`;
    case "slider":
      return `beside its mark, slid toward the ${c.side}`;
    case "internal":
      return "inside its area";
    case "distant":
      return `away from its mark, with a leader to the ${DIRS[direction(ex, c)]}`;
    case "boundary":
      return "in a column in the margin, with a leader";
    case "fan":
      return "in a fan column, with a leader";
    default:
      return c.model;
  }
}

function name(ex: Explained, i: number): string {
  return `<b>${esc(ex.trace.items[i]!.text)}</b>`;
}

function names(ex: Explained, items: readonly number[], max = 6): string {
  const shown = items.slice(0, max).map((i) => name(ex, i));
  if (items.length > max) shown.push(`${items.length - max} more`);
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

export const STEP_TEXT: Record<string, string> = {
  alternatives: "the label's shorter alternative texts",
  wrap: "the text on two or three balanced lines",
  truncate: "the text truncated",
  distant: "positions away from the mark, with a leader",
  boundary: "positions in the canvas margins, with a leader",
  evict_lower: "removing labels of strictly less important items that are in the way",
  soft_overlap: "the hard rules of relaxable classes as costs",
  omit: "giving up",
};

function stepText(step: string): string {
  if (step.startsWith("shrink:")) return `the font scaled by ${step.slice(7)}`;
  return STEP_TEXT[step] ?? step;
}

const REASONS: Record<string, string> = {
  omitted_by_priority: "every position it could take is held by labels at least as important",
  no_feasible_candidate: "none of its candidates satisfies the hard rules",
  budget_exhausted: "the time guard stopped the greedy pass",
  keep_with: "its keep_with set could not be placed together",
  grouped: "a group label covers it",
};

const IDLE: Record<string, string> = {
  unlabeled: "which has no label to relocate",
  single: "which has a single candidate",
  same: "with its current candidate (or one it may not use)",
  labeled: "for an insertion, but it has a label already",
  excluded: "for an insertion, but it belongs to a set or group",
  cap: "for an insertion, but the label cap is reached",
  known: "for an insertion that failed before, and nothing has changed since",
};

/** The narration of event `k`. */
export function narrate(ex: Explained, k: number): Narration {
  const e = ex.event(k);
  const tr = ex.trace;
  const n = tr.items.length;
  switch (e.type) {
    case "phase":
      return phaseIntro(ex, k, e.phase);
    case "generate": {
      const cs = e.cands.map((c) => tr.candidates[c]!);
      const kept = cs.filter((c) => c.fate === "kept");
      const usable = kept.filter((c) => c.feasible === true);
      const bad = kept.filter((c) => c.feasible === false);
      const pruned = cs.filter((c) => c.fate === "pruned" || c.fate === "k_distant").length;
      const blocked = cs.filter((c) => c.fate === "blocked").length;
      let best = -1;
      for (const c of e.cands) {
        const t = tr.candidates[c]!;
        if (t.fate === "kept" && t.feasible && (best < 0 || (t.cost ?? Infinity) < (tr.candidates[best]!.cost ?? Infinity))) best = c;
      }
      const models = [...new Set(cs.map((c) => c.model))];
      const during = ex.groupAt(k).id !== "candidates";
      // ladder candidates are evaluated lazily, once they are free
      const lazy = kept.length > 0 && kept.every((c) => c.cost === null);
      const parts: string[] = [];
      if (during) {
        const step = stepOfLevel(ex, k, e.item);
        parts.push(
          e.level === 0
            ? `${name(ex, e.item)} gets its distant candidates now, on demand: nothing beside its mark is cheaper than a leader could be. `
            : `New candidates for ${name(ex, e.item)} from ladder step ${e.level}${step ? ` (<i>${esc(step)}</i>)` : ""}. `,
        );
      }
      if (cs.length === 0) parts.push("None came out of it.");
      else {
        parts.push(`${plural(cs.length, "candidate")} (${models.join(", ")})`);
        const bits: string[] = [];
        if (lazy) bits.push(`${fmtInt(kept.length)} to be evaluated once one of them is free`);
        else if (kept.length > 0) {
          bits.push(`${fmtInt(usable.length)} usable`);
          if (bad.length) bits.push(`${fmtInt(bad.length)} break a hard rule (${[...new Set(bad.map((c) => blockedName(c.blocked)))].join(", ")})`);
        }
        if (pruned) bits.push(`${fmtInt(pruned)} dropped for costing far more than the best`);
        if (blocked) bits.push(`${blocked === cs.length ? "all" : fmtInt(blocked)} blocked by labels already placed`);
        parts.push(`: ${bits.join(", ")}.`);
      }
      if (e.skipped > 0) {
        parts.push(` ${plural(e.skipped, "more position")} would cover a mark${during ? " or a placed label" : ""}: the occupancy grid ruled ${e.skipped === 1 ? "it" : "them"} out before building ${e.skipped === 1 ? "it" : "them"}.`);
      }
      if (best >= 0 && !lazy) parts.push(` The cheapest is ${esc(where(ex, best))} at ${fmtCost(tr.candidates[best]!.cost)}.`);
      return { title: during ? `More candidates: ${esc(tr.items[e.item]!.text)}` : `Candidates of ${esc(tr.items[e.item]!.text)}`, html: `<p>${parts.join("")}</p>` };
    }
    case "crowded":
      return {
        title: "Crowded: distant labels on",
        html: `<p>${fmtInt(e.lacking)} of ${fmtInt(e.total)} items have no free position beside their mark — more than the preset allows — so distant candidates with leaders are added for everyone.</p>`,
      };
    case "band": {
      const b = ex.bandOf[e.items[0]!]! + 1;
      return {
        title: `Band ${b} of ${ex.bands}`,
        html:
          `<p>${ex.bands > 1 ? `The next ${plural(e.items.length, "item")} of equal priority` : `All ${plural(e.items.length, "item")} have the same priority and`} form a band: ${names(ex, e.items, 8)}.</p>` +
          (ex.bands > 1
            ? `<p>Bands go in priority order, so no label of a less important item exists yet: it cannot take a place a more important one needs.</p>`
            : `<p>Inside a band the order is free: the greedy pass uses that to place the hardest items first.</p>`),
      };
    }
    case "pick": {
      const it = name(ex, e.item);
      if (e.pass === "ladder") {
        return {
          title: `Ladder: ${esc(tr.items[e.item]!.text)}`,
          html: `<p>${it} found no free position at its own size and was deferred. Now that the band's other items are placed, the <i>degradation ladder</i> tries, in order: ${ladderList(ex)}.</p>`,
        };
      }
      if (e.pass === "ordered") return { title: `Next: ${esc(tr.items[e.item]!.text)}`, html: `<p>${it} is next in priority order.</p>` };
      const usable = ex.liveAt(e.item, 0).length;
      const out = usable - e.live;
      let html: string;
      if (e.live > 0) {
        html = `<p>${it} has ${plural(e.live, "free candidate")} left — the fewest of the items still waiting in this band, so it goes first (<i>most constrained first</i>).${out > 0 ? ` Labels placed earlier have ruled out ${fmtInt(out)} more (crossed out).` : ""}</p>`;
      } else if (usable === 0) {
        html = `<p>${it} has no usable candidate beside its mark at all: each one would cover another mark or leave the label area. Items with the fewest free candidates go first, so it is taken now — and deferred.</p>`;
      } else {
        html = `<p>${it} has no free candidate left: the labels placed so far have ruled out all ${fmtInt(usable)} (crossed out). Items with the fewest free candidates go first, so it is taken now — and deferred.</p>`;
      }
      return { title: `Next: ${esc(tr.items[e.item]!.text)}`, html };
    }
    case "score": {
      if (e.options.length === 0 || e.chosen === null) {
        return { title: "No free candidate", html: `<p>None of ${name(ex, e.item)}'s candidates at its own size is free of the labels placed so far.</p>` };
      }
      const ch = e.options.find((o) => o.cand === e.chosen)!;
      const total = ch.cost + ch.dynamic + (ch.lookahead ?? 0);
      const contenders = e.options.filter((o) => o.lookahead !== null);
      const la = contenders.length > 0;
      let html = `<p>${plural(e.options.length, "free candidate")}, each with its <i>static</i> cost (what it covers, its distance and position rank, its leader) and its cost against the labels already placed.</p>`;
      html += la
        ? `<p>The ${contenders.length === e.options.length ? (contenders.length === 1 ? "only one" : `${fmtInt(contenders.length)}`) : `${fmtInt(contenders.length)} cheapest`} also get a <i>lookahead</i> cost: the share of candidates ${contenders.length === 1 ? "it" : "each"} would take from items still waiting. The lowest total wins: ${esc(where(ex, e.chosen))}, ${fmtCost(ch.cost)} + ${fmtCost(ch.dynamic)} + ${fmtCost(ch.lookahead)} = <b>${fmtCost(total)}</b>.</p>`
        : `<p>The cheapest wins: ${esc(where(ex, e.chosen))}, ${fmtCost(ch.cost)} + ${fmtCost(ch.dynamic)} = <b>${fmtCost(total)}</b>.</p>`;
      const cheapest = (la ? contenders : e.options).reduce((a, b) => (a.cost + a.dynamic <= b.cost + b.dynamic ? a : b));
      if (la && cheapest.cand !== e.chosen) {
        html += `<p>${esc(where(ex, cheapest.cand))} is cheaper by itself (${fmtCost(cheapest.cost + cheapest.dynamic)}) but would take more from waiting items (${fmtCost(cheapest.lookahead)}): the lookahead tips the choice.</p>`;
      }
      return { title: `Scoring ${esc(tr.items[e.item]!.text)}`, html };
    }
    case "place": {
      const c = tr.candidates[e.cand]!;
      const v = tr.items[e.item]!.variants[c.variant]!;
      const items = new Set(e.killed.map((x) => tr.candidates[x]!.item));
      let html = `<p>${name(ex, e.item)} is placed ${esc(whereLong(ex, e.cand))}`;
      if (v.level > 0) html += `, as “${esc(candText(tr, e.cand))}” (${esc(v.steps.join(", "))})`;
      html += ".</p>";
      html +=
        e.killed.length > 0
          ? `<p>The label rules out ${plural(e.killed.length, "candidate")} of ${plural(items.size, "waiting item")} (crossed out): ${names(ex, [...items])} now ${items.size === 1 ? "has" : "have"} fewer choices.</p>`
          : `<p>It takes nothing away from items still waiting.</p>`;
      return { title: `Placed: ${esc(candText(tr, e.cand))}`, html };
    }
    case "defer":
      return {
        title: `Deferred: ${esc(tr.items[e.item]!.text)}`,
        html: `<p>No candidate of ${name(ex, e.item)} at its own size is free. It waits for the <i>ladder pass</i> at the end of its band, when the band's other items have their labels.</p>`,
      };
    case "ladder": {
      const it = name(ex, e.item);
      const what = stepText(e.step);
      if (e.step === "evict_lower") {
        return {
          title: `Ladder step: evict_lower`,
          html: e.chosen !== null ? `<p>${it} takes ${esc(where(ex, e.chosen))} by removing less important labels from it.</p>` : `<p>No position of ${it} is held only by less important labels.</p>`,
        };
      }
      const fresh = e.cands.length;
      // the candidates the step generated, before the placed labels filtered them
      const prev = ex.event(k - 1);
      const gen = prev.type === "generate" && prev.item === e.item && prev.level > 0 ? prev : null;
      let none: string;
      if (fresh > 0) none = "None of them is free";
      else if (e.step === "soft_overlap") none = "No candidate becomes free when the relaxable classes turn soft";
      else if (gen && gen.cands.length > 0) none = `Labels already placed block all ${plural(gen.cands.length, "candidate")} it made`;
      else none = EMPTY_STEP[e.step.split(":")[0]!] ?? "Nothing new to try";
      return {
        title: `Ladder step: ${esc(e.step)}`,
        html:
          `<p>Step <i>${esc(e.step)}</i> tries ${what}${fresh > 0 ? `: ${plural(fresh, "new candidate")}` : ""}.</p>` +
          (e.chosen !== null
            ? `<p>The cheapest free one is ${esc(where(ex, e.chosen))}${tr.candidates[e.chosen]!.cost !== null ? ` (cost ${fmtCost(tr.candidates[e.chosen]!.cost)}, including the penalty of the step)` : ""}.</p>`
            : `<p>${none}: on to the next step.</p>`),
      };
    }
    case "evict":
      return {
        title: "Eviction",
        html: `<p>${names(ex, e.evicted)} ${e.evicted.length === 1 ? "is" : "are"} less important than ${name(ex, e.item)} and ${e.evicted.length === 1 ? "loses its label" : "lose their labels"}; they go back into the queue of their band.</p>`,
      };
    case "omit":
      return {
        title: `No label: ${esc(tr.items[e.item]!.text)}`,
        html: `<p>${name(ex, e.item)} gets no label for now: ${REASONS[e.reason] ?? esc(e.reason)}. The result reports why, and later passes may still find it a place.</p>`,
      };
    case "anneal":
      return {
        title: "Start of the search",
        html: `<p>The greedy placement costs <b>${fmtCost(e.cost)}</b> in all. The temperature starts at T₀ = ${e.t0.toPrecision(3)} — the median cost increase of 50 random probe moves — and falls geometrically to T₀/1000 over ${plural(e.iterations, "move")}.</p>`,
      };
    case "move":
      return narrateMove(ex, e);
    case "pass":
      return narratePass(ex, e);
    case "verify": {
      const placed = ex.placementAt(k).filter((c) => c >= 0).length;
      const ok = e.violations === 0 && e.crossings === 0 && e.inversions === 0;
      return {
        title: ok ? "Verified" : "Verified, with repairs",
        html:
          `<p>Every hard rule is checked again, exactly, against the final placement: <b>${fmtInt(e.violations)}</b> violations, <b>${fmtInt(e.crossings)}</b> crossing leaders, <b>${fmtInt(e.inversions)}</b> priority inversions.</p>` +
          `<p>${fmtInt(placed)} of ${plural(n, "item")} labeled; total cost ${fmtCost(ex.result.stats.total_cost)}.${placed < n ? " Hover an item without a label to see why." : ""}</p>`,
      };
    }
  }
}

/** Why a ladder step made no candidates at all. */
const EMPTY_STEP: Record<string, string> = {
  alternatives: "The label has no alternative text",
  wrap: "The text cannot be wrapped into a narrower label",
  truncate: "The label may not be truncated",
  distant: "Its distant candidates exist already, and none of them is free",
  boundary: "Its boundary candidates exist already, and none of them is free",
  shrink: "The font cannot shrink further",
};

/** The ladder step whose candidates the `generate` event `k` of `item` made (the next ladder event of the item). */
function stepOfLevel(ex: Explained, k: number, item: number): string | null {
  for (let t = k + 1; t < ex.length; t++) {
    const e = ex.event(t);
    if (e.type === "ladder" && e.item === item) return e.step;
    if (e.type === "pick" || e.type === "phase") return null;
  }
  return null;
}

function blockedName(b: string | null): string {
  switch (b) {
    case "canvas_edge":
      return "outside the label area";
    case "items":
      return "over a mark";
    case null:
      return "hard rule";
    default:
      return `over ${b}`;
  }
}

function ladderList(ex: Explained): string {
  const steps: string[] = [];
  for (const e of ex.trace.events) if (e.type === "ladder" && !steps.includes(e.step)) steps.push(e.step);
  return steps.length ? steps.map((s) => `<i>${esc(s)}</i>`).join(", ") : "its steps";
}

function phaseIntro(ex: Explained, k: number, phase: string): Narration {
  const tr = ex.trace;
  const n = tr.items.length;
  const g = ex.groupAt(k);
  const events = tr.events.slice(g.start, g.end);
  switch (phase) {
    case "prepare": {
      const sizes = new Array<number>(ex.bands).fill(0);
      for (const b of ex.bandOf) sizes[b]! += 1;
      return {
        title: "The problem",
        html:
          `<p>${plural(n, "item")} to label. The engine first measures every label with its font and resolves each item's mark and options.</p>` +
          `<p>Then it ranks the items by priority. Items of equal priority form a <i>band</i>; ${ex.bands === 1 ? "here all items form one band." : `here ${ex.bands} bands of ${sizes.map(fmtInt).join(", ")} items, most important first (the marks' colors).`}</p>`,
      };
    }
    case "candidates":
      return {
        title: "Candidate positions",
        html: `<p>The engine does not push labels around. It generates <i>candidate</i> positions for each label — beside the mark, slid along it, inside an area, or away on a leader — and computes what each would cost: the marks and obstacles it covers, its distance from the mark, how good its position is, the leader it needs.</p><p>Candidates that break a hard rule by themselves (off the canvas, over a mark) cannot be used.</p>`,
      };
    case "greedy":
      return {
        title: "Greedy placement",
        html: `<p>Items are placed one at a time, band by band in priority order. Within a band the most constrained item goes first: the one with the fewest free candidates left. It takes its cheapest free candidate — counting what that would take away from the items still waiting.</p><p>An item with nothing free waits for the <i>ladder</i>: shorter texts, wrapping, leaders, eviction of less important labels, a smaller font — or no label.</p>`,
      };
    case "local": {
      const a = events.find((e): e is Extract<TraceEvent, { type: "anneal" }> => e.type === "anneal");
      return {
        title: "Local search",
        html: a
          ? `<p>The greedy result is good but short-sighted. ${plural(a.iterations, "random move")} improve it: <i>relocate</i> a label to another candidate, <i>swap</i> it with the one label in the way, or <i>insert</i> an item without a label by moving the labels that block it.</p><p>Better moves are always accepted, worse ones with probability e<sup>−Δ/T</sup> (simulated annealing); the temperature T falls as the search goes on. No move breaks a hard rule or the priority order. The number of moves comes from the time budget — the same on every machine.</p>`
          : "<p>No moves to make.</p>",
      };
    }
    case "exact":
      return {
        title: "Exact search",
        html: `<p>The problem is small and the budget large: a branch and bound over the 24 cheapest candidates of each item looks for the best placement and proves it optimal when it finishes.</p>`,
      };
    case "fan":
      return {
        title: "Fan labels",
        html: `<p>Where anchors crowd and items are left without a label, the crowd's labels can be stacked in a column beside it, each with a leader fanning out of the crowd.</p>${events.some((e) => e.type === "pass") ? "" : "<p>No crowd needed a column here.</p>"}`,
      };
    case "boundary":
      return {
        title: "Boundary columns",
        html: `<p>Labels in columns in the canvas margins are restacked jointly, and items still without a label join a column where it stays feasible.</p>${events.some((e) => e.type === "pass") ? "" : "<p>No boundary labels in this problem.</p>"}`,
      };
    case "uncross":
      return {
        title: "Uncrossing leaders",
        html: `<p>When crossing leaders are only a cost, crossing pairs swap label positions where that shortens the leaders.</p>${events.some((e) => e.type === "pass") ? "" : "<p>Crossings are forbidden here (the default), so there are none to undo.</p>"}`,
      };
    case "repair":
      return {
        title: "Priority repair",
        html: `<p>An item without a label that could take a position held only by less important labels takes it, so that no label is missing in favour of a less important one.</p>${events.some((e) => e.type === "pass") ? "" : "<p>Nothing to repair.</p>"}`,
      };
    case "verify":
      return { title: "Verification", html: "<p>Finally, an independent pass checks the result.</p>" };
    default:
      return { title: phase, html: "" };
  }
}

function narrateMove(ex: Explained, e: Move): Narration {
  const tr = ex.trace;
  const it = `Move ${fmtInt(e.it + 1)} of ${fmtInt(ex.moves.length)}`;
  const nm = e.item >= 0 ? name(ex, e.item) : "an item";
  const p = e.delta !== null && e.delta > 0 ? Math.exp(-e.delta / e.temp) : 1;
  const pct = (v: number) => (v >= 0.995 ? "≈100%" : v < 0.0005 ? "<0.1%" : v < 0.1 ? `${(v * 100).toFixed(1)}%` : `${Math.round(v * 100)}%`);
  const dl = (d: number | null) => (d === null ? "–" : `${d > 0 ? "+" : d < 0 ? "−" : "±"}${fmtCost(Math.abs(d))}`);
  const temp = `T = ${e.temp.toPrecision(2)}`;
  let html: string;
  switch (e.outcome) {
    case "idle":
      html = `<p>Drew ${nm} ${IDLE[e.idle ?? ""] ?? ""}: no move. Such draws still count toward the budget.</p>`;
      break;
    case "improved":
    case "accepted":
    case "rejected": {
      const what =
        e.kind === "swap"
          ? `<p>${nm} would move from ${esc(where(ex, e.from))} to ${esc(where(ex, e.to))}, where only ${name(ex, e.other)}'s label is in the way: that one moves to its best free candidate, ${esc(where(ex, e.otherTo))} (a <i>swap</i>).</p>`
          : `<p><i>Relocate</i> ${nm} from ${esc(where(ex, e.from))} to ${esc(where(ex, e.to))}.</p>`;
      const verdict =
        e.outcome === "improved"
          ? `The cost changes by <b>${dl(e.delta)}</b>: accepted, as every improvement is.`
          : e.outcome === "accepted"
            ? `The cost rises by <b>${dl(e.delta)}</b>; at ${temp} that is accepted with probability e<sup>−Δ/T</sup> = ${pct(p)} — and it was. Such moves let the search escape local optima.`
            : `The cost would rise by <b>${dl(e.delta)}</b>; at ${temp} the chance to accept that is ${pct(p)}: rejected.`;
      html = `${what}<p>${verdict}</p>`;
      break;
    }
    case "blocked":
      html = `<p><i>Relocate</i> ${nm} to ${esc(where(ex, e.to))}? ${plural(e.blockers, "label")} ${e.blockers === 1 ? "is" : "are"} in the way: no move${e.blockers === 1 ? " (half of such draws try a swap instead)" : ""}.</p>`;
      break;
    case "no_room":
      html = `<p><i>Swap</i>: ${nm} would take ${esc(where(ex, e.to))}, but ${name(ex, e.other)}, whose label is in the way, has no other free candidate: no move.</p>`;
      break;
    case "inserted": {
      const moved = e.changes.filter(([i, c]) => i !== e.item && c >= 0).map(([i]) => i);
      const removed = e.changes.filter(([i, c]) => i !== e.item && c < 0).map(([i]) => i);
      html = `<p><i>Insert</i>: ${nm} had no label and now has one, ${esc(where(ex, e.to))}.`;
      if (moved.length) html += ` To make room, ${names(ex, moved)} moved (an <i>ejection chain</i>).`;
      if (removed.length) html += ` ${names(ex, removed)}, less important, lost ${removed.length === 1 ? "its label" : "their labels"}.`;
      html += " More labels outrank any cost: the search continues from here.</p>";
      break;
    }
    case "not_inserted":
      html = `<p><i>Insert</i> ${nm}? None of its cheapest candidates can be freed by moving at most two labels (chains up to three deep), nor by removing less important ones.</p>`;
      break;
  }
  html += `<p class="sub">Total cost ${fmtCost(e.cost)} · best so far ${fmtCost(e.best)} · ${temp}</p>`;
  const kinds: Record<string, string> = { none: "Draw", relocate: "Relocate", swap: "Swap", insert: "Insert" };
  return { title: `${it}: ${kinds[e.kind]} ${e.item >= 0 ? esc(tr.items[e.item]!.text) : ""}`.trim(), html };
}

function narratePass(ex: Explained, e: Extract<TraceEvent, { type: "pass" }>): Narration {
  switch (e.what) {
    case "restore": {
      const best = [...ex.trace.events].reverse().find((x): x is Move => x.type === "move");
      return {
        title: "Best placement restored",
        html: `<p>The walk ended above the best placement it saw, so that one is restored (cost ${fmtCost(best?.best)}).</p>`,
      };
    }
    case "exact":
      return { title: "Exact search result", html: `<p>The branch and bound found a better placement and applied it.</p>` };
    case "fan":
      return {
        title: e.kept ? "A fan column" : "A fan column, undone",
        html: e.kept
          ? `<p>The crowd of ${names(ex, e.items)} gets a column of labels with fanning leaders: it labels more items than before.</p>`
          : `<p>A column for ${names(ex, e.items)} was tried and undone: it would let a less important label keep a more important one out.</p>`,
      };
    case "boundary":
      return { title: "Column restacked", html: `<p>The margin column of ${names(ex, e.items)} is stacked again jointly, at a lower cost.</p>` };
    case "fill":
      return { title: "Column filled", html: `<p>An item without a label joins the margin column: ${names(ex, e.items)}.</p>` };
    case "uncross":
      return { title: "Leaders uncrossed", html: `<p>${names(ex, e.items)} swap positions so that their leaders no longer cross.</p>` };
    case "repair":
      return {
        title: "Priority repaired",
        html: `<p>${name(ex, e.items[0]!)} takes a position held only by less important labels${e.items.length > 1 ? ` (${names(ex, e.items.slice(1))}, tried again in their turn)` : ""}.</p>`,
      };
    default:
      return { title: e.what, html: "" };
  }
}
