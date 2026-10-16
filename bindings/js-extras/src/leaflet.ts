/**
 * Leaflet: a layer of labels for point data, re-solved after every move and warm-started
 * from the previous result, so labels keep their places while you pan and zoom.
 *
 * ```js
 * import L from "leaflet";
 * import { labelLayer } from "@label-anything/extras/leaflet";
 * labelLayer(L, cities, {
 *   latLng: (d) => [d.lat, d.lon],
 *   text: (d) => d.name,
 *   priority: (d) => d.population,                // larger cities win
 *   mark: { shape: "icon", w: 25, h: 41 },        // the default marker pin
 * }).addTo(map);
 * ```
 */
import type { LabelResult } from "@label-anything/core";
import type { LabelOptions, Mark } from "./options.js";
import { idOf, itemExtras, labelOf, resolveFont } from "./options.js";
import { Overlay, type OverlayItem } from "./overlay.js";
import type { RenderOptions } from "./render.js";

type LatLngLike = readonly [number, number] | { lat: number; lng: number };
type PointLike = { x: number; y: number };

/** The parts of a Leaflet map used here. */
export interface LeafletMapLike {
  getSize(): PointLike;
  latLngToContainerPoint(latlng: LatLngLike): PointLike;
  containerPointToLayerPoint(point: [number, number] | PointLike): PointLike;
  getPane(name: string): HTMLElement | undefined;
  createPane(name: string): HTMLElement;
  getBounds?(): { contains(latlng: LatLngLike): boolean };
}

/** The parts of the Leaflet namespace used here (`import L from "leaflet"`). */
export interface LeafletLike {
  Layer: { extend(props: object): new () => object };
  DomUtil: { setPosition(el: HTMLElement | SVGElement, point: PointLike): void };
}

export interface LeafletLabelOptions<D> extends LabelOptions<D>, Omit<RenderOptions, "font"> {
  /** Position of a datum. */
  latLng: (d: D, i: number) => LatLngLike | null | undefined;
  /** Mark at the anchor that labels must not cover (default: circle r = 4). */
  mark?: Mark | ((d: D, i: number) => Mark | undefined);
  /** Map pane for the labels (created with z-index 640 if missing). */
  pane?: string;
  /** Obstacles in container px, e.g. from other layers. */
  obstacles?: (map: LeafletMapLike) => NonNullable<import("@label-anything/core").LabelProblem["obstacles"]> | undefined;
  onResult?: (result: LabelResult) => void;
  onError?: (error: unknown) => void;
}

/** A Leaflet layer with Label Anything labels. */
export interface LabelLayer<D> {
  addTo(map: unknown): this;
  remove(): this;
  /** Replaces the data and re-solves. */
  setData(data: readonly D[]): void;
  /** Re-solves now. */
  update(): void;
  /** The last result (container px of the view it was solved for). */
  readonly result: LabelResult | undefined;
}

export function labelLayer<D>(L: LeafletLike, data: readonly D[], options: LeafletLabelOptions<D>): LabelLayer<D> {
  let rows = data;
  let map: LeafletMapLike | undefined;
  let overlay: Overlay<D> | undefined;
  const font = resolveFont(options.font, { size: 12, family: "sans-serif" });
  const paneName = options.pane ?? "labelAnything";

  const collect = (): OverlayItem[] => {
    if (!map) return [];
    const size = map.getSize();
    const out: OverlayItem[] = [];
    rows.forEach((d, i) => {
      const ll = options.latLng(d, i);
      const label = ll ? labelOf(options, d, i) : null;
      if (!ll || !label) return;
      const p = map!.latLngToContainerPoint(ll);
      if (!(p.x >= 0 && p.y >= 0 && p.x <= size.x && p.y <= size.y)) return;
      const mark = typeof options.mark === "function" ? options.mark(d, i) : (options.mark ?? { shape: "circle", r: 4 });
      out.push({ id: idOf(options, d, i), x: p.x, y: p.y, label, mark, extras: itemExtras(options, d, i) });
    });
    return out;
  };

  const place = () => {
    if (!map || !overlay) return;
    L.DomUtil.setPosition(overlay.svg, map.containerPointToLayerPoint([0, 0]));
    overlay.setVisible(true);
    overlay.update();
  };
  const hide = () => overlay?.setVisible(false);

  const Layer = L.Layer.extend({
    onAdd(this: object, m: LeafletMapLike) {
      map = m;
      const pane = m.getPane(paneName) ?? m.createPane(paneName);
      if (!pane.style.zIndex) pane.style.zIndex = "640";
      pane.style.pointerEvents = "none";
      overlay = new Overlay<D>({
        container: pane,
        options,
        font,
        render: { halo: "white", ...options },
        size: () => {
          const s = m.getSize();
          return [s.x, s.y];
        },
        collect,
        obstacles: options.obstacles ? () => options.obstacles!(m) : undefined,
        onResult: options.onResult,
        onError: options.onError,
      });
      place();
      return this;
    },
    onRemove(this: object) {
      overlay?.destroy();
      overlay = undefined;
      map = undefined;
      return this;
    },
    getEvents(this: object) {
      return { zoomstart: hide, moveend: place, resize: place, viewreset: place };
    },
    setData(this: object, next: readonly D[]) {
      rows = next;
      place();
    },
    update(this: object) {
      place();
    },
  });
  const layer = new Layer() as unknown as LabelLayer<D>;
  Object.defineProperty(layer, "result", { get: () => overlay?.result });
  return layer;
}
