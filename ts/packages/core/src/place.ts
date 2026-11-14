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
import { errorMessage, fmtF64 } from "./json.js";
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
import { type SolveTrace, Tracer } from "./trace.js";
import { Issue, parseIssue, validate as validateProblem } from "./validate.js";

/**
 * Which implementation's per-implementation constants a solve uses: `ts` (the defaults of
 * this package: `solver.time_budget_ms` 250 and 40 moves per ms) or `rust` (100 and 100,
 * the Rust core's), so that tests can run the TypeScript solver with exactly the Rust
 * iteration budgets (ADR solver/time-budget: same decisions for the same iteration counts).
 */
export type BudgetProfile = "ts" | "rust";

/** The outcome of {@link solveValidated}. */
export interface Placed {
  result: Record<string, unknown>;
  /** Grid data for the debug overlay (only when `output.debug_svg` is set). */
  debug: DebugData | null;
  /** The resolved model. */
  model: Model;
}

/**
 * Solve a problem that already passed `validate` (its warnings are passed through).
 * Throws {@link PlaceError} when the problem cannot be prepared. `trace` records the
 * solver's decisions (ADR project/solve-traces).
 */
export function solveValidated(
  problem: unknown,
  env: Env,
  warnings: Issue[],
  profile: BudgetProfile = "ts",
  trace: Tracer | null = null,
): Placed {
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
  obs.setPointsRule(m, variants);
  const t1 = envNow(env);
  const s = new Solve(m, obs, env, pri, measurer, variants);
  if (trace !== null) {
    s.trace = trace;
    trace.begin(s);
    trace.phase("candidates");
  }
  s.generateLevel0();
  const t2 = envNow(env);
  envProgress(env, "greedy", 0);
  if (trace !== null) trace.phase("greedy");
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
    if (trace !== null) {
      trace.iterations = iters;
      trace.phase("local");
    }
    const ls = local.run(s, iters, deadline);
    s.iterations = ls.iterations;
    if (ls.iterations > 0) strategy = "local";
    // exact search: explicitly requested, or auto with a small instance and a large budget
    const small = s.cands.length <= 3000;
    if (st === Strategy.Exact || (st === Strategy.Auto && small && budget >= 500)) {
      envProgress(env, "exact", 0);
      const maxNodes = toIndex(maxf(budget * 2000, 10000));
      if (trace !== null) trace.phase("exact");
      exact.run(s, maxNodes);
      if (trace !== null) trace.pass("exact", "exact", []);
      strategy = "exact";
    }
  }
  if (trace !== null) trace.phase("fan");
  fanPass(s);
  if (trace !== null) trace.phase("boundary");
  repair.boundaryPass(s);
  repair.boundaryFill(s);
  if (trace !== null) trace.phase("uncross");
  repair.uncross(s);
  if (trace !== null) trace.phase("repair");
  repair.priorityRepair(s);
  const t4 = envNow(env);
  if (trace !== null) trace.phase("verify");
  const ver = verify(s);
  if (trace !== null) {
    trace.verified(ver);
    trace.setStrategy(strategy);
  }
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

/**
 * Solve a problem and record the solver's decisions (ADR project/solve-traces): the result,
 * identical to {@link solveWith}'s, and the trace (`trace.ts`).
 */
export function solveTraced(problem: unknown, env: Env, profile: BudgetProfile = "ts"): { result: Record<string, unknown>; trace: SolveTrace } {
  const report = validateProblem(problem);
  if (!report.valid) throw new PlaceError(report.errors);
  const tracer = new Tracer();
  const { result, debug, model } = solveValidated(problem, env, report.warnings, profile, tracer);
  if (debug !== null) result.debug_svg = debugSvg(model, result, debug);
  return { result, trace: tracer.finish() };
}

/** Solve a problem with an environment; fills `debug_svg` when `output.debug_svg` is set. */
export function solveWith(problem: unknown, env: Env, profile: BudgetProfile = "ts"): Record<string, unknown> {
  const report = validateProblem(problem);
  if (!report.valid) throw new PlaceError(report.errors);
  return solveReported(problem, env, report.warnings, profile);
}

/**
 * Solve a problem whose validation report is already known (it must be valid; its
 * warnings are passed through). Fills `debug_svg` when `output.debug_svg` is set.
 */
export function solveReported(problem: unknown, env: Env, warnings: Issue[], profile: BudgetProfile = "ts"): Record<string, unknown> {
  const { result, debug, model } = solveValidated(problem, env, warnings, profile);
  if (debug !== null) result.debug_svg = debugSvg(model, result, debug);
  return result;
}

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function" ? () => performance.now() : () => Date.now();

const CALLBACKS = ["priority", "cost", "measure", "progress", "readFile"] as const;

/** The bytes of an ArrayBuffer view or an ArrayBuffer, without copying. */
function byteView(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return null;
}

/**
 * Checks the options of a solve, with the errors of `@label-anything/wasm`: a wrong type
 * is a `TypeError`, a wrong pixel count a `RangeError`. `null` counts as not set.
 */
function checkOptions(options: unknown): PlaceOptions {
  if (options === undefined || options === null) return {};
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("label-anything: the options must be an object (PlaceOptions)");
  }
  const o = options as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of CALLBACKS) {
    const f = o[key];
    if (f === undefined || f === null) continue;
    if (typeof f !== "function") throw new TypeError(`label-anything: options.${key} must be a function`);
    out[key] = f;
  }
  if (o.signal !== undefined && o.signal !== null) {
    if (typeof o.signal !== "object") throw new TypeError("label-anything: options.signal must be an AbortSignal or an object with `aborted`");
    out.signal = o.signal;
  }
  const r = o.raster;
  if (r !== undefined && r !== null) {
    if (typeof r !== "object") throw new TypeError("label-anything: options.raster must be {width, height, data}");
    const { width, height, data } = r as Record<string, unknown>;
    for (const [key, v] of [["width", width], ["height", height]] as const) {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 0xffffffff) {
        throw new TypeError(`label-anything: options.raster.${key} must be a positive integer`);
      }
    }
    const bytes = byteView(data);
    if (bytes === null) throw new TypeError("label-anything: options.raster.data must be a Uint8Array or Uint8ClampedArray");
    const expected = (width as number) * (height as number) * 4;
    if (bytes.length !== expected) {
      throw new RangeError(`label-anything: options.raster.data has ${bytes.length} bytes, width * height * 4 = ${expected}`);
    }
    out.raster = { width, height, data: bytes };
  }
  return out as PlaceOptions;
}

/** The environment of a {@link place} call: clock, callbacks and host data. */
export class OptionsEnv implements Env {
  private readonly options: PlaceOptions;

  /** Throws a `TypeError` or `RangeError` for options of the wrong kind. */
  constructor(options: PlaceOptions = {}) {
    this.options = checkOptions(options);
  }

  nowMs(): number {
    return now();
  }

  measure(text: string, font: { family: string; weight: number; italic: boolean; size: number }) {
    const m = this.options.measure;
    if (m === undefined) return null;
    const r = m(text, font);
    if (r === null || r === undefined) return null;
    if (!Number.isFinite(r.width) || !Number.isFinite(r.ascent) || !Number.isFinite(r.descent)) {
      throw new TypeError("label-anything: the measure callback must return null or {width, ascent, descent} with finite numbers");
    }
    return r;
  }

  hasMeasureCallback(): boolean {
    return this.options.measure !== undefined;
  }

  priority(item: unknown, index: number): [number | null, number] | null {
    const p = this.options.priority;
    if (p === undefined) return null;
    const v = p(item as LabelProblem["items"][number], index);
    if (typeof v === "number" && Number.isFinite(v)) return [null, v];
    if (Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && typeof v[1] === "number" && Number.isFinite(v[1])) {
      return [v[0] as number, v[1] as number];
    }
    throw new TypeError(
      `label-anything: the priority callback must return a finite number or [tier, score] ` +
        `with an integer tier (item ${index} got ${String(v)})`,
    );
  }

  hasPriorityCallback(): boolean {
    return this.options.priority !== undefined;
  }

  extraCost(itemId: string, bbox: Rect, leader: boolean): number {
    const c = this.options.cost;
    if (c === undefined) return 0;
    const info: CandidateInfo = { itemId, box: { x: bbox.x0, y: bbox.y0, w: bbox.w(), h: bbox.h() }, leader };
    const v = c(info);
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new TypeError(`label-anything: the cost callback must return a finite number (got ${String(v)} for item "${itemId}")`);
    }
    return v;
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
    let content: unknown;
    try {
      content = rf(path);
    } catch (e) {
      throw new Error(`cannot read ${path}: ${errorMessage(e)}`);
    }
    if (typeof content === "string") return new TextEncoder().encode(content);
    const bytes = byteView(content);
    if (bytes === null) throw new TypeError(`label-anything: readFile must return a Uint8Array or a string (path ${path})`);
    return bytes;
  }
}

/**
 * Parse problem JSON text with the engine's `JSON.parse`. Throws a {@link PlaceError} with
 * code `parse` for malformed text; its message is the one of Rust ({@link parseIssue}).
 */
function parseProblem(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new PlaceError([parseIssue(text, e)]);
  }
}

/** Solve a problem (an object or JSON text). Throws {@link PlaceError} if invalid. */
export function place(problem: LabelProblem | string, options: PlaceOptions = {}): LabelResult {
  const p = typeof problem === "string" ? parseProblem(problem) : problem;
  return solveWith(p, new OptionsEnv(options)) as unknown as LabelResult;
}

/**
 * Validate a problem (an object or JSON text) against the schema and the semantic rules.
 * Text that is not JSON is a `parse` error of the report.
 */
export function validate(problem: unknown): ValidationReport {
  let p = problem;
  if (typeof problem === "string") {
    try {
      p = parseProblem(problem);
    } catch (e) {
      if (!(e instanceof PlaceError)) throw e;
      return { valid: false, errors: e.errors, warnings: [] };
    }
  }
  const r = validateProblem(p);
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
