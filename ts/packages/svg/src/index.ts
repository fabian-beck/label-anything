// @label-anything/svg — SVG backgrounds → classified obstacle geometry (spec §4.5).
//
// Pure TypeScript, zero dependencies; works in Node, Deno, Bun and browsers (own XML parser,
// no DOMParser). Line-by-line mirror of the Rust crate `label-anything-svg`; both are tested
// against conformance/svg/. All functions return `Result` values and never throw.

import { classifyImpl, compileSelector, elementByIdImpl, matchContext, outlineImpl, selectImpl, subtreePrimitivesImpl } from "./classify.js";
import { guard } from "./error.js";
import { parseScene } from "./render.js";
import { Selector, selectorMatches } from "./selector.js";
import type { ClassRule, Classified, Geometry, ParseOptions, Primitive, Result, Scene } from "./types.js";

export type {
  ClassRule,
  Classified,
  Element,
  Geometry,
  MeasureFn,
  ParseOptions,
  Point,
  Primitive,
  Rect,
  Result,
  Scene,
  SvgError,
  SvgErrorCode,
} from "./types.js";
export { DEFAULT_ADVANCE, DEFAULT_ASCENT, DEFAULT_DESCENT, DEFAULT_TOLERANCE } from "./types.js";
export { BACKGROUND_FRACTION, SMALL_PX, Selector } from "./selector.js";
export { IGNORE } from "./classify.js";

/**
 * Parses and renders an SVG document into primitives in canvas pixels.
 * Errors: `parse` (malformed XML), `invalid_value` (root is not `<svg>`, no positive viewport,
 * invalid options), `limit` (nesting, element, `<use>` expansion or point limits).
 */
export function parseSvg(svg: string, options: ParseOptions = {}): Result<Scene> {
  return guard(() => parseScene(svg, options ?? {}));
}

/** Parses a selector (our CSS subset). Errors: `pattern`. */
export function parseSelector(selector: string): Result<Selector> {
  return guard(() => compileSelector(selector));
}

/**
 * Classifies all primitives: the first rule whose selector matches the primitive's element
 * (the outermost `<use>` for instance geometry) wins, else `defaultClass`; class `"ignore"`
 * drops the primitive. Errors: `pattern`.
 */
export function classify(scene: Scene, rules: readonly ClassRule[], defaultClass: string): Result<Classified[]> {
  return guard(() => classifyImpl(scene, rules, defaultClass));
}

/** The primitives of the element with this id and its descendants (undefined if no such element). */
export function elementGeometry(scene: Scene, id: string): Primitive[] | undefined {
  const i = elementByIdImpl(scene, id);
  return i === undefined ? undefined : subtreePrimitivesImpl(scene, i);
}

/** The primitives of all elements matching `selector` (and their descendants), in paint order. */
export function select(scene: Scene, selector: string): Result<Primitive[]> {
  return guard(() => selectImpl(scene, selector));
}

/**
 * The outline of some primitives for use as an item mark: per drawn shape its fill polygon,
 * else its text boxes as polygons, else its stroke polylines (to be treated as capsules).
 */
export function outline(primitives: Iterable<Primitive>): Geometry[] {
  return outlineImpl(primitives);
}

/** The first element (in document order) with this id. */
export function elementById(scene: Scene, id: string): number | undefined {
  return elementByIdImpl(scene, id);
}

/** The primitives attributed to `element` or its descendants (contiguous in paint order). */
export function subtreePrimitives(scene: Scene, element: number): Primitive[] {
  return subtreePrimitivesImpl(scene, element);
}

/** Whether element `element` matches `selector`. */
export function matches(scene: Scene, element: number, selector: Selector): boolean {
  return element >= 0 && element < scene.elements.length && selectorMatches(selector, scene.elements, element, matchContext(scene));
}

/** The elements matching `selector`, in document order. */
export function selectElements(scene: Scene, selector: Selector): number[] {
  const ctx = matchContext(scene);
  const out: number[] = [];
  for (let i = 0; i < scene.elements.length; i++) if (selectorMatches(selector, scene.elements, i, ctx)) out.push(i);
  return out;
}
