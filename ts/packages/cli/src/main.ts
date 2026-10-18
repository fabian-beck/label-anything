#!/usr/bin/env node
/**
 * `label-anything-ts`: the command-line interface of Label Anything on the pure
 * TypeScript engine (`@label-anything/core`), mirroring the Rust CLI's `place`,
 * `validate` and `render` (rust/crates/la-cli).
 *
 * ```text
 * label-anything-ts place problem.json -o result.json [--debug-svg out.svg] [--time 200] [--seed 1]
 *                   [--engine core|wasm] [--warmup 3]
 * label-anything-ts render problem.json result.json -o overlay.svg
 * label-anything-ts validate problem.json [--json]
 * ```
 * `-` reads stdin / writes stdout. Exit codes: 0 success, 1 invalid problem or input, 2 any
 * other error.
 *
 * @module
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type Env,
  type Issue,
  PlaceError,
  type ValidationReport,
  VERSION,
  placeValidated,
  renderDebugSvg,
  validate,
} from "@label-anything/core";

const USAGE = `label-anything-ts ${VERSION} — label placement (TypeScript engine)

Usage:
  label-anything-ts place <problem.json|-> [-o <result.json|->] [--debug-svg <file>]
        [--time <ms>] [--seed <n>] [--strategy <name>] [--degrade <step,...>] [--pretty]
        [--preset <name>] [--omission <mode>] [--max-labels <n>] [--font-size <px>]
        [--canvas <WxH>] [--background <file>] [--engine core|wasm] [--warmup <n>]
  label-anything-ts validate <problem.json|-> [--json]
  label-anything-ts render <problem.json> <result.json> [-o <out.svg|->]
  label-anything-ts --help | --version

'-' reads stdin / writes stdout. The options of place set fields of the problem (--canvas
sets its width and height, --background a file relative to the current directory);
validation errors and warnings go to stderr. --engine wasm solves with
@label-anything/wasm (the Rust core compiled to WebAssembly) instead of the TypeScript
core; --warmup <n> solves n times before the reported solve (steady-state timing of a
JIT-compiled engine).

Exit codes: 0 success, 1 invalid problem or input (errors on stderr), 2 any other error.`;

/** A usage or I/O error (exit code 2). */
class CliError extends Error {}

/** An invalid problem (exit code 1): its errors. */
class InvalidProblem extends Error {
  constructor(readonly issues: Issue[]) {
    super("invalid problem");
  }
}

/** Another invalid input, e.g. a result of another problem (exit code 1). */
class InvalidInput extends Error {}

/** The output streams and exit code of a run (testable without a process). */
export interface Io {
  stdin(): string;
  stdout(s: string): void;
  stderr(s: string): void;
}

const processIo: Io = {
  stdin: () => readFileSync(0, "utf8"),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

/** Options that take a value (all others are switches). */
const VALUED = new Set([
  "-o",
  "--output",
  "--debug-svg",
  "--time",
  "--seed",
  "--strategy",
  "--degrade",
  "--preset",
  "--omission",
  "--max-labels",
  "--font-size",
  "--canvas",
  "--background",
  "--engine",
  "--warmup",
]);
const SWITCHES = new Set(["--pretty", "--json", "--no-clock", "--help", "-h", "--version", "-V"]);

function parseArgs(args: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-" || !a.startsWith("-")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (VALUED.has(name)) {
      let v: string | undefined;
      if (name !== a) v = a.slice(eq + 1);
      else v = args[++i];
      if (v === undefined) throw new CliError(`missing value for ${name}`);
      flags.set(name === "--output" ? "-o" : name, v);
    } else if (SWITCHES.has(name)) flags.set(name, true);
    else throw new CliError(`unknown option ${a}`);
  }
  return { positional, flags };
}

/** The text of a file (or stdin), without a UTF-8 byte order mark. */
function readInput(path: string, io: Io): string {
  let text: string;
  if (path === "-") text = io.stdin();
  else {
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new CliError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function writeOutput(path: string, data: string, io: Io): void {
  if (path === "-") {
    io.stdout(data + "\n");
    return;
  }
  try {
    writeFileSync(path, data);
  } catch (e) {
    throw new CliError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A problem's JSON text; malformed JSON is an invalid problem (a `parse` error). */
function parseProblem(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new InvalidProblem([{ pointer: "", code: "parse", message: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` }]);
  }
}

/** File access relative to the problem file's directory (like the Rust CLI). */
function envFor(problemPath: string | null, clock: boolean): Env {
  const base = problemPath !== null && problemPath !== "-" ? dirname(problemPath) : null;
  const env: Env = {
    readFile(path: string): Uint8Array {
      const p = base !== null && !isAbsolute(path) ? resolve(base, path) : path;
      try {
        return new Uint8Array(readFileSync(p));
      } catch (e) {
        throw new Error(`cannot read ${p}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    hasMeasureCallback(): boolean {
      return false;
    },
  };
  if (clock) env.nowMs = () => performance.now();
  return env;
}

function printReport(r: ValidationReport, io: Io): void {
  for (const e of r.errors) io.stderr(`error   ${(e.pointer ?? "") === "" ? "/" : e.pointer} [${e.code}] ${e.message}\n`);
  for (const w of r.warnings) io.stderr(`warning ${w.pointer ?? ""} [${w.code}] ${w.message}\n`);
}

type Obj = Record<string, unknown>;

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v;
}

/**
 * Sets the field at `path` of the problem, creating missing sections; a section of another
 * type is an invalid problem (as in the Rust CLI).
 */
function setOption(problem: unknown, path: readonly string[], value: unknown): void {
  let cur = problem;
  let pointer = "";
  for (let k = 0; k < path.length; k++) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) {
      throw new InvalidProblem([
        { pointer: pointer || "/", code: "type", message: `expected object, got ${typeName(cur)} (a command-line option sets a field in it)` },
      ]);
    }
    const o = cur as Obj;
    const key = path[k]!;
    pointer += `/${key}`;
    if (k + 1 === path.length) {
      o[key] = value;
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(o, key) || o[key] === undefined) o[key] = {};
    cur = o[key];
  }
}

/** Whether `result` is a result of `problem`: one placement per item, with its id, in order. */
function checkResult(problem: unknown, result: unknown): string | null {
  const placements = (result as { placements?: unknown } | null)?.placements;
  if (!Array.isArray(placements)) return 'it has no "placements" array';
  const items = (problem as { items?: unknown }).items;
  const list = Array.isArray(items) ? items : [];
  if (placements.length !== list.length) return `${placements.length} placements for ${list.length} items`;
  for (let k = 0; k < list.length; k++) {
    const own = (list[k] as { id?: unknown }).id;
    const itemId = typeof own === "string" ? own : String(k);
    const id = (placements[k] as { id?: unknown } | null)?.id;
    if (id !== itemId) return `placement ${k} is '${typeof id === "string" ? id : ""}', item ${k} is '${itemId}'`;
  }
  return null;
}

function numberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const v = flags.get(name);
  if (v === undefined) return undefined;
  const x = Number(v);
  if (typeof v !== "string" || v.trim() === "" || !Number.isFinite(x)) throw new CliError(`${name}: not a number: ${String(v)}`);
  return x;
}

/** The `place` function of @label-anything/wasm (loaded by {@link loadWasmEngine}). */
type WasmPlace = (problem: unknown) => unknown;
let wasmPlace: WasmPlace | null = null;

/** Loads @label-anything/wasm for `--engine wasm` (before {@link run}). */
export async function loadWasmEngine(): Promise<void> {
  // a variable specifier: the CLI builds and runs without the optional package
  const spec = "@label-anything/wasm";
  try {
    const m = (await import(spec)) as { place: WasmPlace };
    wasmPlace = m.place;
  } catch (e) {
    throw new CliError(`--engine wasm needs ${spec} (built): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Whether the arguments ask for the WebAssembly engine. */
export function wantsWasm(args: readonly string[]): boolean {
  return args.some((a, i) => a === "--engine=wasm" || (a === "--engine" && args[i + 1] === "wasm"));
}

function cmdPlace(p: Parsed, io: Io): number {
  const path = p.positional[0];
  if (path === undefined) throw new CliError("missing problem file");
  const flags = p.flags;
  const problem = parseProblem(readInput(path, io));
  const time = numberFlag(flags, "--time");
  if (time !== undefined) setOption(problem, ["solver", "time_budget_ms"], time);
  const seed = numberFlag(flags, "--seed");
  if (seed !== undefined) setOption(problem, ["solver", "seed"], seed);
  const strategy = flags.get("--strategy");
  if (typeof strategy === "string") setOption(problem, ["solver", "strategy"], strategy);
  const degrade = flags.get("--degrade");
  if (typeof degrade === "string") setOption(problem, ["degrade"], degrade.split(","));
  const omission = flags.get("--omission");
  if (typeof omission === "string") setOption(problem, ["priority", "omission"], omission);
  const maxLabels = numberFlag(flags, "--max-labels");
  if (maxLabels !== undefined) setOption(problem, ["priority", "budget", "max_labels"], maxLabels);
  const preset = flags.get("--preset");
  if (typeof preset === "string") setOption(problem, ["preset"], preset);
  const fontSize = numberFlag(flags, "--font-size");
  if (fontSize !== undefined) setOption(problem, ["defaults", "font", "size"], fontSize);
  const canvas = flags.get("--canvas");
  if (typeof canvas === "string") {
    const m = /^([^xX]+)[xX](.+)$/.exec(canvas);
    const w = m ? Number(m[1]) : NaN;
    const h = m ? Number(m[2]) : NaN;
    if (!Number.isFinite(w) || !Number.isFinite(h)) throw new CliError("--canvas: expected WxH, e.g. 800x600");
    // the other canvas options (padding, region, background) stay
    setOption(problem, ["canvas", "width"], w);
    setOption(problem, ["canvas", "height"], h);
  }
  const bg = flags.get("--background");
  if (typeof bg === "string") {
    // relative to the current directory, not the problem file's
    const file = resolve(bg);
    if (extname(bg).toLowerCase() === ".svg") setOption(problem, ["obstacles", "svg"], { path: file });
    else setOption(problem, ["obstacles", "raster"], { source: file });
  }
  const debugSvg = flags.get("--debug-svg");
  if (typeof debugSvg === "string") setOption(problem, ["output", "debug_svg"], true);
  const report = validate(problem);
  if (!report.valid) throw new InvalidProblem(report.errors);
  printReport({ ...report, errors: [] }, io);
  const engine = flags.get("--engine") ?? "core";
  if (engine !== "core" && engine !== "wasm") throw new CliError(`--engine: core or wasm, not ${String(engine)}`);
  const warmup = numberFlag(flags, "--warmup") ?? 0;
  if (!Number.isInteger(warmup) || warmup < 0) throw new CliError("--warmup must be a non-negative integer");
  let solve: () => Obj;
  if (engine === "wasm") {
    if (wasmPlace === null) throw new CliError("--engine wasm: the WebAssembly engine is not loaded");
    if (flags.get("--no-clock") === true) throw new CliError("--no-clock is not available with --engine wasm");
    const place = wasmPlace;
    solve = () => place(problem) as Obj;
  } else {
    const env = envFor(path, flags.get("--no-clock") !== true);
    solve = () => placeValidated(env, problem, report) as unknown as Obj;
  }
  for (let k = 0; k < warmup; k++) solve();
  const result = solve();
  // warnings found while preparing (validation warnings are printed above)
  const seen = new Set(report.warnings.map((w) => `${w.pointer}\u0000${w.code}\u0000${w.message}`));
  const later = ((result.warnings as Issue[] | undefined) ?? []).filter((w) => !seen.has(`${w.pointer}\u0000${w.code}\u0000${w.message}`));
  printReport({ valid: true, errors: [], warnings: later }, io);
  if (typeof debugSvg === "string") {
    const svg = result.debug_svg;
    if (typeof svg === "string") {
      try {
        writeFileSync(debugSvg, svg);
      } catch (e) {
        throw new CliError(`${debugSvg}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    result.debug_svg = null;
  }
  const out = flags.get("-o");
  writeOutput(typeof out === "string" ? out : "-", flags.get("--pretty") === true ? JSON.stringify(result, null, 2) : JSON.stringify(result), io);
  return 0;
}

function cmdValidate(p: Parsed, io: Io): number {
  const path = p.positional[0];
  if (path === undefined) throw new CliError("missing problem file");
  const text = readInput(path, io);
  let report: ValidationReport;
  try {
    report = validate(JSON.parse(text));
  } catch (e) {
    const issue: Issue = { pointer: "", code: "parse", message: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
    report = { valid: false, errors: [issue], warnings: [] };
  }
  if (p.flags.get("--json") === true) io.stdout(JSON.stringify(report, null, 2) + "\n");
  else {
    printReport(report, io);
    if (report.valid) io.stderr("valid\n");
  }
  return report.valid ? 0 : 1;
}

function cmdRender(p: Parsed, io: Io): number {
  const [problemPath, resultPath] = p.positional;
  if (problemPath === undefined || resultPath === undefined) throw new CliError("render needs a problem and a result file");
  const problem = parseProblem(readInput(problemPath, io));
  const report = validate(problem);
  if (!report.valid) throw new InvalidProblem(report.errors);
  printReport({ ...report, errors: [] }, io);
  let result: unknown;
  try {
    result = JSON.parse(readInput(resultPath, io));
  } catch (e) {
    throw new InvalidInput(`${resultPath}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const mismatch = checkResult(problem, result);
  if (mismatch !== null) throw new InvalidInput(`${resultPath} is not a result of ${problemPath}: ${mismatch}`);
  const out = p.flags.get("-o");
  const output = typeof out === "string" ? out : "-";
  if (output.toLowerCase().endsWith(".png")) throw new CliError("PNG output is not available in this build; write .svg instead");
  const svg = renderDebugSvg(problem as never, result as never, envFor(problemPath, false));
  writeOutput(output, svg, io);
  return 0;
}

/** Run the CLI with arguments (without `node` and the script); returns the exit code. */
export function run(args: readonly string[], io: Io = processIo): number {
  try {
    const [cmd, ...rest] = args;
    if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
      io.stdout(USAGE + "\n");
      return cmd === undefined ? 2 : 0;
    }
    if (cmd === "--version" || cmd === "-V") {
      io.stdout(`label-anything-ts ${VERSION}\n`);
      return 0;
    }
    const parsed = parseArgs(rest);
    if (parsed.flags.get("--help") === true || parsed.flags.get("-h") === true) {
      io.stdout(USAGE + "\n");
      return 0;
    }
    switch (cmd) {
      case "place":
        return cmdPlace(parsed, io);
      case "validate":
        return cmdValidate(parsed, io);
      case "render":
        return cmdRender(parsed, io);
      default:
        throw new CliError(`unknown command ${cmd}\n\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof InvalidProblem) {
      printReport({ valid: false, errors: e.issues, warnings: [] }, io);
      return 1;
    }
    if (e instanceof InvalidInput) {
      io.stderr(`label-anything-ts: ${e.message}\n`);
      return 1;
    }
    if (e instanceof CliError) io.stderr(`label-anything-ts: ${e.message}\n`);
    else if (e instanceof PlaceError) io.stderr(`label-anything-ts: ${e.message}\n`);
    else io.stderr(`label-anything-ts: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    return 2;
  }
}

/** Whether this module is the script node was started with (also through a bin symlink). */
function isMain(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (wantsWasm(args)) {
    try {
      await loadWasmEngine();
    } catch (e) {
      process.stderr.write(`label-anything-ts: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    }
  }
  process.exitCode = run(args);
}
