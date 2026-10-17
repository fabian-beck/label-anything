/**
 * MapLibre GL (and Mapbox GL): labels for point data in an SVG overlay. Labels follow
 * their anchors while the map moves and are re-solved (warm-started) on `moveend`.
 * Rendered features of other layers can be obstacles (`avoidLayers`).
 *
 * ```js
 * import { labelMapLibre } from "@label-anything/extras/maplibre";
 * const labels = labelMapLibre(map, stations, {
 *   lngLat: (d) => [d.lon, d.lat],
 *   text: (d) => d.name,
 *   priority: (d) => d.passengers,
 *   avoidLayers: ["roads", "rivers"],
 *   avoid: { label: { roads: 0.5, rivers: "hard" } },
 * });
 * ```
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";
import type { LabelOptions, Mark } from "./options.js";
import { idOf, itemExtras, labelOf, resolveFont } from "./options.js";
import { Overlay, type OverlayItem } from "./overlay.js";
import type { RenderOptions } from "./render.js";

type LngLatLike = readonly [number, number] | { lng: number; lat: number };
type Position = number[];
type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "MultiPoint" | "LineString"; coordinates: Position[] }
  | { type: "MultiLineString" | "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] }
  | { type: "GeometryCollection"; geometries: Geometry[] };

/** The parts of a MapLibre/Mapbox map used here. */
export interface MapLibreLike {
  project(lngLat: LngLatLike): { x: number; y: number };
  getCanvasContainer(): HTMLElement;
  getCanvas(): { clientWidth: number; clientHeight: number };
  on(type: string, listener: () => void): unknown;
  off(type: string, listener: () => void): unknown;
  queryRenderedFeatures?(geometry?: unknown, options?: { layers?: string[] }): { layer?: { id: string }; geometry: Geometry }[];
}

export interface MapLibreLabelOptions<D> extends LabelOptions<D>, Omit<RenderOptions, "font"> {
  /** Position of a datum. */
  lngLat: (d: D, i: number) => LngLatLike | null | undefined;
  /** Mark at the anchor that labels must not cover (default: circle r = 4). */
  mark?: Mark | ((d: D, i: number) => Mark | undefined);
  /** Style layers whose rendered features are obstacles (class = layer id). */
  avoidLayers?: string[];
  /** Stroke width of line features (px, default 2) and radius of point features (default 3). */
  lineWidth?: number;
  pointRadius?: number;
  /** Further obstacles in container px. */
  obstacles?: (map: MapLibreLike) => NonNullable<LabelProblem["obstacles"]> | undefined;
  /** Transition time in ms (default 300): labels glide into new places and fade in and out; 0: none. */
  transition?: number;
  onResult?: (result: LabelResult) => void;
  onError?: (error: unknown) => void;
}

export interface MapLabels<D> {
  setData(data: readonly D[]): void;
  update(): void;
  remove(): void;
  readonly result: LabelResult | undefined;
}

export function labelMapLibre<D>(map: MapLibreLike, data: readonly D[], options: MapLibreLabelOptions<D>): MapLabels<D> {
  let rows = data;
  const font = resolveFont(options.font, { size: 12, family: "sans-serif" });
  const size = () => {
    const c = map.getCanvas();
    return [c.clientWidth, c.clientHeight] as const;
  };
  const collect = (): OverlayItem[] => {
    const [w, h] = size();
    const out: OverlayItem[] = [];
    rows.forEach((d, i) => {
      const ll = options.lngLat(d, i);
      const label = ll ? labelOf(options, d, i) : null;
      if (!ll || !label) return;
      const p = map.project(ll);
      if (!(p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h)) return;
      const mark = typeof options.mark === "function" ? options.mark(d, i) : (options.mark ?? { shape: "circle", r: 4 });
      out.push({ id: idOf(options, d, i), x: p.x, y: p.y, label, mark, extras: itemExtras(options, d, i) });
    });
    return out;
  };
  const obstacles = (): LabelProblem["obstacles"] | undefined => {
    const vector = options.avoidLayers?.length ? featureObstacles(map, options.avoidLayers, options.lineWidth ?? 2, options.pointRadius ?? 3) : [];
    const extra = options.obstacles?.(map);
    if (!vector.length) return extra;
    return { ...extra, vector: [...(extra?.vector ?? []), ...vector] };
  };
  const overlay = new Overlay<D>({
    container: map.getCanvasContainer(),
    options,
    font,
    render: { halo: "white", ...options },
    size,
    collect,
    obstacles,
    transition: options.transition,
    onResult: options.onResult,
    onError: options.onError,
  });
  const follow = () => overlay.follow();
  const update = () => overlay.update();
  map.on("move", follow);
  map.on("moveend", update);
  map.on("resize", update);
  update();
  return {
    setData(next) {
      rows = next;
      update();
    },
    update,
    remove() {
      map.off("move", follow);
      map.off("moveend", update);
      map.off("resize", update);
      overlay.destroy();
    },
    get result() {
      return overlay.result;
    },
  };
}

type VectorLayer = NonNullable<NonNullable<LabelProblem["obstacles"]>["vector"]>[number];

function featureObstacles(map: MapLibreLike, layers: string[], lineWidth: number, pointRadius: number): VectorLayer[] {
  if (!map.queryRenderedFeatures) return [];
  const byClass = new Map<string, { polylines: [number, number][][]; polygons: [number, number][][]; points: [number, number][] }>();
  const project = (c: Position): [number, number] => {
    const p = map.project([c[0]!, c[1]!]);
    return [p.x, p.y];
  };
  const add = (cls: string, g: Geometry) => {
    let e = byClass.get(cls);
    if (!e) byClass.set(cls, (e = { polylines: [], polygons: [], points: [] }));
    switch (g.type) {
      case "Point":
        e.points.push(project(g.coordinates));
        break;
      case "MultiPoint":
        for (const c of g.coordinates) e.points.push(project(c));
        break;
      case "LineString":
        if (g.coordinates.length >= 2) e.polylines.push(g.coordinates.map(project));
        break;
      case "MultiLineString":
        for (const l of g.coordinates) if (l.length >= 2) e.polylines.push(l.map(project));
        break;
      case "Polygon":
        if (g.coordinates[0] && g.coordinates[0].length >= 4) e.polygons.push(g.coordinates[0].slice(0, -1).map(project));
        break;
      case "MultiPolygon":
        for (const poly of g.coordinates) if (poly[0] && poly[0].length >= 4) e.polygons.push(poly[0].slice(0, -1).map(project));
        break;
      case "GeometryCollection":
        for (const sub of g.geometries) add(cls, sub);
        break;
    }
  };
  for (const f of map.queryRenderedFeatures(undefined, { layers })) {
    const id = f.layer?.id ?? "features";
    add(/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(id) ? id : "features", f.geometry);
  }
  const out: VectorLayer[] = [];
  for (const [cls, e] of byClass) {
    const layer: VectorLayer = { class: cls };
    if (e.polylines.length) {
      layer.polylines = e.polylines as VectorLayer["polylines"];
      layer.width = lineWidth;
    }
    if (e.polygons.length) layer.polygons = e.polygons as VectorLayer["polygons"];
    if (e.points.length) {
      layer.points = e.points;
      layer.r = pointRadius;
    }
    out.push(layer);
  }
  return out;
}
