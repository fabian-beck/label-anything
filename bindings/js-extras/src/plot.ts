/**
 * Observable Plot: a text mark that places its labels with Label Anything.
 *
 * ```js
 * import * as Plot from "@observablehq/plot";
 * import { labelAnything } from "@label-anything/extras/plot";
 * Plot.plot({ marks: [
 *   Plot.dot(cars, { x: "power", y: "economy" }),
 *   labelAnything(cars, { x: "power", y: "economy", text: "name", priority: (d) => d.power }),
 * ]});
 * ```
 *
 * It accepts the options of `Plot.text` (channels, `fill`, `fontSize`, ...) plus the
 * helper options. Marks drawn before it (dots, lines, axes, grids) are obstacles; put it
 * last. Labels with an asynchronous engine are filled in when the result arrives.
 */
import { text as plotText, type Mark, type TextOptions } from "@observablehq/plot";
import type { LabelProblem, LabelResult } from "@label-anything/core";
import { andThen, resolveEngine } from "./engine.js";
import { buildProblem, placeOptionsOf, resolveFont, type LabelOptions } from "./options.js";
import { renderLabels, type RenderOptions } from "./render.js";
import { snapshotSvg, SVG_NS } from "./svg.js";

export interface LabelMarkOptions<D>
  extends Omit<TextOptions, "render" | "fontWeight" | "fontStyle" | "fontFamily">,
    Omit<LabelOptions<D>, "text" | "id" | "font"> {
  /** Radius of the labeled marks (px), e.g. the `r` of a `Plot.dot` (default 3). */
  r?: number;
  /** Label font family/weight/style (size: the `fontSize` option, default 10). */
  fontFamily?: string;
  fontWeight?: number | "normal" | "bold";
  fontStyle?: "normal" | "italic";
  /** Use the marks drawn before this one as obstacles (default `true`). */
  background?: boolean;
  /** Called with each result. */
  onResult?: (result: LabelResult) => void;
  render?: never;
}

type Values = { x?: ArrayLike<number>; y?: ArrayLike<number>; text?: ArrayLike<unknown>; fontSize?: ArrayLike<number> };
type Dimensions = { width: number; height: number };
type Scales = { x?: { bandwidth?(): number }; y?: { bandwidth?(): number } };
type Context = { document?: Document; ownerSVGElement?: SVGSVGElement };

/** A `Plot.text` mark whose labels avoid each other and the rest of the plot. */
export function labelAnything<D>(data: Iterable<D> | ArrayLike<D>, options: LabelMarkOptions<D> = {}): Mark {
  const {
    engine,
    priority,
    attrs,
    preset,
    avoid,
    leaders,
    placement,
    solver,
    padding,
    problem,
    measure,
    placeOptions,
    r = 3,
    fontFamily,
    fontWeight,
    fontStyle,
    background = true,
    onResult,
    halo,
    ...textOptions
  } = options as LabelMarkOptions<D> & Pick<RenderOptions, "halo">;
  const helper: LabelOptions<D> = { engine, priority, attrs, preset, avoid, leaders, placement, solver, padding, problem, measure, placeOptions };
  const rows = Array.from(data as ArrayLike<D>);
  const fontSize = typeof textOptions.fontSize === "number" ? textOptions.fontSize : 10;
  const font = resolveFont({ family: fontFamily, size: fontSize, weight: fontWeight, style: fontStyle }, { family: "system-ui, sans-serif" });

  function render(index: number[], scales: Scales, values: Values, dimensions: Dimensions, context: Context): SVGGElement {
    const doc = context.document ?? context.ownerSVGElement?.ownerDocument ?? globalThis.document;
    const g = doc.createElementNS(SVG_NS, "g") as SVGGElement;
    g.setAttribute("aria-label", "labels");
    const { x: X, y: Y, text: T, fontSize: FS } = values;
    // Plot's own mark offset: half a pixel on low-DPI screens (crisp edges), half a band
    const view = doc.defaultView as { devicePixelRatio?: number } | null;
    const offset = view && (view.devicePixelRatio ?? 1) > 1 ? 0 : 0.5;
    const ox = offset + (scales.x?.bandwidth ? scales.x.bandwidth() / 2 : 0);
    const oy = offset + (scales.y?.bandwidth ? scales.y.bandwidth() / 2 : 0);
    const items: LabelProblem["items"] = [];
    for (const i of index) {
      const t = T?.[i];
      if (t === null || t === undefined || t === "") continue;
      const x = (X ? X[i]! : dimensions.width / 2) + ox;
      const y = (Y ? Y[i]! : dimensions.height / 2) + oy;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const label: LabelProblem["items"][number]["label"] = { type: "text", text: String(t) };
      if (FS && Number.isFinite(FS[i])) label.font = { size: FS[i] };
      const item: LabelProblem["items"][number] = {
        id: String(i),
        anchor: { type: "point", x, y, mark: { shape: "circle", r } },
        label,
      };
      if (typeof priority === "function") {
        const p = priority(rows[i] as D, i);
        if (typeof p === "number" && Number.isFinite(p)) item.priority = p;
      }
      if (attrs) {
        const a = attrs(rows[i] as D, i);
        if (a) item.attrs = a;
      }
      items.push(item);
    }
    // Faceted marks render in facet coordinates; the plot's SVG would not line up.
    const faceted = (index as { fi?: number }).fi !== undefined;
    const svg = context.ownerSVGElement;
    const obstacles: LabelProblem["obstacles"] | undefined =
      background && svg && !faceted ? { svg: { source: snapshotSvg(svg).source } } : undefined;
    const p = buildProblem(
      { canvas: { width: dimensions.width, height: dimensions.height }, items, ...(obstacles ? { obstacles } : {}) },
      helper,
      font,
    );
    const fill = typeof textOptions.fill === "string" ? textOptions.fill : undefined;
    const stroke = typeof textOptions.stroke === "string" ? textOptions.stroke : undefined;
    const draw = (result: LabelResult) => {
      renderLabels(g, result, { font, fill, halo: halo ?? stroke ?? false });
      onResult?.(result);
    };
    const result = resolveEngine(engine).place(p, placeOptionsOf(helper));
    void andThen(result, draw);
    return g;
  }

  return plotText(data as Iterable<D>, { ...(textOptions as TextOptions), render: render as unknown as TextOptions["render"] });
}
