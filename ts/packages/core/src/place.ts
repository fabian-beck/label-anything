/**
 * The solve pipeline (port of `rust/crates/la-core/src/lib.rs`, `place_validated`) and
 * the public `place` / `validate` / `renderDebugSvg` of the JavaScript API (`api.ts`).
 *
 * `validate → model → fonts → variants → obstacles → priorities → candidates → greedy →
 * local search → (exact) → boundary pass → uncross → verify → result`.
 *
 * @module
 */

import { PlaceError, type CandidateInfo, type LabelProblem, type LabelResult, type PlaceOptions, type ValidationReport } from "./api.js";
import { type Env, envNow, envProgress } from "./env.js";
import type { Rect } from "./geom/index.js";
import { FontError, Measurer, baseVariants, bundledFonts, userFonts } from "./labels.js";
import { maxf, minf, toIndex } from "./math.js";
import { BuildError, type Model, Strategy, build } from "./model/index.js";
import { MAX_GRID_CELLS, gridCell, gridCells, prepare } from "./obstacles.js";
import { fmtF64 } from "./json.js";
import { compute, fontClasses } from "./priority.js";
import { type DebugData, debugSvg } from "./render.js";
import { build as buildResult } from "./result.js";
import * as exact from "./solver/exact.js";
import { fanPass } from "./solver/fan.js";
import * as greedy from "./solver/greedy.js";
import { Solve } from "./solver/index.js";
import * as local from "./solver/local.js";
import * as repair from "./solver/repair.js";
import { verify } from "./solver/verify.js";
import { Issue, validate as validateProblem } from "./validate.js";

/**
 * Which implementation's per-implementation constants a solve uses: `ts` (the defaults of
 * this package: `solver.time_budget_ms` 250 and 40 moves per ms) or `rust` (100 and 100,
 * the Rust core's), so that tests can run the TypeScript solver with exactly the Rust
 * iteration budgets (ADR 0007: same decisions for the same iteration counts).
 */
export type BudgetProfile = "ts" | "rust";

/** The outcome of {@link placeValidated}. */
export interface Placed {
  result: Record<string, unknown>;
  /** Grid data for the debug overlay (only when `output.debug_svg` is set). */
  debug: DebugData | null;
  /** The resolved model. */
  model: Model;
}

/**
 * Solve a problem that already passed `validate` (its warnings are passed through).
 * Throws {@link PlaceError} when the problem cannot be prepared.
 */
export function placeValidated(problem: unknown, env: Env, warnings: Issue[], profile: BudgetProfile = "ts"): Placed {
  const t0 = envNow(env);
  let m: Model;
  try {
    m = build(problem, env, profile);
  } catch (e) {
    if (e instanceof BuildError) throw new PlaceError([new Issue(e.pointer, e.code, e.message)]);
    throw e;
  }
  for (const w of warnings) m.warnings.push(w);
  let fonts;
  try {
    fonts = userFonts(m, env) ?? bundledFonts();
  } catch (e) {
    if (e instanceof FontError) throw new PlaceError([new Issue(e.pointer, "invalid_value", e.message)]);
    throw e;
  }
  const measurer = new Measurer(fonts, env, m.shaping);
  const variants = m.items.map((it) => baseVariants(measurer, it));
  const pri = compute(m, variants, env);
  // font classes (spec §9.4): the priorities stay those of the nominal sizes
  m.fontClass = fontClasses(m, pri);
  m.keyLevel = pri.prio.map((p) => p.key);
  for (let i = 0; i < m.items.length; i++) {
    const k = m.fontClass[i];
    if (k === null || k === undefined) continue;
    const c = m.fontClasses[k]!;
    if (c.scale !== 1 || c.weight !== null) {
      m.items[i]!.rescale(c.scale, c.weight);
      variants[i] = baseVariants(measurer, m.items[i]!);
    }
  }
  let minFont = Infinity;
  for (const it of m.items) {
    minFont = minf(minFont, it.font.size);
    if (it.label.kind === "composite") {
      for (const p of it.label.parts) if (p.kind === "text") minFont = minf(minFont, p.spec.font.size);
    }
  }
  if (!Number.isFinite(minFont)) minFont = m.defaultEm;
  // the grids cover the working extent: it must be finite and not too finely divided
  const ew = m.extent.w();
  const eh = m.extent.h();
  if (!(Number.isFinite(ew) && Number.isFinite(eh))) {
    throw new PlaceError([new Issue("", "limit", `the working extent (${fmtF64(ew)} × ${fmtF64(eh)} px) is not finite`)]);
  }
  const cells = gridCells(m, gridCell(m, minFont));
  if (cells > MAX_GRID_CELLS) {
    throw new PlaceError([
      new Issue(
        "/solver/grid_cell",
        "limit",
        `the grid would have ${fmtF64(cells)} cells (at most ${fmtF64(MAX_GRID_CELLS)}): use a larger solver.grid_cell`,
      ),
    ]);
  }
  const obs = prepare(m, minFont);
  const t1 = envNow(env);
  const s = new Solve(m, obs, env, pri, measurer, variants, t0);
  s.generateLevel0();
  const t2 = envNow(env);
  envProgress(env, "greedy", 0);
  greedy.run(s);
  const t3 = envNow(env);
  let strategy = "greedy";
  const st = m.solver.strategy;
  if ((st === Strategy.Local || st === Strategy.Auto || st === Strategy.Exact) && m.items.length > 1) {
    const budget = m.solver.timeBudgetMs;
    const rate = profile === "rust" ? local.MOVES_PER_MS_RUST : local.MOVES_PER_MS;
    const iters = toIndex(maxf(minf(minf(m.solver.maxIterations, budget * rate), 400 * m.items.length), 0));
    envProgress(env, "local", 0);
    const deadline = t0 > 0 || envNow(env) > 0 ? t0 + 3 * budget : 0;
    const ls = local.run(s, iters, deadline);
    s.iterations = ls.iterations;
    if (ls.iterations > 0) strategy = "local";
    // exact search: explicitly requested, or auto with a small instance and a large budget
    const small = s.cands.length <= 3000;
    if (st === Strategy.Exact || (st === Strategy.Auto && small && budget >= 500)) {
      envProgress(env, "exact", 0);
      const maxNodes = toIndex(maxf(budget * 2000, 10000));
      exact.run(s, maxNodes);
      strategy = "exact";
    }
  }
  fanPass(s);
  repair.boundaryPass(s);
  repair.boundaryFill(s);
  repair.uncross(s);
  repair.priorityRepair(s);
  const t4 = envNow(env);
  const ver = verify(s);
  const t5 = envNow(env);
  const phases: [string, number][] = [
    ["prepare", t1 - t0],
    ["candidates", t2 - t1],
    ["greedy", t3 - t2],
    ["local", t4 - t3],
    ["verify", t5 - t4],
  ];
  const res = buildResult(s, ver, phases, envNow(env) - t0, strategy);
  let debug: DebugData | null = null;
  if (m.output.debugSvg) {
    const g = obs.grid;
    const classes: [string, Uint8Array][] = [];
    for (const c of obs.classes) {
      const sat = c.sat;
      if (sat === null) continue;
      const cov = new Uint8Array(g.cells());
      for (let i = 0; i < cov.length; i++) cov[i] = sat.cell(i % g.cols, Math.trunc(i / g.cols));
      classes.push([c.name, cov]);
    }
    debug = {
      grid: g,
      classes,
      candidates: s.cands.map((c): [string, Rect, boolean] => [m.items[c.item]!.id, c.rect, c.feasible]),
    };
  }
  (res.stats as Record<string, unknown>).runtime_ms = envNow(env) - t0;
  return { result: res, debug, model: m };
}

/** Solve a problem with an environment; fills `debug_svg` when `output.debug_svg` is set. */
export function placeWith(problem: unknown, env: Env, profile: BudgetProfile = "ts"): Record<string, unknown> {
  const report = validateProblem(problem);
  if (!report.valid) throw new PlaceError(report.errors);
  return placeReported(problem, env, report.warnings, profile);
}

/**
 * Solve a problem whose validation report is already known (it must be valid; its
 * warnings are passed through). Fills `debug_svg` when `output.debug_svg` is set.
 */
export function placeReported(problem: unknown, env: Env, warnings: Issue[], profile: BudgetProfile = "ts"): Record<string, unknown> {
  const { result, debug, model } = placeValidated(problem, env, warnings, profile);
  if (debug !== null) result.debug_svg = debugSvg(model, result, debug);
  return result;
}

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function" ? () => performance.now() : () => Date.now();

/** The environment of a {@link place} call: clock, callbacks and host data. */
export class OptionsEnv implements Env {
  constructor(private readonly options: PlaceOptions) {}

  nowMs(): number {
    return now();
  }

  measure(text: string, font: { family: string; weight: number; italic: boolean; size: number }) {
    const m = this.options.measure;
    if (m === undefined) return null;
    const r = m(text, font);
    return r ?? null;
  }

  hasMeasureCallback(): boolean {
    return this.options.measure !== undefined;
  }

  priority(item: unknown, index: number): [number | null, number] | null {
    const p = this.options.priority;
    if (p === undefined) return null;
    const v = p(item as LabelProblem["items"][number], index);
    if (typeof v === "number") return [null, v];
    if (Array.isArray(v)) {
      const t = v[0];
      return [typeof t === "number" && Number.isFinite(t) ? Math.trunc(t) : null, Number(v[1])];
    }
    return null;
  }

  hasPriorityCallback(): boolean {
    return this.options.priority !== undefined;
  }

  extraCost(itemId: string, bbox: Rect, leader: boolean): number {
    const c = this.options.cost;
    if (c === undefined) return 0;
    const info: CandidateInfo = { itemId, box: { x: bbox.x0, y: bbox.y0, w: bbox.w(), h: bbox.h() }, leader };
    return c(info);
  }

  hasCostCallback(): boolean {
    return this.options.cost !== undefined;
  }

  progress(phase: string, fraction: number): void {
    this.options.progress?.(phase, fraction);
  }

  cancelled(): boolean {
    // poll only `aborted`: a duck-typed `{ aborted }` (e.g. backed by a SharedArrayBuffer) works
    const s = this.options.signal as { aborted?: unknown } | undefined;
    return s !== undefined && s !== null && s.aborted === true;
  }

  rasterOverride() {
    const r = this.options.raster;
    if (r === undefined) return null;
    return { width: r.width, height: r.height, data: r.data };
  }

  readFile(path: string): Uint8Array {
    const rf = this.options.readFile;
    if (rf === undefined) throw new Error(`file access is not available in this environment (${path})`);
    try {
      return rf(path);
    } catch (e) {
      throw new Error(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Parse problem JSON text, throwing a {@link PlaceError} with code `parse`. */
function parseProblem(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new PlaceError([new Issue("", "parse", `invalid JSON: ${e instanceof Error ? e.message : String(e)}`)]);
  }
}

/** Solve a problem (an object or JSON text). Throws {@link PlaceError} if invalid. */
export function place(problem: LabelProblem | string, options: PlaceOptions = {}): LabelResult {
  const p = typeof problem === "string" ? parseProblem(problem) : problem;
  return placeWith(p, new OptionsEnv(options ?? {})) as unknown as LabelResult;
}

/** Validate a problem against the schema and the semantic rules. */
export function validate(problem: unknown): ValidationReport {
  const r = validateProblem(problem);
  return { valid: r.valid, errors: r.errors, warnings: r.warnings };
}

/** Debug SVG overlay of a problem and a result (spec §11). */
export function renderDebugSvg(problem: LabelProblem | string, result: LabelResult, env: Env = new OptionsEnv({})): string {
  let model: Model | null = null;
  try {
    const p = typeof problem === "string" ? JSON.parse(problem) : problem;
    model = build(p, env);
  } catch {
    model = null;
  }
  return debugSvg(model, result, null);
}
