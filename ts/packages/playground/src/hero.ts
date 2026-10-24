/**
 * The live header of the documentation's home page (docs/_overrides/home.html), taking the
 * name literally: the logo — a label, its leader and a dot — carries the name as its label,
 * among random things (a rubber duck, coffee, a cactus, the moon, a pair of socks, …), each
 * drawn with its true outline and labeled by the engine. Once the page has loaded, more
 * things come, one at a time, to show that the header is live, until the user takes over
 * (or the header is full); otherwise nothing moves by itself: things move when they are
 * dragged or shuffled, a click adds another, the leader style can be switched, and
 * hovering a label or a thing tells how its label was placed or why it was left out. On
 * the way the engine shows what it does: labels touch the true outlines (into a banana's
 * curve), the moon is labeled inside, the socks share one label, long labels shorten or
 * wrap, the crown's label comes first, and every label keeps off the text.
 *
 * Built into dist/hero.js; the home page loads it from the playground's directory and
 * solves with the playground's TypeScript engine (engine-ts.js) in a worker. Without it
 * (e.g. under `mkdocs serve`) the header shows the static logo the live one starts from.
 *
 * The page provides, inside `[data-la-hero]`: the stage the drawing goes into
 * (`[data-la-hero-stage]`), the static logo (`[data-la-hero-name]` with its label
 * `[data-la-hero-label]`, leader `[data-la-hero-leader]`, dot `[data-la-hero-dot]` and the
 * join where the leader grows out of the label `[data-la-hero-join]`),
 * the elements to keep labels off (`[data-la-avoid]`: `text` for the boxes of its lines,
 * `children` for each child's box, empty for its own box) and the hint shown while live
 * (`[data-la-hero-hint]`, out of the flow, with `[data-la-hero-stats]`, the leader styles
 * `[data-la-hero-styles] button[data-style]`, `[data-la-hero-shuffle]` and
 * `[data-la-hero-reset]`). The custom property `--la-hero-layout` says where the things
 * go: `wide` (beside the text) or `strip` (below it, in the room the class `has-toy` makes).
 * The attribute `data-la-hero-reveal` on `[data-la-hero]` turns on the things that come by
 * themselves (not with reduced motion).
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";
import { LabelMotion } from "@label-anything/extras";
import { createWorkerEngine, type WorkerEngine } from "@label-anything/extras/worker";
import { labelPath } from "./logo.js";

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
const MAX_ADDED = 12;
/** How long a shuffle takes things to their new places (ms). */
const SHUFFLE_MS = 600;
/** The reveal: the first thing comes this long after the page has loaded, the next ones this far apart (ms). */
const REVEAL_FIRST = 1500;
const REVEAL_EVERY = 2500;
/** A thing revealed keeps at least this far from the other things, the labels and the text (px): where none is that free, the reveal ends. */
const REVEAL_ROOM = 24;

// --- the things ---------------------------------------------------------------------------

const r1 = (n: number) => Math.round(n * 10) / 10;
/** Points on an ellipse arc, from a0 to a1 (degrees, clockwise on screen from +x). */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n: number): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    return [r1(cx + rx * Math.cos(a)), r1(cy + ry * Math.sin(a))] as Pt;
  });
}
const circle = (cx: number, cy: number, r: number, n = 20) => arc(cx, cy, r, r, 0, 360 * (1 - 1 / n), n - 1);
const rotate = (pts: Pt[], deg: number): Pt[] => {
  const a = (deg * Math.PI) / 180;
  return pts.map(([x, y]) => [r1(x * Math.cos(a) - y * Math.sin(a)), r1(x * Math.sin(a) + y * Math.cos(a))]);
};

/** What a thing looks like: its outline (the engine's mark), and the details drawn on it. */
interface Art {
  outline: Pt[];
  holes?: Pt[][];
  /** Colours of the outline's fill and stroke (theme-independent: things have colours). */
  fill: string;
  stroke: string;
  /** Details: SVG markup drawn over the filled outline, at the same origin. */
  details?: string;
  /** A round thing: a circle mark of this radius instead of the outline. */
  r?: number;
}

const D = (s: TemplateStringsArray) => s.join("");
const ARTS: Record<string, Art> = {
  duck: {
    outline: [[-19, -4], [-13, 0], [-6, 1], ...arc(7, -7, 7, 7, 165, 350, 8), [14.4, -9.4], [20.5, -6.5], [14.2, -4], ...arc(7, -7, 7, 7, 30, 75, 3), [11, 0.5], ...arc(-1, 6, 15, 9, -25, 200, 12), [-17, 0]],
    fill: "#ffd23f",
    stroke: "#c99a00",
    details: D`<path d="M14.4-9.4L20.5-6.5 14.2-4Z" fill="#ff8c1a"/><circle cx="8.6" cy="-9" r="1.4" fill="#263238"/><path d="M-9 5Q-2 0 5 6" fill="none" stroke="#c99a00" stroke-width="1.2"/>`,
  },
  coffee: {
    outline: [[-10, -6], [10, -6], ...arc(11, 1, 6.5, 6.5, -80, 80, 6), [9.3, 7.5], [7, 12], [13, 12.8], [11.5, 15.5], [-11.5, 15.5], [-13, 12.8], [-7, 12]],
    fill: "#fafafa",
    stroke: "#6d4c41",
    details: D`<path d="M9.8-3C16.5-3 16.5 6.5 8.8 6.5" fill="none" stroke="#6d4c41" stroke-width="2.2"/><ellipse cx="0" cy="13.8" rx="12.5" ry="1.8" fill="#d7ccc8" stroke="#6d4c41" stroke-width="0.8"/><ellipse cx="0" cy="-6" rx="9.6" ry="1.9" fill="#6d4c41"/>`,
  },
  cactus: {
    outline: [...arc(0, -17, 4.5, 4.5, 180, 360, 6), [4.5, -6], [7, -6], [7, -14], ...arc(10.25, -14, 3.25, 3.25, 180, 360, 5), [13.5, -2.5], [4.5, -2.5], [4.5, 8], [10, 8], [10, 11], [8.6, 11], [7, 19], [-7, 19], [-8.6, 11], [-10, 11], [-10, 8], [-4.5, 8], [-4.5, 3.5], [-14.5, 3.5], [-14.5, -9], ...arc(-11, -9, 3.5, 3.5, 180, 360, 5), [-7.5, -1], [-4.5, -1]],
    fill: "#43a047",
    stroke: "#2e7d32",
    details: D`<path d="M-10 8H10V11H8.6L7 19H-7L-8.6 11H-10Z" fill="#d7774f" stroke="#a0522d" stroke-width="0.8"/><path d="M-1.5-12v2M1.5-6v2M-1.5 0v2M10.3-10v2M-11-5v2" stroke="#1b5e20" stroke-width="1" stroke-linecap="round"/>`,
  },
  banana: {
    outline: [...arc(0, -24, 30, 30, 40, 140, 10), ...arc(0, -30, 26, 26, 128, 52, 8), [17.5, -12.5], [20.5, -15.5], [22, -14], [19.5, -10.5]],
    fill: "#ffe066",
    stroke: "#c9a400",
    details: D`<path d="M17.5-12.5L20.5-15.5 22-14 19.5-10.5Z" fill="#8d6e00"/><circle cx="-22.7" cy="-4.5" r="1.3" fill="#5d4037"/>`,
  },
  rocket: {
    outline: rotate([[0, -20], [3.5, -15], [6, -9], [6, 4], [11, 13], [6, 12], [3, 14], [1.5, 19], [0, 17], [-1.5, 19], [-3, 14], [-6, 12], [-11, 13], [-6, 4], [-6, -9], [-3.5, -15]], 35),
    fill: "#eceff1",
    stroke: "#78909c",
    details: D`<g transform="rotate(35)"><path d="M0-20L3.5-15 6-9H-6L-3.5-15Z" fill="#e53935"/><path d="M6 4L11 13 6 12ZM-6 4L-11 13-6 12Z" fill="#e53935"/><path d="M3 14L1.5 19 0 17-1.5 19-3 14Z" fill="#ff9800"/><circle cy="-2" r="3" fill="#42a5f5" stroke="#78909c" stroke-width="0.8"/></g>`,
  },
  plane: {
    outline: [[17, -11], [-16, 0], [-5, 3.5], [-3, 13], [2, 6.5], [9, 10]],
    fill: "#bbdefb",
    stroke: "#1e88e5",
    details: D`<path d="M17-11L-5 3.5-3 13M17-11L2 6.5" fill="none" stroke="#1e88e5" stroke-width="0.9"/>`,
  },
  bulb: {
    outline: [...arc(0, -5, 11, 11, 120, 420, 14), [4.5, 9], [4.5, 14.5], [2, 17], [-2, 17], [-4.5, 14.5], [-4.5, 9]],
    fill: "#fff59d",
    stroke: "#f9a825",
    details: D`<path d="M-4.5 9H4.5V14.5L2 17H-2L-4.5 14.5Z" fill="#b0bec5" stroke="#78909c" stroke-width="0.8"/><path d="M-4.5 11.5H4.5M-4.5 13.8H4.5" stroke="#78909c" stroke-width="0.8"/><path d="M-3 6L-1.5-1 0 3 1.5-1 3 6" fill="none" stroke="#f57f17" stroke-width="1"/>`,
  },
  key: {
    outline: [...arc(-11, 0, 7.5, 7.5, 15, 345, 14), [16, -2], [16, 2], [15, 2], [15, 6], [13, 6], [13, 4], [11, 4], [11, 7], [9, 7], [9, 2], [-3.8, 2]],
    holes: [circle(-11, 0, 3, 10).reverse()],
    fill: "#ffca28",
    stroke: "#c49000",
  },
  umbrella: {
    outline: [...arc(0, 0, 16, 13, 180, 360, 12), [1, 0], [1, 13.5], [5, 13.5], [5, 10.5], [7.5, 10.5], [7.5, 16], [-1, 16], [-1, 0]],
    fill: "#ef5350",
    stroke: "#c62828",
    details: D`<path d="M0 0V13.5A3.5 3.5 0 0 0 7 13.5V11" fill="none" stroke="#5d4037" stroke-width="2" stroke-linecap="round"/><path d="M-16 0Q-13.3-3.5-10.7 0Q-8-3.5-5.3 0Q-2.7-3.5 0 0Q2.7-3.5 5.3 0Q8-3.5 10.7 0Q13.3-3.5 16 0" fill="#fbe9e7" stroke="#c62828" stroke-width="0.8"/><path d="M0-13V0M-7-11.5Q-6-5-5.3 0M7-11.5Q6-5 5.3 0" fill="none" stroke="#c62828" stroke-width="0.8"/>`,
  },
  balloon: {
    outline: [...arc(0, -6, 11, 13.5, 100, 440, 18), [2.2, 9.2], [1.6, 23], [-1.6, 23], [-2.2, 9.2]],
    fill: "#ab47bc",
    stroke: "#7b1fa2",
    details: D`<path d="M0 8Q-2 13 0 16T0 23" fill="none" stroke="#7b1fa2" stroke-width="0.9"/><path d="M-2 9.3H2L0 7Z" fill="#7b1fa2"/><ellipse cx="-4" cy="-11" rx="2.2" ry="3.6" fill="#fff" opacity="0.45"/>`,
  },
  pizza: {
    outline: [[-15, -11], [-8, -13.5], [0, -14.5], [8, -13.5], [15, -11], [0, 16]],
    fill: "#ffd54f",
    stroke: "#e0a458",
    details: D`<path d="M-15-11L-8-13.5 0-14.5 8-13.5 15-11 13.6-8.3Q0-11.5-13.6-8.3Z" fill="#e0a458" stroke="#b5651d" stroke-width="0.8"/><circle cx="-4" cy="-4" r="2.6" fill="#d84315"/><circle cx="4.5" cy="-2" r="2.4" fill="#d84315"/><circle cx="0" cy="6" r="2.1" fill="#d84315"/>`,
  },
  sock: {
    outline: [[-4.5, -13], [4.5, -13], [4.5, 2.5], [10, 5], ...arc(10, 9.5, 4, 4, -90, 90, 5), [-1, 13.5], ...arc(-1, 9.5, 4, 4, 90, 180, 3), [-4.5, -13]],
    fill: "#26a69a",
    stroke: "#00796b",
    details: D`<path d="M-4.5-10H4.5M-4.5-7.5H4.5" stroke="#fff" stroke-width="1.3"/>`,
  },
  sock2: {
    outline: [[-4.5, -13], [4.5, -13], [4.5, 2.5], [10, 5], ...arc(10, 9.5, 4, 4, -90, 90, 5), [-1, 13.5], ...arc(-1, 9.5, 4, 4, 90, 180, 3), [-4.5, -13]],
    fill: "#ff7043",
    stroke: "#d84315",
    details: D`<circle cx="-1" cy="-4" r="1.2" fill="#fff"/><circle cx="2" cy="1" r="1.2" fill="#fff"/><circle cx="-2" cy="6" r="1.2" fill="#fff"/>`,
  },
  crown: {
    outline: [[-14, -7], [-7, 1], [0, -11], [7, 1], [14, -7], [14, 11], [-14, 11]],
    fill: "#ffc107",
    stroke: "#ff8f00",
    details: D`<path d="M-14 6H14" stroke="#ff8f00" stroke-width="0.9"/><circle cx="-7" cy="8.5" r="1.4" fill="#e53935"/><circle cx="0" cy="8.5" r="1.4" fill="#1e88e5"/><circle cx="7" cy="8.5" r="1.4" fill="#43a047"/>`,
  },
  cat: {
    outline: [[-6.5, -11], [-5.5, -19.5], [-1.5, -14.5], [1.5, -14.5], [5.5, -19.5], [6.5, -11], ...arc(0, -8, 7, 7, -20, 40, 3), ...arc(0, 7, 10, 11, -60, 75, 8), [9, 16], [15, 14.5], [17.5, 8], [15.5, 5], [14, 6.5], [15, 10], [12, 12.5], ...arc(0, 7, 10, 11, 100, 240, 8), ...arc(0, -8, 7, 7, 140, 200, 3)],
    fill: "#607d8b",
    stroke: "#37474f",
    details: D`<path d="M-4-8.5h3M1-8.5h3" stroke="#ffeb3b" stroke-width="1.4" stroke-linecap="round"/><path d="M-1.5-4.5L0-3.5 1.5-4.5" fill="none" stroke="#263238" stroke-width="0.8"/>`,
  },
  donut: {
    outline: circle(0, 0, 15, 24),
    holes: [circle(0, 0, 5.5, 14).reverse()],
    fill: "#d9a066",
    stroke: "#a86b32",
    details: D`<path d="M-12.5-4Q-14 3-9.5 8Q-6 12 0 12.5Q6 12.2 10 8.5Q14 3 12.5-4Q10-11 4-12.5Q-3-13.5-8-10.5Q-11.5-8-12.5-4ZM0-5.5A5.5 5.5 0 1 0 0 5.5A5.5 5.5 0 1 0 0-5.5Z" fill="#f48fb1" fill-rule="evenodd"/><path d="M-8-5l2-1M6-8l1 2M9 2l2 1M-3 9l2-1M-10 3l1 2M3-10l2 0" stroke="#fff176" stroke-width="1.3" stroke-linecap="round"/>`,
  },
  moon: {
    outline: circle(0, 0, 40, 28),
    r: 40,
    fill: "#cfd8dc",
    stroke: "#90a4ae",
    details: D`<circle cx="-20" cy="-16" r="6" fill="#b0bec5"/><circle cx="21" cy="17" r="8" fill="#b0bec5"/><circle cx="-11" cy="24" r="3.5" fill="#b0bec5"/><circle cx="19" cy="-22" r="3" fill="#b0bec5"/>`,
  },
};

interface Thing {
  id: string;
  art: string;
  text: string;
  size?: number;
  alternatives?: string[];
  /** Wrapped into at most two lines. */
  wrap?: boolean;
  priority: number;
  group?: string;
  /** Where it is: x = the stage's centre + u · half the span, y = v · the stage's height. */
  u: number;
  v: number;
  /** Where it is on narrow headers: a fraction of the strip below the text (none: not shown). */
  strip?: Pt;
  /** Added by a click, at this count (the oldest go first when there are too many). */
  added?: number;
  /** Moved by the user: shown wherever it is (the others only where clear of the text and the logo). */
  moved?: boolean;
}

/** The things the header starts with, and their labels. */
const THINGS: readonly Thing[] = [
  // a pile on the desk, on the left
  { id: "bulb", art: "bulb", text: "a bright idea", priority: 30, u: -0.63, v: 0.32, strip: [0.66, 0.5] },
  { id: "coffee", art: "coffee", text: "coffee, the third cup today", alternatives: ["coffee"], priority: 40, u: -0.76, v: 0.36, strip: [0.36, 0.14] },
  { id: "key", art: "key", text: "a key (to what?)", alternatives: ["a key"], priority: 25, u: -0.69, v: 0.43, strip: [0.48, 0.56] },
  { id: "duck", art: "duck", text: "a rubber duck", priority: 50, u: -0.84, v: 0.45, strip: [0.12, 0.22] },
  { id: "banana", art: "banana", text: "a banana for scale", alternatives: ["a banana"], priority: 35, u: -0.72, v: 0.53, strip: [0.28, 0.42] },
  { id: "cactus", art: "cactus", text: "a cactus (don't hug)", alternatives: ["a cactus"], priority: 35, u: -0.9, v: 0.66, strip: [0.1, 0.64] },
  { id: "cat", art: "cat", text: "a cat, unimpressed", alternatives: ["a cat"], priority: 30, u: -0.74, v: 0.74, strip: [0.32, 0.84] },
  { id: "sock-a", art: "sock", text: "a pair of socks", priority: 30, group: "socks", u: -0.57, v: 0.82, strip: [0.6, 0.84] },
  { id: "sock-b", art: "sock2", text: "sort of", priority: 30, group: "socks", u: -0.53, v: 0.86, strip: [0.645, 0.875] },
  { id: "plane", art: "plane", text: "a paper plane", priority: 20, u: -0.9, v: 0.12 },
  // the sky and the dessert table, on the right
  { id: "moon", art: "moon", text: "the moon", size: 13, priority: 60, u: 0.8, v: 0.3, strip: [0.84, 0.26] },
  { id: "rocket", art: "rocket", text: "a rocket (to the moon)", alternatives: ["a rocket"], priority: 30, u: 0.6, v: 0.2, strip: [0.6, 0.12] },
  { id: "balloon", art: "balloon", text: "a balloon", priority: 20, u: 0.96, v: 0.46 },
  { id: "umbrella", art: "umbrella", text: "an umbrella, just in case", alternatives: ["an umbrella"], priority: 25, u: 0.7, v: 0.5 },
  { id: "pizza", art: "pizza", text: "the last slice", priority: 30, u: 0.86, v: 0.62 },
  { id: "donut", art: "donut", text: "a donut (a polygon with a hole)", wrap: true, alternatives: ["donut"], priority: 25, u: 0.65, v: 0.72, strip: [0.12, 0.9] },
  { id: "crown", art: "crown", text: "a very important label", size: 15, priority: 90, u: 0.84, v: 0.84, strip: [0.84, 0.78] },
];

/** What a click adds, in turn. */
const MORE: readonly Pick<Thing, "art" | "text" | "alternatives">[] = [
  { art: "duck", text: "another rubber duck", alternatives: ["another duck"] },
  { art: "coffee", text: "more coffee" },
  { art: "pizza", text: "not the last slice after all", alternatives: ["more pizza"] },
  { art: "balloon", text: "a balloon" },
  { art: "sock2", text: "the missing sock" },
  { art: "bulb", text: "another idea" },
  { art: "cactus", text: "a smaller cactus" },
  { art: "crown", text: "an even more important label", alternatives: ["a crown"] },
  { art: "banana", text: "a second banana", alternatives: ["a banana"] },
  { art: "donut", text: "a donut" },
  { art: "plane", text: "a paper plane" },
  { art: "key", text: "a spare key" },
];

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, cls?: string, attrs?: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG_NS, tag);
  if (cls) e.setAttribute("class", cls);
  for (const [k, v] of Object.entries(attrs ?? {})) e.setAttribute(k, String(v));
  return e;
};
const px = (n: number) => String(Math.round(n * 100) / 100);
const inside = (b: Box, x: number, y: number, pad = 0) => x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
const pathOf = (pts: readonly Pt[], close = false) => pts.map((q, i) => `${i ? "L" : "M"}${px(q[0])} ${px(q[1])}`).join("") + (close ? "Z" : "");

/** How far a thing reaches from its anchor. */
const reach = (t: Pick<Thing, "art">) => {
  const a = ARTS[t.art]!;
  return a.r ?? Math.max(...a.outline.map((q) => Math.hypot(q[0], q[1])));
};

/** A small deterministic random generator (mulberry32), for shuffles. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
  bg?: SVGPathElement;
  text: SVGTextElement;
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
  #gLeaders: SVGGElement;
  #gMarks: SVGGElement;
  #gLabels: SVGGElement;
  #tip: HTMLElement;
  #name: HTMLElement;
  #nameLabel: HTMLElement;
  #nameDot: SVGGraphicsElement;
  #nameMark: SVGCircleElement;
  #hint: HTMLElement | null;
  #stats: HTMLElement | null;
  /** The widest the hint has been: labels keep off that much of it, as its numbers change. */
  #hintW = 0;
  #w = 0;
  #h = 0;
  #strip = false;
  /** The strip below the text on narrow headers: [x, y, w, h]. */
  #stripBox: Rect = [0, 0, 0, 0];
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
   * The name's dot radius, leader width, corner radius and the radius of the fillets where
   * its leader grows out of the label, as the static logo draws them; the offset of its
   * baseline from the top of its box.
   */
  #nameR = 8;
  #nameStroke = 4;
  #nameRx = 0;
  #nameJoin = 0;
  #nameBase = 0;
  /** Things placed by a shuffle (or a reset) glide from where they were: offsets that shrink to 0. */
  #shuffle: { from: Map<string, Pt>; t0: number } | null = null;
  #rand = rng(3);
  /** Where results report each label's anchor relative to the thing's (a group's reference point). */
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
  /** Whether more things still come by themselves, the timer of the next, and where they go. */
  #revealing = false;
  #revealTimer = 0;
  #revealRand = rng(11);
  #inView = true;

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
    this.#gLeaders = this.#svg.appendChild(svg("g"));
    this.#gMarks = this.#svg.appendChild(svg("g"));
    this.#gLabels = this.#svg.appendChild(svg("g"));
    this.#nameMark = this.#gMarks.appendChild(svg("circle", "la-hero__name-dot"));
    root.querySelector("[data-la-hero-stage]")!.appendChild(this.#svg);
    this.#tip = root.appendChild(document.createElement("div"));
    this.#tip.className = "la-hero__tip";
    this.#tip.setAttribute("aria-hidden", "true");
    this.#tip.hidden = true;
    root.classList.add("has-toy");
    this.#reset();
    this.#listen();
    new ResizeObserver(() => this.#layout()).observe(root);
    if (root.hasAttribute("data-la-hero-reveal") && !this.#reduced) {
      new IntersectionObserver((es) => (this.#inView = es.some((e) => e.isIntersecting))).observe(root);
      this.#revealing = true;
      this.#revealTimer = window.setTimeout(() => this.#revealNext(), REVEAL_FIRST);
    }
  }

  // --- layout -----------------------------------------------------------------------------

  /** Measures the stage, the text to keep off and the static logo; solves again. */
  #layout(): void {
    const r = this.root.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.#w = r.width;
    this.#h = r.height;
    this.#svg.setAttribute("viewBox", `0 0 ${px(r.width)} ${px(r.height)}`);
    this.#strip = getComputedStyle(this.root).getPropertyValue("--la-hero-layout").trim() === "strip";
    this.#obstacles = this.#measureObstacles(r);
    this.#measureName();
    const lr = this.#name.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(this.#name).fontSize);
    this.#logo = [lr.left - r.left, lr.top - r.top, lr.width + em, lr.height + em];
    // the strip: below the text, above the hint
    const hint = this.#hint?.getBoundingClientRect();
    const hintTop = hint ? hint.top - r.top : this.#h;
    const top = Math.max(0, ...this.#obstacles.filter((o) => o[1] < hintTop - 4).map((o) => o[1] + o[3])) + 16;
    this.#stripBox = [24, top, this.#w - 48, Math.max(0, hintTop - 16 - top)];
    const name = this.#labels.get("name");
    if (name) this.#styleName(name.text);
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

  #measureName(): void {
    const tail = this.#nameDot.ownerSVGElement;
    const scale = tail ? tail.getBoundingClientRect().width / (tail.viewBox.baseVal.width || 1) : 1;
    const leader = this.root.querySelector("[data-la-hero-leader]");
    const join = this.root.querySelector("[data-la-hero-join]");
    this.#nameR = this.#nameDot.getBoundingClientRect().width / 2;
    this.#nameStroke = parseFloat(leader?.getAttribute("stroke-width") ?? "") * scale || 4;
    this.#nameJoin = parseFloat(join?.getAttribute("data-la-hero-join") ?? "") * scale || 0;
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

  /** Where a thing is (null: not shown in this layout); a shuffle's glide is drawn on top. */
  #pos(t: Thing): Pt | null {
    if (t.moved || t.added !== undefined || !this.#strip) {
      const span = Math.min(this.#w - 32, 1320);
      return [this.#w / 2 + (t.u * span) / 2, t.v * this.#h];
    }
    if (!t.strip) return null;
    const [x, y, w, h] = this.#stripBox;
    return h < 120 ? null : [x + t.strip[0] * w, y + t.strip[1] * h];
  }

  #setPos(t: Thing, x: number, y: number): void {
    const span = Math.min(this.#w - 32, 1320);
    t.u = ((x - this.#w / 2) * 2) / span;
    t.v = y / this.#h;
  }

  /** Where a thing is drawn: where it is, or on its way there after a shuffle. */
  #drawnAt(t: Thing, now = performance.now()): Pt {
    const p = this.#pos(t)!;
    const s = this.#shuffle;
    const from = s?.from.get(t.id);
    if (!s || !from) return p;
    const k = Math.min(1, (now - s.t0) / SHUFFLE_MS);
    const e = 1 - (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
    return [p[0] + (from[0] - p[0]) * e, p[1] + (from[1] - p[1]) * e];
  }

  /** Whether a mark of reach `r` at (x, y) is on the stage and clear of the text (and, with `logo`, of the logo). */
  #clear(x: number, y: number, r: number, logo: boolean): boolean {
    if (x < r || x > this.#w - r || y < r || y > this.#h - r) return false;
    const pad = r + 4;
    return ![...this.#obstacles, ...(logo ? [this.#logo] : [])].some(([ox, oy, ow, oh]) => x > ox - pad && x < ox + ow + pad && y > oy - pad && y < oy + oh + pad);
  }

  /** The things shown: in this layout, clear of the text and the logo, unless the user put them there. */
  #visible(): Thing[] {
    return this.things.filter((t) => {
      const p = this.#pos(t);
      if (!p) return false;
      if (t.moved || t.added !== undefined) return true;
      return this.#clear(p[0], p[1], Math.min(reach(t), 16), true);
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

  /** Where each label's anchor is now: the things (on their way after a shuffle), a group's reference point. */
  #anchors(things: Thing[], now: number): Map<string, Pt> {
    const m = new Map<string, Pt>([["name", this.#nameAnchor]]);
    for (const t of things) {
      const p = this.#drawnAt(t, now);
      const off = this.#anchorOffsets.get(t.id);
      m.set(t.id, off ? [p[0] + off[0], p[1] + off[1]] : p);
    }
    return m;
  }

  // --- solving -----------------------------------------------------------------------------

  #label(t: Thing): object {
    return {
      type: "text",
      text: t.text,
      font: { size: t.size ?? 12 },
      ...(t.alternatives ? { alternatives: t.alternatives } : {}),
      ...(t.wrap ? { wrap: { max_width: "9em", max_lines: 2 } } : {}),
    };
  }

  #anchor(t: Thing): object {
    const [x, y] = this.#pos(t)!;
    const a = ARTS[t.art]!;
    const mark = a.r ? { shape: "circle", r: a.r } : { shape: "polygon", points: a.outline, ...(a.holes ? { holes: a.holes } : {}), relative: true };
    return { type: "point", x, y, mark };
  }

  #problem(things: Thing[], rest: boolean): LabelProblem {
    const nb = this.#nameLabel.getBoundingClientRect();
    const nameFont = parseFloat(getComputedStyle(this.#nameLabel).fontSize);
    const pad = Math.round(nb.height * 0.2);
    const placements = this.result?.placements.filter((p) => p.id !== "name" || !this.#nameHome).map(warm) ?? [];
    if (this.#nameHome && this.#nameWarm) placements.push(this.#nameWarm);
    const sides = ["top-left", "top-right", "bottom-left", "bottom-right", "left", "right", "top", "bottom"];
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
          ...(ARTS[t.art]!.r ? { placement: { internal: "prefer" } } : {}),
        })),
      ],
      obstacles: this.#obstacles.length ? { vector: [{ class: "text", rects: this.#obstacles }] } : undefined,
      // more important labels may cover less important things (which then lose theirs)
      avoid: { label: { lower_items: 10 }, leader: { text: 2, lower_items: 2.5 } },
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
    if (!this.#raf) this.#raf = requestAnimationFrame((now) => this.#frame(now));
  }

  #frame(now: number): void {
    this.#raf = 0;
    if (this.#glide) {
      const { from, to, t0 } = this.#glide;
      const t = this.#reduced ? 1 : Math.min(1, (now - t0) / 350);
      const e = 1 - (1 - t) ** 3;
      this.#nameAnchor = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
      if (t >= 1) {
        this.#glide = null;
        this.#request(true);
      }
    }
    if (this.#shuffle && (this.#reduced || now - this.#shuffle.t0 >= SHUFFLE_MS)) this.#shuffle = null;
    const things = this.#visible();
    const anchors = this.#anchors(things, now);
    this.#drawMarks(things, now);
    const f = this.#motion.frame(anchors);
    this.#drawLabels(f.result.placements, f.opacity, f.leaderOpacity, anchors);
    // the drawing takes over from the static logo once it shows the name
    if (this.result?.placements.some((p) => p.id === "name" && p.placed)) this.root.classList.add("is-live");
    if (this.#motion.moving || this.#drag || this.#glide || this.#shuffle) this.#kick();
  }

  #thingShape(t: Thing): SVGGElement {
    const a = ARTS[t.art]!;
    const g = svg("g", "la-hero__thing");
    const d = pathOf(a.outline, true) + (a.holes ?? []).map((h) => pathOf(h, true)).join("");
    g.appendChild(svg("path", undefined, { d, fill: a.fill, stroke: a.stroke, "stroke-width": 1.2, "stroke-linejoin": "round", "fill-rule": "evenodd" }));
    if (a.details) g.insertAdjacentHTML("beforeend", a.details);
    return g;
  }

  #drawMarks(things: Thing[], now: number): void {
    const seen = new Set<string>();
    for (const t of things) {
      seen.add(t.id);
      let g = this.#marks.get(t.id);
      if (!g) {
        g = this.#gMarks.insertBefore(this.#thingShape(t), this.#nameMark);
        this.#marks.set(t.id, g);
      }
      const [x, y] = this.#drawnAt(t, now);
      g.setAttribute("transform", `translate(${px(x)} ${px(y)})`);
    }
    for (const [id, g] of this.#marks) {
      if (!seen.has(id)) {
        g.remove();
        this.#marks.delete(id);
      }
    }
    this.#nameMark.setAttribute("cx", px(this.#nameAnchor[0]));
    this.#nameMark.setAttribute("cy", px(this.#nameAnchor[1]));
    this.#nameMark.setAttribute("r", px(this.#nameR));
  }

  #drawLabels(placements: readonly Placement[], opacity: ReadonlyMap<string, number>, leaderOpacity: ReadonlyMap<string, number>, anchors: Map<string, Pt>): void {
    const seen = new Set<string>();
    this.#drawn.clear();
    const byId = new Map(this.things.map((t) => [t.id, t] as const));
    for (const p of placements) {
      if (!p.placed || !p.box) continue;
      const id = p.id;
      const main = id === "name";
      if (!main && !byId.has(id)) continue;
      seen.add(id);
      const o = opacity.get(id) ?? 1;
      this.#drawLeaders(p, main, leaderOpacity.get(id) ?? o, anchors);
      let s = this.#labels.get(id);
      if (!s) {
        s = this.#newLabel(main);
        this.#labels.set(id, s);
      }
      const b = p.box;
      if (s.bg) {
        // the name's leader grows out of its label where it leaves it
        const pts = p.leader?.points.map((q) => [q[0]!, q[1]!] as Pt) ?? [];
        s.bg.setAttribute("d", labelPath(b, this.#nameRx, pts.at(-1) ?? null, pts.at(-2) ?? null, this.#nameStroke, this.#nameJoin));
      }
      if (main) {
        s.text.setAttribute("x", px(b.x + b.w / 2));
        s.text.setAttribute("y", px(b.y + this.#nameBase));
      } else if (p.text) this.#setText(s.text, p.text, b);
      s.g.classList.toggle("la-hero__label--inside", p.model === "internal");
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

  #newLabel(main: boolean): Shown {
    const g = this.#gLabels.appendChild(svg("g", main ? "la-hero__label la-hero__label--name" : "la-hero__label"));
    const s: Shown = { g, text: svg("text") };
    if (main) {
      s.bg = g.appendChild(svg("path", "la-hero__bg"));
      s.text.textContent = this.#nameLabel.textContent?.trim() ?? "";
      s.text.setAttribute("text-anchor", "middle");
      this.#styleName(s.text);
    } else s.text.style.fontFamily = LABEL_FONT;
    g.appendChild(s.text);
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
        // from the dot's centre (the dot covers its start) into the box (the label and its
        // join cover its end), as the static logo draws it
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

  /** The thing or label at a point: its thing, or "name". */
  #hit(x: number, y: number, touch: boolean): Thing | "name" | null {
    const slop = touch ? 12 : 4;
    if (Math.hypot(x - this.#nameAnchor[0], y - this.#nameAnchor[1]) <= this.#nameR + slop) return "name";
    const nb = this.#drawn.get("name");
    if (nb && inside(nb, x, y)) return "name";
    const things = this.#visible();
    // labels first (they are drawn on top), then the nearest thing (its outline's reach)
    for (const t of things) {
      const b = this.#drawn.get(t.id);
      if (b && inside(b, x, y, touch ? 4 : 0)) return t;
    }
    let best: Thing | null = null;
    let bestD = Infinity;
    for (const t of things) {
      const [tx, ty] = this.#drawnAt(t);
      const d = Math.hypot(x - tx, y - ty) - reach(t) * 0.8;
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
        return [title, rep?.placed ? `shares one label with the other ${rep.members!.length > 2 ? "things" : "one"}` : "left out with its group"];
      }
      const by = (p.blocked_by ?? []).slice(0, 2).map(nameOf);
      const why = p.reason === "omitted_by_priority" ? "a more important label needs the room" : "no free place";
      return [title, `left out: ${why}${by.length ? ` (${by.join(", ")} in the way)` : ""}`];
    }
    const say: string[] = [];
    if (id === "name") say.push("the logo: always on a leader, never left out");
    else {
      if (p.members && p.members.length > 1) say.push(`one label for ${p.members.length} things`);
      switch (p.model) {
        case "internal":
          say.push("inside it, where it fits");
          break;
        case "adjacent":
        case "slider":
          say.push(`${SIDES[p.anchor_side ?? ""] ?? "next to"} it, touching its outline`);
          break;
        case "distant":
          say.push(`out on ${(p.leaders?.length ?? 0) > 1 ? "leaders" : "a leader"}, where it has room`);
          break;
        case "fan":
          say.push("in a fan column, on a leader");
          break;
      }
      if (p.text?.used.startsWith("alternative")) say.push(`shortened from “${t?.text}”`);
      if ((p.text?.lines.length ?? 1) > 1) say.push(`wrapped into ${p.text!.lines.length} lines`);
      if (p.degrade_steps?.includes("evict_lower")) say.push("taking a less important label's place");
      if (t && t.priority >= 90) say.push("labeled before all others");
    }
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
    // on the whole header: the text's boxes are wider than its lines, and a thing or a label
    // can sit next to a line, inside the box of its paragraph
    const root = this.root;
    const onStage = (e: Event) => e.target instanceof Node && this.#svg.contains(e.target);
    const grabbable = (e: Event) => !(e.target instanceof Element && e.target.closest("a, button"));
    root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !grabbable(e)) return;
      const [x, y] = this.#at(e);
      const hit = this.#hit(x, y, e.pointerType !== "mouse");
      if (hit) {
        const [ax, ay] = hit === "name" ? this.#nameAnchor : this.#drawnAt(hit);
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
    // on touch screens, a finger on a thing or label drags it instead of scrolling the page
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
      const to = this.#free(x + this.#drag.dx, y + this.#drag.dy, thing === "name" ? this.#nameR : Math.min(reach(thing), 16));
      if (!to) return;
      if (thing === "name") {
        this.#nameHome = false;
        this.#nameAnchor = to;
      } else if (!this.#move(thing, to)) return;
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
    // the user takes over: no more things come by themselves
    root.addEventListener("pointerdown", () => this.stopReveal());
    root.addEventListener("keydown", () => this.stopReveal());
    root.querySelector("[data-la-hero-reset]")?.addEventListener("click", () => {
      const from = new Map(this.#visible().map((t) => [t.id, this.#drawnAt(t)] as const));
      this.#reset();
      this.#layout();
      this.#startGlide(from);
    });
    root.querySelector("[data-la-hero-shuffle]")?.addEventListener("click", () => this.shuffle());
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-la-hero-styles] button[data-style]")) {
      b.addEventListener("click", () => this.setLeaderStyle(b.dataset.style as Hero["leaderStyle"]));
    }
  }

  /**
   * Moves a thing, and the things of its group with it (a pair of socks stays a pair: one
   * label for both). Not where one of them would go under the text.
   */
  #move(thing: Thing, to: Pt): boolean {
    const [x0, y0] = this.#drawnAt(thing);
    const mates = thing.group ? this.#visible().filter((t) => t.group === thing.group && t !== thing) : [];
    const at: [Thing, Pt][] = [[thing, to]];
    for (const m of mates) {
      const [mx, my] = this.#drawnAt(m);
      const q: Pt = [mx + to[0] - x0, my + to[1] - y0];
      const ok = this.#free(q[0], q[1], Math.min(reach(m), 16));
      if (!ok || Math.hypot(ok[0] - q[0], ok[1] - q[1]) > 0.5) return false;
      at.push([m, q]);
    }
    for (const [t, [x, y]] of at) {
      this.#shuffle?.from.delete(t.id);
      t.moved = true;
      this.#setPos(t, x, y);
    }
    return true;
  }

  /** Things glide from where they were drawn to where they are now. */
  #startGlide(from: Map<string, Pt>): void {
    if (this.#reduced) return;
    for (const [id, p] of from) {
      const t = this.things.find((q) => q.id === id);
      const now = t && this.#pos(t);
      if (!now || Math.hypot(now[0] - p[0], now[1] - p[1]) < 1) from.delete(id);
    }
    this.#shuffle = { from, t0: performance.now() };
    this.#kick();
  }

  /** Switches the leader style of every label (the name's too) and solves again. */
  setLeaderStyle(style: Hero["leaderStyle"]): void {
    this.leaderStyle = style;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>("[data-la-hero-styles] button[data-style]")) {
      b.setAttribute("aria-pressed", String(b.dataset.style === style));
    }
    this.#request(true);
  }

  /**
   * Every thing to a random free place (a group's things together): often a crowd, which
   * the labels have to sort out.
   */
  shuffle(): void {
    const things = this.#visible();
    const from = new Map(things.map((t) => [t.id, this.#drawnAt(t)] as const));
    const placed: [Pt, number][] = [];
    const done = new Set<Thing>();
    for (const t of things) {
      if (done.has(t)) continue;
      // the thing and its group's, at their offsets from it
      const [x0, y0] = from.get(t.id)!;
      const set = t.group ? things.filter((q) => q.group === t.group) : [t];
      for (let i = 0; i < 100; i++) {
        const x = this.#rand() * this.#w;
        const y = this.#rand() * this.#h;
        const at = set.map((q) => {
          const [qx, qy] = from.get(q.id)!;
          return [q, [x + qx - x0, y + qy - y0] as Pt, reach(q)] as const;
        });
        const ok = at.every(([, [qx, qy], r]) => this.#clear(qx, qy, r + 6, true) && placed.every(([p, pr]) => Math.hypot(p[0] - qx, p[1] - qy) > r + pr + 8));
        if (!ok) continue;
        for (const [q, [qx, qy], r] of at) {
          q.moved = true;
          this.#setPos(q, qx, qy);
          placed.push([[qx, qy], r]);
        }
        break;
      }
      for (const q of set) done.add(q);
    }
    this.#startGlide(from);
    this.#request(true);
  }

  /**
   * The next thing of the reveal, the next of `MORE`, at the freest place there is; not while
   * the header is out of sight or the pointer is on a thing or a label.
   */
  #revealNext(): void {
    if (!this.#revealing) return;
    if (this.result && !document.hidden && this.#inView && !this.root.classList.contains("is-over")) {
      const at = this.#added < MORE.length ? this.#roomy(Math.min(reach(MORE[this.#added]!), 16)) : null;
      if (!at) {
        this.stopReveal();
        return;
      }
      this.#add(at[0], at[1]);
    }
    this.#revealTimer = window.setTimeout(() => this.#revealNext(), REVEAL_EVERY);
  }

  /** No more things come by themselves. */
  stopReveal(): void {
    this.#revealing = false;
    clearTimeout(this.#revealTimer);
  }

  /**
   * The freest place for a mark of reach r: as far as can be from the things, the labels, the
   * text and the logo; null where none keeps `REVEAL_ROOM` from them.
   */
  #roomy(r: number): Pt | null {
    const marks = this.#visible().map((t) => [...this.#drawnAt(t), reach(t)] as const);
    const boxes = [...this.#drawn.values(), ...[...this.#obstacles, this.#logo].map(([x, y, w, h]) => ({ x, y, w, h }))];
    let best: Pt | null = null;
    let room = REVEAL_ROOM;
    for (let i = 0; i < 120; i++) {
      const x = r + this.#revealRand() * (this.#w - 2 * r);
      const y = r + this.#revealRand() * (this.#h - 2 * r);
      if (!this.#clear(x, y, r + 6, true)) continue;
      let d = Infinity;
      for (const [mx, my, mr] of marks) d = Math.min(d, Math.hypot(x - mx, y - my) - mr - r);
      for (const b of boxes) d = Math.min(d, Math.hypot(Math.max(b.x - x, 0, x - b.x - b.w), Math.max(b.y - y, 0, y - b.y - b.h)) - r);
      if (d > room) [best, room] = [[x, y], d];
    }
    return best;
  }

  /** A new thing where the user clicked, the next of `MORE`. */
  #add(x: number, y: number): void {
    const n = this.#added;
    const m = MORE[n % MORE.length]!;
    const t: Thing = { ...m, id: `add${n}`, priority: 10, u: 0, v: 0, added: n };
    const at = this.#free(x, y, Math.min(reach(t), 16));
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
    this.#rand = rng(3);
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
