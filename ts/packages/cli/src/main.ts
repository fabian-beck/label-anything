#!/usr/bin/env node
/**
 * `label-anything-ts`: the command-line interface of Label Anything on the pure
 * TypeScript engine (`@label-anything/core`), mirroring the Rust CLI's `place`,
 * `validate` and `render` (rust/crates/la-cli).
 *
 * ```text
 * label-anything-ts place problem.json -o result.json [--debug-svg out.svg] [--time 200] [--seed 1]
 * label-anything-ts render problem.json result.json -o overlay.svg
 * label-anything-ts validate problem.json [--json]
 * ```
 * `-` reads stdin / writes stdout. Exit codes: 0 success, 1 invalid problem, 2 error.
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
        [--time <ms>] [--seed <n>] [--pretty] [--preset <name>] [--omission <mode>]
        [--max-labels <n>] [--font-size <px>] [--canvas <WxH>] [--background <file>]
  label-anything-ts validate <problem.json|-> [--json]
  label-anything-ts render <problem.json> <result.json> [-o <out.svg|->]
  label-anything-ts --help | --version

'-' reads stdin / writes stdout.`;

/** A usage or I/O error (exit code 2). */
class CliError extends Error {}

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
  "--preset",
  "--omission",
  "--max-labels",
  "--font-size",
  "--canvas",
  "--background",
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

function readInput(path: string, io: Io): string {
  if (path === "-") return io.stdin();
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new CliError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
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

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`${what}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
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
  };
  if (clock) env.nowMs = () => performance.now();
  return env;
}

function printReport(r: ValidationReport, io: Io): void {
  for (const e of r.errors) io.stderr(`error   ${(e.pointer ?? "") === "" ? "/" : e.pointer} [${e.code}] ${e.message}\n`);
  for (const w of r.warnings) io.stderr(`warning ${w.pointer ?? ""} [${w.code}] ${w.message}\n`);
}

type Obj = Record<string, unknown>;

/** `obj.entry(key).or_insert({})` as an object (an error if it is something else). */
function section(obj: Obj, key: string): Obj {
  const v = obj[key];
  if (v === undefined || v === null) {
    const o: Obj = {};
    obj[key] = o;
    return o;
  }
  if (typeof v !== "object" || Array.isArray(v)) throw new CliError(`${key} must be an object`);
  return v as Obj;
}

function numberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const v = flags.get(name);
  if (v === undefined) return undefined;
  const x = Number(v);
  if (typeof v !== "string" || v.trim() === "" || !Number.isFinite(x)) throw new CliError(`${name}: not a number: ${String(v)}`);
  return x;
}

function cmdPlace(p: Parsed, io: Io): number {
  const path = p.positional[0];
  if (path === undefined) throw new CliError("missing problem file");
  const flags = p.flags;
  const problem = parseJson(readInput(path, io), path);
  if (typeof problem !== "object" || problem === null || Array.isArray(problem)) throw new CliError("the problem must be a JSON object");
  const obj = problem as Obj;
  const time = numberFlag(flags, "--time");
  if (time !== undefined) section(obj, "solver").time_budget_ms = time;
  const seed = numberFlag(flags, "--seed");
  if (seed !== undefined) section(obj, "solver").seed = seed;
  const omission = flags.get("--omission");
  if (typeof omission === "string") section(obj, "priority").omission = omission;
  const maxLabels = numberFlag(flags, "--max-labels");
  if (maxLabels !== undefined) section(section(obj, "priority"), "budget").max_labels = maxLabels;
  const preset = flags.get("--preset");
  if (typeof preset === "string") obj.preset = preset;
  const fontSize = numberFlag(flags, "--font-size");
  if (fontSize !== undefined) section(section(obj, "defaults"), "font").size = fontSize;
  const canvas = flags.get("--canvas");
  if (typeof canvas === "string") {
    const m = /^([^xX]+)[xX](.+)$/.exec(canvas);
    const w = m ? Number(m[1]) : NaN;
    const h = m ? Number(m[2]) : NaN;
    if (!Number.isFinite(w) || !Number.isFinite(h)) throw new CliError("--canvas must be WxH");
    obj.canvas = { width: w, height: h };
  }
  const bg = flags.get("--background");
  if (typeof bg === "string") {
    const o = section(obj, "obstacles");
    if (extname(bg).toLowerCase() === ".svg") o.svg = { path: bg };
    else o.raster = { source: bg };
  }
  const debugSvg = flags.get("--debug-svg");
  if (typeof debugSvg === "string") section(obj, "output").debug_svg = true;
  const report = validate(problem);
  if (!report.valid) {
    printReport(report, io);
    return 1;
  }
  const env = envFor(path, flags.get("--no-clock") !== true);
  const result = placeValidated(env, problem, report) as unknown as Obj;
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
  const problem = parseJson(readInput(problemPath, io), problemPath);
  const result = parseJson(readInput(resultPath, io), resultPath);
  const out = p.flags.get("-o");
  const output = typeof out === "string" ? out : "-";
  if (output.endsWith(".png")) throw new CliError("PNG output is not available in this build; write .svg instead");
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

if (isMain()) process.exitCode = run(process.argv.slice(2));
