// Smoke tests of `label-anything-ts` (place, validate, render), in process and as a Node
// process, and its agreement with the Rust CLI when that has been built.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { type Io, loadWasmEngine, run, wantsWasm } from "../src/main.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const PROBLEMS = join(ROOT, "conformance/problems");
const MAIN = join(ROOT, "ts/packages/cli/dist/main.js");
const RUST = join(ROOT, "rust/target/release/label-anything");
const tmp = mkdtempSync(join(tmpdir(), "la-cli-"));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function io(stdin = ""): Io & { out: string; err: string } {
  const r = {
    out: "",
    err: "",
    stdin: () => stdin,
    stdout: (s: string) => {
      r.out += s;
    },
    stderr: (s: string) => {
      r.err += s;
    },
  };
  return r;
}

type Result = { placements: { placed: boolean }[]; stats: Record<string, unknown>; debug_svg: unknown };

const WASM_BUILT = existsSync(join(ROOT, "ts/packages/wasm-adapter/wasm/label_anything_bg.wasm"));

describe("engines and warm-up", () => {
  const placements = (f: string) =>
    (JSON.parse(readFileSync(f, "utf8")) as { placements: unknown[] }).placements;
  it("--warmup solves several times and reports the last (identical) solve", () => {
    const a = join(tmp, "w0.json");
    const b = join(tmp, "w2.json");
    expect(run(["place", join(PROBLEMS, "scatter-basic.json"), "-o", a, "--no-clock"], io())).toBe(0);
    expect(run(["place", join(PROBLEMS, "scatter-basic.json"), "-o", b, "--no-clock", "--warmup", "2"], io())).toBe(0);
    expect(placements(b)).toEqual(placements(a));
    const t = io();
    expect(run(["place", join(PROBLEMS, "scatter-basic.json"), "--warmup", "-1"], t)).toBe(2);
    expect(t.err).toContain("--warmup");
  });
  it("--engine wasm needs the WebAssembly engine loaded", () => {
    expect(wantsWasm(["place", "p.json", "--engine", "wasm"])).toBe(true);
    expect(wantsWasm(["place", "p.json", "--engine=wasm"])).toBe(true);
    expect(wantsWasm(["place", "p.json", "--engine", "core"])).toBe(false);
    const t = io();
    expect(run(["place", join(PROBLEMS, "scatter-basic.json"), "--engine", "nope"], t)).toBe(2);
    expect(t.err).toContain("--engine");
  });
  it.skipIf(!WASM_BUILT)("--engine wasm solves with @label-anything/wasm", async () => {
    await loadWasmEngine();
    const out = join(tmp, "wasm.json");
    expect(run(["place", join(PROBLEMS, "scatter-basic.json"), "-o", out, "--engine", "wasm"], io())).toBe(0);
    const r = JSON.parse(readFileSync(out, "utf8")) as Result;
    expect(String(r.stats.implementation)).toMatch(/^wasm\//);
    expect(r.placements.some((p) => p.placed)).toBe(true);
  });
});

describe("label-anything-ts", () => {
  it("places a problem file and writes the result", () => {
    const out = join(tmp, "r.json");
    const t = io();
    expect(run(["place", join(PROBLEMS, "scatter-basic.json"), "-o", out], t)).toBe(0);
    const r = JSON.parse(readFileSync(out, "utf8")) as Result;
    expect(r.stats.hard_violations).toBe(0);
    expect(r.stats.placed).toBe(20);
    expect(String(r.stats.implementation)).toMatch(/^ts\//);
  });

  it("reads stdin, applies overrides and writes the debug SVG", () => {
    const svg = join(tmp, "debug.svg");
    const t = io(readFileSync(join(PROBLEMS, "minimal.json"), "utf8"));
    expect(run(["place", "-", "--seed", "3", "--time", "50", "--debug-svg", svg, "--pretty"], t)).toBe(0);
    const r = JSON.parse(t.out) as Result;
    expect(r.stats.seed).toBe(3);
    expect(r.debug_svg).toBeNull();
    expect(readFileSync(svg, "utf8")).toMatch(/^<svg /);
  });

  it("--strategy sets solver.strategy", () => {
    const out = join(tmp, "greedy.json");
    expect(run(["place", join(PROBLEMS, "scatter-basic.json"), "-o", out, "--strategy", "greedy"], io())).toBe(0);
    expect((JSON.parse(readFileSync(out, "utf8")) as Result).stats.strategy_used).toBe("greedy");
    expect(run(["place", join(PROBLEMS, "scatter-basic.json"), "-o", out], io())).toBe(0);
    expect((JSON.parse(readFileSync(out, "utf8")) as Result).stats.strategy_used).toBe("local");
    const bad = io();
    expect(run(["place", join(PROBLEMS, "scatter-basic.json"), "--strategy", "nope"], bad)).toBe(1);
    expect(bad.err).toContain("/solver/strategy");
  });

  it("--degrade sets the degradation ladder", () => {
    const out = join(tmp, "degrade.json");
    // a row of long labels where the prefix grows only through the ladder
    const ladderCase = JSON.parse(readFileSync(join(ROOT, "conformance/place/prefix-ladder.json"), "utf8")) as {
      problem: unknown;
    };
    const prefix = join(tmp, "prefix-ladder.json");
    writeFileSync(prefix, JSON.stringify(ladderCase.problem));
    expect(run(["place", prefix, "-o", out, "--degrade", "omit"], io())).toBe(0);
    const plain = JSON.parse(readFileSync(out, "utf8")) as Result;
    expect(run(["place", prefix, "-o", out, "--degrade", "wrap,distant,shrink:0.85,omit"], io())).toBe(0);
    const ladder = JSON.parse(readFileSync(out, "utf8")) as Result;
    expect(plain.stats.degraded).toEqual({});
    expect(Number(ladder.stats.placed)).toBeGreaterThan(Number(plain.stats.placed));
    const bad = io();
    expect(run(["place", prefix, "--degrade", "wrap,nope"], bad)).toBe(1);
    expect(bad.err).toContain("/degrade/1");
  });

  it("validates", () => {
    const ok = io();
    expect(run(["validate", join(PROBLEMS, "minimal.json")], ok)).toBe(0);
    expect(ok.err).toContain("valid");
    const bad = io(JSON.stringify({ items: 3 }));
    expect(run(["validate", "-", "--json"], bad)).toBe(1);
    expect(JSON.parse(bad.out).valid).toBe(false);
    const invalid = io(JSON.stringify({ items: 3 }));
    expect(run(["place", "-"], invalid)).toBe(1);
    expect(invalid.err).toMatch(/^error /);
    // malformed JSON is an invalid problem, as in the Rust CLI
    const malformed = io("{ not json");
    expect(run(["place", "-"], malformed)).toBe(1);
    expect(malformed.err).toMatch(/^error {3}\/ \[parse\] invalid JSON/);
  });

  it("reports options on sections of the wrong type as invalid problems", () => {
    const t = io(JSON.stringify({ solver: "fast", items: [] }));
    expect(run(["place", "-", "--time", "50"], t)).toBe(1);
    expect(t.err).toBe("error   /solver [type] expected object, got string (a command-line option sets a field in it)\n");
  });

  it("keeps the other canvas options with --canvas and prints warnings", () => {
    const problem = {
      canvas: { width: 100, height: 100, padding: 0, region: [0, 0, 60, 400] },
      items: [{ id: "a", anchor: { type: "point", x: 30, y: 30 }, label: { type: "text", text: "Alpha" } }],
      avoid: { label: { lnies: 0.5 } },
    };
    const t = io("\uFEFF" + JSON.stringify(problem)); // a byte order mark is skipped
    expect(run(["place", "-", "--canvas", "400x300"], t)).toBe(0);
    expect(t.err).toContain("warning /avoid/label/lnies [unknown_class]");
    const box = (JSON.parse(t.out) as { placements: { box: { x: number; w: number } }[] }).placements[0]!.box;
    expect(box.x + box.w).toBeLessThanOrEqual(60); // inside the region
  });

  it("reads --background relative to the current directory", () => {
    const sub = join(tmp, "sub");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "p.json"), JSON.stringify({ canvas: { width: 50, height: 50 }, items: [] }));
    writeFileSync(join(tmp, "bg.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="10" height="10"/></svg>');
    expect(run(["place", join(sub, "p.json"), "--background", relative(process.cwd(), join(tmp, "bg.svg"))], io())).toBe(0);
  });

  it("renders a result", () => {
    const res = join(tmp, "m.json");
    expect(run(["place", join(PROBLEMS, "minimal.json"), "-o", res], io())).toBe(0);
    const t = io();
    expect(run(["render", join(PROBLEMS, "minimal.json"), res, "-o", "-"], t)).toBe(0);
    expect(t.out).toMatch(/^<svg [\s\S]*<\/svg>\n$/);
    expect(run(["render", join(PROBLEMS, "minimal.json"), res, "-o", join(tmp, "x.PNG")], io())).toBe(2);
    // the result of another problem, an invalid problem
    const other = io();
    expect(run(["render", join(PROBLEMS, "scatter-basic.json"), res], other)).toBe(1);
    expect(other.err).toMatch(/is not a result of .*scatter-basic\.json: \d+ placements for \d+ items/);
    const invalid = io(JSON.stringify({ items: 3 }));
    expect(run(["render", "-", res], invalid)).toBe(1);
    expect(invalid.err).toMatch(/^error /);
  });

  it.skipIf(!existsSync(MAIN))("runs as a Node process", () => {
    const r = spawnSync(process.execPath, [MAIN, "place", "-"], { input: readFileSync(join(PROBLEMS, "minimal.json")) });
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout.toString()) as Result).stats.hard_violations).toBe(0);
    expect(spawnSync(process.execPath, [MAIN, "frobnicate"]).status).toBe(2);
  });

  it.skipIf(!existsSync(MAIN) || !existsSync(RUST))("matches the Rust CLI without a clock (scatter-basic)", () => {
    const problem = readFileSync(join(PROBLEMS, "scatter-basic.json"));
    const ts = JSON.parse(execFileSync(process.execPath, [MAIN, "place", "-", "--no-clock"], { input: problem }).toString());
    const rust = JSON.parse(execFileSync(RUST, ["place", "-", "--no-clock"], { input: problem }).toString());
    for (const r of [ts, rust]) {
      delete r.stats.runtime_ms;
      delete r.stats.phases_ms;
      delete r.stats.implementation;
    }
    // the TypeScript default budget (250 ms × 40 moves/ms) equals Rust's (100 × 100)
    expect(ts).toEqual(rust);
  });
});
