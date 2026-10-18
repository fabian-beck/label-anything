/**
 * The public JavaScript/TypeScript API of Label Anything (spec §6.2, §6.4).
 *
 * `@label-anything/core` (pure TypeScript) and `@label-anything/wasm` (the Rust core
 * compiled to WebAssembly) implement exactly these signatures, so callers can switch
 * between them by changing the import. Options that are not part of the JSON problem
 * (callbacks, pixels, cancellation) are passed in {@link PlaceOptions}; they are the
 * documented non-schema extensions of spec §6.4.
 */
import type { LabelProblem } from "./generated/problem.js";
import type { Issue, LabelResult } from "./generated/result.js";

export type { LabelProblem, LabelResult, Issue };

/** One item of a problem: where the labeled feature is (`anchor`) and what to place (`label`). */
export type LabelItem = LabelProblem["items"][number];
/** Where a labeled feature is: a point (with an optional mark shape) or an area polygon. */
export type Anchor = LabelItem["anchor"];
/** What to place: a text, an icon or box of a given size, or a composite of these. */
export type Label = LabelItem["label"];
/** One entry of `LabelResult.placements`: the label box, leader and text layout of an item. */
export type LabelPlacement = LabelResult["placements"][number];
/** A label box in canvas px: top-left corner `x`, `y` and size `w`, `h`. */
export type Box = NonNullable<LabelPlacement["box"]>;
/** A leader line from the anchor to the label (`points`, `style`, `port`, ...). */
export type Leader = NonNullable<LabelPlacement["leader"]>;
/** Summary of a solve (`LabelResult.stats`). */
export type Stats = LabelResult["stats"];

/** Font of a label as passed to a host {@link PlaceOptions.measure} callback. */
export interface FontSpec {
  family: string;
  weight: number;
  italic: boolean;
  /** Font size in px. */
  size: number;
}

/** Host-measured text metrics in px; `ascent` and `descent` are positive. */
export interface TextMetrics {
  width: number;
  ascent: number;
  descent: number;
}

/** A candidate position offered to a host {@link PlaceOptions.cost} callback. */
export interface CandidateInfo {
  /** Id of the item the candidate belongs to. */
  itemId: string;
  /** Label box in canvas px (top-left corner, size). */
  box: { x: number; y: number; w: number; h: number };
  /** Whether the candidate needs a leader. */
  leader: boolean;
}

/** RGBA8 pixels, row-major, straight alpha (an `ImageData` qualifies). */
export interface RgbaPixels {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** Result of {@link PlaceOptions.priority}: a score, or `[tier, score]`. */
export type PriorityValue = number | readonly [tier: number, score: number];

/** Non-schema options of a solve. Every field is optional. */
export interface PlaceOptions {
  /**
   * Host priority function, evaluated once per item before solving (never in inner
   * loops). It replaces `priority.terms`; tiers, `required` and ties still apply.
   */
  priority?: (item: LabelItem, index: number) => PriorityValue;
  /** Extra user cost added to the static cost of every candidate. */
  cost?: (candidate: CandidateInfo) => number;
  /**
   * Host text measurement, e.g. via `CanvasRenderingContext2D.measureText`. Return
   * `null` to fall back to the built-in measurement for this text.
   */
  measure?: (text: string, font: FontSpec) => TextMetrics | null;
  /** Progress notifications (`phase` is e.g. "prepare", "greedy", "local", "verify"). */
  progress?: (phase: string, fraction: number) => void;
  /**
   * Cancellation: when aborted, the solver stops improving and returns the best valid
   * result found so far (the greedy result at the latest).
   */
  signal?: AbortSignal;
  /**
   * Raster background pixels supplied directly: they replace the image of the first
   * `obstacles.raster` source, or add a raster source with default options.
   */
  raster?: RgbaPixels;
  /** Reads files referenced by path (`svg.path`, raster `source`, font `file`); Node only. */
  readFile?: (path: string) => Uint8Array;
}

/** Outcome of {@link validate}. */
export interface ValidationReport {
  valid: boolean;
  errors: Issue[];
  warnings: Issue[];
}

/** Thrown by `place` when the problem is invalid or cannot be prepared. */
export class PlaceError extends Error {
  readonly errors: Issue[];
  constructor(errors: Issue[]) {
    super(errors.map((e) => `${e.pointer || "/"} ${e.code}: ${e.message}`).join("\n"));
    this.name = "PlaceError";
    this.errors = errors;
  }
}

/** The functions both packages export. */
export interface LabelAnythingApi {
  /** Solve a problem (an object or JSON text). Throws {@link PlaceError} if invalid. */
  place(problem: LabelProblem | string, options?: PlaceOptions): LabelResult;
  /** Validate a problem against the schema and the semantic rules. */
  validate(problem: unknown): ValidationReport;
  /** Debug SVG overlay of a problem and a result (spec §11). */
  renderDebugSvg(problem: LabelProblem | string, result: LabelResult): string;
  /** Implementation version. */
  readonly VERSION: string;
}
