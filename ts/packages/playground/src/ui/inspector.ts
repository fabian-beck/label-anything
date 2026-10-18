/**
 * The Inspect tab: the selected (or hovered) label with what the engine reports about it
 * — model, side, cost, priority, why an item has no label and which labels are in its way —
 * and the statistics of the solves: counts, verification, phases, time and movement.
 */
import type { App } from "../app.js";
import { ENGINE_NAMES, samePlacements } from "../engines.js";
import { MODEL_COLORS } from "../render.js";
import { fmt, type Obj } from "../util.js";
import { h, svgEl } from "./dom.js";

const REASONS: Record<string, string> = {
  no_feasible_candidate: "no position is free of hard obstacles",
  omitted_by_priority: "every free position collides with more important labels",
  budget_exhausted: "the label budget or the time guard ran out",
  label_budget: "the label budget (max_labels) is used up",
  ink_budget: "the ink budget (max_ink_fraction) is used up",
  keep_with: "a member of its keep_with set has no label",
  group_member: "its group is labeled by another member",
};

const PHASE_COLORS: Record<string, string> = {
  prepare: "#8a93a3",
  candidates: "#00897b",
  greedy: "#3949ab",
  local: "#7b1fa2",
  exact: "#c2185b",
  verify: "#ef6c00",
};

export class Inspector {
  #root: HTMLElement;
  #app: App;
  #parity: HTMLElement = h("div", { class: "parity" });

  constructor(root: HTMLElement, app: App) {
    this.#root = root;
    this.#app = app;
  }

  update(): void {
    const app = this.#app;
    const r = app.result;
    const parts: HTMLElement[] = [];
    parts.push(this.#selection());
    if (r) {
      parts.push(this.#stats(r.stats as unknown as Obj));
      parts.push(this.#history());
    }
    parts.push(this.#engines());
    this.#root.replaceChildren(h("div", { class: "ins" }, parts));
  }

  #selection(): HTMLElement {
    const app = this.#app;
    const id = app.selected ?? app.hover;
    const box = h("section", {}, h("h3", {}, app.selected ? "Selected label" : "Label under the pointer"));
    if (!id) {
      box.appendChild(h("p", { class: "empty" }, "Hover over a label or a mark to see what the engine reports about it; click to keep it selected."));
      return box;
    }
    const p = app.placementOf(id);
    const item = app.scene.items().find((it) => it.id === id);
    const text = (item?.label as { text?: string } | undefined)?.text ?? id;
    if (!p) {
      box.appendChild(h("p", { class: "empty" }, `“${text}” is not in the latest result.`));
      return box;
    }
    const q = p as unknown as Obj;
    const pr = (p.priority ?? {}) as Obj;
    const rows: [string, Node | string][] = [["Item", h("span", {}, text, text === id ? null : h("span", { class: "mono", style: { color: "var(--faint)" } }, `  ${id}`))]];
    if (p.placed) {
      const model = p.model ?? "adjacent";
      rows.push(["Model", h("span", { class: "pill", style: { color: MODEL_COLORS[model] } }, model)]);
      rows.push(["Side", String(p.anchor_side ?? "–")]);
      if (p.text) {
        const t = p.text;
        rows.push(["Text", t.lines.join(" ⏎ ") + (t.used && t.used !== "original" ? `  (${t.used})` : "")]);
        rows.push(["Font", `${fmt(t.font_size)} px${t.font_weight && t.font_weight !== 400 ? `, weight ${t.font_weight}` : ""}${t.scale && t.scale < 1 ? `, shrunk to ${Math.round(t.scale * 100)} %` : ""}`]);
      }
      rows.push(["Box", `${fmt(p.box!.x)}, ${fmt(p.box!.y)}  ·  ${fmt(p.box!.w)} × ${fmt(p.box!.h)} px`]);
      if (p.leader) rows.push(["Leader", `${p.leader.style}, ${fmt(leaderLength(p.leader.points as number[][]))} px`]);
      if (typeof p.cost === "number") rows.push(["Cost", fmt(p.cost, 3)]);
      if (p.degrade_steps?.length) rows.push(["Ladder", p.degrade_steps.join(" → ")]);
      if (typeof q.displacement === "number") rows.push(["Moved", `${fmt(q.displacement as number)} px since the last solve`]);
    } else {
      const reason = String(q.reason ?? "");
      rows.push(["Status", h("span", { class: "pill err" }, "no label")]);
      rows.push(["Why", REASONS[reason] ?? reason ?? "–"]);
      const blocking = (q.blocking as string[] | undefined) ?? [];
      if (blocking.length) rows.push(["Hard classes", blocking.join(", ")]);
      const by = (q.blocked_by as string[] | undefined) ?? [];
      if (by.length) {
        rows.push([
          "In its way",
          h("span", {}, by.slice(0, 8).map((b, i) => [i ? ", " : "", h("button", { class: "linkish", type: "button", onclick: () => app.select(b) }, labelText(app, b))]), by.length > 8 ? ` and ${by.length - 8} more` : ""),
        ]);
      }
      if (p.degrade_steps?.length) rows.push(["Tried", p.degrade_steps.join(" → ")]);
    }
    rows.push(["Priority", `rank ${pr.rank ?? "–"}${typeof pr.score === "number" ? `, score ${fmt(pr.score as number, 2)}` : ""}${pr.tier ? `, tier ${pr.tier}` : ""}${typeof pr.font_class === "number" ? `, font class ${pr.font_class}` : ""}`]);
    box.appendChild(kv(rows));
    if (app.view.showCandidates) {
      const n = (app.result?.candidates ?? []).filter((c) => c.id === id).length;
      box.appendChild(h("p", { class: "empty" }, n ? `${n} candidates drawn on the canvas.` : "Candidates appear after the next solve at rest."));
    }
    return box;
  }

  #stats(st: Obj): HTMLElement {
    const phases = (st.phases_ms ?? {}) as Record<string, number>;
    const total = Object.values(phases).reduce((a, b) => a + b, 0) || 1;
    const flicker = st.flicker as Obj | undefined;
    const degraded = st.degraded as Record<string, number> | undefined;
    const rows: [string, Node | string][] = [
      ["Labels", `${st.placed} of ${st.total} placed (weighted ${fmt(Number(st.placed_weighted ?? 0) * 100, 0)} %)`],
      ["Verification", h("span", {}, pill(Number(st.hard_violations ?? 0) === 0, `${st.hard_violations ?? 0} overlaps`), " ", pill(Number(st.leader_crossings ?? 0) === 0, `${st.leader_crossings ?? 0} crossings`), " ", pill(Number(st.priority_inversions ?? 0) === 0, `${st.priority_inversions ?? 0} inversions`))],
      ["Solver", `${st.strategy_used}, ${fmt(Number(st.iterations ?? 0))} moves, ${fmt(Number(st.candidates ?? 0))} candidates`],
      ["Time", `${fmt(Number(st.runtime_ms ?? 0))} ms in the engine (${st.implementation})`],
    ];
    if (st.time_guard_hit) {
      rows.push(["Guard", h("span", { class: "pill err", title: "Raise the budget (Solver) for a complete search" }, "the wall-clock guard stopped the search: this result depends on the machine's speed")]);
    }
    if (degraded && Object.keys(degraded).length) rows.push(["Degraded", Object.entries(degraded).map(([k, v]) => `${v} ${k}`).join(", ")]);
    if (flicker) rows.push(["Since last", `${flicker.moved ?? 0} moved, ${flicker.added ?? 0} added, ${flicker.removed ?? 0} removed; ${fmt(Number(flicker.mean_displacement ?? 0))} px on average`]);
    const bar = h("div", { class: "phases" }, Object.entries(phases).map(([k, v]) => h("i", { title: `${k}: ${fmt(v)} ms`, style: { width: `${(100 * v) / total}%`, background: PHASE_COLORS[k] ?? "#999" } })));
    const legend = h("div", { class: "legend" }, Object.entries(phases).map(([k, v]) => h("span", { style: { "--c": PHASE_COLORS[k] ?? "#999" } as unknown as Record<string, string> }, `${k} ${fmt(v)}`)));
    legend.querySelectorAll("span").forEach((s, i) => s.style.setProperty("--c", PHASE_COLORS[Object.keys(phases)[i]!] ?? "#999"));
    return h("section", {}, h("h3", {}, "Last solve"), kv(rows), h("div", { style: { marginTop: "8px", display: "flex", flexDirection: "column", gap: "4px" } }, bar, legend));
  }

  #history(): HTMLElement {
    const hist = this.#app.history;
    const sec = h("section", {}, h("h3", {}, `Recent solves (${hist.length})`));
    if (hist.length < 2) {
      sec.appendChild(h("p", { class: "empty" }, "Play an animation or drag a mark to see time and movement per solve."));
      return sec;
    }
    const recent = hist.slice(-120);
    const span = (recent[recent.length - 1]!.at - recent[0]!.at) / 1000;
    const rate = span > 0 ? (recent.length - 1) / span : 0;
    const runtimes = recent.map((s) => s.runtime);
    const moves = recent.map((s) => s.moved ?? 0);
    sec.appendChild(sparkRow("Engine time per solve", runtimes, `${fmt(median(runtimes))} ms median`));
    if (recent.some((s) => s.moved !== undefined)) sec.appendChild(sparkRow("Label movement per solve (warm starts)", moves, `${fmt(mean(moves))} px mean`));
    sec.appendChild(h("p", { class: "empty" }, `${fmt(rate)} solves per second lately; round trip with the worker ${fmt(median(recent.map((s) => s.roundTrip)))} ms median.`));
    return sec;
  }

  #engines(): HTMLElement {
    const app = this.#app;
    const run = h("button", {
      class: "btn",
      type: "button",
      onclick: async () => {
        run.disabled = true;
        this.#parity.replaceChildren(h("span", { class: "empty" }, "Solving with both engines…"));
        try {
          const res = await app.compareEngines();
          if (!res) return;
          const cmp = samePlacements(res.wasm.result, res.ts.result);
          const ok = cmp.same === cmp.total;
          const tw = Number((res.wasm.result.stats as unknown as Obj).runtime_ms ?? 0);
          const tt = Number((res.ts.result.stats as unknown as Obj).runtime_ms ?? 0);
          this.#parity.replaceChildren(
            h("div", {}, h("span", { class: ok ? "ok" : "err" }, ok ? "Identical layouts" : `${cmp.total - cmp.same} placements differ`), ` — ${cmp.same} of ${cmp.total} placements equal`, ok ? "" : ` (first: ${cmp.firstDiff})`, "."),
            h("div", { class: "empty" }, `${ENGINE_NAMES.wasm}: ${fmt(tw)} ms · ${ENGINE_NAMES.ts}: ${fmt(tt)} ms (${fmt(tt / Math.max(tw, 0.01))}× the time).`),
          );
        } catch (e) {
          this.#parity.replaceChildren(h("span", { class: "err" }, `Failed: ${(e as Error).message}`));
        } finally {
          run.disabled = false;
        }
      },
    }, "Solve with both engines");
    return h(
      "section",
      {},
      h("h3", {}, "Engines"),
      h("p", { class: "empty", style: { margin: "0 0 8px" } }, "The Rust core compiled to WebAssembly and its TypeScript port make the same decisions for the same number of search moves: the layouts are identical, only the time differs."),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" } }, run, this.#parity),
    );
  }
}

function kv(rows: [string, Node | string][]): HTMLElement {
  const dl = h("dl", { class: "kv" });
  for (const [k, v] of rows) dl.append(h("dt", {}, k), h("dd", {}, v));
  return dl;
}

function pill(ok: boolean, text: string): HTMLElement {
  return h("span", { class: `pill ${ok ? "ok" : "err"}` }, text);
}

function labelText(app: App, id: string): string {
  const it = app.scene.items().find((i) => i.id === id);
  return (it?.label as { text?: string } | undefined)?.text ?? id;
}

function leaderLength(points: number[][]): number {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += Math.hypot(points[i]![0]! - points[i - 1]![0]!, points[i]![1]! - points[i - 1]![1]!);
  return s;
}

function sparkRow(title: string, values: number[], summary: string): HTMLElement {
  const W = 300;
  const H = 44;
  const max = Math.max(...values, 1e-9);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", class: "spark", role: "img", "aria-label": `${title}: ${summary}` });
  const step = values.length > 1 ? W / (values.length - 1) : W;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - 3 - (v / max) * (H - 8)).toFixed(1)}`);
  svg.appendChild(svgEl("polyline", { points: pts.join(" "), fill: "none", stroke: "var(--accent)", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" }));
  return h("div", {}, h("div", { class: "spark-row" }, h("span", {}, title), h("b", {}, summary)), svg);
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
