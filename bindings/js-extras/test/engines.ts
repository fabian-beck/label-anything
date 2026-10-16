// Test engines: a fake one that records problems, and the Rust CLI (when built).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LabelProblem, LabelResult, PlaceOptions } from "@label-anything/core";
import type { Engine } from "../src/engine.js";

type Placement = LabelResult["placements"][number];

export interface FakeEngine extends Engine {
  calls: { problem: LabelProblem; options: PlaceOptions }[];
  readonly last: { problem: LabelProblem; options: PlaceOptions };
}

/**
 * Places every label to the right of its anchor (after the mark), first come first
 * served; a label overlapping an earlier one is omitted.
 */
export function fakeEngine(): FakeEngine {
  const calls: FakeEngine["calls"] = [];
  return {
    calls,
    get last() {
      return calls[calls.length - 1]!;
    },
    place(problem, options = {}) {
      const p = (typeof problem === "string" ? JSON.parse(problem) : problem) as LabelProblem;
      calls.push({ problem: structuredClone(p), options });
      const f = p.defaults?.font ?? {};
      const size = f.size ?? 12;
      const boxes: { x: number; y: number; w: number; h: number }[] = [];
      const placements: Placement[] = p.items.map((item, i) => {
        const id = item.id ?? String(i);
        const label = item.label as { type: string; text?: string; font?: { size?: number } };
        const text = label.type === "text" ? (label.text ?? "") : "";
        const s = label.font?.size ?? size;
        const m = options.measure?.(text, { family: String(f.family ?? "default"), size: s, weight: Number(f.weight ?? 400), italic: f.style === "italic" });
        const w = m?.width ?? text.length * s * 0.6;
        const h = s * 1.2;
        const a = item.anchor as { x: number; y: number; mark?: { r?: number; w?: number } };
        const r = a.mark?.r ?? (a.mark?.w ?? 0) / 2;
        const box = { x: a.x + r + 2, y: a.y - h / 2, w, h };
        if (boxes.some((b) => b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h)) {
          return { id, placed: false, reason: "no_feasible_candidate" };
        }
        boxes.push(box);
        return {
          id,
          placed: true,
          box,
          model: "adjacent",
          anchor_side: "right",
          leader: null,
          text: { lines: [text], used: "original", baseline_offsets: [s * 0.95], x_offset: 0, font_size: s },
        };
      });
      return { version: "1", placements, stats: {} } as unknown as LabelResult;
    },
  };
}

// (jsdom replaces the global URL, so build the path without it)
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../../rust/target/release/label-anything");

/** The Rust engine through its CLI (`label-anything place -`), if it has been built. */
export const cliEngine: Engine | undefined = existsSync(BIN)
  ? {
      place(problem) {
        const input = typeof problem === "string" ? problem : JSON.stringify(problem);
        return JSON.parse(execFileSync(BIN, ["place", "-"], { input, maxBuffer: 1 << 28 }).toString()) as LabelResult;
      },
    }
  : undefined;

/** Placed labels must not overlap each other. */
export function overlaps(result: LabelResult): string[] {
  const placed = result.placements.filter((p) => p.placed && p.box);
  const out: string[] = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!.box!;
      const b = placed[j]!.box!;
      if (a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6) {
        out.push(`${placed[i]!.id}/${placed[j]!.id}`);
      }
    }
  }
  return out;
}
