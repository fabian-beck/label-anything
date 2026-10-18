/**
 * Callouts on a picture: annotated parts of a photograph labeled in the margins (the
 * `illustration` preset: boundary and distant labels, covering the picture costs as much
 * as a leader). The photograph is a raster obstacle: the engine reads its pixels (`ink`
 * mode). Click the picture to add a label, drag it around; drop an image of your own.
 */
import type { RgbaPixels } from "@label-anything/core";
import type { Control } from "../controls.js";
import type { Obj } from "../util.js";
import type { Anchors, DrawState, Item, PointerInfo, Scene, SceneHost } from "./scene.js";

type P = [number, number];

interface Part {
  id: string;
  label: string;
  polygon: P[];
  holes?: P[][];
}

interface Picture {
  id: string;
  title: string;
  file: string;
  size: [number, number];
  credit: string;
  parts: Part[];
}

interface Pin {
  id: string;
  label: string;
  /** Position in image pixels. */
  x: number;
  y: number;
}

export class PictureScene implements Scene {
  readonly id = "picture";
  readonly title = "Picture";
  readonly hint = "Click the photo to add a label, drag it; drop an image of your own onto the drawing.";
  readonly about =
    "The photo is a raster obstacle: the engine reads its pixels. The labels name annotated parts (area items) from the margins with elbow leaders: the illustration preset, in which covering the picture costs as much as a leader.";
  readonly classes: readonly string[] = ["ink"];
  readonly animated = false;
  readonly cursor = "crosshair" as const;
  playing = false;
  readonly controls: Control[] = [
    { key: "picture", label: "Picture", kind: "segmented", options: [] },
    { key: "regions", label: "Show the annotated parts", kind: "toggle", hint: "Outlines of the areas the labels name" },
    { key: "labelText", label: "Text of the next label", kind: "text", placeholder: "New label", hint: "Click the photo to place it" },
  ];
  readonly params: Obj = { picture: "astronaut", regions: false, labelText: "New label" };

  #pictures: Picture[] = [];
  #images = new Map<string, HTMLImageElement>();
  #pixels = new Map<string, RgbaPixels>();
  #upload: { picture: Picture; image: HTMLImageElement; pixels: RgbaPixels } | null = null;
  #pins: Pin[] = [];
  #w = 800;
  #h = 600;
  #rect = { x: 0, y: 0, s: 1 };
  #drag: Pin | null = null;
  #next = 1;
  #host!: SceneHost;
  #file: HTMLInputElement | null = null;

  get credits(): string {
    return `Photo: ${this.#current()?.credit ?? ""}; annotations CC0.`;
  }

  async load(host: SceneHost): Promise<void> {
    this.#host = host;
    if (this.#pictures.length) return;
    const meta = (await (await fetch(host.asset("pictures/pictures.json"))).json()) as { pictures: Picture[] };
    this.#pictures = meta.pictures;
    (this.controls[0] as { options: { value: unknown; label: string }[] }).options = [
      ...this.#pictures.map((p) => ({ value: p.id, label: p.title })),
      { value: "upload", label: "your image" },
    ];
    await Promise.all(this.#pictures.map((p) => this.#loadImage(p)));
    this.#bindDrop();
  }

  async #loadImage(p: Picture): Promise<void> {
    const img = new Image();
    img.src = this.#host.asset(`pictures/${p.file}`);
    await img.decode();
    this.#images.set(p.id, img);
    this.#pixels.set(p.id, pixelsOf(img));
  }

  #bindDrop(): void {
    const stage = document.getElementById("stage-wrap");
    if (!stage || stage.dataset.drop) return;
    stage.dataset.drop = "1";
    stage.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
    stage.addEventListener("drop", (e) => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      void this.#useFile(f);
    });
  }

  async #useFile(f: File): Promise<void> {
    if (!f.type.startsWith("image/")) {
      this.#host.toast("That is not an image.");
      return;
    }
    const img = new Image();
    img.src = URL.createObjectURL(f);
    try {
      await img.decode();
    } catch {
      this.#host.toast("The image could not be read.");
      return;
    }
    // at most 800 px on the long side: the engine's raster pipeline gets the pixels
    const s = Math.min(1, 800 / Math.max(img.naturalWidth, img.naturalHeight));
    const pixels = pixelsOf(img, s);
    const picture: Picture = {
      id: "upload", title: "Your image", file: f.name, size: [pixels.width, pixels.height],
      credit: "your image (it stays in this browser)", parts: [],
    };
    this.#upload = { picture, image: img, pixels };
    this.params.picture = "upload";
    this.#pins = [];
    this.#layout();
    this.#host.toast("Click the image to add labels.");
    this.#host.invalidate();
  }

  #current(): Picture | undefined {
    if (this.params.picture === "upload") return this.#upload?.picture;
    return this.#pictures.find((p) => p.id === this.params.picture) ?? this.#pictures[0];
  }

  #image(): HTMLImageElement | undefined {
    if (this.params.picture === "upload") return this.#upload?.image;
    return this.#images.get(String(this.params.picture));
  }

  resize(w: number, h: number): void {
    this.#w = w;
    this.#h = h;
    this.#layout();
  }

  /** The picture in the middle, with room for a column of callouts on either side. */
  #layout(): void {
    const p = this.#current();
    if (!p) return;
    const [iw, ih] = p.size;
    const s = Math.min((this.#w * 0.5) / iw, (this.#h - 70) / ih, 2);
    this.#rect = { x: Math.round((this.#w - iw * s) / 2), y: Math.round((this.#h - ih * s) / 2), s };
  }

  setParam(key: string, value: unknown): void {
    if (key === "picture" && value === "upload" && !this.#upload) {
      this.#pickFile();
      return;
    }
    this.params[key] = value;
    if (key === "picture") {
      this.#pins = [];
      this.#layout();
    }
    this.#host.invalidate();
  }

  #pickFile(): void {
    if (!this.#file) {
      this.#file = document.createElement("input");
      this.#file.type = "file";
      this.#file.accept = "image/*";
      this.#file.addEventListener("change", () => {
        const f = this.#file?.files?.[0];
        if (f) void this.#useFile(f);
      });
    }
    this.#file.value = "";
    this.#file.click();
  }

  reset(): void {
    this.#pins = [];
    this.#host.invalidate();
  }

  viewButtons() {
    return [
      { label: "Your image…", title: "Label an image of your own (it stays in this browser)", run: () => this.#pickFile() },
      { label: "Clear added", title: "Remove the labels you added", run: () => this.reset() },
    ];
  }

  options() {
    const p = this.#current();
    const r = this.#rect;
    return {
      preset: "illustration" as const,
      placement: { models: ["boundary", "distant"] as ("boundary" | "distant")[], boundary: { sides: ["left", "right"] as ("left" | "right")[], align: "stack" as const } },
      leaders: { style: "elbow" as const, port: "side-center" as const, angles: [45, 135, 225, 315] },
      obstacles: p
        ? { raster: { source: p.file, mode: "ink" as const, class: "ink", scale: round(1 / r.s), offset: [r.x, r.y] as [number, number] } }
        : undefined,
    };
  }

  #toCanvas(q: P): P {
    const r = this.#rect;
    return [round(r.x + q[0] * r.s), round(r.y + q[1] * r.s)];
  }

  items(): Item[] {
    const p = this.#current();
    if (!p) return [];
    const out: Item[] = p.parts.map((part) => {
      const anchor: Record<string, unknown> = { type: "area", polygon: part.polygon.map((q) => this.#toCanvas(q)) };
      if (part.holes?.length) anchor.holes = part.holes.map((h) => h.map((q) => this.#toCanvas(q)));
      return { id: part.id, anchor, label: { type: "text", text: part.label } } as unknown as Item;
    });
    for (const pin of this.#pins) {
      const [x, y] = this.#toCanvas([pin.x, pin.y]);
      out.push({ id: pin.id, anchor: { type: "point", x, y, mark: { shape: "circle", r: 3 } }, label: { type: "text", text: pin.label } });
    }
    return out;
  }

  obstacles() {
    return undefined;
  }

  raster(): RgbaPixels | undefined {
    if (this.params.picture === "upload") return this.#upload?.pixels;
    return this.#pixels.get(String(this.params.picture));
  }

  anchors(): Anchors {
    const m: Anchors = new Map();
    for (const pin of this.#pins) m.set(pin.id, this.#toCanvas([pin.x, pin.y]));
    return m;
  }

  step(): boolean {
    return false;
  }

  draw(ctx: CanvasRenderingContext2D, layer: "background" | "marks", state: DrawState): void {
    const p = this.#current();
    const img = this.#image();
    const r = this.#rect;
    if (layer === "background") {
      if (img && p) {
        ctx.save();
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, r.x, r.y, p.size[0] * r.s, p.size[1] * r.s);
        ctx.restore();
      } else {
        ctx.save();
        ctx.fillStyle = "#5d6676";
        ctx.font = "14px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Drop an image here, or choose one with “Your image…”.", this.#w / 2, this.#h / 2);
        ctx.restore();
      }
      return;
    }
    if (!p) return;
    const focus = state.selected ?? state.hover;
    ctx.save();
    for (const part of p.parts) {
      const on = part.id === focus;
      if (!on && !this.params.regions) continue;
      ctx.beginPath();
      for (const ring of [part.polygon, ...(part.holes ?? [])]) {
        ring.forEach((q, i) => {
          const c = this.#toCanvas(q);
          if (i) ctx.lineTo(c[0], c[1]);
          else ctx.moveTo(c[0], c[1]);
        });
        ctx.closePath();
      }
      ctx.fillStyle = on ? "rgba(255, 213, 79, 0.35)" : "rgba(255, 255, 255, 0.12)";
      ctx.fill("evenodd");
      ctx.strokeStyle = on ? "#ffd54f" : "rgba(255, 255, 255, 0.8)";
      ctx.lineWidth = on ? 2 : 1;
      ctx.setLineDash(on ? [] : [4, 3]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const pin of this.#pins) {
      const [x, y] = this.#toCanvas([pin.x, pin.y]);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = pin.id === focus ? "#3949ab" : "#ffd54f";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#1b2130";
      ctx.stroke();
    }
    ctx.restore();
  }

  hit(x: number, y: number): string | null {
    for (const pin of this.#pins) {
      const [px, py] = this.#toCanvas([pin.x, pin.y]);
      if (Math.hypot(px - x, py - y) < 7) return pin.id;
    }
    const p = this.#current();
    if (!p) return null;
    const r = this.#rect;
    const q: P = [(x - r.x) / r.s, (y - r.y) / r.s];
    // the smallest part under the pointer
    let best: Part | null = null;
    let area = Infinity;
    for (const part of p.parts) {
      if (!inRing(q, part.polygon) || part.holes?.some((h) => inRing(q, h))) continue;
      const a = Math.abs(ringArea(part.polygon));
      if (a < area) [best, area] = [part, a];
    }
    return best?.id ?? null;
  }

  pointerDown(pi: PointerInfo): boolean {
    const id = this.hit(pi.x, pi.y);
    const pin = this.#pins.find((q) => q.id === id);
    if (pin) {
      this.#drag = pin;
      return true;
    }
    // anywhere on the photo, an annotated part included: a new label at that spot
    const p = this.#current();
    const r = this.#rect;
    if (!p) return false;
    const q: P = [(pi.x - r.x) / r.s, (pi.y - r.y) / r.s];
    if (q[0] < 0 || q[1] < 0 || q[0] > p.size[0] || q[1] > p.size[1]) return false;
    const text = String(this.params.labelText ?? "").trim() || `Label ${this.#next}`;
    const created: Pin = { id: `u${this.#next++}`, label: text, x: q[0], y: q[1] };
    this.#pins.push(created);
    this.#drag = created;
    this.#host.invalidate();
    return true;
  }

  pointerMove(pi: PointerInfo): void {
    const pin = this.#drag;
    const p = this.#current();
    if (!pin || !p) return;
    const r = this.#rect;
    pin.x = Math.min(p.size[0], Math.max(0, (pi.x - r.x) / r.s));
    pin.y = Math.min(p.size[1], Math.max(0, (pi.y - r.y) / r.s));
    this.#host.moved();
  }

  pointerUp(): void {
    this.#drag = null;
  }
}

/** RGBA pixels of an image, optionally scaled. */
function pixelsOf(img: HTMLImageElement, scale = 1): RgbaPixels {
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data };
}

function inRing(p: P, ring: P[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringArea(r: P[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1];
  return s / 2;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
