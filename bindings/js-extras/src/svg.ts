/**
 * Live SVG → markup for `obstacles.svg`: computed styles are inlined (so that stylesheet
 * rules such as `path.line { fill: none }` are seen by the engine's SVG parser), the label
 * layer itself is left out, and labeled marks get ids for `svg_id` / `auto_mark_items`.
 */
import { elementById, parseSvg, type Scene } from "@label-anything/svg";

export const SVG_NS = "http://www.w3.org/2000/svg";

/** Inherited properties: inlined only where they differ from the parent's computed value. */
const INHERITED = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "visibility",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
];
/** Non-inherited properties: inlined only when not at their initial value. */
const OWN: Record<string, string> = { display: "inline", opacity: "1", "vector-effect": "none" };

export interface SnapshotOptions {
  /** Elements that will be labeled: they get an id (if they have none) for `svg_id`. */
  marks?: readonly Element[];
  /** Subtrees to leave out (e.g. the label layer). */
  exclude?: (element: Element) => boolean;
  /** Inline computed styles (default: when `getComputedStyle` exists). */
  inlineStyles?: boolean;
}

export interface SvgSnapshot {
  /** Serialized SVG markup. */
  source: string;
  /** Per requested mark: its id in the markup. */
  ids: string[];
}

let snapshotCounter = 0;

export function snapshotSvg(root: SVGSVGElement | Element, options: SnapshotOptions = {}): SvgSnapshot {
  const marks = options.marks ?? [];
  const wanted = new Map<Element, number>();
  marks.forEach((m, i) => wanted.set(m, i));
  const ids: string[] = new Array(marks.length).fill("");
  const view = root.ownerDocument?.defaultView;
  const computed =
    options.inlineStyles !== false && view && typeof view.getComputedStyle === "function"
      ? (e: Element) => view.getComputedStyle(e)
      : undefined;
  const prefix = `la${(snapshotCounter++).toString(36)}m`;
  let next = 0;
  const clone = root.cloneNode(true) as Element;

  const walk = (a: Element, b: Element, parentStyle: Map<string, string> | undefined): void => {
    const style = computed ? inlineStyle(a, b, computed(a), parentStyle) : undefined;
    const k = wanted.get(a);
    if (k !== undefined) {
      let id = b.getAttribute("id");
      if (!id) {
        id = `${prefix}${next++}`;
        b.setAttribute("id", id);
      }
      ids[k] = id;
    }
    let ca = a.firstElementChild;
    let cb = b.firstElementChild;
    while (ca && cb) {
      const na = ca.nextElementSibling;
      const nb = cb.nextElementSibling;
      if (options.exclude?.(ca)) b.removeChild(cb);
      else walk(ca, cb, style);
      ca = na;
      cb = nb;
    }
  };
  walk(root, clone, undefined);
  const XS = (root.ownerDocument?.defaultView as { XMLSerializer?: new () => { serializeToString(n: Node): string } } | null)?.XMLSerializer;
  let source: string;
  if (XS) {
    source = new XS().serializeToString(clone); // declares the SVG namespace itself
  } else {
    source = clone.outerHTML;
    if (!/^<svg[^>]*\sxmlns=/.test(source)) source = source.replace(/^<svg/, `<svg xmlns="${SVG_NS}"`);
  }
  return { source, ids };
}

function inlineStyle(
  a: Element,
  b: Element,
  cs: CSSStyleDeclaration,
  parent: Map<string, string> | undefined,
): Map<string, string> {
  const mine = new Map<string, string>();
  let css = "";
  for (const p of INHERITED) {
    const v = cs.getPropertyValue(p);
    if (!v) continue;
    mine.set(p, v);
    if (parent?.get(p) !== v) css += `${p}:${v};`;
  }
  for (const [p, initial] of Object.entries(OWN)) {
    const v = cs.getPropertyValue(p);
    if (v && v !== initial) css += `${p}:${v};`;
  }
  if (css) b.setAttribute("style", css);
  // A CSS transform (stylesheet or style) on an element without a transform attribute.
  const t = cs.getPropertyValue("transform");
  if (t && t !== "none" && !a.hasAttribute("transform")) {
    const origin = cs.getPropertyValue("transform-origin").split(/\s+/).map((s) => Number.parseFloat(s));
    const [ox, oy] = [origin[0] || 0, origin[1] || 0];
    b.setAttribute("transform", ox || oy ? `translate(${ox},${oy}) ${t} translate(${-ox},${-oy})` : t);
  }
  return mine;
}

/** The root's viewBox mapping (root user units → viewport px) as an SVG matrix. */
export function viewBoxMatrix(scene: Scene, preserveAspectRatio: string | null): [number, number, number, number, number, number] {
  const vb = scene.view_box;
  if (!vb) return [1, 0, 0, 1, 0, 0];
  const [vx, vy, vw, vh] = vb;
  const W = scene.width;
  const H = scene.height;
  let sx = W / vw;
  let sy = H / vh;
  const [align = "xMidYMid", meet = "meet"] = (preserveAspectRatio ?? "").trim().split(/\s+/).filter(Boolean);
  let tx = 0;
  let ty = 0;
  if (align !== "none") {
    const s = meet === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = sy = s;
    if (align.includes("xMid")) tx = (W - vw * s) / 2;
    else if (align.includes("xMax")) tx = W - vw * s;
    if (align.includes("YMid")) ty = (H - vh * s) / 2;
    else if (align.includes("YMax")) ty = H - vh * s;
  }
  return [sx, 0, 0, sy, tx - vx * sx, ty - vy * sy];
}

/** Inverse of an axis-aligned scale + translate matrix, as an SVG transform attribute. */
export function inverseTransform(m: readonly number[]): string {
  const [a, , , d, e, f] = m as [number, number, number, number, number, number];
  if (a === 1 && d === 1 && e === 0 && f === 0) return "";
  return `matrix(${1 / a},0,0,${1 / d},${-e / a},${-f / d})`;
}

export interface ParsedMarks {
  scene: Scene;
  /** Bounding box (canvas px) per requested id, or null when the element draws nothing. */
  boxes: ({ x: number; y: number; w: number; h: number } | null)[];
}

/** Parses the snapshot with the engine's own SVG parser and looks up the marks' boxes. */
export function markBoxes(snapshot: SvgSnapshot): ParsedMarks {
  const parsed = parseSvg(snapshot.source);
  if (!parsed.ok) throw new Error(`@label-anything/extras: cannot parse the SVG (${parsed.error.code}: ${parsed.error.message})`);
  const scene = parsed.value;
  const boxes = snapshot.ids.map((id) => {
    const i = id ? elementById(scene, id) : undefined;
    return i === undefined ? null : scene.elements[i]!.bbox;
  });
  return { scene, boxes };
}
