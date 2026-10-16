/**
 * d3: label the elements of a selection.
 *
 * ```js
 * import { labelSelection } from "@label-anything/extras/d3";
 * const dots = svg.selectAll("circle").data(cars).join("circle")...;
 * labelSelection(dots, (d) => d.name, { priority: (d) => d.power, leaders: "straight" });
 * ```
 *
 * Everything already drawn in the owner `<svg>` (axes, grid lines, other marks) becomes the
 * obstacle background (with the preset's SVG class rules), the selected elements are the
 * labeled marks (their true outlines), and the labels are drawn into a `<g>` of that
 * `<svg>`. No d3 import is needed: any object with `nodes()` and `data()` works.
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";
import { andThen, resolveEngine, type AnyEngine, type AsyncEngine, type Engine } from "./engine.js";
import { numericWeight } from "./measure.js";
import { buildProblem, idOf, itemExtras, labelOf, placeOptionsOf, resolveFont, type Label, type LabelOptions } from "./options.js";
import { renderLabels, type RenderOptions } from "./render.js";
import { inverseTransform, markBoxes, snapshotSvg, SVG_NS, viewBoxMatrix } from "./svg.js";

/** The parts of a d3 selection used here. */
export interface SelectionLike<D> {
  nodes(): Element[];
  data(): D[];
}

export interface LabelSelectionOptions<D> extends LabelOptions<D>, Omit<RenderOptions, "font"> {
  /**
   * Use the owner SVG's other content as obstacles (default `true`); `false` avoids only
   * the labeled marks themselves.
   */
  background?: boolean;
  /** Group to draw into (default: a `<g data-la-labels>` appended to the owner `<svg>`). */
  container?: SVGGElement | Element;
  /** Name of the default container, to label several selections of one `<svg>` independently. */
  key?: string;
  /** Draw the labels (default `true`); `false` only computes the result. */
  draw?: boolean;
  /** Inline computed styles into the background snapshot (default `true` in browsers). */
  inlineStyles?: boolean;
}

/** Label the elements of `selection`; returns the result (a promise for async engines). */
export function labelSelection<D>(
  selection: SelectionLike<D>,
  text: LabelOptions<D>["text"],
  options?: LabelSelectionOptions<D> & { engine?: Engine },
): LabelResult;
export function labelSelection<D>(
  selection: SelectionLike<D>,
  text: LabelOptions<D>["text"],
  options: LabelSelectionOptions<D> & { engine: AsyncEngine },
): Promise<LabelResult>;
export function labelSelection<D>(
  selection: SelectionLike<D>,
  text: LabelOptions<D>["text"],
  options: LabelSelectionOptions<D> = {},
): LabelResult | Promise<LabelResult> {
  const opts: LabelSelectionOptions<D> = { ...options, text: text ?? options.text };
  const nodes = selection.nodes();
  const data = selection.data();
  const svg = ownerSvg(nodes);
  if (!svg) throw new Error("labelSelection: the selection is empty or not inside an <svg>");
  const container = opts.container ?? labelGroup(svg, opts.key ?? "default", opts.draw !== false);
  const inLabels = (e: Element) => e === container || e.hasAttribute("data-la-labels");

  // Keep only elements with a label; they become items with their own outline as mark.
  const marks: Element[] = [];
  const meta: { id: string; label: Label; extras: Partial<LabelProblem["items"][number]> }[] = [];
  nodes.forEach((node, i) => {
    const d = data[i] as D;
    const label = labelOf(opts, d, i, (dd) => (dd as { label?: unknown } | null)?.label);
    if (!label || !node) return;
    marks.push(node);
    meta.push({ id: idOf(opts, d, i), label, extras: itemExtras(opts, d, i) });
  });

  const snapshot = snapshotSvg(svg, { marks, exclude: inLabels, inlineStyles: opts.inlineStyles });
  const { scene, boxes } = markBoxes(snapshot);
  const items: LabelProblem["items"] = [];
  meta.forEach((m, k) => {
    const b = boxes[k];
    if (!b) return; // draws nothing: cannot be labeled
    items.push({ id: m.id, anchor: { type: "point", x: b.x + b.w / 2, y: b.y + b.h / 2 }, label: m.label, svg_id: snapshot.ids[k], ...m.extras });
  });

  const font = resolveFont(opts.font, inheritedFont(svg));
  const problem = buildProblem(
    {
      canvas: { width: scene.width, height: scene.height },
      items,
      obstacles: {
        svg: {
          source: snapshot.source,
          auto_mark_items: true,
          // without background, only the labeled marks are drawn geometry
          ...(opts.background === false ? { classes: [{ selector: "*", class: "ignore" }] } : {}),
        },
      },
    },
    opts,
    font,
  );
  const engine: AnyEngine = resolveEngine(opts.engine);
  const result = engine.place(problem, placeOptionsOf(opts));
  return andThen(result, (r) => {
    if (opts.draw !== false) {
      const t = inverseTransform(viewBoxMatrix(scene, svg.getAttribute("preserveAspectRatio")));
      if (t) container.setAttribute("transform", t);
      else container.removeAttribute("transform");
      renderLabels(container, r, { ...opts, font });
    }
    return r;
  });
}

function ownerSvg(nodes: Element[]): SVGSVGElement | null {
  for (const n of nodes) {
    if (!n) continue;
    let e: Element | null = n;
    let top: SVGSVGElement | null = null;
    while (e) {
      if (e.namespaceURI === SVG_NS && e.localName === "svg") top = e as SVGSVGElement;
      e = e.parentElement;
    }
    if (top) return top;
  }
  return null;
}

function labelGroup(svg: SVGSVGElement, key: string, create: boolean): Element {
  for (const c of Array.from(svg.children)) if (c.getAttribute("data-la-labels") === key) return c;
  const g = svg.ownerDocument.createElementNS(SVG_NS, "g");
  g.setAttribute("data-la-labels", key);
  g.setAttribute("class", "la-labels");
  if (create) svg.appendChild(g);
  return g;
}

function inheritedFont(svg: SVGSVGElement): { family?: string; size?: number; weight?: number } {
  const cs = svg.ownerDocument.defaultView?.getComputedStyle?.(svg);
  if (!cs) return {};
  const family = cs.getPropertyValue("font-family") || undefined;
  const size = Number.parseFloat(cs.getPropertyValue("font-size"));
  const weight = cs.getPropertyValue("font-weight");
  return {
    family,
    // the browser default (16px) is rarely meant for chart labels
    size: Number.isFinite(size) && size > 0 && size !== 16 ? size : undefined,
    weight: weight ? numericWeight(weight) : undefined,
  };
}
