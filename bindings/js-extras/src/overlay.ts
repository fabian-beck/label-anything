/**
 * An SVG label overlay over an interactive view (maps, graphs): solves on demand with the
 * previous result as warm start, follows moving anchors between solves, and keeps only the
 * latest solve when updates overlap.
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";
import { LatestRunner, resolveEngine } from "./engine.js";
import type { CssFont } from "./measure.js";
import { buildProblem, placeOptionsOf, type Item, type Label, type LabelOptions, type Mark } from "./options.js";
import { followAnchors, renderLabels, type RenderOptions } from "./render.js";
import { LabelMemory, type Anchors } from "./stable.js";
import { SVG_NS } from "./svg.js";


/** One item of the current view, in overlay px. */
export interface OverlayItem {
  id: string;
  x: number;
  y: number;
  label: Label;
  mark?: Mark;
  extras?: Partial<Item>;
}

export interface OverlayConfig<D> {
  /** Element the overlay `<svg>` is appended to. */
  container: Element;
  options: LabelOptions<D>;
  font: CssFont;
  render?: Omit<RenderOptions, "font">;
  /** View size in px. */
  size(): readonly [number, number];
  /** The items to label, at their current positions (overlay px). */
  collect(): OverlayItem[];
  /** Obstacles of the current view (overlay px). */
  obstacles?(): LabelProblem["obstacles"] | undefined;
  onResult?(result: LabelResult): void;
  onError?(error: unknown): void;
}

export class Overlay<D> {
  readonly svg: SVGSVGElement;
  readonly group: SVGGElement;
  readonly memory = new LabelMemory();
  readonly runner: LatestRunner;
  #config: OverlayConfig<D>;

  constructor(config: OverlayConfig<D>) {
    this.#config = config;
    this.runner = new LatestRunner(resolveEngine(config.options.engine));
    const doc = config.container.ownerDocument;
    this.svg = doc.createElementNS(SVG_NS, "svg") as SVGSVGElement;
    this.svg.setAttribute("class", `${config.render?.className ?? "la"}-overlay`);
    this.svg.setAttribute("style", "position:absolute;left:0;top:0;overflow:visible;pointer-events:none");
    this.group = doc.createElementNS(SVG_NS, "g") as SVGGElement;
    this.svg.appendChild(this.group);
    config.container.appendChild(this.svg);
  }

  /** The last result (positions as of its solve). */
  get result(): LabelResult | undefined {
    return this.memory.result;
  }

  #anchors(items: OverlayItem[]): Map<string, readonly [number, number]> {
    return new Map(items.map((it) => [it.id, [it.x, it.y] as const]));
  }

  /** Solves for the current view. */
  update(): void {
    const c = this.#config;
    const [w, h] = c.size();
    this.svg.setAttribute("width", String(w));
    this.svg.setAttribute("height", String(h));
    if (!(w > 0 && h > 0)) return;
    const items = c.collect();
    const anchors = this.#anchors(items);
    const warm = this.memory.warmStart(anchors);
    const obstacles = c.obstacles?.();
    const problem = buildProblem(
      {
        canvas: { width: w, height: h },
        items: items.map((it) => ({
          id: it.id,
          anchor: it.mark ? { type: "point", x: it.x, y: it.y, mark: it.mark } : { type: "point", x: it.x, y: it.y },
          label: it.label,
          ...it.extras,
        })),
        ...(obstacles ? { obstacles } : {}),
        ...(warm ? { warm_start: warm } : {}),
      },
      c.options,
      c.font,
    );
    this.runner.run(
      problem,
      placeOptionsOf(c.options),
      (result) => {
        this.memory.remember(result, anchors);
        this.follow();
        c.onResult?.(result);
      },
      (error) => (c.onError ? c.onError(error) : console.error(error)),
    );
  }

  /** Redraws the last result with every label moved along with its anchor (no solve). */
  follow(anchors?: Anchors): void {
    const result = this.memory.result;
    if (!result) return;
    const now = anchors ?? this.#anchors(this.#config.collect());
    renderLabels(this.group, followAnchors(result, this.memory.anchors, now), { ...this.#config.render, font: this.#config.font });
  }

  setVisible(visible: boolean): void {
    this.svg.style.display = visible ? "" : "none";
  }

  destroy(): void {
    this.runner.cancel();
    this.svg.remove();
    this.memory.clear();
  }
}
