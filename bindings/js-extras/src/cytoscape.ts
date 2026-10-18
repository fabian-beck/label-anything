/**
 * Cytoscape.js: node labels placed by Label Anything.
 *
 * ```js
 * import { labelCytoscape } from "@label-anything/extras/cytoscape";
 * const labels = labelCytoscape(cy, { priority: (n) => n.degree() });
 * ```
 *
 * Cytoscape keeps drawing the labels; this sets per-node `text-margin-x/y` (with
 * `text-halign`/`text-valign: center`) and hides omitted labels (`text-opacity: 0`). The
 * solve runs in model coordinates, so panning and zooming keep the layout valid (labels
 * scale with the graph); it re-runs after layouts, node drags and graph changes. Leaders
 * (if enabled) are drawn in an SVG overlay. Unlabeled nodes are hard obstacles (class
 * `nodes`), edges soft ones (class `edges`). Cytoscape draws the labels as styled, so
 * they are moved but never wrapped or shrunk (the ladder leaves out `wrap`, `truncate`
 * and `shrink`).
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";
import { LatestRunner, resolveEngine } from "./engine.js";
import { numericWeight } from "./measure.js";
import { buildProblem, itemExtras, keepHostText, labelOf, placeOptionsOf, resolveFont, type LabelOptions, type Mark } from "./options.js";
import { renderLabels, type RenderOptions } from "./render.js";
import { SVG_NS } from "./svg.js";

type P = { x: number; y: number };

/** The parts of a Cytoscape node used here. */
export interface CyNode {
  id(): string;
  position(): P;
  outerWidth(): number;
  outerHeight(): number;
  visible(): boolean;
  style(name: string): unknown;
  style(props: Record<string, string | number>): unknown;
  removeStyle(names?: string): unknown;
}

/** The parts of a Cytoscape edge used here. */
export interface CyEdge {
  visible(): boolean;
  source(): { position(): P };
  target(): { position(): P };
  sourceEndpoint(): P;
  targetEndpoint(): P;
  segmentPoints?(): P[] | undefined;
  controlPoints?(): P[] | undefined;
  style(name: string): unknown;
}

/** The parts of a Cytoscape core used here. */
export interface CytoscapeLike {
  nodes(): { forEach(f: (n: CyNode, i: number) => void): unknown };
  edges(): { forEach(f: (e: CyEdge, i: number) => void): unknown };
  zoom(): number;
  pan(): P;
  container(): HTMLElement | null;
  on(events: string, handler: () => void): unknown;
  off(events: string, handler: () => void): unknown;
  batch(f: () => void): unknown;
}

export interface CytoscapeLabelOptions extends Omit<LabelOptions<CyNode>, "id">, Omit<RenderOptions, "font"> {
  /** Label text (default: the node's `label` style, e.g. `data(label)`). */
  text?: LabelOptions<CyNode>["text"];
  /** Edges as obstacles (default `true`). */
  avoidEdges?: boolean;
  /** Re-solve delay after graph changes in ms (default 30). */
  debounce?: number;
  onResult?: (result: LabelResult) => void;
  onError?: (error: unknown) => void;
}

export interface GraphLabels {
  update(): void;
  remove(): void;
  readonly result: LabelResult | undefined;
}

function attempt<T>(f: () => T): T | undefined {
  try {
    return f() ?? undefined;
  } catch {
    return undefined;
  }
}

const px = (v: unknown, fallback: number) => {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
};

export function labelCytoscape(cy: CytoscapeLike, options: CytoscapeLabelOptions = {}): GraphLabels {
  const runner = new LatestRunner(resolveEngine(options.engine));
  let result: LabelResult | undefined;
  let nodes = new Map<string, CyNode>();
  let font = resolveFont(options.font, { family: "Helvetica Neue, Helvetica, sans-serif", size: 16 });
  const doc = cy.container()?.ownerDocument;
  let svg: SVGSVGElement | undefined;
  let group: SVGGElement | undefined;
  if (doc && cy.container()) {
    svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    svg.setAttribute("style", "position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none;z-index:1");
    group = doc.createElementNS(SVG_NS, "g") as SVGGElement;
    svg.appendChild(group);
    cy.container()!.appendChild(svg);
  }

  const viewport = () => {
    if (!group) return;
    const pan = cy.pan();
    group.setAttribute("transform", `translate(${pan.x},${pan.y}) scale(${cy.zoom()})`);
  };

  const apply = (r: LabelResult) => {
    result = r;
    cy.batch(() => {
      for (const p of r.placements) {
        const n = nodes.get(p.id);
        if (!n) continue;
        if (p.placed && p.box) {
          const pos = n.position();
          n.removeStyle("text-opacity");
          n.style({
            "text-halign": "center",
            "text-valign": "center",
            "text-margin-x": p.box.x + p.box.w / 2 - pos.x,
            "text-margin-y": p.box.y + p.box.h / 2 - pos.y,
          });
        } else {
          n.style({ "text-opacity": 0 });
        }
      }
    });
    if (group) {
      // only the leaders: Cytoscape draws the texts
      renderLabels(group, { ...r, placements: r.placements.map((p) => ({ ...p, text: undefined, parts: undefined })) }, { ...options, font });
      viewport();
    }
    options.onResult?.(r);
  };

  const solve = () => {
    nodes = new Map();
    const items: LabelProblem["items"] = [];
    const unlabeled: NonNullable<NonNullable<LabelProblem["obstacles"]>["vector"]>[number]["shapes"] = [];
    let first: CyNode | undefined;
    cy.nodes().forEach((n, i) => {
      if (!n.visible()) return;
      const pos = n.position();
      const w = n.outerWidth();
      const h = n.outerHeight();
      const shape = String(n.style("shape"));
      const mark: Mark =
        shape === "ellipse" ? (Math.abs(w - h) < 1e-9 ? { shape: "circle", r: w / 2 } : { shape: "ellipse", rx: w / 2, ry: h / 2 }) : { shape: "rect", w, h };
      const label = labelOf(options, n, i, (node) => node.style("label"));
      if (!label) {
        unlabeled!.push({ ...mark, x: pos.x, y: pos.y });
        return;
      }
      first ??= n;
      if (label.type === "text") {
        label.font = {
          size: px(n.style("font-size"), 16),
          family: String(n.style("font-family") || font.family),
          weight: numericWeight(String(n.style("font-weight") ?? "")),
          ...(n.style("font-style") === "italic" ? { style: "italic" as const } : {}),
        };
      }
      nodes.set(n.id(), n);
      items.push({ id: n.id(), anchor: { type: "point", x: pos.x, y: pos.y, mark }, label, ...itemExtras(options, n, i) });
    });
    if (first && !options.font) {
      font = resolveFont(
        { family: String(first.style("font-family") || font.family), size: px(first.style("font-size"), 16), weight: numericWeight(String(first.style("font-weight") ?? "")) },
        font,
      );
    }
    const polylines: [number, number][][] = [];
    let edgeWidth = 1;
    if (options.avoidEdges !== false) {
      cy.edges().forEach((e) => {
        if (!e.visible()) return;
        // endpoints and bends need a renderer; headless instances fall back to the centres
        const mid = attempt(() => e.segmentPoints?.()) ?? attempt(() => e.controlPoints?.()) ?? [];
        const a = attempt(() => e.sourceEndpoint()) ?? e.source().position();
        const b = attempt(() => e.targetEndpoint()) ?? e.target().position();
        const pts = [a, ...mid, b].map((p) => [p.x, p.y] as [number, number]);
        if (pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) polylines.push(pts);
        edgeWidth = Math.max(edgeWidth, px(e.style("width"), 1));
      });
    }
    const vector: NonNullable<NonNullable<LabelProblem["obstacles"]>["vector"]> = [];
    if (unlabeled!.length) vector.push({ class: "nodes", shapes: unlabeled });
    if (polylines.length) vector.push({ class: "edges", polylines: polylines as never, width: edgeWidth });
    const avoid = { ...options.avoid, label: { nodes: "hard" as const, ...options.avoid?.label } };
    const problem = keepHostText(buildProblem({ items, ...(vector.length ? { obstacles: { vector } } : {}) }, { ...options, avoid }, font));
    runner.run(problem, placeOptionsOf(options), apply, (e) => (options.onError ? options.onError(e) : console.error(e)));
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      solve();
    }, options.debounce ?? 30);
  };
  const events = "layoutstop add remove data dragfree";
  cy.on(events, schedule);
  cy.on("viewport", viewport);
  solve();

  return {
    update: solve,
    remove() {
      if (timer !== undefined) clearTimeout(timer);
      cy.off(events, schedule);
      cy.off("viewport", viewport);
      runner.cancel();
      svg?.remove();
      cy.batch(() => {
        for (const n of nodes.values()) n.removeStyle("text-halign text-valign text-margin-x text-margin-y text-opacity");
      });
    },
    get result() {
      return result;
    },
  };
}
