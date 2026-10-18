/**
 * The option controls of the panel. A control edits one value: a field of the problem
 * (its dotted path, e.g. `leaders.style`), a setting of the playground (`view.*`) or a
 * parameter of the scene. Problem fields show the value in effect: the user's, else the
 * scene's, else the preset's, else the engine default (spec/defaults.md).
 */
import { emValue } from "./util.js";

export interface Choice {
  value: unknown;
  label: string;
  title?: string;
}

interface Base {
  /** Dotted problem path, `view.<name>`, or a scene parameter. */
  key: string;
  label: string;
  /** One line of explanation under the control. */
  hint?: string;
  /** Shown only while this holds (gets the value of any key). */
  when?: (get: (key: string) => unknown) => boolean;
}

export interface SelectControl extends Base {
  kind: "select" | "segmented";
  options: Choice[];
}

export interface RangeControl extends Base {
  kind: "range";
  min: number;
  max: number;
  step: number;
  /** Slider position is the log of the value. */
  log?: boolean;
  /** Stored value from the slider's number (e.g. `n => n + "em"`), and back. */
  encode?: (n: number) => unknown;
  decode?: (v: unknown) => number;
  format?: (n: number) => string;
}

export interface ToggleControl extends Base {
  kind: "toggle";
  /** Stored values for on and off (default true / false). */
  on?: unknown;
  off?: unknown;
}

export interface ChecksControl extends Base {
  kind: "checks";
  /** The value is the list of the checked options' values, in this order. */
  options: Choice[];
}

export interface AvoidControl extends Base {
  kind: "avoid";
}

export interface JsonControl extends Base {
  kind: "json";
}

export interface TextControl extends Base {
  kind: "text";
  placeholder?: string;
}

export type Control = SelectControl | RangeControl | ToggleControl | ChecksControl | AvoidControl | JsonControl | TextControl;

export interface Section {
  id: string;
  title: string;
  /** What the section (a scene) demonstrates, above its controls. */
  about?: string;
  note?: string;
  open?: boolean;
  controls: Control[];
}

const em = (fallback: number) => ({
  encode: (n: number) => `${Math.round(n * 100) / 100}em`,
  decode: (v: unknown) => emValue(v, fallback),
  format: (n: number) => `${Math.round(n * 100) / 100} em`,
});

const px = (n: number) => `${Math.round(n * 10) / 10} px`;
const ms = (n: number) => `${n >= 100 ? Math.round(n) : Math.round(n * 10) / 10} ms`;
const transitions = (g: (key: string) => unknown) => Number(g("view.transition")) > 0;

/** Font classes by priority (spec §9.4), as named choices. */
export const FONT_CLASSES: Choice[] = [
  { value: [], label: "Uniform" },
  { value: [{ first: "8%", scale: 1.35, weight: 700 }], label: "Top 8 % larger" },
  { value: [{ first: "4%", scale: 1.6, weight: 700 }, { first: "20%", scale: 1.25 }], label: "Three sizes" },
  { value: [{ first: "10%", scale: 1.3, weight: 700 }, { first: "45%", scale: 1 }, { scale: 0.85 }], label: "Large to small" },
];

export const MODELS: Choice[] = [
  { value: "adjacent", label: "Adjacent", title: "Next to the mark, at the 8 standard positions" },
  { value: "slider", label: "Slider", title: "Sliding along the mark between the standard positions" },
  { value: "internal", label: "Internal", title: "Inside areas and large marks" },
  { value: "distant", label: "Distant", title: "Further away, with a leader" },
  { value: "boundary", label: "Boundary", title: "In a column at the canvas edge, with a leader" },
];

export const POSITION_ORDERS: Choice[] = [
  { value: "perceptual", label: "Perceptual", title: "top, right, bottom, left, then the diagonals" },
  { value: "cartographic", label: "Cartographic", title: "Imhof: top-right first" },
  { value: ["right", "top-right", "bottom-right"], label: "Right" },
  { value: ["left", "top-left", "bottom-left"], label: "Left" },
  { value: ["top", "bottom"], label: "Above / below" },
];

export const DEGRADE_STEPS: Choice[] = [
  { value: "alternatives", label: "Shorter text", title: "Use the label's alternatives (abbreviations)" },
  { value: "wrap", label: "Wrap", title: "Break long labels into 2–3 lines" },
  { value: "distant", label: "Leader", title: "Move away with a leader" },
  { value: "boundary", label: "Margin", title: "Move to the canvas edge with a leader" },
  { value: "evict_lower", label: "Evict lower", title: "Displace a less important label" },
  { value: "shrink:0.85", label: "Shrink", title: "Smaller font, down to 70 %" },
  { value: "soft_overlap", label: "Soft overlap", title: "Allow covering points, lines and ink at a cost" },
  { value: "omit", label: "Omit", title: "Leave the label out (always the last step)" },
];

/** The panel's sections after the scene's own. */
export const SECTIONS: Section[] = [
  {
    id: "labels",
    title: "Labels",
    open: true,
    controls: [
      { key: "defaults.font.size", label: "Font size", kind: "range", min: 8, max: 22, step: 0.5, format: px },
      { key: "priority.font_classes", label: "Size by importance", kind: "select", options: FONT_CLASSES, hint: "Font classes over the priority order" },
      { key: "defaults.margin", label: "Margin", kind: "range", min: 0, max: 1, step: 0.05, ...em(0.2), hint: "Space kept from other labels and marks" },
      { key: "placement.offset", label: "Offset", kind: "range", min: 0, max: 12, step: 0.5, format: px, hint: "Gap between a mark and its adjacent label" },
      { key: "defaults.padding", label: "Padding", kind: "range", min: 0, max: 0.6, step: 0.05, ...em(0.15) },
      { key: "defaults.wrap", label: "Wrap long labels", kind: "toggle", on: { max_width: "9em", max_lines: 2 }, off: null },
    ],
  },
  {
    id: "placement",
    title: "Placement",
    open: true,
    controls: [
      {
        key: "preset", label: "Preset", kind: "select",
        options: ["auto", "scatter", "map", "graph", "illustration", "none"].map((v) => ({ value: v, label: v })),
      },
      { key: "placement.models", label: "Candidate models", kind: "checks", options: MODELS },
      { key: "placement.position_order", label: "Position order", kind: "select", options: POSITION_ORDERS },
      {
        key: "placement.fan", label: "Fan labels", kind: "segmented",
        options: [{ value: "auto", label: "auto" }, { value: "always", label: "always" }, { value: "off", label: "off" }],
        hint: "Crowds get a column of labels with fanning leaders",
      },
      {
        key: "placement.internal", label: "Inside areas", kind: "segmented",
        options: ["auto", "prefer", "allow", "never"].map((v) => ({ value: v, label: v })),
      },
      { key: "placement.max_distance", label: "Max. distance", kind: "range", min: 2, max: 24, step: 0.5, ...em(8), hint: "Of distant labels", when: (g) => hasModel(g, "distant") },
      {
        key: "placement.boundary.sides", label: "Margin sides", kind: "checks",
        options: ["left", "right", "top", "bottom"].map((v) => ({ value: v, label: v })),
        when: (g) => hasModel(g, "boundary") || hasStep(g, "boundary"),
      },
      {
        key: "placement.boundary.align", label: "Margin column", kind: "segmented",
        options: [{ value: "stack", label: "stack" }, { value: "spread", label: "spread" }],
        when: (g) => hasModel(g, "boundary") || hasStep(g, "boundary"),
      },
    ],
  },
  {
    id: "leaders",
    title: "Leaders",
    controls: [
      {
        key: "leaders.style", label: "Style", kind: "segmented",
        options: ["straight", "angles", "orthogonal", "elbow", "curved"].map((v) => ({ value: v, label: v })),
      },
      { key: "leaders.max_length", label: "Max. length", kind: "range", min: 2, max: 40, step: 0.5, ...em(10) },
      { key: "leaders.clearance", label: "Clearance", kind: "range", min: 0, max: 1.2, step: 0.05, ...em(0.4), hint: "From other marks and leaders" },
      {
        key: "leaders.port", label: "Port", kind: "segmented",
        options: ["nearest", "side-center", "baseline"].map((v) => ({ value: v, label: v })),
      },
    ],
  },
  {
    id: "avoid",
    title: "Avoidance",
    note: "Hard: never covered. A number: cost per em² covered (1 = as much as a leader).",
    controls: [
      { key: "avoid.label.items", label: "Labels over marks", kind: "avoid" },
      { key: "avoid.label.points", label: "Labels over unlabeled points", kind: "avoid", when: (g) => g("scene.hasPoints") === true },
      { key: "avoid.label.lines", label: "Labels over lines", kind: "avoid", when: (g) => g("scene.hasLines") === true },
      { key: "avoid.label.ink", label: "Labels over the background", kind: "avoid", when: (g) => g("scene.hasInk") === true },
      { key: "avoid.label.canvas_edge", label: "Labels past the edge", kind: "avoid" },
      { key: "avoid.leader.leaders", label: "Leaders crossing", kind: "avoid" },
    ],
  },
  {
    id: "priority",
    title: "Priority",
    controls: [
      {
        key: "priority.omission", label: "Omission", kind: "segmented",
        options: [
          { value: "strict", label: "strict", title: "A label is left out only if every more important one is placed" },
          { value: "prefix", label: "prefix", title: "Placed labels are a prefix of the priority order" },
          { value: "weighted", label: "weighted", title: "Maximize the weighted number of labels" },
        ],
      },
      {
        key: "priority.budget.max_labels", label: "Label budget", kind: "range", min: 0, max: 400, step: 1,
        encode: (n) => (n === 0 ? null : n), decode: (v) => (typeof v === "number" ? v : 0),
        format: (n) => (n === 0 ? "no limit" : `${n} labels`),
      },
      {
        key: "degrade", label: "Degradation ladder", kind: "checks", options: DEGRADE_STEPS,
        hint: "Tried in this order for labels that do not fit",
      },
    ],
  },
  {
    id: "solver",
    title: "Solver",
    controls: [
      {
        key: "solver.strategy", label: "Strategy", kind: "segmented",
        options: ["auto", "greedy", "local", "exact"].map((v) => ({ value: v, label: v })),
      },
      { key: "view.budgetRest", label: "Budget at rest", kind: "range", min: 5, max: 1000, step: 1, log: true, format: ms, hint: "solver.time_budget_ms of static views" },
      { key: "view.budgetMoving", label: "Budget while moving", kind: "range", min: 2, max: 200, step: 1, log: true, format: ms, hint: "solver.time_budget_ms of the frames of an animation" },
      { key: "solver.seed", label: "Seed", kind: "range", min: 0, max: 99, step: 1, format: (n) => String(n) },
    ],
  },
  {
    id: "motion",
    title: "Motion",
    note: "How labels behave while things move.",
    controls: [
      { key: "view.warmStart", label: "Warm start", kind: "toggle", hint: "Each solve starts from the previous labels (warm_start)" },
      { key: "weights.stability", label: "Stability", kind: "range", min: 0, max: 4, step: 0.1, format: (n) => n.toFixed(1), hint: "Cost of moving away from the previous place", when: (g) => g("view.warmStart") === true },
      { key: "view.settle", label: "Settle at rest", kind: "toggle", hint: "One more solve, freer to improve, once things stop", when: (g) => g("view.warmStart") === true },
      { key: "view.transition", label: "Smooth transitions", kind: "range", min: 0, max: 1000, step: 10, format: (n) => (n === 0 ? "off" : ms(n)), hint: "Labels glide and fade (LabelMotion)" },
      { key: "view.moveDelay", label: "Move delay", kind: "range", min: 0, max: 2000, step: 10, format: ms, hint: "A label the solver moved stays until its new place has held this long", when: transitions },
      { key: "view.appearDelay", label: "Appear delay", kind: "range", min: 0, max: 1000, step: 10, format: ms, hint: "A new label shows only if it is still placed after this time", when: transitions },
      { key: "view.holdTime", label: "Hold time", kind: "range", min: 0, max: 2000, step: 10, format: ms, hint: "A label that is left out stays this long, in case it is back in the next solves", when: transitions },
      { key: "view.collisions", label: "Labels make way", kind: "toggle", hint: "Of two labels that meet between solves, the less important one fades out", when: transitions },
      { key: "view.fadeJumps", label: "Fade long moves", kind: "toggle", hint: "A label that moves further than two lines fades out and in instead of gliding", when: transitions },
      { key: "view.maxRate", label: "Solves per second", kind: "range", min: 2, max: 60, step: 1, format: (n) => (n >= 60 ? "as fast as possible" : `at most ${n}`) },
    ],
  },
  {
    id: "display",
    title: "Display",
    controls: [
      {
        key: "view.labelStyle", label: "Label style", kind: "segmented",
        options: [{ value: "box", label: "box" }, { value: "halo", label: "halo" }, { value: "plain", label: "plain" }],
      },
      { key: "view.showBoxes", label: "Label boxes", kind: "toggle", hint: "The collision boxes the engine placed" },
      { key: "view.showOmitted", label: "Omitted labels", kind: "toggle", hint: "Rings at the items without a label" },
      { key: "view.showCandidates", label: "Candidates of the selection", kind: "toggle", hint: "Every position tried (output.candidates)" },
      { key: "view.showObstacles", label: "Obstacles", kind: "toggle", hint: "The vector obstacles sent to the engine" },
      { key: "view.compare", label: "Compare with naive labels", kind: "toggle", hint: "Left of the divider: every label at its top-right" },
      { key: "view.avoidHud", label: "Keep labels off the controls", kind: "toggle", hint: "The buttons on the drawing are obstacles (class overlay)" },
    ],
  },
  {
    id: "json",
    title: "Problem JSON",
    note: "Any other field of the problem format, merged last. Errors of the engine's validator show here.",
    controls: [{ key: "view.customJson", label: "Extra fields", kind: "json" }],
  },
];

function hasModel(get: (key: string) => unknown, model: string): boolean {
  const m = get("placement.models");
  return Array.isArray(m) && m.includes(model);
}

function hasStep(get: (key: string) => unknown, step: string): boolean {
  const d = get("degrade");
  return Array.isArray(d) && d.includes(step);
}
