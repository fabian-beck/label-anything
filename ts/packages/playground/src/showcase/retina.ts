/**
 * A photograph: the parts of the eye's fundus, labeled in the margins
 * (examples/showcase/retina.py, live).
 *
 * It starts from the problem of the static figure (examples/showcase/retina.json): the
 * names stacked in the margins (the `boundary` model), a leader from each to a dot inside
 * its part, the photograph the problem's raster background (`saliency`). The margins the
 * names go to and the style of the leaders can be chosen; hovering a name or a part shows
 * the part's outline.
 */
import type { LabelProblem, RgbaPixels } from "@label-anything/core";
import type { MotionFrame } from "@label-anything/extras";
import type { Example, Info, Solve, Stage } from "./stage.js";
import { LABEL_FAMILY, f2, inRing, ringArea, ringsPath, segmented, set, svg, type Pt, type Ring } from "./util.js";

const W = 960;
const H = 600;
const SIZE = 560; // the photograph
const OX = (W - SIZE) / 2;
const OY = (H - SIZE) / 2; // where it is
const TEXT = "#1f2328";

const ABOUT: Record<string, string> = {
  disc: "Where the optic nerve and the retina's vessels leave the eye: the blind spot",
  cup: "The pale hollow in the middle of the optic disc",
  atrophy: "Thinned tissue beside the optic disc",
  macula: "The middle of the retina, with the sharpest sight",
  fovea: "The pit in the middle of the macula",
  sta: "The vessels arching above the macula",
  ita: "The vessels arching below the macula",
  snv: "The vessels of the upper retina on the nose's side",
  inv: "The vessels of the lower retina on the nose's side",
};

// the photograph fills the height: names above or below it would cover it
type Sides = "sides" | "left" | "right";
// the styles that differ for names in the margins (a curved leader is drawn straight there)
type Style = "straight" | "elbow" | "orthogonal";
const SIDES: Record<Sides, string[]> = { sides: ["left", "right"], left: ["left"], right: ["right"] };

export interface Picture {
  id: string;
  file: string;
  size: [number, number];
  parts: { id: string; label: string; polygon: Pt[] }[];
}

interface Part {
  id: string;
  name: string;
  at: Pt;
  outline: Ring;
}

type Item = { id: string; anchor: { x: number; y: number }; label: { text: string } };

export class Retina implements Example {
  readonly name = "retina";
  readonly width = W;
  readonly height = H;
  readonly title = "A fundus photograph with its parts labeled in the margins, live, by Label Anything";
  readonly hint = "Choose where the names go and how the leaders run. Hover or tap a name or a part of the eye for its outline.";
  readonly render = {
    font: { family: LABEL_FAMILY, size: 13, weight: 400, italic: false },
    fill: TEXT,
    leaderStroke: TEXT,
    leaderWidth: 1,
  };
  readonly motion = { duration: 350, appearDelay: 0, holdTime: 0, moveDelay: 0, jump: Infinity };

  sides: Sides = "sides";
  style: Style = "straight";
  #base: LabelProblem;
  #parts: Part[];
  #pixels: RgbaPixels;
  #image: string;
  #stage!: Stage;

  /** `base`: the problem of the static figure; `picture`: the photograph's parts; its pixels and its address. */
  constructor(base: LabelProblem, picture: Picture, pixels: RgbaPixels, image: string) {
    this.#base = base;
    this.#pixels = pixels;
    this.#image = image;
    const scale = SIZE / picture.size[0];
    const outlines = new Map(picture.parts.map((q) => [q.id, q.polygon.map(([x, y]) => [OX + x * scale, OY + y * scale] as Pt)]));
    this.#parts = (base.items as unknown as Item[]).map((it) => ({ id: it.id, name: it.label.text, at: [it.anchor.x, it.anchor.y], outline: outlines.get(it.id) ?? [] }));
  }

  problem(): LabelProblem {
    // the photograph the problem names is handed over with it, as pixels (`raster`)
    const base = this.#base as unknown as { placement: { boundary: object }; leaders: object };
    return {
      ...this.#base,
      placement: { ...base.placement, boundary: { ...base.placement.boundary, sides: SIDES[this.sides] } },
      leaders: { ...base.leaders, style: this.style },
    } as unknown as LabelProblem;
  }

  mount(stage: Stage): void {
    this.#stage = stage;
    const cx = OX + SIZE / 2;
    const cy = OY + SIZE / 2;
    const r = SIZE / 2 - 4;
    svg("rect", { width: W, height: H, fill: "#ffffff" }, stage.picture);
    const clip = svg("clipPath", { id: "la-ex-fundus" }, stage.picture);
    svg("circle", { cx: f2(cx), cy: f2(cy), r: f2(r) }, clip);
    svg("image", { x: f2(OX), y: f2(OY), width: SIZE, height: SIZE, "clip-path": "url(#la-ex-fundus)", href: this.#image }, stage.picture);
    svg("circle", { cx: f2(cx), cy: f2(cy), r: f2(r), fill: "none", stroke: "#d0d4d9", "stroke-width": 1 }, stage.picture);
    const dots = svg("g", { fill: "#ffffff", stroke: TEXT, "stroke-width": 1.2 }, stage.top);
    for (const p of this.#parts) svg("circle", { cx: f2(p.at[0]), cy: f2(p.at[1]), r: 3 }, dots);
    segmented<Sides>(stage.controls, "Names", [["sides", "left and right"], ["left", "left"], ["right", "right"]], this.sides, (v) => this.set({ sides: v }));
    segmented<Style>(stage.controls, "Leaders", [["straight", "straight"], ["elbow", "elbow"], ["orthogonal", "right angles"]], this.style, (v) => this.set({ style: v }));
  }

  set(change: { sides?: Sides; style?: Style }): void {
    this.sides = change.sides ?? this.sides;
    this.style = change.style ?? this.style;
    // another layout: solved afresh, not from the labels shown
    this.#stage.request(true, true);
  }

  solve(): Solve {
    return { problem: this.problem(), anchors: this.anchors(), raster: this.#pixels };
  }

  anchors(): Map<string, Pt> {
    return new Map(this.#parts.map((p) => [p.id, p.at]));
  }

  /** A white casing under the leaders keeps them readable over the photograph. */
  drawn(_: MotionFrame): void {
    const leaders = this.#stage.labels.querySelector(".la-leaders");
    if (!leaders) return;
    const casing = leaders.cloneNode(true) as SVGGElement;
    set(casing, { class: "la-ex-casing", stroke: "#ffffff", "stroke-width": 3, "stroke-opacity": 0.8 });
    leaders.before(casing);
  }

  hit(x: number, y: number): string | null {
    for (const p of this.#parts) if (Math.hypot(x - p.at[0], y - p.at[1]) <= 7) return p.id;
    // the smallest part there: the cup in the disc, the fovea in the macula
    let best: Part | null = null;
    for (const p of this.#parts) {
      if (p.outline.length >= 3 && inRing(p.outline, x, y) && (!best || ringArea(p.outline) < ringArea(best.outline))) best = p;
    }
    return best?.id ?? null;
  }

  info(id: string): Info | null {
    const p = this.#parts.find((p) => p.id === id);
    return p ? { title: p.name, subtitle: ABOUT[id] } : null;
  }

  highlight(id: string | null): void {
    const layer = this.#stage.hover;
    layer.replaceChildren();
    const p = this.#parts.find((p) => p.id === id);
    if (!p) return;
    if (p.outline.length >= 3) {
      const d = ringsPath([p.outline]);
      svg("path", { d, fill: "#ffffff", "fill-opacity": 0.12, stroke: "#1f2328", "stroke-opacity": 0.55, "stroke-width": 3.4, "stroke-linejoin": "round" }, layer);
      svg("path", { d, fill: "none", stroke: "#ffffff", "stroke-width": 1.6, "stroke-linejoin": "round" }, layer);
    }
    svg("circle", { cx: f2(p.at[0]), cy: f2(p.at[1]), r: 5.5, fill: "none", stroke: "#ffffff", "stroke-width": 1.6 }, layer);
  }
}

/** The pixels of an image (decoded by the browser). */
export async function pixelsOf(url: string): Promise<RgbaPixels> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: data.width, height: data.height, data: data.data };
}
