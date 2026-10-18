/**
 * What a scene provides: its data as Label Anything items and obstacles, its default
 * options, a simulation that moves the items (optional), drawing, and pointer handling.
 * The app owns the engine, the options the user set, the labels and their motion.
 */
import type { LabelProblem, LabelResult, RgbaPixels } from "@label-anything/core";
import type { Control } from "../controls.js";

export type Item = LabelProblem["items"][number];
export type Anchors = Map<string, [number, number]>;

export interface SceneHost {
  /** Size of the drawing in CSS px. */
  readonly width: number;
  readonly height: number;
  /** URL of a file published with the playground (`data/...`). */
  asset(path: string): string;
  /** The scene's data or settings changed: solve again from scratch. */
  invalidate(): void;
  /** Items moved (by the scene itself, outside of `step`): solve again, warm-started. */
  moved(): void;
  /** Redraw without solving. */
  redraw(): void;
  /** Show a short message over the drawing. */
  toast(text: string): void;
}

/** Passed to `draw`: what the labels look like now, for scenes that highlight. */
export interface DrawState {
  hover: string | null;
  selected: string | null;
  /** Ids of items with a placed label in the latest result. */
  placed: ReadonlySet<string>;
}

export interface PointerInfo {
  x: number;
  y: number;
  /** Pointer events of a touch screen. */
  touch: boolean;
  shift: boolean;
}

export interface Scene {
  readonly id: string;
  readonly title: string;
  /** One line under the title on the drawing: what to do. */
  readonly hint: string;
  /** What the scene shows of the engine, at the top of its section. */
  readonly about: string;
  /** Data credits shown under the panel (HTML). */
  readonly credits: string;
  /** Controls of the scene's own section (their keys are `params` keys). */
  readonly controls: Control[];
  /** Obstacle classes the scene sends besides the items (`points`, `lines`, `ink`): their avoidance controls show. */
  readonly classes: readonly string[];
  /** Playground settings this scene starts with (budgets, transitions, display). */
  readonly view?: Partial<Record<string, unknown>>;
  readonly params: Record<string, unknown>;
  /** A scene control changed. */
  setParam(key: string, value: unknown): void;

  /** Load data; called once, before the first `resize`. */
  load(host: SceneHost): Promise<void>;
  /** The drawing got this size (also right after `load`). */
  resize(width: number, height: number): void;

  /** Problem options of this scene (preset, models, leaders, priority, ...): merged under the user's. */
  options(): Record<string, unknown>;
  /** The items at their current positions. */
  items(): Item[];
  /** Obstacles besides the items (vector layers). */
  obstacles(): LabelProblem["obstacles"] | undefined;
  /** Raster background pixels at canvas size (pictures). */
  raster?(): RgbaPixels | undefined;
  /** Current anchor positions by item id (labels follow them between solves). */
  anchors(): Anchors;
  /** State taken when a problem is built, handed back with its result (e.g. the map's view). */
  snapshot?(): unknown;
  /** A result arrived for the problem built at `snapshot`. */
  onResult?(result: LabelResult, snapshot: unknown): void;

  /** Has a simulation that `step` advances. */
  readonly animated: boolean;
  playing: boolean;
  /** Advance the simulation by `dt` ms (scaled by the speed); true when anything moved. */
  step(dt: number): boolean;
  /** Back to the scene's initial state. */
  reset(): void;

  /** Draw under the labels: `background` first, then `marks`. */
  draw(ctx: CanvasRenderingContext2D, layer: "background" | "marks", state: DrawState): void;
  /** The item whose mark is under the pointer. */
  hit(x: number, y: number): string | null;

  /** Pointer handling; return true when the scene takes the gesture. */
  pointerDown?(p: PointerInfo): boolean;
  pointerMove?(p: PointerInfo): void;
  pointerUp?(p: PointerInfo): void;
  /** Wheel or pinch zoom by `factor` around (x, y); true when handled. */
  zoom?(x: number, y: number, factor: number): boolean;
  /** Cursor over empty space (CSS class of the canvas). */
  readonly cursor?: "grab" | "crosshair" | "default";
  /** A color legend shown over the drawing (an obstacle like the other controls). */
  legend?(): { label: string; color: string }[];
  /** Extra buttons for the bottom-right corner of the drawing (zoom). */
  viewButtons?(): { label: string; title: string; run(): void }[];
}
