/**
 * A force-directed network: the import graph of Label Anything's own TypeScript packages
 * (one node per module, sized by its lines of code, colored by package). The layout runs
 * on load and whenever a node is dragged; labels follow, warm-started, and settle when
 * the layout comes to rest. Edges are soft obstacles (`lines`).
 */
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { FONT_CLASSES, type Control } from "../controls.js";
import { rng, type Obj } from "../util.js";
import type { Anchors, DrawState, Item, PointerInfo, Scene, SceneHost } from "./scene.js";

interface Mod {
  id: string;
  pkg: string;
  path: string;
  lines: number;
}

interface Node extends SimulationNodeDatum {
  id: string;
  pkg: string;
  name: string;
  r: number;
  importers: number;
  imports: number;
  lines: number;
}

type Link = SimulationLinkDatum<Node> & { source: Node; target: Node };

const PKG_COLORS: Record<string, string> = {
  core: "#5c6bc0",
  text: "#26a69a",
  svg: "#ef8f3c",
  raster: "#8d6e63",
  extras: "#ab47bc",
  wasm: "#607d8b",
  cli: "#9e9d24",
};

export class NetworkScene implements Scene {
  readonly id = "network";
  readonly title = "Network";
  readonly hint = "Label Anything's own modules and their imports. Drag a node; the layout and the labels follow.";
  readonly about =
    "Each node is one of the project's TypeScript modules, each edge an import. Labels never cover nodes and avoid edges at a cost (the graph preset); crowded nodes get leaders. The labels are solved while the layout moves, and once more when it comes to rest.";
  readonly credits = "Data: the import graph of Label Anything's TypeScript packages, generated from the sources at build time.";
  readonly classes: readonly string[] = ["lines"];
  readonly animated = true;
  readonly cursor = "default" as const;
  readonly view = { budgetMoving: 10, maxRate: 30 };
  readonly controls: Control[] = [
    {
      key: "importance", label: "Importance", kind: "segmented",
      options: [
        { value: "importers", label: "imported by", title: "Modules many others import come first" },
        { value: "lines", label: "size", title: "Larger modules come first" },
        { value: "none", label: "none", title: "No priority: input order" },
      ],
    },
    { key: "packages", label: "Packages", kind: "checks", options: Object.keys(PKG_COLORS).map((p) => ({ value: p, label: p })) },
  ];
  readonly params: Obj = { importance: "importers", packages: ["core", "text", "svg", "raster", "extras", "wasm", "cli"] };
  playing = true;

  #mods: Mod[] = [];
  #links: [string, string][] = [];
  #nodes: Node[] = [];
  #edges: Link[] = [];
  #sim: Simulation<Node, Link> | null = null;
  #w = 800;
  #h = 600;
  #drag: Node | null = null;
  #host!: SceneHost;

  async load(host: SceneHost): Promise<void> {
    this.#host = host;
    if (this.#mods.length) return;
    const data = (await (await fetch(host.asset("modules.json"))).json()) as { nodes: Mod[]; links: [string, string][] };
    this.#mods = data.nodes;
    this.#links = data.links;
  }

  resize(w: number, h: number): void {
    const first = this.#nodes.length === 0;
    const sx = w / this.#w;
    const sy = h / this.#h;
    this.#w = w;
    this.#h = h;
    if (first) this.#build();
    else {
      for (const n of this.#nodes) [n.x, n.y] = [(n.x ?? 0) * sx, (n.y ?? 0) * sy];
      this.#forces();
    }
  }

  setParam(key: string, value: unknown): void {
    this.params[key] = value;
    if (key === "packages") this.#build();
  }

  reset(): void {
    this.#build();
  }

  #build(): void {
    const pkgs = new Set(this.params.packages as string[]);
    const mods = this.#mods.filter((m) => pkgs.has(m.pkg));
    const ids = new Set(mods.map((m) => m.id));
    const links = this.#links.filter(([a, b]) => ids.has(a) && ids.has(b));
    const importers = new Map<string, number>();
    const imports = new Map<string, number>();
    for (const [a, b] of links) {
      importers.set(b, (importers.get(b) ?? 0) + 1);
      imports.set(a, (imports.get(a) ?? 0) + 1);
    }
    const r = rng(3);
    const names = new Map<string, number>();
    this.#nodes = mods.map((m) => {
      const name = m.path === "index" ? m.pkg : m.path.endsWith("/index") ? m.path.slice(0, -6) : m.path;
      names.set(name, (names.get(name) ?? 0) + 1);
      return {
        id: m.id, pkg: m.pkg, name, lines: m.lines,
        r: 2.5 + Math.sqrt(m.lines) * 0.22,
        importers: importers.get(m.id) ?? 0, imports: imports.get(m.id) ?? 0,
        x: this.#w / 2 + (r() - 0.5) * this.#w * 0.6, y: this.#h / 2 + (r() - 0.5) * this.#h * 0.6,
      };
    });
    // the same path in two packages: say which
    for (const n of this.#nodes) if ((names.get(n.name) ?? 0) > 1 && n.name !== n.pkg) n.name = `${n.pkg}/${n.name}`;
    const byId = new Map(this.#nodes.map((n) => [n.id, n]));
    this.#edges = links.map(([a, b]) => ({ source: byId.get(a)!, target: byId.get(b)! }));
    this.#sim?.stop();
    this.#sim = forceSimulation<Node, Link>(this.#nodes).stop();
    this.#forces();
    this.#sim.alpha(1);
    this.playing = true;
    this.#host?.invalidate();
  }

  #forces(): void {
    const sim = this.#sim;
    if (!sim) return;
    const scale = Math.sqrt((this.#w * this.#h) / (900 * 650));
    sim
      .force("link", forceLink<Node, Link>(this.#edges).id((d) => d.id).distance(34 * scale).strength(0.35))
      .force("charge", forceManyBody<Node>().strength(-150 * scale).distanceMax(320 * scale))
      .force("collide", forceCollide<Node>().radius((d) => d.r + 4))
      .force("x", forceX<Node>(this.#w / 2).strength(0.06 * (this.#h / this.#w)))
      .force("y", forceY<Node>(this.#h / 2).strength(0.06));
  }

  options() {
    return {
      preset: "graph" as const,
      priority: { font_classes: FONT_CLASSES[2]!.value as never },
    };
  }

  items(): Item[] {
    const imp = this.params.importance;
    return this.#nodes.map((n) => {
      const item: Item = {
        id: n.id,
        anchor: { type: "point", x: round(n.x!), y: round(n.y!), mark: { shape: "circle", r: round(n.r) } },
        label: { type: "text", text: n.name },
      };
      if (imp === "importers") item.priority = n.importers + n.lines / 10000;
      else if (imp === "lines") item.priority = n.lines;
      return item;
    });
  }

  obstacles() {
    return {
      vector: [
        {
          class: "lines",
          width: 1,
          polylines: this.#edges.map((e): [[number, number], [number, number]] => [
            [round(e.source.x!), round(e.source.y!)],
            [round(e.target.x!), round(e.target.y!)],
          ]),
        },
      ],
    };
  }

  anchors(): Anchors {
    return new Map(this.#nodes.map((n) => [n.id, [round(n.x!), round(n.y!)]]));
  }

  step(dt: number): boolean {
    const sim = this.#sim;
    if (!sim) return false;
    // about 60 ticks per second of the layout, whatever the frame rate
    const ticks = Math.max(1, Math.round(dt / 16.7));
    for (let i = 0; i < ticks; i++) sim.tick();
    for (const n of this.#nodes) {
      n.x = Math.min(this.#w - n.r - 2, Math.max(n.r + 2, n.x!));
      n.y = Math.min(this.#h - n.r - 2, Math.max(n.r + 2, n.y!));
    }
    if (sim.alpha() < sim.alphaMin() && !this.#drag) this.playing = false;
    return true;
  }

  draw(ctx: CanvasRenderingContext2D, layer: "background" | "marks", state: DrawState): void {
    const focus = state.selected ?? state.hover;
    if (layer === "background") {
      ctx.save();
      ctx.lineWidth = 1;
      for (const e of this.#edges) {
        const hot = focus !== null && (e.source.id === focus || e.target.id === focus);
        ctx.strokeStyle = hot ? "rgba(57, 73, 171, 0.75)" : "rgba(100, 110, 130, 0.22)";
        ctx.beginPath();
        ctx.moveTo(e.source.x!, e.source.y!);
        ctx.lineTo(e.target.x!, e.target.y!);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    ctx.save();
    for (const n of this.#nodes) {
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
      ctx.fillStyle = PKG_COLORS[n.pkg] ?? "#888";
      ctx.globalAlpha = state.placed.has(n.id) || n.id === focus ? 1 : 0.55;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = n.id === focus ? 2.5 : 1;
      ctx.strokeStyle = n.id === focus ? "#1b2130" : "#ffffff";
      ctx.stroke();
    }
    ctx.restore();
  }

  legend() {
    const pkgs = new Set(this.#nodes.map((n) => n.pkg));
    return Object.entries(PKG_COLORS).filter(([p]) => pkgs.has(p)).map(([label, color]) => ({ label, color }));
  }

  hit(x: number, y: number): string | null {
    let best: Node | null = null;
    let bd = Infinity;
    for (const n of this.#nodes) {
      const d = Math.hypot(n.x! - x, n.y! - y) - n.r;
      if (d < 5 && d < bd) [best, bd] = [n, d];
    }
    return best?.id ?? null;
  }

  pointerDown(p: PointerInfo): boolean {
    const id = this.hit(p.x, p.y);
    const n = this.#nodes.find((q) => q.id === id);
    if (!n) return false;
    this.#drag = n;
    n.fx = n.x;
    n.fy = n.y;
    // a gentle reheat: the neighbours follow, the rest of the graph (and its labels) stays calm
    this.#sim?.alphaTarget(0.12);
    this.playing = true;
    return true;
  }

  pointerMove(p: PointerInfo): void {
    if (!this.#drag) return;
    this.#drag.fx = Math.min(this.#w - 4, Math.max(4, p.x));
    this.#drag.fy = Math.min(this.#h - 4, Math.max(4, p.y));
    this.#host.moved();
  }

  pointerUp(): void {
    if (this.#drag) {
      this.#drag.fx = null;
      this.#drag.fy = null;
    }
    this.#drag = null;
    this.#sim?.alphaTarget(0);
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
