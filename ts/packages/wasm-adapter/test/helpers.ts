// Shared test helpers. The WebAssembly tests need the generated wasm/ directory
// (`npm run build:wasm -w @label-anything/wasm`); without it they are skipped with a warning.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LabelProblem, LabelResult, PlaceOptions } from "@label-anything/core";
import { decodeSource } from "../../raster/src/index.js";

export const WASM_FILE = fileURLToPath(new URL("../wasm/label_anything_bg.wasm", import.meta.url));
export const built =
  existsSync(WASM_FILE) && existsSync(fileURLToPath(new URL("../wasm/label_anything.js", import.meta.url)));
if (!built) {
  console.warn(
    "@label-anything/wasm: wasm/ is not built, skipping the WebAssembly tests " +
      "(run `npm run build:wasm -w @label-anything/wasm`)",
  );
}

export const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
export const PROBLEMS = `${REPO}conformance/problems/`;
export const problemFiles = readdirSync(PROBLEMS)
  .filter((f) => f.endsWith(".json"))
  .sort();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProblem = LabelProblem & Record<string, any>;

export function readProblem(name: string): AnyProblem {
  return JSON.parse(readFileSync(PROBLEMS + name, "utf8")) as AnyProblem;
}

/**
 * The result without the wall-clock fields: `stats.runtime_ms`, `stats.phases_ms` and the
 * runtime printed in the stats line of `debug_svg`.
 */
export function untimed(r: LabelResult): unknown {
  const { runtime_ms: _r, phases_ms: _p, ...stats } = r.stats as unknown as Record<string, unknown>;
  const svg = (r as { debug_svg?: unknown }).debug_svg;
  return {
    ...r,
    stats,
    debug_svg: typeof svg === "string" ? svg.replace(/ · [0-9.]+ ms</, " · ms<") : svg,
  };
}

/** A small scatter problem: `n` points on a diagonal, labels "P0", "P1", … */
export function scatter(n: number, extra: Record<string, unknown> = {}): AnyProblem {
  return {
    canvas: { width: 400, height: 300 },
    items: Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      anchor: { type: "point", x: 40 + ((i * 37) % 320), y: 40 + ((i * 53) % 220) },
      label: { type: "text", text: `P${i}` },
    })),
    ...extra,
  } as AnyProblem;
}

/**
 * Pixels for a problem with an encoded raster `source` when the build has no image
 * decoder (`features` without "decode"): decoded by @label-anything/raster, which is
 * byte-identical to the Rust decoder.
 */
export function rasterOptions(features: string[], problem: AnyProblem): PlaceOptions | undefined {
  const src = problem.obstacles?.raster?.source;
  if (typeof src !== "string" || features.includes("decode")) return undefined;
  const img = decodeSource(src);
  return { raster: { width: img.width, height: img.height, data: img.data } };
}
