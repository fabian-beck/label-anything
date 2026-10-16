// Document preparation (elements, style sheets, cascade) and rendering into primitives.
// Mirrors render.rs.

import { type CssRule, type Decl, parseDeclarations, parseStylesheet } from "./css.js";
import { SvgFailure, fail } from "./error.js";
import * as flatten from "./flatten.js";
import type { Subpath } from "./flatten.js";
import { type Affine, type BBox, IDENTITY, apply, bboxExtend, bboxOfPoints, bboxUnion, meanScale, mul, scale, translate } from "./geom.js";
import { type Length, parseLength, parseNumberList, resolveLength } from "./num.js";
import { parsePath } from "./path.js";
import { type MatchContext, complexMatches } from "./selector.js";
import { type CascadeContext, type Computed, EMPTY_SPECIFIED, type Specified, cascade, compute, initialStyle, isFilled, isStroked } from "./style.js";
import { layoutText } from "./text.js";
import { type AspectRatio, DEFAULT_ASPECT_RATIO, parseAspectRatio, parseTransform, parseViewBox, viewBoxTransform } from "./transform.js";
import {
  DEFAULT_ADVANCE,
  DEFAULT_ASCENT,
  DEFAULT_DESCENT,
  DEFAULT_TOLERANCE,
  type Element,
  type MeasureFn,
  type ParseOptions,
  type Point,
  type Primitive,
  type Rect,
  type Scene,
  type SvgError,
  type SvgErrorCode,
} from "./types.js";
import { NS_SVG, NS_XLINK, type XmlDoc, localName, localOf, parseXml, plainAttr } from "./xml.js";

export const MAX_RENDER_DEPTH = 384;
export const MAX_VISITS = 2_000_000;
export const MAX_POINTS = 8_000_000;
const DEFAULT_VIEWPORT: [number, number] = [300, 150];

/** The parsed document with resolved styles. */
export interface Doc {
  xml: XmlDoc;
  isSvg: boolean[];
  specified: Specified[];
  styles: Computed[];
  xmlSpace: (boolean | null)[];
  ids: Map<string, number>;
}

export function docTag(doc: Doc, i: number): string {
  return localName(doc.xml.elements[i]!);
}

/** An unprefixed attribute. */
export function docAttr(doc: Doc, i: number, name: string): string | undefined {
  return plainAttr(doc.xml.elements[i]!, name);
}

function docHref(doc: Doc, i: number): string | undefined {
  const e = doc.xml.elements[i]!;
  const v = plainAttr(e, "href");
  if (v !== undefined || e.attrNs === null) return v;
  for (let k = 0; k < e.attrNs.length; k++) {
    const ns = e.attrNs[k]!;
    if (ns !== null && doc.xml.namespaces[ns] === NS_XLINK && localOf(e.attrs[2 * k]!) === "href") return e.attrs[2 * k + 1];
  }
  return undefined;
}

function docLength(doc: Doc, i: number, name: string): Length | null {
  const v = docAttr(doc, i, name);
  return v === undefined ? null : parseLength(v);
}

function docTransform(doc: Doc, i: number): Affine {
  const v = docAttr(doc, i, "transform");
  return (v === undefined ? null : parseTransform(v)) ?? IDENTITY;
}

function docViewBox(doc: Doc, i: number): [number, number, number, number] | null {
  const v = docAttr(doc, i, "viewBox");
  return v === undefined ? null : parseViewBox(v);
}

function docAspectRatio(doc: Doc, i: number): AspectRatio {
  const v = docAttr(doc, i, "preserveAspectRatio");
  return v === undefined ? DEFAULT_ASPECT_RATIO : parseAspectRatio(v);
}

function countCodePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

const defaultMeasure: MeasureFn = (text, size) => DEFAULT_ADVANCE * size * countCodePoints(text);

/** Rendering context of one element. */
export interface Ctx {
  ctm: Affine;
  vw: number;
  vh: number;
  opacity: number;
  attr: number | null;
  instance: boolean;
  depth: number;
}

const RENDERABLE = new Set(["g", "a", "switch", "svg", "use", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text"]);

/** Scene → internal id map (hidden from JSON). */
export const SCENE_IDS = new WeakMap<Scene, Map<string, number>>();

/** Parses and renders an SVG document (throws SvgFailure). */
export function parseScene(svg: string, options: ParseOptions): Scene {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const ascent = options.ascent ?? DEFAULT_ASCENT;
  const descent = options.descent ?? DEFAULT_DESCENT;
  const canvas = options.canvas ?? null;
  if (typeof svg !== "string") fail("invalid_value", "the SVG source must be a string");
  if (!(tolerance > 0 && Number.isFinite(tolerance))) fail("invalid_value", "tolerance must be a positive number");
  if (canvas !== null) {
    const { width: w, height: h } = canvas;
    if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) {
      fail("invalid_value", "canvas width and height must be positive");
    }
  }
  if (!(Number.isFinite(ascent) && Number.isFinite(descent))) fail("invalid_value", "ascent and descent must be finite");
  const xml = parseXml(svg);
  const n = xml.elements.length;

  // Elements.
  const elements: Element[] = new Array<Element>(n);
  const isSvg: boolean[] = new Array<boolean>(n);
  for (let i = 0; i < n; i++) {
    const x = xml.elements[i]!;
    const uri = x.ns === null ? null : xml.namespaces[x.ns]!;
    const svgNs = uri === null || uri === "" || uri === NS_SVG;
    isSvg[i] = svgNs;
    const attributes: Record<string, string> = {};
    let id: string | null = null;
    let cls: string | null = null;
    const a = x.attrs;
    for (let k = 0; k < a.length; k += 2) {
      const q = a[k]!;
      const v = a[k + 1]!;
      if (q === "__proto__") {
        Object.defineProperty(attributes, q, { value: v, enumerable: true, writable: true, configurable: true });
      } else attributes[q] = v;
      if (q === "id") id = v;
      else if (q === "class") cls = v;
    }
    elements[i] = {
      tag: localName(x),
      namespace: svgNs ? null : uri,
      id,
      classes: cls === null ? [] : cls.split(/[ \t\n\r\f]+/).filter((c) => c.length > 0),
      attributes,
      parent: x.parent,
      subtree_end: 0,
      drawn: false,
      filled: false,
      stroked: false,
      bbox: null,
    };
  }
  const ends = new Array<number>(n);
  for (let i = 0; i < n; i++) ends[i] = i + 1;
  for (let i = n - 1; i >= 0; i--) {
    const p = elements[i]!.parent;
    if (p !== null && ends[i]! > ends[p]!) ends[p] = ends[i]!;
  }
  for (let i = 0; i < n; i++) elements[i]!.subtree_end = ends[i]!;
  if (!isSvg[0] || elements[0]!.tag !== "svg") {
    fail("invalid_value", `the root element is <${xml.elements[0]!.qname}>, expected <svg>`);
  }
  const ids = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const id = elements[i]!.id;
    if (id !== null && !ids.has(id)) ids.set(id, i);
  }

  // Style sheets.
  const rules: CssRule[] = [];
  for (let i = 0; i < n; i++) {
    const x = xml.elements[i]!;
    if (!isSvg[i] || localName(x) !== "style") continue;
    const t = plainAttr(x, "type");
    const ty = t === undefined ? null : t.trim().toLowerCase();
    if (ty !== null && ty !== "" && ty !== "text/css") continue;
    let text = "";
    for (const c of x.children) if (typeof c === "string") text += c;
    for (const r of parseStylesheet(text)) rules.push(r);
  }

  // Cascade and computed styles (document tree).
  const ctx0: MatchContext = { canvasWidth: 0, canvasHeight: 0 };
  const cctx: CascadeContext = { urlExists: (id: string): boolean => ids.has(id), paints: new Map() };
  const specified: Specified[] = new Array<Specified>(n);
  const styles: Computed[] = new Array<Computed>(n);
  const xmlSpace: (boolean | null)[] = new Array<boolean | null>(n);
  const initial = initialStyle();
  const noDecls: Decl[] = [];
  const noCss: Decl[][] = [];
  for (let i = 0; i < n; i++) {
    const x = xml.elements[i]!;
    let space: boolean | null = null;
    if (x.attrNs !== null) {
      for (let k = 0; k < x.attrNs.length; k++) {
        if (x.attrNs[k] === 0 && localOf(x.attrs[2 * k]!) === "space") {
          const v = x.attrs[2 * k + 1];
          space = v === "preserve" ? true : v === "default" ? false : null;
          break;
        }
      }
    }
    xmlSpace[i] = space;
    let spec: Specified = EMPTY_SPECIFIED;
    if (isSvg[i]) {
      const style = plainAttr(x, "style") ?? null;
      let css = noCss;
      if (rules.length > 0) {
        const matched: [[number, number, number], number][] = [];
        for (let k = 0; k < rules.length; k++) {
          let best: [number, number, number] | null = null;
          for (const c of rules[k]!.selectors) {
            if (!complexMatches(c, elements, i, ctx0)) continue;
            if (best === null || cmpSpec(c.specificity, best) > 0) best = c.specificity;
          }
          if (best !== null) matched.push([best, k]);
        }
        if (matched.length > 0) {
          matched.sort((a, b) => cmpSpec(a[0], b[0]) || a[1] - b[1]);
          css = matched.map(([, k]) => rules[k]!.decls);
        }
      }
      const inline = style === null ? noDecls : parseDeclarations(style);
      spec = cascade(x.attrs, css, inline, cctx);
      // (x.attrs holds unprefixed and prefixed names; cascade only uses unprefixed ones)
    }
    const parentStyle = x.parent === null ? initial : styles[x.parent]!;
    specified[i] = spec;
    styles[i] = compute(spec, parentStyle, space);
  }
  for (let i = 0; i < n; i++) {
    const el = elements[i]!;
    // Images are ink; a line has no interior.
    el.filled = el.tag === "image" || (el.tag !== "line" && isFilled(styles[i]!));
    el.stroked = isStroked(styles[i]!);
  }

  const doc: Doc = { xml, isSvg, specified, styles, xmlSpace, ids };

  // Viewport and canvas.
  const viewBox = docViewBox(doc, 0);
  let refW = DEFAULT_VIEWPORT[0];
  let refH = DEFAULT_VIEWPORT[1];
  if (viewBox !== null) {
    refW = viewBox[2];
    refH = viewBox[3];
  } else if (canvas !== null) {
    refW = canvas.width;
    refH = canvas.height;
  }
  const wlen = docLength(doc, 0, "width");
  const hlen = docLength(doc, 0, "height");
  const wl = wlen !== null && wlen.v > 0 ? resolveLength(wlen, 16, refW) : null;
  const hl = hlen !== null && hlen.v > 0 ? resolveLength(hlen, 16, refH) : null;
  let width: number;
  let height: number;
  if (wl !== null && hl !== null) {
    width = wl;
    height = hl;
  } else if (wl !== null) {
    width = wl;
    height = viewBox === null ? refH : (wl * viewBox[3]) / viewBox[2];
  } else if (hl !== null) {
    width = viewBox === null ? refW : (hl * viewBox[2]) / viewBox[3];
    height = hl;
  } else {
    width = refW;
    height = refH;
  }
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
    fail("invalid_value", "the SVG viewport has no positive size");
  }
  const canvasWidth = canvas === null ? width : canvas.width;
  const canvasHeight = canvas === null ? height : canvas.height;

  const userMeasure = options.measure ?? null;
  const r = new Renderer(doc, elements, tolerance, userMeasure ?? defaultMeasure, ascent, descent);

  const rootStyle = doc.styles[0]!;
  if (!rootStyle.display_none) {
    const ctm = mul(
      mul(scale(canvasWidth / width, canvasHeight / height), docTransform(doc, 0)),
      viewBoxTransform(viewBox, docAspectRatio(doc, 0), width, height),
    );
    const vw = viewBox === null ? width : viewBox[2];
    const vh = viewBox === null ? height : viewBox[3];
    const opacity = rootStyle.opacity;
    const ctx: Ctx = { ctm, vw, vh, opacity, attr: null, instance: false, depth: 1 };
    const bbox = r.renderChildren(0, ctx, rootStyle);
    elements[0]!.drawn = rootStyle.visible && opacity > 0;
    elements[0]!.bbox = bbox === null ? null : toRect(bbox);
  }

  const scene: Scene = {
    width,
    height,
    canvas_width: canvasWidth,
    canvas_height: canvasHeight,
    view_box: viewBox,
    elements,
    primitives: r.prims,
    warnings: r.warnings,
  };
  SCENE_IDS.set(scene, ids);
  return scene;
}

function cmpSpec(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function toRect(b: BBox): Rect {
  return { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
}

export class Renderer {
  prims: Primitive[] = [];
  warnings: SvgError[] = [];
  private shape = 0;
  private visits = 0;
  points = 0;
  private useStack: number[] = [];
  private depthWarned = false;

  constructor(
    readonly doc: Doc,
    readonly elements: Element[],
    readonly tol: number,
    readonly measure: MeasureFn,
    readonly ascent: number,
    readonly descent: number,
  ) {}

  private warn(code: SvgErrorCode, message: string): void {
    this.warnings.push({ code, message });
  }

  nextShape(): number {
    return this.shape++;
  }

  addPoints(n: number): void {
    this.points += n;
    if (this.points > MAX_POINTS) fail("limit", `SVG geometry exceeds ${MAX_POINTS} points`);
  }

  styleOf(i: number, ctx: Ctx, parent: Computed): Computed {
    return ctx.instance ? compute(this.doc.specified[i]!, parent, this.doc.xmlSpace[i]!) : this.doc.styles[i]!;
  }

  render(i: number, ctx: Ctx, parent: Computed): BBox | null {
    const doc = this.doc;
    if (!doc.isSvg[i]) return null;
    if (ctx.depth > MAX_RENDER_DEPTH) {
      if (!this.depthWarned) {
        this.depthWarned = true;
        this.warn("limit", `content nested deeper than ${MAX_RENDER_DEPTH} levels was skipped`);
      }
      return null;
    }
    this.visits++;
    if (this.visits > MAX_VISITS) fail("limit", `SVG expands to more than ${MAX_VISITS} rendered elements`);
    const style = this.styleOf(i, ctx, parent);
    if (style.display_none) return null;
    const opacity = ctx.opacity * style.opacity;
    const drawn = style.visible && opacity > 0;
    let bbox: BBox | null;
    const tag = docTag(doc, i);
    switch (tag) {
      case "g":
      case "a":
        bbox = this.renderChildren(i, { ...ctx, ctm: mul(ctx.ctm, docTransform(doc, i)), opacity, depth: ctx.depth + 1 }, style);
        break;
      case "switch": {
        const c: Ctx = { ...ctx, ctm: mul(ctx.ctm, docTransform(doc, i)), opacity, depth: ctx.depth + 1 };
        const k = this.switchChild(i);
        bbox = k === null ? null : this.render(k, c, style);
        break;
      }
      case "svg":
        bbox = this.renderSvg(i, ctx, style, opacity, null);
        break;
      case "use":
        bbox = this.renderUse(i, ctx, style, opacity);
        break;
      case "rect":
      case "circle":
      case "ellipse":
      case "line":
      case "polyline":
      case "polygon":
      case "path":
        bbox = this.renderShape(i, ctx, style, drawn);
        break;
      case "text":
        bbox = this.renderText(i, ctx, style, opacity);
        break;
      case "image":
        bbox = this.renderImage(i, ctx, style, drawn);
        break;
      default:
        return null;
    }
    if (!ctx.instance) {
      const el = this.elements[i]!;
      el.drawn = drawn;
      el.bbox = bbox === null ? null : toRect(bbox);
    }
    return bbox;
  }

  renderChildren(i: number, ctx: Ctx, style: Computed): BBox | null {
    let bbox: BBox | null = null;
    for (const c of this.doc.xml.elements[i]!.children) {
      if (typeof c !== "number") continue;
      const b = this.render(c, ctx, style);
      if (b === null) continue;
      // Accumulate in a private copy (children's boxes are never shared).
      if (bbox === null) bbox = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
      else bboxExtend(bbox, b);
    }
    return bbox;
  }

  private switchChild(i: number): number | null {
    const doc = this.doc;
    for (const c of doc.xml.elements[i]!.children) {
      if (typeof c !== "number") continue;
      if (!doc.isSvg[c]) continue;
      const tag = docTag(doc, c);
      if (!(RENDERABLE.has(tag) || tag === "image" || tag === "foreignObject")) continue;
      if (docAttr(doc, c, "requiredExtensions") !== undefined) continue;
      const langs = docAttr(doc, c, "systemLanguage");
      if (langs !== undefined) {
        const ok = langs.split(",").some((l) => {
          const t = l.trim().toLowerCase();
          return t === "en" || t.startsWith("en-");
        });
        if (!ok) continue;
      }
      if (tag === "foreignObject") continue;
      return c;
    }
    return null;
  }

  private renderSvg(
    i: number,
    ctx: Ctx,
    style: Computed,
    opacity: number,
    size: [Length | null, Length | null] | null,
  ): BBox | null {
    const doc = this.doc;
    const fs = style.font_size;
    const lx = docLength(doc, i, "x");
    const ly = docLength(doc, i, "y");
    const x = lx === null ? 0 : resolveLength(lx, fs, ctx.vw);
    const y = ly === null ? 0 : resolveLength(ly, fs, ctx.vh);
    const ow = size === null ? null : size[0];
    const oh = size === null ? null : size[1];
    const lw = ow ?? docLength(doc, i, "width");
    const lh = oh ?? docLength(doc, i, "height");
    const w = lw === null ? ctx.vw : resolveLength(lw, fs, ctx.vw);
    const h = lh === null ? ctx.vh : resolveLength(lh, fs, ctx.vh);
    if (!(w > 0 && h > 0)) return null;
    const vb = docViewBox(doc, i);
    const ctm = mul(
      mul(mul(ctx.ctm, docTransform(doc, i)), translate(x, y)),
      viewBoxTransform(vb, docAspectRatio(doc, i), w, h),
    );
    const vw = vb === null ? w : vb[2];
    const vh = vb === null ? h : vb[3];
    return this.renderChildren(i, { ...ctx, ctm, vw, vh, opacity, depth: ctx.depth + 1 }, style);
  }

  private renderUse(i: number, ctx: Ctx, style: Computed, opacity: number): BBox | null {
    const doc = this.doc;
    const raw = docHref(doc, i);
    if (raw === undefined) return null;
    const href = raw.trim();
    if (!href.startsWith("#")) {
      this.warn("ignored", `<use> reference '${href}' outside the document was ignored`);
      return null;
    }
    const id = href.slice(1);
    const t = doc.ids.get(id);
    if (t === undefined) {
      this.warn("ignored", `<use> reference '#${id}' not found`);
      return null;
    }
    if ((t <= i && i < this.elements[t]!.subtree_end) || this.useStack.includes(t)) {
      this.warn("ignored", `circular <use> reference '#${id}' was ignored`);
      return null;
    }
    if (!doc.isSvg[t]) return null;
    const fs = style.font_size;
    const lx = docLength(doc, i, "x");
    const ly = docLength(doc, i, "y");
    const x = lx === null ? 0 : resolveLength(lx, fs, ctx.vw);
    const y = ly === null ? 0 : resolveLength(ly, fs, ctx.vh);
    const ctm = mul(mul(ctx.ctm, docTransform(doc, i)), translate(x, y));
    const attr = ctx.attr ?? i;
    const base: Ctx = { ...ctx, ctm, opacity, attr, instance: true, depth: ctx.depth + 1 };
    this.useStack.push(t);
    try {
      switch (docTag(doc, t)) {
        case "symbol": {
          const sym = compute(doc.specified[t]!, style, doc.xmlSpace[t]!);
          const lw = docLength(doc, i, "width") ?? docLength(doc, t, "width");
          const lh = docLength(doc, i, "height") ?? docLength(doc, t, "height");
          const w = lw === null ? ctx.vw : resolveLength(lw, fs, ctx.vw);
          const h = lh === null ? ctx.vh : resolveLength(lh, fs, ctx.vh);
          if (!(w > 0 && h > 0)) return null;
          const vb = docViewBox(doc, t);
          const m = mul(ctm, viewBoxTransform(vb, docAspectRatio(doc, t), w, h));
          const vw = vb === null ? w : vb[2];
          const vh = vb === null ? h : vb[3];
          return this.renderChildren(t, { ...base, ctm: m, vw, vh, opacity: opacity * sym.opacity }, sym);
        }
        case "svg": {
          const st = compute(doc.specified[t]!, style, doc.xmlSpace[t]!);
          if (st.display_none) return null;
          const size: [Length | null, Length | null] = [docLength(doc, i, "width"), docLength(doc, i, "height")];
          return this.renderSvg(t, base, st, opacity * st.opacity, size);
        }
        default:
          return this.render(t, base, style);
      }
    } finally {
      this.useStack.pop();
    }
  }

  private renderShape(i: number, ctx: Ctx, style: Computed, drawn: boolean): BBox | null {
    const doc = this.doc;
    const ctm = mul(ctx.ctm, docTransform(doc, i));
    const fs = style.font_size;
    const diag = Math.sqrt((ctx.vw * ctx.vw + ctx.vh * ctx.vh) / 2);
    const lx = (name: string): number | null => {
      const l = docLength(doc, i, name);
      return l === null ? null : resolveLength(l, fs, ctx.vw);
    };
    const ly = (name: string): number | null => {
      const l = docLength(doc, i, name);
      return l === null ? null : resolveLength(l, fs, ctx.vh);
    };
    const tol = this.tol;
    const tag = docTag(doc, i);
    let geometry: Subpath[] | null;
    switch (tag) {
      case "rect": {
        const x = lx("x") ?? 0;
        const y = ly("y") ?? 0;
        const w = lx("width");
        const h = ly("height");
        if (w === null || h === null || !(w > 0 && h > 0)) return null;
        const rxl = lx("rx");
        const ryl = ly("ry");
        const rx0 = rxl !== null && rxl >= 0 ? rxl : null;
        const ry0 = ryl !== null && ryl >= 0 ? ryl : null;
        let rx = 0;
        let ry = 0;
        if (rx0 !== null && ry0 !== null) {
          rx = rx0;
          ry = ry0;
        } else if (rx0 !== null) {
          rx = rx0;
          ry = rx0;
        } else if (ry0 !== null) {
          rx = ry0;
          ry = ry0;
        }
        if (rx > w / 2) rx = w / 2;
        if (ry > h / 2) ry = h / 2;
        geometry = flatten.rect(ctm, tol, x, y, w, h, rx, ry);
        break;
      }
      case "circle": {
        const cx = lx("cx") ?? 0;
        const cy = ly("cy") ?? 0;
        const rl = docLength(doc, i, "r");
        const r = rl === null ? null : resolveLength(rl, fs, diag);
        if (r === null || !(r > 0)) return null;
        geometry = flatten.ellipse(ctm, tol, cx, cy, r, r);
        break;
      }
      case "ellipse": {
        const cx = lx("cx") ?? 0;
        const cy = ly("cy") ?? 0;
        const a = lx("rx");
        const b = ly("ry");
        if (a === null && b === null) return null;
        const rx = a ?? b!;
        const ry = b ?? a!;
        if (!(rx > 0 && ry > 0)) return null;
        geometry = flatten.ellipse(ctm, tol, cx, cy, rx, ry);
        break;
      }
      case "line":
        geometry = flatten.poly(ctm, tol, [lx("x1") ?? 0, ly("y1") ?? 0, lx("x2") ?? 0, ly("y2") ?? 0], false);
        break;
      case "polyline":
      case "polygon": {
        const pts = docAttr(doc, i, "points");
        const coords = pts === undefined ? [] : parseNumberList(pts)[0];
        if (coords.length < 4) return null;
        geometry = flatten.poly(ctm, tol, coords, tag === "polygon");
        break;
      }
      case "path": {
        const d = docAttr(doc, i, "d");
        geometry = flatten.path(ctm, tol, d === undefined ? [] : parsePath(d));
        break;
      }
      default:
        return null;
    }
    if (geometry === null) return null;
    let bbox: BBox | null = null;
    let count = 0;
    for (const s of geometry) {
      bbox = bboxUnion(bbox, bboxOfPoints(s.pts));
      count += s.pts.length;
    }
    if (bbox === null) return null;
    this.addPoints(count);
    if (drawn) {
      const shape = this.nextShape();
      const element = ctx.attr ?? i;
      const fill = tag !== "line" && isFilled(style);
      let strokeWidth = 0;
      if (isStroked(style)) {
        const w = resolveLength(style.stroke_width, fs, diag);
        strokeWidth = style.non_scaling ? w : w * meanScale(ctm);
      }
      const stroke = strokeWidth > 0 && Number.isFinite(strokeWidth);
      if (fill) {
        const rings: Point[][] = [];
        for (const s of geometry) if (s.pts.length >= 3) rings.push(stroke ? s.pts.slice() : s.pts);
        if (rings.length > 0) {
          this.prims.push({ element, source: i, shape, type: "polygon", rings, even_odd: style.even_odd });
        }
      }
      if (stroke) {
        for (const s of geometry) {
          this.prims.push({ element, source: i, shape, type: "polyline", points: s.pts, width: strokeWidth, closed: s.closed });
        }
      }
    }
    return bbox;
  }

  private renderText(i: number, ctx: Ctx, style: Computed, opacity: number): BBox | null {
    const ctm = mul(ctx.ctm, docTransform(this.doc, i));
    const chunks = layoutText(this, i, ctx, ctm, style);
    let bbox: BBox | null = null;
    for (const c of chunks) bbox = bboxUnion(bbox, c.all);
    this.addPoints(4 * chunks.length);
    if (opacity > 0 && chunks.some((c) => c.inked !== null)) {
      const shape = this.nextShape();
      const element = ctx.attr ?? i;
      for (const c of chunks) {
        const b = c.inked;
        if (b === null) continue;
        this.prims.push({ element, source: i, shape, type: "rect", x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
      }
    }
    return bbox;
  }

  private renderImage(i: number, ctx: Ctx, style: Computed, drawn: boolean): BBox | null {
    const doc = this.doc;
    const fs = style.font_size;
    const lx = docLength(doc, i, "x");
    const ly = docLength(doc, i, "y");
    const x = lx === null ? 0 : resolveLength(lx, fs, ctx.vw);
    const y = ly === null ? 0 : resolveLength(ly, fs, ctx.vh);
    const lw = docLength(doc, i, "width");
    const lh = docLength(doc, i, "height");
    if (lw === null || lh === null) return null;
    const w = resolveLength(lw, fs, ctx.vw);
    const h = resolveLength(lh, fs, ctx.vh);
    if (!(w > 0 && h > 0)) return null;
    const ctm = mul(ctx.ctm, docTransform(doc, i));
    const ring: Point[] = [apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x + w, y + h), apply(ctm, x, y + h)];
    for (const p of ring) if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
    const bbox = bboxOfPoints(ring);
    this.addPoints(4);
    if (drawn) {
      this.prims.push({ element: ctx.attr ?? i, source: i, shape: this.nextShape(), type: "polygon", rings: [ring], even_odd: false });
    }
    return bbox;
  }
}

export { SvgFailure };
