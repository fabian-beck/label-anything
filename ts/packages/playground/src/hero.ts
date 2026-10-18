/**
 * The live header of the documentation's home page (docs/_overrides/home.html). The logo —
 * a label, its leader and a dot — carries the name as its label, among small scenes that
 * show what the engine does: a map (a lake labeled inside, a river, crowded cities, pins
 * with icon labels, a name that shortens), a network (a hub labeled inside, nodes of every
 * shape, edges to keep off) and a chart (points, a trend line, an outlier, a wrapped
 * callout, three points that share one label). The engine places every label, keeping off
 * the header's text, while things are dragged or added by a click; the leader style can be
 * switched, and hovering a label or a mark says how it was placed or why it was left out.
 * Built into dist/hero.js; the home page loads it from the playground's directory and
 * solves with the playground's TypeScript engine (engine-ts.js) in a worker. Without it
 * (e.g. under `mkdocs serve`) the header shows the static logo the live one starts from.
 *
 * The page provides, inside `[data-la-hero]`: the stage the drawing goes into
 * (`[data-la-hero-stage]`), the static logo (`[data-la-hero-name]` with its label
 * `[data-la-hero-label]`, leader `[data-la-hero-leader]` and dot `[data-la-hero-dot]`),
 * the elements to keep labels off (`[data-la-avoid]`: `text` for the boxes of its lines,
 * `children` for each child's box, empty for its own box) and the hint shown while live
 * (`[data-la-hero-hint]`, out of the flow, with `[data-la-hero-stats]`, the leader styles
 * `[data-la-hero-styles] button[data-style]` and a `[data-la-hero-reset]` button). The
 * custom property `--la-hero-layout` says where the scenes go: `wide` (beside the text)
 * or `strip` (below it, in the room the class `has-toy` makes).
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";
import { LabelMotion } from "@label-anything/extras";
import { createWorkerEngine, type WorkerEngine } from "@label-anything/extras/worker";

type Placement = LabelResult["placements"][number];
type TextInfo = NonNullable<Placement["text"]>;
type Box = { x: number; y: number; w: number; h: number };
type Rect = [number, number, number, number];
type Pt = [number, number];

const SVG_NS = "http://www.w3.org/2000/svg";
/** The engine measures text with its bundled Noto Sans; the labels are drawn with it. */
const LABEL_FONT = '"LA Noto Sans", "Noto Sans", sans-serif';
/** Budgets (ms, of the Rust core; the TypeScript worker scales them) while dragging and at rest. */
const BUDGET_MOVING = 4;
const BUDGET_REST = 10;
/** At most this many things added by clicks: the oldest go first. */
const MAX_ADDED = 16;

/** A thing's mark, relative to its anchor. */
type Mark =
  | { shape: "circle"; r: number }
  | { shape: "planet"; rx: number; ry: number; rotation: number; r: number }
  | { shape: "rect"; w: number; h: number; corner: number; rotation: number }
  | { shape: "polygon"; points: Pt[] }
  /** A map pin, its tip on the anchor (an icon mark with a silhouette). */
  | { shape: "pin" }
  /** An area: its outline (the anchor is a reference point inside). */
  | { shape: "area"; points: Pt[] };

type Icon = "cafe" | "museum" | "plane" | "train" | "tree";
/** How a label is drawn — the host's choice, as on any chart or map. */
type Look = "map" | "chip" | "plain" | "pill" | "inside" | "water" | "callout";
type SceneId = "map" | "network" | "chart" | "saturn" | "polaris" | "free";
type Model = "adjacent" | "slider" | "internal" | "distant";

interface Thing {
  id: string;
  /** The scene it belongs to; its anchor is the scene's origin + (dx, dy). */
  scene: SceneId;
  dx: number;
  dy: number;
  mark: Mark;
  text: string;
  size: number;
  alternatives?: string[];
  /** Wrapped into at most two lines. */
  wrap?: boolean;
  /** A composite label: this icon, then the text. */
  icon?: Icon;
  look: Look;
  accent?: boolean;
  priority: number;
  group?: string;
  models?: Model[];
  internal?: "prefer";
  /** Added by a click, at this count (the oldest go first when there are too many). */
  added?: number;
  /** Moved by the user: shown wherever it is (the others only where clear of the text and the logo). */
  moved?: boolean;
}

// --- the scenes ---------------------------------------------------------------------------

const ring = (n: number, f: (a: number) => Pt): Pt[] => Array.from({ length: n }, (_, i) => f((i / n) * Math.PI * 2));
const round1 = (n: number) => Math.round(n * 10) / 10;
/** A lake: an irregular oval. */
const LAKE: Pt[] = ring(28, (a) => {
  const k = 1 + 0.1 * Math.sin(3 * a + 0.6) + 0.07 * Math.cos(5 * a);
  return [round1(66 * k * Math.cos(a)), round1(31 * k * Math.sin(a))];
});
/** The river out of the lake, relative to the lake's anchor. */
const RIVER: Pt[] = [[44, 22], [54, 50], [44, 80], [60, 110], [47, 142], [64, 176], [54, 212], [66, 250]];
const STAR: Pt[] = ring(10, (a) => {
  const r = Math.round(a / (Math.PI / 5)) % 2 === 0 ? 9 : 4;
  return [round1(r * Math.sin(a)), round1(-r * Math.cos(a))];
});
const DIAMOND: Pt[] = [[0, -11], [11, 0], [0, 11], [-11, 0]];
/** The pin's outline for the engine, from the icon's top-left corner (16 × 22, tip at the bottom). */
const PIN_SILHOUETTE: Pt[] = [[8, 22], ...ring(12, (a) => [round1(8 + 7.4 * Math.cos(a + 2.4)), round1(8 + 7.4 * Math.sin(a + 2.4))] as Pt).filter((p) => p[1] < 13)];
const PIN_PATH = "M0 0C-2.2-3.6-7-8.6-7-14A7 7 0 1 1 7-14C7-8.6 2.2-3.6 0 0Z";

/** The chart's unlabeled points and trend, relative to its origin. */
const CLOUD: Pt[] = (() => {
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  return Array.from({ length: 20 }, (_, i) => {
    const x = -100 + i * 10.5 + rnd() * 4;
    return [round1(x), round1(-0.42 * x + rnd() * 16)] as Pt;
  });
})();
const TREND: Pt[] = [[-112, 47], [112, -47]];
const EDGES: [string, string][] = [["hub", "router"], ["hub", "server"], ["hub", "printer"], ["hub", "laptop"], ["hub", "phone"], ["router", "server"]];

/** The things the header starts with. */
const THINGS: readonly Thing[] = [
  // a map: Lake Como and the cities below it
  { id: "lake", scene: "map", dx: 6, dy: -122, mark: { shape: "area", points: LAKE }, text: "Lake Como", size: 13, look: "water", priority: 7, internal: "prefer" },
  { id: "milan", scene: "map", dx: 0, dy: 0, mark: { shape: "circle", r: 5 }, text: "Milan", size: 16, look: "map", priority: 10 },
  { id: "monza", scene: "map", dx: 17, dy: -15, mark: { shape: "circle", r: 3 }, text: "Monza", size: 12, look: "map", priority: 4 },
  { id: "bergamo", scene: "map", dx: 62, dy: -28, mark: { shape: "circle", r: 3.5 }, text: "Bergamo", size: 13, look: "map", priority: 6 },
  { id: "lecco", scene: "map", dx: 34, dy: -66, mark: { shape: "circle", r: 3 }, text: "Lecco", size: 12, look: "map", priority: 3 },
  { id: "como", scene: "map", dx: -22, dy: -62, mark: { shape: "circle", r: 3.5 }, text: "Como", size: 13, look: "map", priority: 5 },
  { id: "centrale", scene: "map", dx: -30, dy: 10, mark: { shape: "pin" }, text: "Centrale", size: 12, icon: "train", look: "chip", priority: 5 },
  { id: "duomo", scene: "map", dx: 44, dy: 70, mark: { shape: "pin" }, text: "Duomo", size: 12, icon: "museum", look: "chip", priority: 6 },
  // a crowd: Milan's districts, too close for labels next to them
  { id: "brera", scene: "map", dx: 8, dy: 30, mark: { shape: "circle", r: 2.5 }, text: "Brera", size: 11, look: "map", priority: 3 },
  { id: "isola", scene: "map", dx: 16, dy: 23, mark: { shape: "circle", r: 2.5 }, text: "Isola", size: 11, look: "map", priority: 2 },
  { id: "navigli", scene: "map", dx: 0, dy: 41, mark: { shape: "circle", r: 2.5 }, text: "Navigli", size: 11, look: "map", priority: 3 },
  { id: "romana", scene: "map", dx: 19, dy: 38, mark: { shape: "circle", r: 2.5 }, text: "Porta Romana", size: 11, look: "map", priority: 2 },
  { id: "citylife", scene: "map", dx: -6, dy: 28, mark: { shape: "circle", r: 2.5 }, text: "CityLife", size: 11, look: "map", priority: 2 },
  { id: "malpensa", scene: "map", dx: -86, dy: -14, mark: { shape: "pin" }, text: "Malpensa Airport", alternatives: ["Malpensa", "MXP"], size: 12, icon: "plane", look: "chip", priority: 6 },
  { id: "here", scene: "map", dx: -52, dy: 62, mark: { shape: "pin" }, text: "you are here", size: 12, look: "map", accent: true, priority: 8 },
  // a network: a hub labeled inside, nodes of several shapes
  { id: "hub", scene: "network", dx: 0, dy: 0, mark: { shape: "rect", w: 74, h: 30, corner: 8, rotation: 0 }, text: "hub", size: 13, look: "inside", priority: 9, internal: "prefer" },
  { id: "router", scene: "network", dx: 80, dy: -44, mark: { shape: "polygon", points: DIAMOND }, text: "router", size: 12, look: "pill", priority: 5 },
  { id: "server", scene: "network", dx: 88, dy: 34, mark: { shape: "rect", w: 15, h: 21, corner: 2, rotation: 0 }, text: "server", size: 12, look: "pill", priority: 5 },
  { id: "printer", scene: "network", dx: -86, dy: -36, mark: { shape: "circle", r: 7 }, text: "printer", size: 12, look: "pill", priority: 4 },
  { id: "laptop", scene: "network", dx: -76, dy: 40, mark: { shape: "rect", w: 24, h: 15, corner: 2, rotation: -14 }, text: "laptop", size: 12, look: "pill", priority: 4 },
  { id: "phone", scene: "network", dx: 10, dy: 60, mark: { shape: "rect", w: 9, h: 16, corner: 2, rotation: 12 }, text: "phone", size: 12, look: "pill", priority: 3 },
  // a chart: points on a trend, three labeled, an annotation and a group
  { id: "outlier", scene: "chart", dx: 56, dy: 42, mark: { shape: "circle", r: 5 }, text: "outlier", size: 12, look: "plain", accent: true, priority: 8 },
  { id: "peak", scene: "chart", dx: 100, dy: -64, mark: { shape: "circle", r: 4 }, text: "peak", size: 12, look: "plain", priority: 6 },
  { id: "dip", scene: "chart", dx: -64, dy: 58, mark: { shape: "circle", r: 4 }, text: "record low after the storm", size: 12, wrap: true, look: "callout", priority: 7, models: ["distant"] },
  { id: "sensor-a", scene: "chart", dx: -16, dy: 2, mark: { shape: "circle", r: 3 }, text: "sensors A", size: 12, look: "plain", priority: 5, group: "sensors" },
  { id: "sensor-b", scene: "chart", dx: -10, dy: 7, mark: { shape: "circle", r: 3 }, text: "B", size: 12, look: "plain", priority: 5, group: "sensors" },
  { id: "sensor-c", scene: "chart", dx: -18, dy: 10, mark: { shape: "circle", r: 3 }, text: "C", size: 12, look: "plain", priority: 5, group: "sensors" },
  // the sky above
  { id: "saturn", scene: "saturn", dx: 0, dy: 0, mark: { shape: "planet", rx: 17, ry: 6, rotation: -20, r: 6 }, text: "Saturn", size: 13, look: "plain", priority: 5 },
  { id: "polaris", scene: "polaris", dx: 0, dy: 0, mark: { shape: "polygon", points: STAR }, text: "Polaris", size: 13, look: "plain", accent: true, priority: 4 },
];

/** Where the scenes go: their origin at (u, v) beside the text; in the strip below it, at fx of the width (from minW px on). */
const SCENES: Record<Exclude<SceneId, "free">, { u: number; v: number; strip?: { fx: number; y: number; minW: number; fxAlone?: number } }> = {
  map: { u: -0.79, v: 0.66, strip: { fx: 0.3, y: 172, minW: 0, fxAlone: 0.52 } },
  network: { u: 0.77, v: 0.25, strip: { fx: 0.74, y: 110, minW: 620 } },
  chart: { u: 0.76, v: 0.75 },
  saturn: { u: -0.43, v: 0.13 },
  polaris: { u: 0.46, v: 0.1 },
};

/** What a click adds, in turn. */
const MORE: readonly Omit<Thing, "id" | "scene" | "dx" | "dy" | "added">[] = [
  { mark: { shape: "pin" }, text: "Café", size: 12, icon: "cafe", look: "chip", priority: 2 },
  { mark: { shape: "circle", r: 3.5 }, text: "Oslo", size: 13, look: "map", priority: 2 },
  { mark: { shape: "polygon", points: STAR }, text: "Vega", size: 12, look: "plain", accent: true, priority: 2 },
  { mark: { shape: "rect", w: 14, h: 14, corner: 3, rotation: 0 }, text: "node 7", size: 12, look: "pill", priority: 2 },
  { mark: { shape: "pin" }, text: "museum", size: 12, icon: "museum", look: "chip", priority: 2 },
  { mark: { shape: "circle", r: 4 }, text: "anomaly", size: 12, look: "plain", accent: true, priority: 2 },
  { mark: { shape: "pin" }, text: "trailhead", size: 12, icon: "tree", look: "chip", priority: 2 },
  { mark: { shape: "circle", r: 3 }, text: "Lima", size: 13, look: "map", priority: 2 },
  { mark: { shape: "pin" }, text: "station", size: 12, icon: "train", look: "chip", priority: 2 },
  { mark: { shape: "polygon", points: DIAMOND }, text: "switch", size: 12, look: "pill", priority: 2 },
  { mark: { shape: "circle", r: 3 }, text: "Hanoi", size: 13, look: "map", priority: 2 },
  { mark: { shape: "pin" }, text: "ice cream", size: 12, icon: "cafe", look: "chip", priority: 2 },
];

/** Icons in a 16 × 16 box: stroked paths. */
const ICONS: Record<Icon, string> = {
  cafe: "M2.5 5.5h8.5v3a4 4 0 0 1-4 4h-.5a4 4 0 0 1-4-4zM11 6.5h1.2a2 2 0 0 1 0 4H11M2 15h10",
  museum: "M8 1.5l6.5 3.5h-13zM3.5 7v5.5M6.5 7v5.5M9.5 7v5.5M12.5 7v5.5M1.5 14.5h13",
  plane: "M8 1.5v13M8 6.5l-6.5 3.5M8 6.5l6.5 3.5M5.5 14.5h5",
  train: "M4.5 1.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM2.5 7.5h11M5.5 12.5l-2 3M10.5 12.5l2 3",
  tree: "M8 1.5l5 7H3zM8 5.5l5.5 7h-11zM8 12.5v3",
};

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, cls?: string, attrs?: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG_NS, tag);
  if (cls) e.setAttribute("class", cls);
  for (const [k, v] of Object.entries(attrs ?? {})) e.setAttribute(k, String(v));
  return e;
};
const px = (n: number) => String(Math.round(n * 100) / 100);
const inside = (b: Box, x: number, y: number, pad = 0) => x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
const pathOf = (pts: readonly Pt[], close = false) => pts.map((q, i) => `${i ? "L" : "M"}${px(q[0])} ${px(q[1])}`).join("") + (close ? "Z" : "");
/** A smooth curve through the points (Catmull-Rom as cubic Béziers). */
const smoothPathOf = (pts: readonly Pt[]) =>
  pts
    .map((q, i) => {
      if (i === 0) return `M${px(q[0])} ${px(q[1])}`;
      const [a, b, c] = [pts[i - 2] ?? pts[i - 1]!, pts[i - 1]!, pts[i + 1] ?? q];
      const c1: Pt = [b[0] + (q[0] - a[0]) / 6, b[1] + (q[1] - a[1]) / 6];
      const c2: Pt = [q[0] - (c[0] - b[0]) / 6, q[1] - (c[1] - b[1]) / 6];
      return `C${px(c1[0])} ${px(c1[1])} ${px(c2[0])} ${px(c2[1])} ${px(q[0])} ${px(q[1])}`;
    })
    .join("");

/** How far a thing's mark reaches from its anchor. */
function extent(t: Thing): number {
  const m = t.mark;
  switch (m.shape) {
    case "circle":
      return m.r;
    case "planet":
      return m.rx;
    case "rect":
      return Math.hypot(m.w, m.h) / 2;
    case "pin":
      return 22;
    default:
      return Math.max(...m.points.map((q) => Math.hypot(q[0], q[1])));
  }
}

/** What `warm_start` needs of a placement: the box, where it was placed for, its leader. */
function warm(p: Placement): object {
  if (!p.placed || !p.box) return { id: p.id, placed: false };
  return { id: p.id, placed: true, box: p.box, anchor: p.anchor, ...(p.leader ? { leader: { points: p.leader.points, style: p.leader.style } } : {}) };
}

const SIDES: Record<string, string> = {
  top: "above", bottom: "below", left: "to the left of", right: "to the right of",
  "top-left": "above, left of", "top-right": "above, right of", "bottom-left": "below, left of", "bottom-right": "below, right of",
};

interface Shown {
  g: SVGGElement;
  bg?: SVGRectElement;
  icon?: SVGPathElement;
  text?: SVGTextElement;
  look: Look | "name";
}

export class Hero {
  readonly root: HTMLElement;
  /** The latest result. */
  result: LabelResult | undefined;
  /** Solves done. */
  solves = 0;
  things: Thing[] = [];
  leaderStyle: "straight" | "elbow" | "curved" = "straight";

  #engine: WorkerEngine;
  #motion: LabelMotion;
  #svg: SVGSVGElement;
  #gDecor: SVGGElement;
  #gLeaders: SVGGElement;
  #gMarks: SVGGElement;
  #gLabels: SVGGElement;
  #tip: HTMLElement;
  #name: HTMLElement;
  #nameLabel: HTMLElement;
  #nameDot: SVGGraphicsElement;
  #hint: HTMLElement | null;
  #stats: HTMLElement | null;
  /** The widest the hint has been: labels keep off that much of it, as its numbers change. */
  #hintW = 0;
  #w = 0;
  #h = 0;
  /** The scenes' origins in this layout (null: not shown). */
  #origins = new Map<SceneId, Pt | null>();
  #obstacles: Rect[] = [];
  /** Where the static logo is: the things the header starts with keep clear of it. */
  #logo: Rect = [0, 0, 0, 0];
  /** The name's dot while it is where the static logo has it (not dragged since). */
  #nameHome = true;
  #nameAnchor: Pt = [0, 0];
  /** Where the name's dot was when the name last had a place, and the glide back there. */
  #nameOk: Pt | null = null;
  #glide: { from: Pt; to: Pt; t0: number } | null = null;
  #nameWarm: object | null = null;
  /**
   * The name's dot radius, leader width and corner radius as the static logo draws them;
   * the offset of its baseline from the top of its box.
   */
  #nameR = 8;
  #nameStroke = 4;
  #nameRx = 0;
  #nameBase = 0;
  /**
   * Where results report each label's anchor relative to the thing's anchor: an area's
   * pole, a group's reference point (labels follow that point between solves).
   */
  #anchorOffsets = new Map<string, Pt>();
  #ctx = document.createElement("canvas").getContext("2d")!;
  #marks = new Map<string, SVGGElement>();
  #leaders = new Map<string, SVGPathElement[]>();
  #labels = new Map<string, Shown>();
  /** The boxes as drawn, for hit tests. */
  #drawn = new Map<string, Box>();
  #busy = false;
  #dirty = false;
  /** Counts resets: a solve that started before one is not shown. */
  #generation = 0;
  #rest = true;
  #raf = 0;
  #drag: { thing: Thing | "name"; dx: number; dy: number; id: number } | null = null;
  #press: { x: number; y: number; t: number; id: number } | null = null;
  #added = 0;
  #reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(root: HTMLElement, engine: WorkerEngine) {
    this.root = root;
    this.#engine = engine;
    this.#motion = new LabelMotion(this.#reduced ? { duration: 0 } : { duration: 260, appearDelay: 120, holdTime: 250, moveDelay: 150 });
    this.#name = root.querySelector<HTMLElement>("[data-la-hero-name]")!;
    this.#nameLabel = root.querySelector<HTMLElement>("[data-la-hero-label]")!;
    this.#nameDot = root.querySelector<SVGGraphicsElement>("[data-la-hero-dot]")!;
    this.#hint = root.querySelector<HTMLElement>("[data-la-hero-hint]");
    this.#stats = root.querySelector<HTMLElement>("[data-la-hero-stats]");
    this.#svg = svg("svg", "la-hero__svg", { "aria-hidden": "true" });
    this.#gDecor = this.#svg.appendChild(svg("g"));
    this.#gLeaders = this.#svg.appendChild(svg("g"));
    this.#gMarks = this.#svg.appendChild(svg("g"));
    this.#gLabels = this.#svg.appendChild(svg("g"));
    root.querySelector("[data-la-hero-stage]")!.appendChild(this.#svg);
    this.#tip = root.appendChild(document.createElement("div"));
    this.#tip.className = "la-hero__tip";
    this.#tip.setAttribute("aria-hidden", "true");
    this.#tip.hidden = true;
    root.classList.add("has-toy");
    this.#reset();
    this.#listen();
    new ResizeObserver(() => this.#layout()).observe(root);
  }

  // --- layout -----------------------------------------------------------------------------

  /** Measures the stage, the text to keep off and the static logo; places the scenes; solves again. */
  #layout(): void {
    const r = this.root.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.#w = r.width;
    this.#h = r.height;
    this.#svg.setAttribute("viewBox", `0 0 ${px(r.width)} ${px(r.height)}`);
    this.#obstacles = this.#measureObstacles(r);
    this.#measureName();
    const lr = this.#name.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(this.#name).fontSize);
    this.#logo = [lr.left - r.left, lr.top - r.top, lr.width + em, lr.height + em];
    this.#placeScenes(r);
    const name = this.#labels.get("name");
    if (name?.text) this.#styleName(name.text);
    if (this.#nameHome) this.#homeName(r);
    else {
      // a dragged dot stays where it is, off the text that may have moved over it
      const at = this.#free(this.#nameAnchor[0], this.#nameAnchor[1], this.#nameR);
      if (at) this.#nameAnchor = at;
      else {
        this.#nameHome = true;
        this.#homeName(r);
      }
    }
    this.#drawDecor();
    this.#request(true);
  }

  #measureObstacles(origin: DOMRect): Rect[] {
    const out: Rect[] = [];
    const add = (b: DOMRect, pad: number) => {
      if (b.width > 0 && b.height > 0) out.push([b.left - origin.left - pad, b.top - origin.top - pad, b.width + 2 * pad, b.height + 2 * pad]);
    };
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-la-avoid]")) {
      const how = el.dataset.laAvoid;
      if (el === this.#hint) {
        const b = el.getBoundingClientRect();
        this.#hintW = Math.max(this.#hintW, b.width);
        add(new DOMRect(b.left + b.width / 2 - this.#hintW / 2, b.top, this.#hintW, b.height), 2);
      } else if (how === "text") {
        const range = document.createRange();
        range.selectNodeContents(el);
        for (const b of range.getClientRects()) add(b, 2);
      } else if (how === "children") {
        for (const c of el.children) add(c.getBoundingClientRect(), 2);
      } else add(el.getBoundingClientRect(), 2);
    }
    return out;
  }

  /** The scenes' origins: beside the text on wide headers, in the strip below it on narrow ones. */
  #placeScenes(origin: DOMRect): void {
    const strip = getComputedStyle(this.root).getPropertyValue("--la-hero-layout").trim() === "strip";
    const span = Math.min(this.#w - 32, 1320);
    // the strip: below the text, above the hint
    const hint = this.#hint?.getBoundingClientRect();
    const hintTop = hint ? hint.top - origin.top : this.#h;
    const textBottom = Math.max(0, ...this.#obstacles.filter((o) => o[1] < hintTop - 4).map((o) => o[1] + o[3]));
    const stripTop = textBottom + 8;
    const stripBottom = hintTop - 8;
    const alone = this.#w < (SCENES.network.strip?.minW ?? 0);
    for (const [id, s] of Object.entries(SCENES) as [Exclude<SceneId, "free">, (typeof SCENES)["map"]][]) {
      let at: Pt | null = [this.#w / 2 + (s.u * span) / 2, s.v * this.#h];
      if (strip) {
        const st = s.strip;
        at = !st || this.#w < st.minW || stripBottom - stripTop < 160 ? null : [this.#w * (alone && st.fxAlone ? st.fxAlone : st.fx), Math.min(stripTop + st.y, stripBottom - 60)];
      }
      this.#origins.set(id, at);
    }
    this.#origins.set("free", [0, 0]);
  }

  #measureName(): void {
    const tail = this.#nameDot.ownerSVGElement;
    const scale = tail ? tail.getBoundingClientRect().width / (tail.viewBox.baseVal.width || 1) : 1;
    const leader = this.root.querySelector("[data-la-hero-leader]");
    this.#nameR = this.#nameDot.getBoundingClientRect().width / 2;
    this.#nameStroke = parseFloat(leader?.getAttribute("stroke-width") ?? "") * scale || 4;
    const cs = getComputedStyle(this.#nameLabel);
    this.#nameRx = parseFloat(cs.borderTopLeftRadius) || 0;
    // where the browser puts the baseline in a line box: half the leading, then the ascent
    const size = parseFloat(cs.fontSize);
    const lh = parseFloat(cs.lineHeight) || size * 1.2;
    this.#ctx.font = `${cs.fontWeight} ${size}px ${cs.fontFamily}`;
    const m = this.#ctx.measureText("Label Anything");
    const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
    const desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
    this.#nameBase = parseFloat(cs.paddingTop) + (lh - (asc + desc)) / 2 + asc;
  }

  #styleName(text: SVGTextElement): void {
    const cs = getComputedStyle(this.#nameLabel);
    Object.assign(text.style, { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing });
  }

  /** The name's label and dot where the static logo draws them, as the warm start of the name. */
  #homeName(origin: DOMRect): void {
    const b = this.#nameLabel.getBoundingClientRect();
    const d = this.#nameDot.getBoundingClientRect();
    const box = { x: b.left - origin.left, y: b.top - origin.top, w: b.width, h: b.height };
    const a: Pt = [d.left - origin.left + d.width / 2, d.top - origin.top + d.height / 2];
    const r = this.#nameR;
    // the leader leaves the box at its point nearest to the dot and ends at the dot's edge
    const port: Pt = [Math.min(Math.max(a[0], box.x), box.x + box.w), Math.min(Math.max(a[1], box.y), box.y + box.h)];
    const len = Math.hypot(port[0] - a[0], port[1] - a[1]) || 1;
    const start: Pt = [a[0] + ((port[0] - a[0]) / len) * (r + 1.5), a[1] + ((port[1] - a[1]) / len) * (r + 1.5)];
    this.#nameAnchor = a;
    this.#nameWarm = { id: "name", placed: true, box, anchor: a, leader: { points: [start, port], style: "straight" } };
  }

  #pos(t: Thing): Pt | null {
    const o = this.#origins.get(t.scene);
    return o ? [o[0] + t.dx, o[1] + t.dy] : null;
  }

  #setPos(t: Thing, x: number, y: number): void {
    const o = this.#origins.get(t.scene) ?? [0, 0];
    t.dx = x - o[0];
    t.dy = y - o[1];
  }

  /** Whether a mark of reach `r` at (x, y) is on the stage and clear of the text (and, with `logo`, of the logo). */
  #clear(x: number, y: number, r: number, logo: boolean): boolean {
    if (x < 8 || x > this.#w - 8 || y < 8 || y > this.#h - 8) return false;
    const pad = r + 4;
    return ![...this.#obstacles, ...(logo ? [this.#logo] : [])].some(([ox, oy, ow, oh]) => x > ox - pad && x < ox + ow + pad && y > oy - pad && y < oy + oh + pad);
  }

  /** The things shown: those of the scenes shown, clear of the text and the logo, unless the user put them there. */
  #visible(): Thing[] {
    return this.things.filter((t) => {
      const p = this.#pos(t);
      if (!p) return false;
      if (t.moved || t.added !== undefined) return true;
      return this.#clear(p[0], p[1], t.mark.shape === "area" ? 12 : Math.min(extent(t), 14), true);
    });
  }

  /**
   * A place near (x, y) for a mark of reach r, on the stage and not under the text (things
   * stop at the text's edge, so they stay in reach and in sight); null where none is near.
   */
  #free(x: number, y: number, r: number): Pt | null {
    for (let i = 0; i < 6; i++) {
      x = Math.min(Math.max(x, 8), this.#w - 8);
      y = Math.min(Math.max(y, 8), this.#h - 8);
      const pad = r + 3;
      const hit = this.#obstacles.find(([ox, oy, ow, oh]) => x > ox - pad && x < ox + ow + pad && y > oy - pad && y < oy + oh + pad);
      if (!hit) return [x, y];
      const [ox, oy, ow, oh] = hit;
      // out over the nearest edge
      const out: [number, number, number][] = [
        [ox - pad - 0.5 - x, 0, x - (ox - pad)],
        [ox + ow + pad + 0.5 - x, 0, ox + ow + pad - x],
        [0, oy - pad - 0.5 - y, y - (oy - pad)],
        [0, oy + oh + pad + 0.5 - y, oy + oh + pad - y],
      ];
      out.sort((a, b) => a[2] - b[2]);
      x += out[0]![0];
      y += out[0]![1];
    }
    return null;
  }

  /** Where each label's anchor is now: the things' anchors, the areas' poles. */
  #anchors(things: Thing[]): Map<string, Pt> {
    const m = new Map<string, Pt>([["name", this.#nameAnchor]]);
    for (const t of things) {
      const p = this.#pos(t)!;
      const off = this.#anchorOffsets.get(t.id);
      m.set(t.id, off ? [p[0] + off[0], p[1] + off[1]] : p);
    }
    return m;
  }

  // --- the scenes' background: the river, the chart's points and trend, the network's edges ---

  #river(things: Thing[]): Pt[] | null {
    const lake = things.find((t) => t.id === "lake");
    const p = lake && this.#pos(lake);
    return p ? RIVER.map((q) => [p[0] + q[0], p[1] + q[1]] as Pt) : null;
  }

  #cloud(): Pt[] {
    const o = this.#origins.get("chart");
    if (!o) return [];
    return CLOUD.map((q) => [o[0] + q[0], o[1] + q[1]] as Pt).filter((q) => this.#clear(q[0], q[1], 3, true));
  }

  #trend(): Pt[] | null {
    const o = this.#origins.get("chart");
    return o && this.#cloud().length ? TREND.map((q) => [o[0] + q[0], o[1] + q[1]] as Pt) : null;
  }

  #edges(things: Thing[]): Pt[][] {
    const at = new Map(things.map((t) => [t.id, this.#pos(t)!] as const));
    return EDGES.filter(([a, b]) => at.has(a) && at.has(b)).map(([a, b]) => [at.get(a)!, at.get(b)!]);
  }

  /** The static background: the chart's points and trend line. */
  #drawDecor(): void {
    for (const e of this.#gDecor.querySelectorAll(".la-hero__trend, .la-hero__cloud")) e.remove();
    const trend = this.#trend();
    if (trend) this.#gDecor.prepend(svg("path", "la-hero__trend", { d: pathOf(trend) }));
    for (const q of this.#cloud()) this.#gDecor.appendChild(svg("circle", "la-hero__cloud", { cx: px(q[0]), cy: px(q[1]), r: 2.5 }));
  }

  // --- solving -----------------------------------------------------------------------------

  #label(t: Thing): object {
    const text = { type: "text", text: t.text, font: { size: t.size }, ...(t.alternatives ? { alternatives: t.alternatives } : {}) };
    if (t.icon) return { type: "composite", direction: "row", gap: 4, padding: 4, parts: [{ type: "icon", width: 13, height: 13 }, text] };
    if (t.wrap) return { ...text, wrap: { max_width: "8em", max_lines: 2 }, padding: 5 };
    if (t.look === "pill") return { ...text, padding: 3 };
    return text;
  }

  #anchor(t: Thing): object {
    const [x, y] = this.#pos(t)!;
    const m = t.mark;
    switch (m.shape) {
      case "area":
        return { type: "area", polygon: m.points.map((q) => [round1(x + q[0]), round1(y + q[1])]) };
      case "circle":
        return { type: "point", x, y, mark: { shape: "circle", r: m.r } };
      case "planet":
        return { type: "point", x, y, mark: { shape: "ellipse", rx: m.rx, ry: m.ry, rotation: m.rotation } };
      case "rect":
        return { type: "point", x, y, mark: { shape: "rect", w: m.w, h: m.h, corner_radius: m.corner, rotation: m.rotation } };
      case "polygon":
        return { type: "point", x, y, mark: { shape: "polygon", points: m.points, relative: true } };
      case "pin":
        return { type: "point", x, y, mark: { shape: "icon", w: 16, h: 22, tip: [8, 22], silhouette: PIN_SILHOUETTE } };
    }
  }

  #problem(things: Thing[], rest: boolean): LabelProblem {
    const nb = this.#nameLabel.getBoundingClientRect();
    const nameFont = parseFloat(getComputedStyle(this.#nameLabel).fontSize);
    const pad = Math.round(nb.height * 0.2);
    const placements = this.result?.placements.filter((p) => p.id !== "name" || !this.#nameHome).map(warm) ?? [];
    if (this.#nameHome && this.#nameWarm) placements.push(this.#nameWarm);
    const sides = ["top-left", "top-right", "bottom-left", "bottom-right", "left", "right", "top", "bottom"];
    const vector: object[] = [];
    if (this.#obstacles.length) vector.push({ class: "text", rects: this.#obstacles });
    const river = this.#river(things);
    if (river) vector.push({ class: "water", polylines: [river], width: 4 });
    const edges = this.#edges(things);
    if (edges.length) vector.push({ class: "edges", polylines: edges, width: 2 });
    const cloud = this.#cloud();
    if (cloud.length) vector.push({ class: "points", points: cloud, r: 2.5 });
    const trend = this.#trend();
    if (trend) vector.push({ class: "lines", polylines: [trend], width: 1.5 });
    return {
      canvas: { width: Math.round(this.#w), height: Math.round(this.#h), padding: 6 },
      preset: "none",
      defaults: { font: { size: 12 }, padding: 2 },
      items: [
        {
          id: "name",
          anchor: { type: "point", x: this.#nameAnchor[0], y: this.#nameAnchor[1], mark: { shape: "circle", r: this.#nameR } },
          label: {
            type: "text",
            text: this.#nameLabel.textContent?.trim() ?? "",
            width: Math.max(1, nb.width - 2 * pad),
            height: Math.max(1, nb.height - 2 * pad),
            padding: pad,
            font: { size: nameFont, weight: "bold" },
          },
          priority: 100,
          required: true,
          // the logo keeps its leader: the name sits at a distance from its dot
          placement: { models: ["distant"], position_order: sides },
        },
        ...things.map((t) => ({
          id: t.id,
          anchor: this.#anchor(t),
          label: this.#label(t),
          priority: t.priority,
          ...(t.group ? { group: t.group } : {}),
          ...(t.models || t.internal ? { placement: { ...(t.models ? { models: t.models } : {}), ...(t.internal ? { internal: t.internal } : {}) } } : {}),
        })),
      ],
      obstacles: vector.length ? { vector } : undefined,
      // labels keep off the river, the edges, the chart's points and its trend line where
      // they can; the name may cover the marks of less important things (they lose their labels)
      avoid: {
        label: { water: 2, edges: 1, points: 0.5, lines: 1, lower_items: 10 },
        leader: { text: 2, water: 0.3, lower_items: 2.5 },
      },
      // fewer candidates than the defaults (a third of the solve time, about the same layout)
      placement: {
        models: ["adjacent", "slider", "internal", "distant"],
        min_distance: "1em",
        max_distance: "6em",
        slider_per_quadrant: 2,
        distant_rings: 3,
        distant_directions: 12,
        k_distant: 12,
        free_space_seeds: false,
      },
      leaders: { style: this.leaderStyle, max_length: "8em", width: 1.5 },
      degrade: ["alternatives", "wrap", "distant", "evict_lower", "omit"],
      solver: { time_budget_ms: rest ? BUDGET_REST : BUDGET_MOVING, grid_cell: 6 },
      warm_start: { placements },
    } as unknown as LabelProblem;
  }

  /** Solves again (once the solve running has returned). */
  #request(rest: boolean): void {
    this.#dirty = true;
    this.#rest = rest;
    if (!this.#busy) void this.#solve();
  }

  async #solve(): Promise<void> {
    this.#busy = true;
    while (this.#dirty && this.#w > 0) {
      this.#dirty = false;
      const things = this.#visible();
      const generation = this.#generation;
      const rest = this.#rest;
      const problem = this.#problem(things, rest);
      const at = new Map(things.map((t) => [t.id, this.#pos(t)!] as const));
      at.set("name", this.#nameAnchor);
      try {
        const result = await this.#engine.place(problem);
        if (generation !== this.#generation) continue;
        this.result = result;
        this.solves++;
        for (const p of result.placements) {
          const a = at.get(p.id);
          if (p.anchor && a && p.id !== "name") this.#anchorOffsets.set(p.id, [p.anchor[0]! - a[0], p.anchor[1]! - a[1]]);
        }
        this.#motion.target(result);
        // the name always shows: where it has no room, its dot glides back once let go
        if (result.placements.some((p) => p.id === "name" && p.placed)) this.#nameOk = at.get("name")!;
        else if (rest && !this.#drag && this.#nameOk) this.#glide = { from: this.#nameAnchor, to: this.#nameOk, t0: performance.now() };
        this.#showStats(result);
        this.#kick();
        // the first solves compile the engine's code: two more, so that the first drag is smooth
        if (this.solves < 3) this.#request(this.#rest);
      } catch (e) {
        console.warn("label-anything hero:", e);
        break;
      }
    }
    this.#busy = false;
  }

  #showStats(r: LabelResult): void {
    if (!this.#stats) return;
    // grouped items share a label: they are neither placed nor left out
    const grouped = r.placements.filter((p) => p.reason === "grouped").length;
    const omitted = r.stats.total - r.stats.placed - grouped;
    this.#stats.textContent = `${r.stats.placed} labels placed${omitted > 0 ? `, ${omitted} left out` : ""}`;
    if (this.#hint && this.#hint.getBoundingClientRect().width > this.#hintW + 0.5) this.#layout();
  }

  // --- drawing -----------------------------------------------------------------------------

  #kick(): void {
    if (!this.#raf) this.#raf = requestAnimationFrame(() => this.#frame());
  }

  #frame(): void {
    this.#raf = 0;
    if (this.#glide) {
      const { from, to, t0 } = this.#glide;
      const t = this.#reduced ? 1 : Math.min(1, (performance.now() - t0) / 350);
      const e = 1 - (1 - t) ** 3;
      this.#nameAnchor = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
      if (t >= 1) {
        this.#glide = null;
        this.#request(true);
      }
    }
    const things = this.#visible();
    const anchors = this.#anchors(things);
    this.#drawMarks(things);
    const f = this.#motion.frame(anchors);
    this.#drawLabels(f.result.placements, f.opacity, f.leaderOpacity, anchors);
    // the drawing takes over from the static logo once it shows the name
    if (this.result?.placements.some((p) => p.id === "name" && p.placed)) this.root.classList.add("is-live");
    if (this.#motion.moving || this.#drag || this.#glide) this.#kick();
  }

  /** A mark's drawing, at the origin (moved into place with a transform). */
  #markShape(t: Thing | "name"): SVGGElement {
    const g = svg("g", "la-hero__mark");
    if (t === "name") {
      g.classList.add("la-hero__mark--name");
      g.appendChild(svg("circle", undefined, { r: px(this.#nameR) }));
      return g;
    }
    g.classList.add(`la-hero__mark--${t.look}`);
    if (t.accent) g.classList.add("la-hero__mark--accent");
    const m = t.mark;
    switch (m.shape) {
      case "circle":
        g.appendChild(svg("circle", undefined, { r: m.r }));
        break;
      case "planet":
        g.appendChild(svg("circle", undefined, { r: m.r }));
        g.appendChild(svg("ellipse", "la-hero__ring", { rx: m.rx, ry: m.ry, transform: `rotate(${m.rotation})` }));
        break;
      case "rect":
        g.appendChild(svg("rect", undefined, { x: -m.w / 2, y: -m.h / 2, width: m.w, height: m.h, rx: m.corner, transform: `rotate(${m.rotation})` }));
        break;
      case "polygon":
        g.appendChild(svg("path", undefined, { d: pathOf(m.points, true) }));
        break;
      case "pin":
        g.classList.add("la-hero__mark--pin");
        g.appendChild(svg("path", undefined, { d: PIN_PATH }));
        g.appendChild(svg("circle", "la-hero__pin-eye", { cy: -14, r: 2.6 }));
        break;
      case "area":
        g.classList.add("la-hero__mark--area");
        g.appendChild(svg("path", "la-hero__river", { d: smoothPathOf(RIVER) }));
        g.appendChild(svg("path", undefined, { d: pathOf(m.points, true) }));
        break;
    }
    return g;
  }

  #drawMarks(things: Thing[]): void {
    const seen = new Set<string>();
    const place = (id: string, t: Thing | "name", at: Pt, layer: SVGGElement) => {
      seen.add(id);
      let g = this.#marks.get(id);
      if (!g) {
        g = layer.appendChild(this.#markShape(t));
        this.#marks.set(id, g);
      }
      g.setAttribute("transform", `translate(${px(at[0])} ${px(at[1])})`);
    };
    // the network's edges, and areas, under the other marks
    let e = this.#gDecor.querySelector<SVGPathElement>(".la-hero__edges");
    if (!e) e = this.#gDecor.appendChild(svg("path", "la-hero__edges"));
    e.setAttribute("d", this.#edges(things).map((q) => pathOf(q)).join(""));
    for (const t of things) place(t.id, t, this.#pos(t)!, t.mark.shape === "area" ? this.#gDecor : this.#gMarks);
    place("name", "name", this.#nameAnchor, this.#gMarks);
    for (const [id, g] of this.#marks) {
      if (!seen.has(id)) {
        g.remove();
        this.#marks.delete(id);
      }
    }
  }

  #drawLabels(placements: readonly Placement[], opacity: ReadonlyMap<string, number>, leaderOpacity: ReadonlyMap<string, number>, anchors: Map<string, Pt>): void {
    const seen = new Set<string>();
    this.#drawn.clear();
    const byId = new Map(this.things.map((t) => [t.id, t] as const));
    for (const p of placements) {
      if (!p.placed || !p.box) continue;
      const id = p.id;
      const t = byId.get(id);
      const main = id === "name";
      if (!main && !t) continue;
      seen.add(id);
      const o = opacity.get(id) ?? 1;
      this.#drawLeaders(p, main, leaderOpacity.get(id) ?? o, anchors);
      let s = this.#labels.get(id);
      if (!s) {
        s = this.#newLabel(main ? "name" : t!);
        this.#labels.set(id, s);
      }
      const b = p.box;
      if (s.bg) {
        const r = main ? this.#nameRx : s.look === "pill" ? b.h / 2 : 4;
        for (const [k, v] of Object.entries({ x: b.x, y: b.y, width: b.w, height: b.h, rx: r })) s.bg.setAttribute(k, px(v));
      }
      if (main) {
        s.text!.setAttribute("x", px(b.x + b.w / 2));
        s.text!.setAttribute("y", px(b.y + this.#nameBase));
      } else {
        const textPart = p.parts?.find((q) => q.type === "text");
        const icon = p.parts?.find((q) => q.type === "icon");
        if (icon && s.icon) s.icon.setAttribute("transform", `translate(${px(icon.box.x)} ${px(icon.box.y)}) scale(${px(icon.box.w / 16)})`);
        const info = textPart?.text ?? p.text;
        if (info && s.text) this.#setText(s.text, info, textPart?.box ?? b);
      }
      // a label meant to sit inside its shape that had to go outside is drawn like the others
      if (s.look === "inside") s.g.classList.toggle("la-hero__label--out", p.model !== "internal");
      s.g.style.opacity = String(o);
      this.#drawn.set(id, b);
    }
    for (const [id, s] of this.#labels) {
      if (!seen.has(id)) {
        s.g.remove();
        this.#labels.delete(id);
        for (const path of this.#leaders.get(id) ?? []) path.remove();
        this.#leaders.delete(id);
      }
    }
  }

  #newLabel(t: Thing | "name"): Shown {
    const look = t === "name" ? "name" : t.look;
    const g = this.#gLabels.appendChild(svg("g", `la-hero__label la-hero__label--${look}`));
    const s: Shown = { g, look };
    if (look === "name" || look === "chip" || look === "pill" || look === "callout") s.bg = g.appendChild(svg("rect", "la-hero__bg"));
    if (t !== "name" && t.icon) s.icon = g.appendChild(svg("path", "la-hero__icon", { d: ICONS[t.icon] }));
    s.text = g.appendChild(svg("text"));
    if (t === "name") {
      s.text.textContent = this.#nameLabel.textContent?.trim() ?? "";
      s.text.setAttribute("text-anchor", "middle");
      this.#styleName(s.text);
    } else {
      s.text.style.fontFamily = LABEL_FONT;
      if (t.accent) g.classList.add("la-hero__label--accent");
    }
    return s;
  }

  /** The text's lines at the baselines the engine measured them for. */
  #setText(el: SVGTextElement, info: TextInfo, box: Box): void {
    const key = info.lines.join("\n");
    if (el.dataset.lines !== key) {
      el.replaceChildren(...info.lines.map((line) => Object.assign(svg("tspan"), { textContent: line })));
      el.dataset.lines = key;
    }
    el.style.fontSize = `${px(info.font_size)}px`;
    const x0 = box.x + (info.x_offset ?? 0);
    [...el.children].forEach((span, i) => {
      span.setAttribute("x", px(x0));
      span.setAttribute("y", px(box.y + (info.baseline_offsets[i] ?? 0)));
    });
  }

  #drawLeaders(p: Placement, main: boolean, opacity: number, anchors: Map<string, Pt>): void {
    const leaders = p.leaders?.length ? p.leaders : p.leader ? [p.leader] : [];
    const paths = this.#leaders.get(p.id) ?? [];
    while (paths.length > leaders.length) paths.pop()!.remove();
    while (paths.length < leaders.length) paths.push(this.#gLeaders.appendChild(svg("path", main ? "la-hero__leader la-hero__leader--name" : "la-hero__leader")));
    this.#leaders.set(p.id, paths);
    leaders.forEach((l, i) => {
      const pts = l.points.map((q) => [q[0]!, q[1]!] as Pt);
      if (main) {
        // from the dot's centre (the dot covers its start) into the box, under its rounded
        // corner, as the static logo draws it
        const a = anchors.get("name");
        if (a) pts[0] = a;
        const [q, e] = [pts[pts.length - 2]!, pts[pts.length - 1]!];
        const len = Math.hypot(e[0] - q[0], e[1] - q[1]) || 1;
        pts[pts.length - 1] = [e[0] + ((e[0] - q[0]) / len) * this.#nameRx, e[1] + ((e[1] - q[1]) / len) * this.#nameRx];
        paths[i]!.style.strokeWidth = `${px(this.#nameStroke)}px`;
      }
      paths[i]!.setAttribute("d", pathOf(pts));
      paths[i]!.style.opacity = String(opacity);
    });
  }

  // --- interaction -------------------------------------------------------------------------

  /** The mark or label at a point: its thing, or "name". */
  #hit(x: number, y: number, touch: boolean): Thing | "name" | null {
    const slop = touch ? 14 : 6;
    if (Math.hypot(x - this.#nameAnchor[0], y - this.#nameAnchor[1]) <= this.#nameR + slop) return "name";
    const things = this.#visible();
    // labels first (they are drawn on top), then the nearest mark
    const nb = this.#drawn.get("name");
    if (nb && inside(nb, x, y)) return "name";
    for (const t of things) {
      const b = this.#drawn.get(t.id);
      if (b && inside(b, x, y, touch ? 4 : 0)) return t;
    }
    let best: Thing | null = null;
    let bestD = Infinity;
    for (const t of things) {
      const [tx, ty] = this.#pos(t)!;
      const m = t.mark;
      let d: number;
      if (m.shape === "area") {
        const xs = m.points.map((q) => q[0]);
        const ys = m.points.map((q) => q[1]);
        const bx = { x: tx + Math.min(...xs), y: ty + Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        d = inside(bx, x, y) ? 0 : Infinity;
      } else if (m.shape === "pin") d = Math.hypot(x - tx, y - (ty - 14)) - 8;
      else d = Math.hypot(x - tx, y - ty) - Math.min(extent(t), 14);
      if (d <= slop && d < bestD) [best, bestD] = [t, d];
    }
    return best;
  }

  /** How a label was placed, or why it was left out: [what, how]. */
  describe(id: string): [string, string] | null {
    const r = this.result;
    const p = r?.placements.find((q) => q.id === id);
    if (!r || !p) return null;
    const t = this.things.find((q) => q.id === id);
    const title = id === "name" ? "Label Anything" : p.members && p.text ? p.text.lines.join(" ") : (t?.text ?? id);
    const nameOf = (q: string) => (q === "name" ? "the name" : (this.things.find((u) => u.id === q)?.text ?? q));
    if (!p.placed) {
      if (p.reason === "grouped") {
        const rep = r.placements.find((q) => q.members?.includes(id));
        return [title, rep?.placed ? `shares one label with ${(rep.members?.length ?? 1) - 1} other points` : "left out with its group"];
      }
      const by = (p.blocked_by ?? []).slice(0, 2).map(nameOf);
      const why = p.reason === "omitted_by_priority" ? "a more important label needs the room" : "no free place";
      return [title, `left out: ${why}${by.length ? ` (${by.join(", ")} in the way)` : ""}`];
    }
    const say: string[] = [];
    if (p.members && p.members.length > 1) say.push(`one label for ${p.members.length} points`);
    const what = p.members && p.members.length > 1 ? "the points" : t?.mark.shape === "pin" ? "its pin" : "its mark";
    switch (p.model) {
      case "internal":
        say.push(t?.mark.shape === "area" ? "inside its area" : "inside its shape");
        break;
      case "adjacent":
      case "slider":
        say.push(`${SIDES[p.anchor_side ?? ""] ?? "next to"} ${what}, touching ${what === "the points" ? "their" : "its"} outline`);
        break;
      case "distant":
        say.push(`out on ${(p.leaders?.length ?? 0) > 1 ? "leaders" : "a leader"}, where it has room`);
        break;
      case "fan":
        say.push("in a fan column, on a leader");
        break;
      case "boundary":
        say.push("in the margin, on a leader");
        break;
    }
    const used = (p.parts?.find((q) => q.text)?.text ?? p.text)?.used ?? "";
    if (used.startsWith("alternative")) say.push(`shortened from “${t?.text}”`);
    if ((p.text?.lines.length ?? 1) > 1) say.push(`wrapped into ${p.text!.lines.length} lines`);
    if (p.degrade_steps?.includes("evict_lower")) say.push("taking a less important label's place");
    return [title, say.join("; ")];
  }

  #showTip(hit: Thing | "name" | null, x: number, y: number): void {
    const d = hit && this.describe(hit === "name" ? "name" : hit.id);
    if (!d) {
      this.#tip.hidden = true;
      return;
    }
    this.#tip.replaceChildren(Object.assign(document.createElement("strong"), { textContent: d[0] }), document.createTextNode(` ${d[1]}`));
    this.#tip.hidden = false;
    const w = this.#tip.offsetWidth;
    const h = this.#tip.offsetHeight;
    this.#tip.style.left = `${px(Math.min(Math.max(8, x + 14), this.#w - w - 8))}px`;
    this.#tip.style.top = `${px(y + 18 + h > this.#h ? y - h - 12 : y + 18)}px`;
  }

  #at(e: PointerEvent): Pt {
    const r = this.root.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  #listen(): void {
    // on the whole header: the text's boxes are wider than its lines, and a mark or a label
    // can sit next to a line, inside the box of its paragraph
    const root = this.root;
    const onStage = (e: Event) => e.target instanceof Node && this.#svg.contains(e.target);
    const grabbable = (e: Event) => !(e.target instanceof Element && e.target.closest("a, button"));
    root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !grabbable(e)) return;
      const [x, y] = this.#at(e);
      const hit = this.#hit(x, y, e.pointerType !== "mouse");
      if (hit) {
        const [ax, ay] = hit === "name" ? this.#nameAnchor : this.#pos(hit)!;
        this.#drag = { thing: hit, dx: ax - x, dy: ay - y, id: e.pointerId };
        if (hit === "name") this.#glide = null;
        this.#tip.hidden = true;
        root.setPointerCapture(e.pointerId);
        root.classList.add("is-dragging");
        e.preventDefault();
      } else if (onStage(e)) {
        this.#press = { x, y, t: performance.now(), id: e.pointerId };
      }
    });
    // on touch screens, a finger on a mark or label drags it instead of scrolling the page
    root.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        if (!t || !grabbable(e)) return;
        const r = root.getBoundingClientRect();
        if (this.#hit(t.clientX - r.left, t.clientY - r.top, true)) e.preventDefault();
      },
      { passive: false },
    );
    root.addEventListener("pointermove", (e) => {
      const [x, y] = this.#at(e);
      if (!this.#drag) {
        if (e.pointerType !== "mouse") return;
        const hit = grabbable(e) ? this.#hit(x, y, false) : null;
        root.classList.toggle("is-over", hit !== null);
        this.#showTip(hit, x, y);
        return;
      }
      if (e.pointerId !== this.#drag.id) return;
      const thing = this.#drag.thing;
      const reach = thing === "name" ? this.#nameR : thing.mark.shape === "area" ? 20 : Math.min(extent(thing), 14);
      const to = this.#free(x + this.#drag.dx, y + this.#drag.dy, reach);
      if (!to) return;
      if (thing === "name") {
        this.#nameHome = false;
        this.#nameAnchor = to;
      } else {
        thing.moved = true;
        this.#setPos(thing, to[0], to[1]);
      }
      this.#request(false);
      this.#kick();
    });
    root.addEventListener("pointerleave", () => {
      this.#tip.hidden = true;
      root.classList.remove("is-over");
    });
    const end = (e: PointerEvent) => {
      if (this.#drag && e.pointerId === this.#drag.id) {
        this.#drag = null;
        root.classList.remove("is-dragging");
        this.#request(true);
        return;
      }
      const p = this.#press;
      this.#press = null;
      if (!p || p.id !== e.pointerId || e.type !== "pointerup") return;
      const [x, y] = this.#at(e);
      if (Math.hypot(x - p.x, y - p.y) < 6 && performance.now() - p.t < 600) this.#add(x, y);
    };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
    root.querySelector("[data-la-hero-reset]")?.addEventListener("click", () => {
      this.#reset();
      this.#layout();
    });
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-la-hero-styles] button[data-style]")) {
      b.addEventListener("click", () => this.setLeaderStyle(b.dataset.style as Hero["leaderStyle"]));
    }
  }

  /** Switches the leader style of every label (the name's too) and solves again. */
  setLeaderStyle(style: Hero["leaderStyle"]): void {
    this.leaderStyle = style;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>("[data-la-hero-styles] button[data-style]")) {
      b.setAttribute("aria-pressed", String(b.dataset.style === style));
    }
    this.#request(true);
  }

  /** A new thing where the user clicked, the next of `MORE`. */
  #add(x: number, y: number): void {
    const n = this.#added;
    const t: Thing = { ...MORE[n % MORE.length]!, id: `add${n}`, scene: "free", dx: 0, dy: 0, added: n };
    const at = this.#free(x, y, Math.min(extent(t), 14));
    if (!at) return;
    this.#added++;
    this.#setPos(t, at[0], at[1]);
    this.things.push(t);
    const added = this.things.filter((q) => q.added !== undefined);
    if (added.length > MAX_ADDED) this.things.splice(this.things.indexOf(added[0]!), 1);
    this.#request(true);
    this.#kick();
  }

  #reset(): void {
    this.things = THINGS.map((t) => ({ ...t }));
    this.#added = 0;
    this.#nameHome = true;
    this.#nameOk = null;
    this.#glide = null;
    this.#anchorOffsets.clear();
    this.result = undefined;
    this.#generation++;
  }
}

/** Starts the live header of the page, if it has one, once the labels' font is loaded. */
export async function start(doc: Document = document): Promise<Hero | undefined> {
  const root = doc.querySelector<HTMLElement>("[data-la-hero]");
  if (!root || typeof Worker === "undefined") return undefined;
  const engine = createWorkerEngine(() => new Worker(new URL("engine-ts.js", import.meta.url), { type: "module", name: "label-anything-hero" }));
  try {
    const font = new FontFace("LA Noto Sans", `url(${new URL("fonts/NotoSans-Regular.ttf", import.meta.url).href})`);
    doc.fonts.add(font);
    await Promise.race([font.load(), new Promise((ok) => setTimeout(ok, 4000))]);
  } catch {
    // drawn with a fallback font: the boxes fit the text a little less well
  }
  const hero = new Hero(root, engine);
  (globalThis as { labelAnythingHero?: Hero }).labelAnythingHero = hero;
  return hero;
}

void start();
