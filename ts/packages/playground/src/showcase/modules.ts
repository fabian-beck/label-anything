/**
 * A diagram: the module graph of this repository's TypeScript packages
 * (examples/showcase/modules.py, live).
 *
 * It starts from the problem of the static figure (examples/showcase/modules.json): every
 * module a node, sized by its lines of code and coloured by its package, every import an
 * edge. Nodes can be dragged; their edges follow, and the labels are placed again from
 * where they are, so only those in the way move. The most imported modules are labeled
 * first; labels may cross edges at a cost, never nodes.
 */
import type { LabelProblem } from "@label-anything/core";
import type { Example, Info, Solve, Stage } from "./stage.js";
import { LABEL_FAMILY, button, clamp, easeInOut, esc, f2, round, set, svg, type Pt } from "./util.js";

const W = 960;
const H = 600;
const COLOURS: Record<string, string> = {
  core: "#4e79a7", text: "#f28e2b", svg: "#59a14f", raster: "#b07aa1", extras: "#e15759", wasm: "#76b7b2", cli: "#9c755f",
};
const TEXT = "#1f2328";
const RETURN_MS = 450;

interface Node {
  id: string;
  name: string;
  pkg: string;
  path: string;
  lines: number;
  r: number;
  /** Where the layout put it, and where it is now. */
  home: Pt;
  at: Pt;
  /** The modules it imports, and those that import it. */
  out: string[];
  in: string[];
}

interface Edge {
  a: Node;
  b: Node;
  /** The edge as the layout drew it, between the nodes' homes. */
  line: Pt[];
  path: SVGPathElement;
}

/** A gentle arc from a to b (a quadratic Bézier, bent to the left by 12 % of its length). */
function curve(a: Pt, b: Pt, n = 8): Pt[] {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const cx = mx - dy * 0.12;
  const cy = my + dx * 0.12;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * cx + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * cy + t * t * b[1]] as Pt;
  });
}

const pathOf = (pts: Pt[]): string => "M" + pts.map(([x, y]) => `${f2(x)} ${f2(y)}`).join("L");

const home = (n: Node): boolean => n.at[0] === n.home[0] && n.at[1] === n.home[1];
/** An edge's points: as the layout drew it while both its nodes are where the layout put them. */
const points = (e: Edge): Pt[] => (home(e.a) && home(e.b) ? e.line : curve(e.a.at, e.b.at));

type Item = { id: string; anchor: { x: number; y: number; mark: { r: number } }; label: { text: string }; priority: number };
type Vector = { class: string; polylines?: number[][][]; rects?: number[][]; width?: number };

export class Modules implements Example {
  readonly name = "modules";
  readonly width = W;
  readonly height = H;
  readonly title = "The module graph of Label Anything's TypeScript packages, labeled live by Label Anything";
  readonly hint = "Drag a node: its edges follow and the labels make room. Hover or tap a node or a label for the module and what it imports.";
  readonly render = {
    font: { family: LABEL_FAMILY, size: 11, weight: 400, italic: false },
    fill: TEXT,
    halo: "#ffffff",
    haloWidth: 2.6,
    leaderStroke: "#5f6670",
    leaderWidth: 0.8,
  };
  readonly motion = { duration: 220, appearDelay: 120, holdTime: 200, moveDelay: 120 };

  #base: LabelProblem;
  #nodes = new Map<string, Node>();
  #edges: Edge[] = [];
  #stage!: Stage;
  #circles = new Map<string, SVGCircleElement>();
  #edgeLayer!: SVGGElement;
  #reset!: HTMLButtonElement;
  #drag: { node: Node; pointer: number; grab: Pt; moved: boolean } | null = null;
  #back: { from: Map<string, Pt>; t0: number } | null = null;

  /** `base`: the problem of the static figure. */
  constructor(base: LabelProblem) {
    this.#base = base;
    const vector = (base.obstacles as { vector: Vector[] }).vector;
    const at = new Map<string, Node>();
    for (const it of base.items as unknown as Item[]) {
      const [pkg, ...rest] = it.id.split("/");
      const p: Pt = [it.anchor.x, it.anchor.y];
      // the priority is the number of importers, and the lines of code as its fraction
      const lines = Math.round((it.priority - Math.floor(it.priority)) * 1e5);
      const node: Node = { id: it.id, name: it.label.text, pkg: pkg!, path: rest.join("/"), lines, r: it.anchor.mark.r, home: p, at: [...p], out: [], in: [] };
      this.#nodes.set(it.id, node);
      at.set(`${p[0]},${p[1]}`, node);
    }
    // an edge is a polyline from the importing module's node to the imported one's
    for (const line of vector.find((v) => v.class === "edges")!.polylines!) {
      const a = at.get(`${line[0]![0]},${line[0]![1]}`);
      const b = at.get(`${line.at(-1)![0]},${line.at(-1)![1]}`);
      if (!a || !b) continue;
      a.out.push(b.id);
      b.in.push(a.id);
      this.#edges.push({ a, b, line: line as Pt[], path: svg("path") });
    }
  }

  problem(): LabelProblem {
    const base = this.#base;
    const vector = (base.obstacles as { vector: Vector[] }).vector;
    const polylines = this.#edges.map((e) => points(e).map(([x, y]) => [round(x, 1), round(y, 1)]));
    return {
      ...base,
      obstacles: { vector: vector.map((v) => (v.class === "edges" ? { ...v, polylines } : v)) },
      items: (base.items as unknown as Item[]).map((it) => {
        const n = this.#nodes.get(it.id)!;
        return { ...it, anchor: { ...it.anchor, x: round(n.at[0], 1), y: round(n.at[1], 1) } };
      }),
    } as unknown as LabelProblem;
  }

  mount(stage: Stage): void {
    this.#stage = stage;
    svg("rect", { width: W, height: H, fill: "#ffffff" }, stage.picture);
    this.#edgeLayer = svg("g", { class: "la-ex-edges", fill: "none", stroke: "#8b939c", "stroke-opacity": 0.32, "stroke-width": 0.8 }, stage.picture);
    for (const e of this.#edges) this.#edgeLayer.appendChild(e.path);
    const nodes = svg("g", { stroke: "#ffffff", "stroke-width": 1 }, stage.picture);
    // the largest first, so that the smaller ones are drawn over them
    for (const n of [...this.#nodes.values()].sort((a, b) => b.lines - a.lines)) {
      this.#circles.set(n.id, svg("circle", { class: "la-ex-fade", r: f2(n.r), fill: COLOURS[n.pkg] ?? "#888888" }, nodes));
    }
    const legend = svg("g", { "font-size": 11, fill: TEXT }, stage.picture);
    const names = Object.keys(COLOURS);
    const o = ['<text x="16" y="24" font-size="12" font-weight="700">Packages</text>'];
    names.forEach((pkg, i) => {
      o.push(`<circle cx="22" cy="${42 + i * 17}" r="5" fill="${COLOURS[pkg]}"/>`, `<text x="32" y="${46 + i * 17}">${esc(pkg)}</text>`);
    });
    o.push(`<text x="16" y="${46 + names.length * 17 + 6}" fill="#5f6670" font-size="10">Size: lines of code</text>`);
    o.push(`<text x="16" y="${46 + names.length * 17 + 20}" fill="#5f6670" font-size="10">Lines: imports</text>`);
    legend.innerHTML = o.join("");
    this.#reset = button(stage.controls, "Reset the layout", () => this.reset());
    this.#reset.disabled = true;
    this.#draw();

    const el = stage.svg;
    el.addEventListener("pointerdown", (ev) => this.#down(ev));
    el.addEventListener("pointermove", (ev) => this.#move(ev));
    for (const type of ["pointerup", "pointercancel"] as const) el.addEventListener(type, (ev) => this.#up(ev));
  }

  /** Draws the nodes and edges where they are (all, or those of one node). */
  #draw(only?: Node): void {
    for (const e of this.#edges) {
      if (!only || e.a === only || e.b === only) set(e.path, { d: pathOf(points(e)) });
    }
    for (const n of only ? [only] : this.#nodes.values()) set(this.#circles.get(n.id)!, { cx: f2(n.at[0]), cy: f2(n.at[1]) });
  }

  #down(ev: PointerEvent): void {
    if (ev.pointerType === "mouse" && ev.button !== 0) return;
    const [x, y] = this.#stage.toCanvas(ev);
    const id = this.hit(x, y);
    const node = id === null ? undefined : this.#nodes.get(id);
    if (!node || this.#drag) return;
    this.#back = null;
    this.#drag = { node, pointer: ev.pointerId, grab: [x - node.at[0], y - node.at[1]], moved: false };
    this.#stage.svg.setPointerCapture(ev.pointerId);
    if (ev.pointerType === "mouse") ev.preventDefault(); // no text selection while dragging
  }

  #move(ev: PointerEvent): void {
    const d = this.#drag;
    if (!d || ev.pointerId !== d.pointer) return;
    const stage = this.#stage;
    const [x, y] = stage.toCanvas(ev);
    const to: Pt = [clamp(x - d.grab[0], d.node.r + 4, W - d.node.r - 4), clamp(y - d.grab[1], d.node.r + 4, H - d.node.r - 4)];
    if (!d.moved && Math.hypot(to[0] - d.node.at[0], to[1] - d.node.at[1]) < 2) return;
    if (!d.moved) {
      d.moved = true;
      stage.gesture = true;
      stage.setHover(d.node.id);
      stage.hideTip();
      stage.svg.classList.add("is-dragging");
    }
    d.node.at = to;
    this.#draw(d.node);
    this.highlight(d.node.id);
    this.#reset.disabled = false;
    stage.request(false);
    stage.kick();
  }

  #up(ev: PointerEvent): void {
    const d = this.#drag;
    if (!d || ev.pointerId !== d.pointer) return;
    this.#drag = null;
    if (!d.moved) return;
    this.#stage.gesture = false;
    this.#stage.svg.classList.remove("is-dragging");
    this.#stage.request(true);
  }

  /** The nodes glide back to where the layout put them. */
  reset(): void {
    this.#drag = null;
    this.#stage.gesture = false;
    this.#stage.setHover(null);
    this.#reset.disabled = true;
    this.#back = { from: new Map([...this.#nodes].map(([id, n]) => [id, [...n.at] as Pt])), t0: this.#stage.reduced ? -Infinity : performance.now() };
    this.#stage.kick();
  }

  frame(now: number): boolean {
    const b = this.#back;
    if (!b) return false;
    const t = Math.min(1, (now - b.t0) / RETURN_MS);
    const e = easeInOut(t);
    for (const [id, n] of this.#nodes) {
      const a = b.from.get(id)!;
      n.at = t >= 1 ? [...n.home] : [a[0] + (n.home[0] - a[0]) * e, a[1] + (n.home[1] - a[1]) * e];
    }
    this.#draw();
    if (t >= 1) {
      this.#back = null;
      // as at the start: solved afresh
      this.#stage.request(true, true);
    } else this.#stage.request(false);
    return t < 1;
  }

  solve(): Solve {
    return { problem: this.problem(), anchors: this.anchors() };
  }

  anchors(): Map<string, Pt> {
    return new Map([...this.#nodes].map(([id, n]) => [id, [n.at[0], n.at[1]]]));
  }

  hit(x: number, y: number): string | null {
    let best: Node | null = null;
    let nearest = Infinity;
    for (const n of this.#nodes.values()) {
      const d = Math.hypot(x - n.at[0], y - n.at[1]);
      // a small node is easier to catch than its dot is large
      if (d <= Math.max(n.r, 5) + 1 && d - n.r < nearest) {
        nearest = d - n.r;
        best = n;
      }
    }
    return best?.id ?? null;
  }

  info(id: string): Info | null {
    const n = this.#nodes.get(id);
    if (!n) return null;
    const count = (k: number) => `${k} module${k === 1 ? "" : "s"}`;
    return {
      title: n.name,
      subtitle: `${n.pkg}: ${n.path}.ts`,
      rows: [["Lines of code", n.lines.toLocaleString("en-US")], ["Imported by", count(n.in.length)], ["Imports", count(n.out.length)]],
    };
  }

  related(id: string): ReadonlySet<string> {
    const n = this.#nodes.get(id);
    return new Set(n ? [...n.in, ...n.out] : []);
  }

  /** The node, its imports and importers and the edges between them stand out. */
  highlight(id: string | null): void {
    const layer = this.#stage.hover;
    layer.replaceChildren();
    const n = id === null ? undefined : this.#nodes.get(id);
    const near = n ? new Set([n.id, ...n.in, ...n.out]) : null;
    for (const [k, c] of this.#circles) c.classList.toggle("is-hover", near?.has(k) ?? false);
    set(this.#edgeLayer, { "stroke-opacity": n ? 0.1 : 0.32 });
    if (!n) return;
    // what it imports in its own colour, what imports it in grey
    for (const e of this.#edges) {
      if (e.a !== n && e.b !== n) continue;
      svg("path", { d: pathOf(points(e)), fill: "none", stroke: e.a === n ? (COLOURS[n.pkg] ?? TEXT) : "#5f6670", "stroke-width": 1.3, "stroke-opacity": 0.85 }, layer);
    }
    svg("circle", { cx: f2(n.at[0]), cy: f2(n.at[1]), r: f2(n.r + 1.5), fill: "none", stroke: TEXT, "stroke-width": 1.6 }, layer);
  }
}
