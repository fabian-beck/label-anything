// The WebAssembly build gives exactly the result of the native CLI (greedy, so that no
// wall-clock decision is involved). Needs the CLI: `cargo build -p label-anything-cli`
// (release or debug) or LA_CLI=/path/to/label-anything. LA_EXTRA_PROBLEMS adds problem
// files (comma-separated paths), e.g. the performance problems.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LabelResult } from "@label-anything/core";
import { built, PROBLEMS, problemFiles, rasterOptions, REPO, required, untimed, type AnyProblem } from "./helpers.js";

type Wasm = typeof import("../src/node.js");
let la: Wasm;

const cli = [
  process.env.LA_CLI,
  `${REPO}rust/target/release/label-anything`,
  `${REPO}rust/target/debug/label-anything`,
].find((p): p is string => typeof p === "string" && p !== "" && existsSync(p));
if (built && !cli) {
  const msg = "@label-anything/wasm: native CLI not found (cargo build -p label-anything-cli)";
  if (required) throw new Error(`${msg}; LA_WASM_REQUIRED is set`);
  console.warn(`${msg}, skipping the comparison`);
}

const files = [
  ...problemFiles.map((f) => PROBLEMS + f),
  ...(process.env.LA_EXTRA_PROBLEMS ?? "").split(",").filter((p) => p !== ""),
];

describe.skipIf(!built || !cli)("WebAssembly equals the native CLI (greedy)", () => {
  let dir = "";
  beforeAll(async () => {
    la = await import("../src/node.js");
    dir = mkdtempSync(join(tmpdir(), "la-wasm-native-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  for (const file of files) {
    it(basename(file), () => {
      const problem = JSON.parse(readFileSync(file, "utf8")) as AnyProblem;
      problem.solver = { ...(problem.solver ?? {}), strategy: "greedy" };
      const path = join(dir, basename(file));
      writeFileSync(path, JSON.stringify(problem));
      const native = JSON.parse(
        execFileSync(cli as string, ["place", path, "-o", "-"], { encoding: "utf8", maxBuffer: 1 << 28 }),
      ) as LabelResult;
      const wasm = la.place(problem, rasterOptions(la.features(), problem));
      expect(wasm.stats.strategy_used).toBe("greedy");
      expect(untimed(wasm)).toEqual(untimed(native));
    }, 60_000);
  }
});
