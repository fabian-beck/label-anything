/**
 * An SVG label overlay over an interactive view (maps, graphs): solves on demand with the
 * previous result as warm start, follows moving anchors between solves, moves labels
 * smoothly into the places of a new solve (`LabelMotion`), and keeps only the latest solve
 * when updates overlap.
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";
import { LatestRunner, resolveEngine } from "./engine.js";
import type { CssFont } from "./measure.js";
import { buildProblem, placeOptionsOf, type Item, type Label, type LabelOptions, type Mark } from "./options.js";
import { LabelMotion } from "./motion.js";
import { renderLabels, type RenderOptions } from "./render.js";
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
  /**
   * Transition time in ms (default 300): labels glide into the places of a new solve and
   * fade in and out; 0 draws each solve as it is.
   */
  transition?: number;
  onResult?(result: LabelResult): void;
  onError?(error: unknown): void;
}

export class Overlay<D> {
  readonly svg: SVGSVGElement;
  readonly group: SVGGElement;
  readonly memory = new LabelMemory();
  readonly motion: LabelMotion;
  readonly runner: LatestRunner;
  #config: OverlayConfig<D>;
  #frame: number | undefined;

  constructor(config: OverlayConfig<D>) {
    this.#config = config;
    this.motion = new LabelMotion({ duration: config.transition ?? 300 });
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
        this.motion.target(result, anchors);
        this.follow();
        this.#animate();
        c.onResult?.(result);
      },
      (error) => (c.onError ? c.onError(error) : console.error(error)),
    );
  }

  /** Redraws the labels, every one moved along with its anchor (no solve). */
  follow(anchors?: Anchors): void {
    if (!this.motion.result) return;
    const f = this.motion.frame(anchors ?? this.#anchors(this.#config.collect()));
    renderLabels(this.group, f.result, {
      ...this.#config.render,
      font: this.#config.font,
      opacity: f.opacity,
      leaderOpacity: f.leaderOpacity,
    });
  }

  /** Redraws on every animation frame until the labels have settled (at once without rAF). */
  #animate(): void {
    if (this.#frame !== undefined || !this.motion.moving) return;
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== "function") {
      this.motion.finish();
      this.follow();
      return;
    }
    const step = () => {
      this.#frame = undefined;
      this.follow();
      if (this.motion.moving) this.#frame = raf(step);
    };
    this.#frame = raf(step);
  }

  setVisible(visible: boolean): void {
    this.svg.style.display = visible ? "" : "none";
  }

  destroy(): void {
    if (this.#frame !== undefined) globalThis.cancelAnimationFrame?.(this.#frame);
    this.#frame = undefined;
    this.runner.cancel();
    this.svg.remove();
    this.memory.clear();
    this.motion.clear();
  }
}
