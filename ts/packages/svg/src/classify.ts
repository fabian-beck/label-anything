// Classification of primitives and geometry lookup for `from_svg` marks. Mirrors classify.rs.

import { SvgFailure } from "./error.js";
import { SCENE_IDS } from "./render.js";
import { type MatchContext, Selector, parseSelectorList, selectorMatches } from "./selector.js";
import type { ClassRule, Classified, Geometry, Primitive, Scene } from "./types.js";

/** The class name that drops matching primitives. */
export const IGNORE = "ignore";

export function matchContext(scene: Scene): MatchContext {
  return { canvasWidth: scene.canvas_width, canvasHeight: scene.canvas_height };
}

export function compileSelector(s: string): Selector {
  if (typeof s !== "string") throw new SvgFailure("pattern", "selector must be a string");
  return new Selector(parseSelectorList(s, "rules"));
}

export function elementByIdImpl(scene: Scene, id: string): number | undefined {
  let ids = SCENE_IDS.get(scene);
  if (ids === undefined) {
    ids = new Map();
    scene.elements.forEach((e, i) => {
      if (e.id !== null && !ids!.has(e.id)) ids!.set(e.id, i);
    });
    SCENE_IDS.set(scene, ids);
  }
  return ids.get(id);
}

function lowerBound(prims: readonly Primitive[], element: number): number {
  let lo = 0;
  let hi = prims.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prims[mid]!.element < element) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function subtreePrimitivesImpl(scene: Scene, element: number): Primitive[] {
  const el = scene.elements[element];
  if (el === undefined) return [];
  const lo = lowerBound(scene.primitives, element);
  const hi = lowerBound(scene.primitives, el.subtree_end);
  return scene.primitives.slice(lo, hi);
}

export function classifyImpl(scene: Scene, rules: readonly ClassRule[], defaultClass: string): Classified[] {
  const selectors: Selector[] = [];
  rules.forEach((r, k) => {
    try {
      selectors.push(compileSelector(r.selector));
    } catch (e) {
      if (e instanceof SvgFailure) throw new SvgFailure(e.error.code, `class rule ${k}: ${e.error.message}`);
      throw e;
    }
  });
  const ctx = matchContext(scene);
  const out: Classified[] = [];
  let memoEl = -1;
  let memoClass = defaultClass;
  scene.primitives.forEach((p, index) => {
    if (p.element !== memoEl) {
      memoEl = p.element;
      memoClass = defaultClass;
      for (let k = 0; k < selectors.length; k++) {
        if (selectorMatches(selectors[k]!, scene.elements, p.element, ctx)) {
          memoClass = rules[k]!.class;
          break;
        }
      }
    }
    if (memoClass !== IGNORE) out.push({ class: memoClass, index, primitive: p });
  });
  return out;
}

export function selectImpl(scene: Scene, selector: string): Primitive[] {
  const sel = compileSelector(selector);
  const ctx = matchContext(scene);
  const out: Primitive[] = [];
  let covered = 0;
  for (let i = 0; i < scene.elements.length; i++) {
    if (i < covered) continue;
    if (selectorMatches(sel, scene.elements, i, ctx)) {
      for (const p of subtreePrimitivesImpl(scene, i)) out.push(p);
      covered = scene.elements[i]!.subtree_end;
    }
  }
  return out;
}

function geometryOf(p: Primitive): Geometry {
  switch (p.type) {
    case "polygon":
      return { type: "polygon", rings: p.rings, even_odd: p.even_odd };
    case "polyline":
      return { type: "polyline", points: p.points, width: p.width, closed: p.closed };
    case "rect":
      return { type: "rect", x: p.x, y: p.y, w: p.w, h: p.h };
  }
}

function flush(group: Primitive[], out: Geometry[]): void {
  const hasFill = group.some((p) => p.type === "polygon");
  const hasRect = group.some((p) => p.type === "rect");
  for (const p of group) {
    if (p.type === "polygon") out.push(geometryOf(p));
    else if (p.type === "rect") {
      out.push({
        type: "polygon",
        rings: [
          [
            [p.x, p.y],
            [p.x + p.w, p.y],
            [p.x + p.w, p.y + p.h],
            [p.x, p.y + p.h],
          ],
        ],
        even_odd: false,
      });
    } else if (!hasFill && !hasRect) out.push(geometryOf(p));
  }
  group.length = 0;
}

export function outlineImpl(primitives: Iterable<Primitive>): Geometry[] {
  const out: Geometry[] = [];
  const group: Primitive[] = [];
  for (const p of primitives) {
    const last = group[group.length - 1];
    if (last !== undefined && last.shape !== p.shape) flush(group, out);
    group.push(p);
  }
  flush(group, out);
  return out;
}
