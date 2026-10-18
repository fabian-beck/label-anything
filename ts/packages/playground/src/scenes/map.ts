/**
 * A world map (Natural Earth countries, Equal Earth projection) with a label per country:
 * inside its area where it fits, else next to it or with a leader, abbreviated when space
 * is short, larger for the more important ones. Pan and zoom: every move is solved again,
 * warm-started, so labels stay put and the label set nests as space opens. Optional
 * flights cross the map as moving labeled points.
 */
import { geoEqualEarth, geoGraticule10, geoInterpolate, geoPath, type GeoProjection } from "d3-geo";
import type { LabelResult } from "@label-anything/core";
import { FONT_CLASSES, type Control } from "../controls.js";
import { clamp, rng, type Obj } from "../util.js";
import type { Anchors, DrawState, Item, PointerInfo, Scene, SceneHost } from "./scene.js";

type P = [number, number];

interface Country {
  id: string;
  name: string;
  abbrev: string | null;
  continent: string;
  pop: number;
  gdp: number;
  area: number;
  rank: number;
  label: P;
  /** Projected rings (base projection), per part: outer ring then holes. */
  shapes: P[][][];
  /** The part the label is for (the largest), and its bounds. */
  main: P[][];
  bounds: [number, number, number, number];
  labelXY: P;
}

interface Flight {
  id: string;
  code: string;
  from: P;
  to: P;
  t: number;
  speed: number;
  interp: (t: number) => P;
}

interface ViewT {
  k: number;
  x: number;
  y: number;
}

const AIRLINES = ["LH", "AF", "BA", "KL", "UA", "DL", "AA", "QF", "SQ", "EK", "NH", "TK", "QR", "LX", "IB", "AZ", "CX", "AC", "ET", "LA"];

export class MapScene implements Scene {
  readonly id = "map";
  readonly title = "World map";
  readonly hint = "Drag to pan, scroll or pinch to zoom: labels stay put and fill in as space opens.";
  readonly about =
    "Each country is an area item: its label goes inside where it fits, else beside it or on a leader. Abbreviations are shorter alternatives the engine falls back to, and type size follows importance. Every pan and zoom is solved again from the previous labels (warm start): labels stay put, and zooming in only adds labels.";
  readonly credits = 'Map data: <a href="https://www.naturalearthdata.com/">Made with Natural Earth</a> (public domain).';
  readonly classes: readonly string[] = [];
  readonly cursor = "grab" as const;
  readonly view = { budgetMoving: 20, maxRate: 20 };
  readonly controls: Control[] = [
    {
      key: "importance", label: "Importance", kind: "segmented",
      options: [
        { value: "pop", label: "population" },
        { value: "gdp", label: "GDP" },
        { value: "area", label: "area" },
        { value: "rank", label: "map rank", title: "Natural Earth's label rank" },
      ],
    },
    { key: "abbrev", label: "Abbreviations", kind: "toggle", hint: "Offer Natural Earth's abbreviations (Ger., Zimb.) as shorter alternatives" },
    {
      key: "flights", label: "Flights", kind: "segmented",
      options: [{ value: 0, label: "none" }, { value: 25, label: "25" }, { value: 60, label: "60" }, { value: 120, label: "120" }],
      hint: "Moving labeled points over the map",
    },
    { key: "flightsFirst", label: "Flights before countries", kind: "toggle", hint: "Flight labels outrank country labels", when: (g) => Number(g("param.flights")) > 0 },
  ];
  readonly params: Obj = { importance: "pop", abbrev: true, flights: 0, flightsFirst: false };
  playing = false;

  #countries: Country[] = [];
  #flights: Flight[] = [];
  #proj: GeoProjection = geoEqualEarth();
  #sphere: P[][] = [];
  #graticule: P[][] = [];
  #w = 800;
  #h = 600;
  #v: ViewT = { k: 1, x: 0, y: 0 };
  #pan: { x: number; y: number } | null = null;
  #host!: SceneHost;
  /** Poles of the area labels of the latest result, in base coordinates. */
  #poles = new Map<string, P>();
  #raw: { countries: (Omit<Country, "shapes" | "main" | "bounds" | "labelXY"> & { parts: P[][][] })[] } | null = null;

  get animated(): boolean {
    return Number(this.params.flights) > 0;
  }

  async load(host: SceneHost): Promise<void> {
    this.#host = host;
    if (!this.#raw) this.#raw = await (await fetch(host.asset("world.json"))).json();
  }

  resize(w: number, h: number): void {
    const keep = this.#countries.length > 0;
    const center = keep ? this.#toBase([this.#w / 2, this.#h / 2]) : null;
    this.#w = w;
    this.#h = h;
    this.#project();
    if (center && this.#v.k > 1) {
      // keep the same place in the middle
      this.#v.x = w / 2 - this.#v.k * center[0];
      this.#v.y = h / 2 - this.#v.k * center[1];
      this.#clampView();
    } else this.#v = { k: 1, x: 0, y: 0 };
    if (!this.#flights.length) this.#spawnFlights();
  }

  /** Projects every outline once, for the current size (d3 cuts them at the antimeridian). */
  #project(): void {
    const pad = 12;
    this.#proj = geoEqualEarth().fitExtent([[pad, pad + 40], [this.#w - pad, this.#h - pad - 40]], { type: "Sphere" });
    const rings = (geom: unknown): P[][] => {
      const out: P[][] = [];
      let cur: P[] = [];
      const ctx = {
        moveTo: (x: number, y: number) => { cur = [[x, y]]; out.push(cur); },
        lineTo: (x: number, y: number) => { cur.push([x, y]); },
        closePath: () => undefined,
        arc: () => undefined,
        beginPath: () => undefined,
      };
      geoPath(this.#proj, ctx as unknown as CanvasRenderingContext2D)(geom as never);
      return out;
    };
    this.#sphere = rings({ type: "Sphere" });
    this.#graticule = rings(geoGraticule10());
    this.#countries = (this.#raw?.countries ?? []).map((c) => {
      const shapes = c.parts.map((part) => rings({ type: "Polygon", coordinates: part }));
      // the label's part: the largest projected outer ring (d3 may cut one part into several)
      let main: P[][] = shapes[0] ?? [];
      let best = -1;
      for (const s of shapes) {
        for (let i = 0; i < s.length; i++) {
          const a = Math.abs(ringArea(s[i]!));
          if (a > best && i === 0) [best, main] = [a, s];
        }
      }
      const all = shapes.flat(2);
      const xs = all.map((p) => p[0]);
      const ys = all.map((p) => p[1]);
      const lp = this.#proj(c.label) ?? main[0]?.[0] ?? [0, 0];
      return {
        ...c,
        shapes,
        main,
        bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        labelXY: [lp[0], lp[1]],
      } as Country;
    });
    this.#poles.clear();
  }

  setParam(key: string, value: unknown): void {
    this.params[key] = value;
    if (key === "flights") {
      this.#spawnFlights();
      this.playing = this.animated;
    }
  }

  reset(): void {
    this.#v = { k: 1, x: 0, y: 0 };
    this.#spawnFlights();
    this.#host?.invalidate();
  }

  #spawnFlights(): void {
    const n = Number(this.params.flights);
    const r = rng(42);
    const big = this.#countries.filter((c) => c.pop > 5e6);
    const pick = (): P => {
      const c = big[Math.floor(r() * big.length)];
      return c ? [c.label[0], c.label[1]] : [0, 0];
    };
    this.#flights = Array.from({ length: n }, (_, i) => {
      const from = pick();
      let to = pick();
      for (let k = 0; k < 5 && Math.hypot(to[0] - from[0], to[1] - from[1]) < 25; k++) to = pick();
      const code = `${AIRLINES[Math.floor(r() * AIRLINES.length)]} ${100 + Math.floor(r() * 899)}`;
      return { id: `f${i}`, code, from, to, t: r(), speed: 0, interp: geoInterpolate(from, to) as (t: number) => P };
    });
    for (const f of this.#flights) f.speed = this.#speedOf(f);
    if (n === 0) this.playing = false;
  }

  /** Progress per ms: about 900 km/h, 40 000 times faster than real time. */
  #speedOf(f: Flight): number {
    const d = angularDistance(f.from, f.to) * 6371;
    return (900 / 3.6e6) * 40000 / Math.max(d, 300);
  }

  // --- view ----------------------------------------------------------------------------

  #toScreen(p: P): P {
    return [this.#v.k * p[0] + this.#v.x, this.#v.k * p[1] + this.#v.y];
  }

  #toBase(p: P): P {
    return [(p[0] - this.#v.x) / this.#v.k, (p[1] - this.#v.y) / this.#v.k];
  }

  #clampView(): void {
    const { k } = this.#v;
    // keep some of the world in view
    const minX = this.#w * 0.5 - k * this.#w * 0.95;
    const maxX = this.#w * 0.5 - k * this.#w * 0.05;
    const minY = this.#h * 0.5 - k * this.#h * 0.95;
    const maxY = this.#h * 0.5 - k * this.#h * 0.05;
    this.#v.x = clamp(this.#v.x, Math.min(minX, 0), Math.max(maxX, 0));
    this.#v.y = clamp(this.#v.y, Math.min(minY, 0), Math.max(maxY, 0));
  }

  zoom(x: number, y: number, factor: number): boolean {
    const k = clamp(this.#v.k * factor, 1, 40);
    const f = k / this.#v.k;
    if (f === 1) return true;
    this.#v = { k, x: x - (x - this.#v.x) * f, y: y - (y - this.#v.y) * f };
    if (k === 1) this.#v = { k: 1, x: 0, y: 0 };
    this.#clampView();
    this.#host.moved();
    return true;
  }

  viewButtons() {
    return [
      { label: "+", title: "Zoom in", run: () => this.#animateZoom(2) },
      { label: "−", title: "Zoom out", run: () => this.#animateZoom(0.5) },
      { label: "World", title: "The whole world", run: () => this.#animateTo({ k: 1, x: 0, y: 0 }) },
    ];
  }

  #animateZoom(f: number): void {
    const k = clamp(this.#v.k * f, 1, 40);
    const g = k / this.#v.k;
    const cx = this.#w / 2;
    const cy = this.#h / 2;
    this.#animateTo(k === 1 ? { k: 1, x: 0, y: 0 } : { k, x: cx - (cx - this.#v.x) * g, y: cy - (cy - this.#v.y) * g });
  }

  #animateTo(to: ViewT): void {
    const from = { ...this.#v };
    const t0 = performance.now();
    const dur = 450;
    const tick = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      // interpolate the scale geometrically, the translation so that the zoom looks linear
      const k = from.k * (to.k / from.k) ** e;
      const a = (k - from.k) / (to.k - from.k || 1);
      this.#v = { k, x: from.x + (to.x - from.x) * (Number.isFinite(a) ? a : e), y: from.y + (to.y - from.y) * (Number.isFinite(a) ? a : e) };
      this.#host.moved();
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  pointerDown(p: PointerInfo): boolean {
    this.#pan = { x: p.x, y: p.y };
    return true;
  }

  pointerMove(p: PointerInfo): void {
    if (!this.#pan) return;
    this.#v.x += p.x - this.#pan.x;
    this.#v.y += p.y - this.#pan.y;
    this.#pan = { x: p.x, y: p.y };
    this.#clampView();
    this.#host.moved();
  }

  pointerUp(): void {
    this.#pan = null;
  }

  // --- problem ---------------------------------------------------------------------------

  options() {
    return {
      preset: "map" as const,
      placement: { models: ["internal", "adjacent", "slider", "distant"] as ("internal" | "adjacent" | "slider" | "distant")[], position_order: "cartographic" as const, max_distance: "5em" },
      leaders: { style: "straight" as const, max_length: "6em" },
      priority: { font_classes: FONT_CLASSES[2]!.value as never },
      defaults: { font: { size: 11.5 } },
    };
  }

  #visible(c: Country): boolean {
    const [x0, y0] = this.#toScreen([c.bounds[0], c.bounds[1]]);
    const [x1, y1] = this.#toScreen([c.bounds[2], c.bounds[3]]);
    return x1 >= 0 && y1 >= 0 && x0 <= this.#w && y0 <= this.#h;
  }

  items(): Item[] {
    const imp = this.params.importance as string;
    const flightsFirst = this.params.flightsFirst === true;
    const out: Item[] = [];
    for (const c of this.#countries) {
      if (!this.#visible(c) || !c.main.length) continue;
      // only the visible part counts: the label goes there, and the engine samples less
      const view: [number, number, number, number] = [-2, -2, this.#w + 2, this.#h + 2];
      const ring = simplifyRing(clipRing(c.main[0]!.map((p) => this.#toScreen(p)), view), 0.8).map(roundP);
      let anchor: Record<string, unknown>;
      if (ring.length >= 3 && Math.abs(ringArea(ring)) >= 12) {
        anchor = { type: "area", polygon: ring };
        const holes = c.main.slice(1).map((h) => simplifyRing(clipRing(h.map((p) => this.#toScreen(p)), view), 0.8).map(roundP)).filter((h) => h.length >= 3);
        if (holes.length) anchor.holes = holes;
      } else {
        // a country of a few pixels: a point at its label point
        const s = this.#toScreen(c.labelXY);
        if (s[0] < 0 || s[1] < 0 || s[0] > this.#w || s[1] > this.#h) continue;
        anchor = { type: "point", x: round(s[0]), y: round(s[1]), mark: { shape: "circle", r: 2 } };
      }
      const label: Record<string, unknown> = { type: "text", text: c.name };
      if (this.params.abbrev && c.abbrev) label.alternatives = [c.abbrev];
      const score = imp === "gdp" ? c.gdp : imp === "area" ? c.area : imp === "rank" ? 20 - c.rank + Math.log10(c.pop + 1) / 20 : c.pop;
      out.push({ id: c.id, anchor, label, priority: score, tier: flightsFirst ? 0 : 1 } as unknown as Item);
    }
    for (const f of this.#flights) {
      const s = this.#flightXY(f);
      if (!s || s[0] < 0 || s[1] < 0 || s[0] > this.#w || s[1] > this.#h) continue;
      out.push({
        id: f.id,
        anchor: { type: "point", x: round(s[0]), y: round(s[1]), mark: { shape: "circle", r: 3.5 } },
        label: { type: "text", text: f.code, font: { size: 10 } },
        tier: flightsFirst ? 1 : 0,
        priority: 0,
      } as Item);
    }
    return out;
  }

  obstacles() {
    return undefined;
  }

  snapshot(): ViewT {
    return { ...this.#v };
  }

  /** Remember where the engine put each area label's anchor (its pole), so labels follow it while panning. */
  onResult(result: LabelResult, at: unknown): void {
    const v = at as ViewT;
    this.#external.clear();
    for (const p of result.placements) {
      if (p.id.startsWith("f")) continue;
      if (p.anchor) this.#poles.set(p.id, [(p.anchor[0] - v.x) / v.k, (p.anchor[1] - v.y) / v.k]);
      if (p.placed && p.model !== "internal") this.#external.add(p.id);
    }
  }

  anchors(): Anchors {
    const m: Anchors = new Map();
    for (const c of this.#countries) {
      const base = this.#poles.get(c.id) ?? c.labelXY;
      const s = this.#toScreen(base);
      m.set(c.id, [round(s[0]), round(s[1])]);
    }
    for (const f of this.#flights) {
      const s = this.#flightXY(f);
      if (s) m.set(f.id, [round(s[0]), round(s[1])]);
    }
    return m;
  }

  #flightXY(f: Flight): P | null {
    const ll = f.interp(f.t);
    const p = this.#proj(ll);
    return p ? this.#toScreen([p[0], p[1]]) : null;
  }

  step(dt: number): boolean {
    if (!this.#flights.length) return false;
    for (const f of this.#flights) {
      f.t += f.speed * dt;
      if (f.t >= 1) {
        // on to a new destination
        const r = Math.random;
        const big = this.#countries.filter((c) => c.pop > 5e6);
        f.from = f.to;
        const c = big[Math.floor(r() * big.length)]!;
        f.to = [c.label[0], c.label[1]];
        f.interp = geoInterpolate(f.from, f.to) as (t: number) => P;
        f.t = 0;
        f.speed = this.#speedOf(f);
      }
    }
    return true;
  }

  // --- drawing ----------------------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, layer: "background" | "marks", state: DrawState): void {
    if (layer === "background") {
      ctx.save();
      ctx.fillStyle = "#e9eff5";
      this.#path(ctx, this.#sphere);
      ctx.fill();
      ctx.strokeStyle = "rgba(120, 140, 165, 0.16)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (const line of this.#graticule) this.#line(ctx, line);
      ctx.stroke();
      const focus = state.selected ?? state.hover;
      for (const c of this.#countries) {
        if (!this.#visible(c)) continue;
        ctx.beginPath();
        for (const part of c.shapes) for (const ring of part) this.#ring(ctx, ring);
        ctx.fillStyle = c.id === focus ? "#dfe3f3" : "#fbfaf7";
        ctx.fill("evenodd");
        ctx.strokeStyle = c.id === focus ? "#3949ab" : "#b9c0ca";
        ctx.lineWidth = c.id === focus ? 1.5 : 0.6;
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    for (const f of this.#flights) {
      const s = this.#flightXY(f);
      if (!s) continue;
      const ahead = this.#proj(f.interp(Math.min(1, f.t + 0.01)));
      const a = ahead ? Math.atan2(this.#v.k * ahead[1] + this.#v.y - s[1], this.#v.k * ahead[0] + this.#v.x - s[0]) : 0;
      ctx.save();
      ctx.translate(s[0], s[1]);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(5, 0);
      ctx.lineTo(-4, -3.5);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-4, 3.5);
      ctx.closePath();
      ctx.fillStyle = state.selected === f.id || state.hover === f.id ? "#3949ab" : "#33415c";
      ctx.fill();
      ctx.restore();
    }
    // a dot at the anchor of countries labeled outside their area
    ctx.save();
    ctx.fillStyle = "#5d6676";
    for (const c of this.#countries) {
      if (!state.placed.has(c.id) || !this.#external.has(c.id) || !this.#visible(c)) continue;
      const pole = this.#poles.get(c.id);
      if (!pole) continue;
      const s = this.#toScreen(pole);
      ctx.beginPath();
      ctx.arc(s[0], s[1], 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Countries labeled outside their area (they get a dot at their anchor). */
  #external = new Set<string>();

  #path(ctx: CanvasRenderingContext2D, rings: P[][]): void {
    ctx.beginPath();
    for (const r of rings) this.#ring(ctx, r);
  }

  #ring(ctx: CanvasRenderingContext2D, ring: P[]): void {
    const v = this.#v;
    ring.forEach((p, i) => (i ? ctx.lineTo(v.k * p[0] + v.x, v.k * p[1] + v.y) : ctx.moveTo(v.k * p[0] + v.x, v.k * p[1] + v.y)));
    ctx.closePath();
  }

  #line(ctx: CanvasRenderingContext2D, line: P[]): void {
    const v = this.#v;
    line.forEach((p, i) => (i ? ctx.lineTo(v.k * p[0] + v.x, v.k * p[1] + v.y) : ctx.moveTo(v.k * p[0] + v.x, v.k * p[1] + v.y)));
  }

  hit(x: number, y: number): string | null {
    for (const f of this.#flights) {
      const s = this.#flightXY(f);
      if (s && Math.hypot(s[0] - x, s[1] - y) < 7) return f.id;
    }
    const b = this.#toBase([x, y]);
    for (const c of this.#countries) {
      if (b[0] < c.bounds[0] || b[0] > c.bounds[2] || b[1] < c.bounds[1] || b[1] > c.bounds[3]) continue;
      for (const part of c.shapes) if (part[0] && inRing(b, part[0])) return c.id;
    }
    return null;
  }
}

/** Douglas–Peucker in screen px: vertices closer than `tol` to the outline add nothing at this zoom. */
function simplifyRing(ring: P[], tol: number): P[] {
  if (ring.length <= 8) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[ring.length - 1] = 1;
  const stack: [number, number][] = [[0, ring.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = ring[a]!;
    const [bx, by] = ring[b]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i]!;
      const d2 = len2 > 0 ? (dy * (px - ax) - dx * (py - ay)) ** 2 / len2 : (px - ax) ** 2 + (py - ay) ** 2;
      if (d2 > best) [best, idx] = [d2, i];
    }
    if (best > t2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 3 ? out : ring;
}

/** Sutherland–Hodgman clipping of a ring to a rectangle [x0, y0, x1, y1]. */
function clipRing(ring: P[], [x0, y0, x1, y1]: [number, number, number, number]): P[] {
  let pts = ring;
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  for (const [inside, cut] of edges) {
    if (!pts.length) break;
    const out: P[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length]!;
      const b = pts[i]!;
      if (inside(b)) {
        if (!inside(a)) out.push(cut(a, b));
        out.push(b);
      } else if (inside(a)) out.push(cut(a, b));
    }
    pts = out;
  }
  // drop repeated points
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]![0] || p[1] !== pts[i - 1]![1]);
}

function ringArea(r: P[]): number {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1];
  return s / 2;
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

function angularDistance(a: P, b: P): number {
  const r = Math.PI / 180;
  const s = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

const round = (v: number) => Math.round(v * 100) / 100;
const roundP = (p: P): P => [round(p[0]), round(p[1])];
