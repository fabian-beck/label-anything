// Public data types. Field names are snake_case so that objects are identical to the JSON
// produced by the Rust crate `label-anything-svg` (feature `serde`).

/** A point `[x, y]` in canvas pixels. */
export type Point = [number, number];

/** An axis-aligned rectangle in canvas pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Drawn geometry in canvas pixels. */
export type Geometry =
  /** A filled area: implicitly closed rings (each ≥ 3 points) combined with the fill rule. */
  | { type: "polygon"; rings: Point[][]; even_odd: boolean }
  /** A stroked subpath, treated as a capsule chain (round joins and caps). Closed polylines do not repeat the first point. */
  | { type: "polyline"; points: Point[]; width: number; closed: boolean }
  /** The bounding box of a text chunk. */
  | { type: "rect"; x: number; y: number; w: number; h: number };

/** One piece of drawn geometry. */
export type Primitive = {
  /** The element it is attributed to (the outermost `<use>` for instance content). */
  element: number;
  /** The element whose geometry it is (e.g. the `<path>` inside `<defs>`). */
  source: number;
  /** Drawn-shape counter: the fill and stroke primitives of one shape share it. */
  shape: number;
} & Geometry;

/** One XML element of the document, in document order. */
export interface Element {
  /** Local name (`rect`, `linearGradient`, ...). */
  tag: string;
  /** Namespace URI for elements outside the SVG namespace (never drawn); null for SVG elements. */
  namespace: string | null;
  id: string | null;
  /** Whitespace-separated tokens of the `class` attribute. */
  classes: string[];
  /** Attributes in source order, keyed by their qualified name as written (`xlink:href`). */
  attributes: Record<string, string>;
  parent: number | null;
  /** End (exclusive) of this element's descendants: they are `index + 1 .. subtree_end`. */
  subtree_end: number;
  /** Rendered directly (not only through `<use>`), visible and with non-zero opacity. */
  drawn: boolean;
  /** Computed fill paint ≠ none with alpha × fill-opacity > 0 (images: always; `<line>`: never). */
  filled: boolean;
  /** Computed stroke paint ≠ none with alpha × stroke-opacity > 0 and width > 0. */
  stroked: boolean;
  /** Geometry bbox (without stroke) of the element and its rendered descendants, canvas px. */
  bbox: Rect | null;
}

/** Error and warning codes, shared with the Rust implementation. */
export type SvgErrorCode = "parse" | "invalid_value" | "pattern" | "limit" | "ignored";

/** A structured error (or warning). */
export interface SvgError {
  code: SvgErrorCode;
  /** Human-readable message (not part of the cross-implementation contract). */
  message: string;
}

/** Result of a fallible operation (no exceptions are thrown). */
export type Result<T> = { ok: true; value: T } | { ok: false; error: SvgError };

/** A parsed and rendered SVG document. */
export interface Scene {
  /** Viewport width of the SVG in px (resolved `width`). */
  width: number;
  height: number;
  /** Canvas size (the target size, or the viewport size). */
  canvas_width: number;
  canvas_height: number;
  /** The root `viewBox`, if valid. */
  view_box: [number, number, number, number] | null;
  /** All elements in document order (index 0 is the root `<svg>`). */
  elements: Element[];
  /** Drawn geometry in paint order (non-decreasing `element`). */
  primitives: Primitive[];
  /** Non-fatal problems (codes `ignored`, `limit`). */
  warnings: SvgError[];
}

/**
 * Text measurement: `(text, fontSizePx, family, weight) -> widthPx`. `fontSizePx` is in the
 * text element's user units, `family` the first family of `font-family` (unquoted).
 */
export type MeasureFn = (text: string, fontSize: number, family: string, weight: number) => number;

/** Options of `parseSvg`. */
export interface ParseOptions {
  /** Target canvas size; the SVG viewport is scaled onto it. Default: the viewport size. */
  canvas?: { width: number; height: number } | null;
  /** Curve flattening tolerance in canvas px (default 0.25). */
  tolerance?: number;
  /** Text measurement (default: 0.55 em per code point). */
  measure?: MeasureFn | null;
  /** Ascent of text boxes in em (default 0.8). */
  ascent?: number;
  /** Descent of text boxes in em (default 0.2). */
  descent?: number;
}

/** A class rule (`class` may be `"ignore"`). */
export interface ClassRule {
  selector: string;
  class: string;
}

/** A fill of a region (spec §4.8): a polygon primitive and the rule that made it part of a region. */
export interface RegionFill {
  /** Index of the first selector that matches `element`. */
  rule: number;
  /**
   * The element that selector matches: the primitive's element (the outermost `<use>` for
   * instance geometry) or its nearest ancestor that a selector matches.
   */
  element: number;
  /** Index into `scene.primitives`. */
  index: number;
  /** The primitive (always a polygon: fills only). */
  primitive: Primitive;
}

/** A drawn primitive with its class. */
export interface Classified {
  /** The class (never `"ignore"`). */
  class: string;
  /** Index into `scene.primitives`. */
  index: number;
  primitive: Primitive;
}

export const DEFAULT_TOLERANCE = 0.25;
export const DEFAULT_ASCENT = 0.8;
export const DEFAULT_DESCENT = 0.2;
/** Width per code point of the default text measurement (em). */
export const DEFAULT_ADVANCE = 0.55;
