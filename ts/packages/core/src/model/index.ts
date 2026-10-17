/**
 * The resolved model: a validated problem with presets, defaults, units and coordinates
 * applied, backgrounds loaded and item geometry built; port of
 * `rust/crates/la-core/src/model/mod.rs`.
 *
 * @module
 */

import { RasterError, decode, decodeSource, rgbaFromBase64 } from "@label-anything/raster";
import type { FontSpec } from "../api.js";
import {
  type Env,
  type Geom,
  type RasterOpts,
  type RgbaImage,
  type SvgDoc,
  SvgRuleError,
  envRasterOverride,
  envReadFile,
  envSvg,
} from "../env.js";
import { Affine, P, Rect, bboxOf } from "../geom/index.js";
import { PathError, flatten } from "../geom/path.js";
import { convexHull, polylabel } from "../geom/polygon.js";
import { Shape } from "../geom/shape.js";
import { asArray, asBool, asF64, asI64, asStr, asU64, at, get, isObject, items as itemsOf, parseRustF64 } from "../json.js";
import { clampf, maxf, minf } from "../math.js";
import { Opts, lookup, sourceOpt } from "../options.js";
import { Length } from "../units.js";
import { Issue } from "../validate.js";
import { bundledFonts } from "../labels.js";
import {
  DegradeOpts,
  type InternalPolicy,
  LeaderOpts,
  Models,
  Omission,
  OutputOpts,
  PlacementOpts,
  type Pos,
  SolverOpts,
  type Step,
  type Ties,
  Weights,
  internalPolicyParse,
  positionOrder,
  stepParse,
} from "./opts.js";
import { parseRustU64 } from "../json.js";

export * from "./opts.js";

/** Shape of a fixed-size label (icon, box), relative to its box. */
export type LabelShape =
  | { kind: "rect" }
  | { kind: "rounded"; r: number }
  | { kind: "circle" }
  /** Polygon relative to the box's top-left corner. */
  | { kind: "polygon"; pts: P[] };

/** `LabelShape::parse`. */
export function labelShapeParse(s: string | null, polygon: unknown): LabelShape {
  if (s === "circle") return { kind: "circle" };
  if (s === "polygon") return { kind: "polygon", pts: pointsOf(polygon === undefined ? null : polygon) };
  if (s !== null && s.startsWith("rounded:")) return { kind: "rounded", r: parseRustF64(s.slice(8)) ?? 0 };
  return { kind: "rect" };
}

/** Rust's derived `PartialEq` of `LabelShape`. */
export function labelShapeEq(a: LabelShape, b: LabelShape): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "rounded":
      return a.r === (b as { r: number }).r;
    case "polygon": {
      const q = (b as { pts: P[] }).pts;
      return a.pts.length === q.length && a.pts.every((p, i) => p.eq(q[i]!));
    }
    default:
      return true;
  }
}

export type Truncate = "none" | "end" | "middle";

function truncateParse(s: string): Truncate {
  return s === "end" ? "end" : s === "middle" ? "middle" : "none";
}

/** Resolved font of a label. */
export class FontSel {
  constructor(
    public family: string,
    public weight: number,
    public italic: boolean,
    public size: number,
    public lineHeight: number,
    /** Font file (data URL or path) to register for this family/weight/style. */
    public file: string | null,
  ) {}

  clone(): FontSel {
    return new FontSel(this.family, this.weight, this.italic, this.size, this.lineHeight, this.file);
  }

  spec(scale: number): FontSpec {
    return { family: this.family, weight: this.weight, italic: this.italic, size: this.size * scale };
  }
}

export interface WrapSpec {
  maxWidth: number | null;
  maxLines: number;
  balance: boolean;
}

export interface TextSpec {
  text: string;
  alternatives: string[];
  wrap: WrapSpec | null;
  truncate: Truncate;
  /** Host-measured `(width, height, lines)`. */
  explicit: [number, number, string[]] | null;
  align: string;
  font: FontSel;
}

export const FixedKind = { Icon: 0, Box: 1 } as const;
export type FixedKind = (typeof FixedKind)[keyof typeof FixedKind];

export type PartSpec =
  | { kind: "text"; spec: TextSpec }
  | { kind: "fixed"; fixed: FixedKind; w: number; h: number; shape: LabelShape };

export type LabelSpec =
  | { kind: "text"; spec: TextSpec }
  | { kind: "fixed"; fixed: FixedKind; w: number; h: number; shape: LabelShape }
  | { kind: "composite"; row: boolean; gap: number; align: string; parts: PartSpec[] };

/** `LabelSpec::text`: the label's main text (for expressions and debug output). */
export function labelText(l: LabelSpec): string {
  switch (l.kind) {
    case "text":
      return l.spec.text;
    case "fixed":
      return "";
    case "composite": {
      const t: string[] = [];
      for (const p of l.parts) if (p.kind === "text") t.push(p.spec.text);
      return t.join(" ");
    }
  }
}

/** An area anchor's polygon. */
export interface Area {
  shape: Shape;
  pole: P;
  poleDist: number;
}

/** Per-item resolved lengths (px). */
export interface ItemLengths {
  padding: number;
  buffer: number;
  offset: number;
  innerPadding: number;
  maxDistance: number;
  minDistance: number;
  leaderMin: number;
  leaderMax: number;
  anchorGap: number;
  clearance: number;
  boundaryGap: number;
  boundaryMargin: number;
}

/** `keep_with` membership. */
export type KeepWith = { kind: "set"; name: string } | { kind: "ids"; ids: string[] };

/** A resolved item. */
export class Item {
  constructor(
    public index: number,
    public id: string,
    /** Reference point in canvas px. */
    public anchor: P,
    /** The labeled mark (for area anchors: the fallback dot at the pole). */
    public shape: Shape,
    public area: Area | null,
    /** Leaders attach at the tip (icon marks). */
    public tip: boolean,
    public label: LabelSpec,
    public font: FontSel,
    public len: ItemLengths,
    public models: Models,
    public internal: InternalPolicy,
    public positions: Pos[],
    public attrs: unknown,
    public explicitPriority: number | null,
    public explicitTier: number | null,
    public required: boolean,
    public group: string | null,
    public keepWith: KeepWith | null,
    public svgId: string | null,
    /** The original item JSON (for callbacks). */
    public raw: unknown,
  ) {}

  /** Cache of {@link pole}. */
  private poleCache: P | null = null;

  em(): number {
    return this.font.size;
  }

  /**
   * The pole of inaccessibility of the mark (polygon marks; the reference point of other
   * shapes), computed once.
   */
  pole(): P {
    let p = this.poleCache;
    if (p === null) {
      const s = this.shape;
      p = s.kind === "polygon" ? polylabel(s.poly.rings, s.poly.evenOdd, 0.5)[0] : s.reference();
      this.poleCache = p;
    }
    return p;
  }
}

/** A vector obstacle primitive in canvas px. */
export type Prim =
  | { kind: "disc"; c: P; r: number }
  | { kind: "rect"; rect: Rect }
  | { kind: "polygon"; rings: P[][]; evenOdd: boolean; bbox: Rect }
  | { kind: "polyline"; points: P[]; hw: number; closed: boolean }
  | { kind: "shape"; shape: Shape };

/** `Prim::bbox`. */
export function primBbox(p: Prim): Rect {
  switch (p.kind) {
    case "disc":
      return Rect.fromCenter(p.c, p.r, p.r);
    case "rect":
      return p.rect;
    case "polygon":
      return p.bbox;
    case "polyline":
      return bboxOf(p.points).inflate(p.hw);
    case "shape":
      return p.shape.bbox();
  }
}

/** A decoded raster source with its options. */
export interface RasterSrc {
  img: RgbaImage;
  opts: RasterOpts;
}

/** The resolved problem. */
export class Model {
  canvas: Rect | null = null;
  /** Labels must stay inside (canvas or region minus padding); null = unbounded. */
  labelArea: Rect | null = null;
  /** Leaders must stay inside (the canvas); null = unbounded. */
  leaderArea: Rect | null = null;
  /** Extent of the grid. */
  extent: Rect = new Rect(0, 0, 1, 1);
  toPx: Affine = Affine.IDENTITY;
  items: Item[] = [];
  /** Vector obstacles by class (problem vector layers and SVG geometry). */
  vector: [string, Prim][] = [];
  rasters: RasterSrc[] = [];
  avoidLabel: Record<string, unknown> = {};
  avoidLeader: Record<string, unknown> = {};
  avoidBuffer: Record<string, unknown> = {};
  relaxable: string[] = [];
  placement!: PlacementOpts;
  leaders!: LeaderOpts;
  weights!: Weights;
  solver!: SolverOpts;
  ladder: Step[] = [];
  degrade!: DegradeOpts;
  output!: OutputOpts;
  omission: Omission = Omission.Strict;
  ties: Ties = { kind: "input_order" };
  band = 0;
  maxLabels: number | null = null;
  maxInkFraction: number | null = null;
  focus: P | null = null;
  priorityValue: unknown = null;
  /** `auto` preset: (crowded fraction, models when crowded) unless the user set models. */
  autoCrowded: [number, Models] | null = null;
  gridCell: number | null = null;
  defaultEm = 12;
  shaping = "auto";
  warm: Map<string, Rect | null> = new Map();
  warnings: Issue[] = [];
  presetName = "auto";
  /** Groups of items sharing one label: (representative, members incl. the representative). */
  groups: [number, number[]][] = [];
  /** For each item: the representative of its group (itself for representatives). */
  groupOf: (number | null)[] = [];

  /** Members of the group represented by `rep` (empty if `rep` is not a representative). */
  groupMembers(rep: number): readonly number[] {
    for (const g of this.groups) if (g[0] === rep) return g[1];
    return NO_MEMBERS;
  }
}

const NO_MEMBERS: readonly number[] = [];

/** A model-building failure (the problem passed validation but cannot be solved). */
export class BuildError extends Error {
  readonly pointer: string;
  readonly code: string;
  constructor(pointer: string, code: string, message: string) {
    super(message);
    this.name = "BuildError";
    this.pointer = pointer;
    this.code = code;
  }
}

function err(pointer: string, code: string, message: string): BuildError {
  return new BuildError(pointer, code, message);
}

/** `points_of`: `[[x, y], …]` (entries that are not two numbers are skipped). */
export function pointsOf(v: unknown): P[] {
  const out: P[] = [];
  if (!Array.isArray(v)) return out;
  for (const q of v) {
    const x = asF64(at(q, 0));
    const y = asF64(at(q, 1));
    if (x !== null && y !== null) out.push(new P(x, y));
  }
  return out;
}

function pointsOfSingle(v: unknown): P | null {
  const x = asF64(at(v, 0));
  const y = asF64(at(v, 1));
  return x !== null && y !== null ? new P(x, y) : null;
}

function weightOf(v: unknown): number | null {
  if (typeof v === "number") return Math.trunc(clampf(v, 1, 1000));
  if (v === "bold") return 700;
  if (v === "normal") return 400;
  return null;
}

/** Merge a font object over a base font. */
function fontOver(base: FontSel, v: unknown): FontSel {
  const f = base.clone();
  if (isObject(v)) {
    const family = asStr(get(v, "family"));
    if (family !== null) f.family = family;
    const size = asF64(get(v, "size"));
    if (size !== null) f.size = size;
    const w = get(v, "weight");
    const weight = w === undefined ? null : weightOf(w);
    if (weight !== null) f.weight = weight;
    const style = asStr(get(v, "style"));
    if (style !== null) f.italic = style === "italic";
    const lh = asF64(get(v, "line_height"));
    if (lh !== null) f.lineHeight = lh;
    const file = get(v, "file");
    if (typeof file === "string") f.file = file;
    else if (file === null) f.file = null;
  }
  return f;
}

function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObject(v)) return [v];
  return [];
}

const utf8 = new TextEncoder();

/** Decode `data:` URLs (base64 or percent-encoded) into bytes. */
export function dataUrlBytes(s: string): Uint8Array | null {
  if (!s.startsWith("data:")) return null;
  const rest = s.slice(5);
  const comma = rest.indexOf(",");
  if (comma < 0) return null;
  const meta = rest.slice(0, comma);
  const data = rest.slice(comma + 1);
  return meta.endsWith(";base64") ? base64Decode(data) : percentDecode(data);
}

/** Rust's `u8::from_str_radix(two_chars, 16)` (a leading `+` is allowed). */
function hexByte(b: Uint8Array, i: number): number {
  const h = (c: number): number =>
    c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x61 && c <= 0x66 ? c - 0x57 : c >= 0x41 && c <= 0x46 ? c - 0x37 : -1;
  const a = b[i]!;
  const c = b[i + 1]!;
  if (a === 0x2b) return h(c);
  const x = h(a);
  const y = h(c);
  return x < 0 || y < 0 ? -1 : x * 16 + y;
}

function percentDecode(s: string): Uint8Array {
  const b = utf8.encode(s);
  const out: number[] = [];
  let i = 0;
  while (i < b.length) {
    if (b[i] === 0x25 && i + 2 < b.length) {
      const v = hexByte(b, i + 1);
      if (v >= 0) {
        out.push(v);
        i += 3;
        continue;
      }
    }
    out.push(b[i]!);
    i += 1;
  }
  return Uint8Array.from(out);
}

/** Minimal base64 decoder (standard and URL-safe alphabets, whitespace ignored). */
export function base64Decode(s: string): Uint8Array | null {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    let v: number;
    if (c >= 0x41 && c <= 0x5a) v = c - 0x41;
    else if (c >= 0x61 && c <= 0x7a) v = c - 0x61 + 26;
    else if (c >= 0x30 && c <= 0x39) v = c - 0x30 + 52;
    else if (c === 0x2b || c === 0x2d) v = 62;
    else if (c === 0x2f || c === 0x5f) v = 63;
    else if (c === 0x3d) break;
    else if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) continue;
    else return null;
    buf = ((buf << 6) | v) >>> 0;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Build the model. `problem` must have passed `validate`. */
export function build(problem: unknown, env: Env, implementation: "ts" | "rust" = "ts"): Model {
  const m = buildRaw(problem, env, implementation);
  resolveGroups(m);
  return m;
}

/**
 * Merge items sharing a `group` id into one label (spec §5.7 "groups"): the first member
 * (input order) represents the group; its mark becomes the convex hull of all member
 * marks, its anchor their centroid, and its text lists the distinct member texts.
 */
function resolveGroups(m: Model): void {
  const n = m.items.length;
  m.groupOf = new Array<number | null>(n).fill(null);
  const byName = new Map<string, number[]>();
  for (const it of m.items) {
    if (it.group !== null) {
      let v = byName.get(it.group);
      if (v === undefined) {
        v = [];
        byName.set(it.group, v);
      }
      v.push(it.index);
    }
  }
  const groups: [number, number[]][] = [];
  for (const v of byName.values()) if (v.length >= 2) groups.push([v[0]!, v]);
  groups.sort((a, b) => a[0] - b[0]);
  for (const [rep, members] of groups) {
    const pts: P[] = [];
    let centroid = new P(0, 0);
    for (const k of members) {
      for (const q of m.items[k]!.shape.outline()) pts.push(q);
      centroid = centroid.add(m.items[k]!.anchor);
      m.groupOf[k] = rep;
    }
    centroid = centroid.mul(1 / members.length);
    const hull = convexHull(pts);
    const shape = hull.length >= 3 ? Shape.polygon([hull], false, centroid) : Shape.circle(centroid, 2);
    const texts: string[] = [];
    for (const k of members) {
      const s = labelText(m.items[k]!.label);
      if (s.length > 0 && !texts.includes(s)) texts.push(s);
    }
    const r = m.items[rep]!;
    r.anchor = centroid;
    r.shape = shape;
    r.tip = false;
    if (r.label.kind === "text") {
      const t = r.label.spec;
      if (texts.length > 1 && t.explicit === null) {
        t.text = texts.join(", ");
        t.alternatives = [];
      }
    }
  }
  m.groups = groups;
}

function rasterErr(at: string, e: unknown): BuildError {
  if (e instanceof RasterError) {
    return err(at, e.code === "unsupported" ? "unsupported" : "invalid_value", `${e.message} (${e.code})`);
  }
  throw e;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const utf8Lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

type SvgEntry = [doc: SvgDoc, src: unknown, ptr: string];

function buildRaw(problem: unknown, env: Env, implementation: "ts" | "rust"): Model {
  const o = new Opts(problem);
  o.implementation = implementation;
  const warnings: Issue[] = [];
  const dw = o.get("defaults.font.weight");
  const defaultFont = new FontSel(
    o.string("defaults.font.family"),
    weightOf(dw) ?? 400,
    o.string("defaults.font.style") === "italic",
    o.f64("defaults.font.size"),
    o.f64("defaults.font.line_height"),
    asStr(o.get("defaults.font.file")),
  );
  const defaultEm = defaultFont.size;

  // --- rasters (decoded first: they may define the canvas) ---
  const rasters: RasterSrc[] = [];
  const rasterList = asList(lookup(problem, "obstacles.raster"));
  let overrideImg = envRasterOverride(env);
  if (overrideImg !== null && rasterList.length === 0) rasterList.push({});
  const rasterIsArray = Array.isArray(lookup(problem, "obstacles.raster"));
  for (let i = 0; i < rasterList.length; i++) {
    const src = rasterList[i];
    if (overrideImg !== null) {
      const img = overrideImg;
      overrideImg = null;
      rasters.push({ img, opts: rasterOpts(src, "/obstacles/raster") });
      continue;
    }
    const ptr = `/obstacles/raster${rasterIsArray ? `/${i}` : ""}`;
    let img: RgbaImage;
    const rgba = get(src, "rgba");
    if (rgba !== undefined) {
      const w = (asU64(get(rgba, "width")) ?? 0) % 4294967296;
      const h = (asU64(get(rgba, "height")) ?? 0) % 4294967296;
      try {
        img = rgbaFromBase64(w, h, asStr(get(rgba, "data")) ?? "");
      } catch (e) {
        throw rasterErr(`${ptr}/rgba/data`, e);
      }
    } else {
      const s = asStr(get(src, "source")) ?? "";
      if (s.startsWith("data:") || looksBase64(s)) {
        try {
          img = decodeSource(s);
        } catch (e) {
          throw rasterErr(`${ptr}/source`, e);
        }
      } else {
        let bytes: Uint8Array;
        try {
          bytes = envReadFile(env, s);
        } catch (e) {
          throw err(`${ptr}/source`, "invalid_value", errorMessage(e));
        }
        try {
          img = decode(bytes);
        } catch (e) {
          throw rasterErr(`${ptr}/source`, e);
        }
      }
    }
    rasters.push({ img, opts: rasterOpts(src, ptr) });
  }

  // --- canvas ---
  const cv = get(problem, "canvas");
  let canvas: Rect | null =
    cv !== undefined ? new Rect(0, 0, asF64(get(cv, "width")) ?? 0, asF64(get(cv, "height")) ?? 0) : null;
  if (canvas === null && rasters.length > 0) {
    const r = rasters[0]!;
    canvas = new Rect(0, 0, r.img.width / r.opts.scale, r.img.height / r.opts.scale);
  }

  // --- SVG documents ---
  const svgs: SvgEntry[] = [];
  const svgList = asList(lookup(problem, "obstacles.svg"));
  const svgIsArray = Array.isArray(lookup(problem, "obstacles.svg"));
  for (let i = 0; i < svgList.length; i++) {
    const src = svgList[i];
    const ptr = `/obstacles/svg${svgIsArray ? `/${i}` : ""}`;
    const backend = envSvg(env);
    if (backend === null) {
      throw err(ptr, "unsupported", "SVG backgrounds need an SVG backend (not available in this build)");
    }
    const source = asStr(get(src, "source"));
    const path = asStr(get(src, "path"));
    let markup: string;
    if (source !== null) markup = source;
    else if (path !== null) {
      let b: Uint8Array;
      try {
        b = envReadFile(env, path);
      } catch (e) {
        throw err(`${ptr}/path`, "invalid_value", errorMessage(e));
      }
      markup = utf8Lossy.decode(b);
    } else markup = "";
    const tol = asF64(sourceOpt(src, "obstacles.svg", "tolerance")) ?? 0.25;
    // SVG text is measured with the bundled fonts (simple shaping); its boxes span their
    // ascender and descender (the same for every bundled font), like label boxes
    const book = bundledFonts();
    const measure = (t: string, size: number, fam: string, w: number): number =>
      book.font(book.resolve(fam, w, false)).width(t, size);
    const font = book.font(book.resolve("default", 400, false));
    const upm = font.unitsPerEm;
    const ascent = font.ascender / upm;
    const descent = -font.descender / upm;
    let doc: SvgDoc;
    try {
      doc = backend.load(markup, canvas !== null ? [canvas.w(), canvas.h()] : null, tol, measure, ascent, descent);
    } catch (e) {
      throw err(`${ptr}/source`, "invalid_value", errorMessage(e));
    }
    if (canvas === null) {
      const [w, h] = doc.size();
      canvas = new Rect(0, 0, w, h);
    }
    svgs.push([doc, src, ptr]);
  }

  // --- coordinates ---
  let toPx = Affine.IDENTITY;
  const tr = get(problem, "transform");
  if (Array.isArray(tr) && tr.length === 6) {
    const v = tr.map((x) => asF64(x) ?? 0);
    toPx = new Affine([v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!]);
  }
  if (o.string("y_axis") === "up") {
    const h = canvas !== null ? canvas.h() : 0;
    toPx = toPx.then(new Affine([1, 0, 0, -1, 0, h]));
  }

  // --- items ---
  const itemsJson = itemsOf(get(problem, "items"));
  const globalModels = Models.fromNames(o.strings("placement.models"));
  const userSetModels = lookup(problem, "placement.models") !== undefined;
  const items: Item[] = [];
  const usedSvgIds: string[] = [];
  const autoMarks = svgList.some((s) => asBool(sourceOpt(s, "obstacles.svg", "auto_mark_items")) ?? false);
  for (let i = 0; i < itemsJson.length; i++) {
    items.push(
      buildItem(i, itemsJson[i], `/items/${i}`, o, defaultFont, toPx, svgs, autoMarks, usedSvgIds, globalModels, warnings),
    );
  }

  // --- vector obstacles ---
  const vector: [string, Prim][] = [];
  for (const layer of itemsOf(lookup(problem, "obstacles.vector"))) {
    const cls = asStr(get(layer, "class")) ?? "ink";
    const r = asF64(sourceOpt(layer, "obstacles.vector", "r")) ?? 2;
    const width = asF64(sourceOpt(layer, "obstacles.vector", "width")) ?? 1;
    const evenOdd = asStr(sourceOpt(layer, "obstacles.vector", "fill_rule")) === "evenodd";
    const pv = get(layer, "points");
    // pointsOf(pv) mapped through toPx, without the intermediate points
    if (Array.isArray(pv)) {
      for (const q of pv) {
        const x = asF64(at(q, 0));
        const y = asF64(at(q, 1));
        if (x !== null && y !== null) vector.push([cls, { kind: "disc", c: toPx.applyXY(x, y), r }]);
      }
    }
    for (const c of itemsOf(get(layer, "circles"))) {
      const x = asF64(at(c, 0)) ?? 0;
      const y = asF64(at(c, 1)) ?? 0;
      const cr = asF64(at(c, 2)) ?? 0;
      vector.push([cls, { kind: "disc", c: toPx.apply(new P(x, y)), r: cr }]);
    }
    for (const pl of itemsOf(get(layer, "polylines"))) {
      const pts = pointsOf(pl).map((p) => toPx.apply(p));
      vector.push([cls, { kind: "polyline", points: pts, hw: width * 0.5, closed: false }]);
    }
    for (const pg of itemsOf(get(layer, "polygons"))) {
      const ring = pointsOf(pg).map((p) => toPx.apply(p));
      const bbox = bboxOf(ring);
      vector.push([cls, { kind: "polygon", rings: [ring], evenOdd, bbox }]);
    }
    for (const rc of itemsOf(get(layer, "rects"))) {
      const v = itemsOf(rc).map((x) => asF64(x) ?? 0);
      if (v.length === 4) {
        const a = toPx.apply(new P(v[0]!, v[1]!));
        const b = toPx.apply(new P(v[0]! + v[2]!, v[1]! + v[3]!));
        if (toPx.m[1] === 0 && toPx.m[2] === 0) {
          vector.push([cls, { kind: "rect", rect: new Rect(minf(a.x, b.x), minf(a.y, b.y), maxf(a.x, b.x), maxf(a.y, b.y)) }]);
        } else {
          const ring = [
            new P(v[0]!, v[1]!),
            new P(v[0]! + v[2]!, v[1]!),
            new P(v[0]! + v[2]!, v[1]! + v[3]!),
            new P(v[0]!, v[1]! + v[3]!),
          ].map((p) => toPx.apply(p));
          const bbox = bboxOf(ring);
          vector.push([cls, { kind: "polygon", rings: [ring], evenOdd: false, bbox }]);
        }
      }
    }
    for (const sh of itemsOf(get(layer, "shapes"))) {
      const atp = toPx.apply(new P(asF64(get(sh, "x")) ?? 0, asF64(get(sh, "y")) ?? 0));
      const [shape] = markShape(sh, atp, toPx, [], warnings, "/obstacles/vector");
      vector.push([cls, { kind: "shape", shape }]);
    }
  }
  // SVG geometry
  const presetRules: [string, string][] = [];
  for (const r of itemsOf(o.preset !== null ? get(o.preset, "svg_classes") : undefined)) {
    const sel = asStr(get(r, "selector"));
    const c = asStr(get(r, "class"));
    if (sel !== null && c !== null) presetRules.push([sel, c]);
  }
  for (const [doc, src, ptr] of svgs) {
    const classes = asArray(get(src, "classes"));
    let rules: [string, string][];
    if (classes !== null) {
      rules = [];
      for (const r of classes) {
        const sel = asStr(get(r, "selector"));
        const c = asStr(get(r, "class"));
        if (sel !== null && c !== null) rules.push([sel, c]);
      }
    } else rules = presetRules.slice();
    const defaultClass = asStr(sourceOpt(src, "obstacles.svg", "default_class")) ?? "ink";
    let geoms: [string, Geom][];
    try {
      geoms = doc.classify(rules, defaultClass, usedSvgIds);
    } catch (e) {
      if (e instanceof SvgRuleError) throw err(`${ptr}/classes/${e.rule}/selector`, "pattern", e.message);
      throw e;
    }
    for (const [cls, g] of geoms) vector.push([cls, geomToPrim(g)]);
  }

  // --- extent ---
  const maxDistGlobal = o.length("placement.max_distance").px(defaultEm);
  let extent: Rect;
  if (canvas !== null) extent = canvas;
  else {
    let bb = Rect.EMPTY;
    for (const it of items) {
      bb = bb.union(it.shape.bbox());
      if (it.area !== null) bb = bb.union(it.area.shape.bbox());
    }
    for (const [, p] of vector) bb = bb.union(primBbox(p));
    if (bb.isEmpty()) bb = new Rect(0, 0, 1, 1);
    const grow = maxf(maxDistGlobal, 20 * defaultEm);
    extent = bb.inflate(grow);
  }

  // --- label area ---
  const allowOutside = o.bool("canvas.allow_outside");
  const pad = o.length("canvas.padding").px(defaultEm);
  let region: Rect | null = null;
  const rv = asArray(get(get(problem, "canvas"), "region"));
  if (rv !== null) {
    const v = rv.filter((x): x is number => typeof x === "number");
    if (v.length === 4) region = Rect.xywh(v[0]!, v[1]!, v[2]!, v[3]!);
  }
  const labelArea = canvas !== null && !allowOutside ? (region ?? canvas).inflate(-pad) : null;
  const leaderArea = allowOutside ? null : canvas;

  // --- priority options ---
  let omission: Omission;
  switch (o.string("priority.omission")) {
    case "prefix":
      omission = Omission.Prefix;
      break;
    case "weighted":
      omission = Omission.Weighted;
      break;
    default:
      omission = Omission.Strict;
  }
  const tiesS = o.string("priority.ties");
  const solver = SolverOpts.from(o);
  let ties: Ties;
  if (tiesS === "id") ties = { kind: "id" };
  else if (tiesS === "anchor_x") ties = { kind: "anchor_x" };
  else if (tiesS === "random") ties = { kind: "random", seed: BigInt(solver.seed) };
  else if (tiesS.startsWith("random(")) ties = { kind: "random", seed: parseRustU64(tiesS.slice(7, tiesS.length - 1)) ?? BigInt(0) };
  else ties = { kind: "input_order" };
  const fv = lookup(problem, "priority.focus");
  const fp = fv === undefined ? null : pointsOfSingle(fv);
  const focus = fp !== null ? toPx.apply(fp) : null;

  // --- ladder ---
  const ladder: Step[] = [];
  for (const s of o.strings("degrade")) {
    const st = stepParse(s);
    if (st !== null) ladder.push(st);
  }

  // --- auto preset ---
  let autoCrowded: [number, Models] | null = null;
  if (o.presetName === "auto" && !userSetModels && o.preset !== null) {
    const a = get(o.preset, "auto");
    if (a !== undefined) {
      const f = asF64(get(a, "crowded_fraction")) ?? 0.3;
      const names: string[] = [];
      for (const s of itemsOf(get(a, "crowded_models"))) if (typeof s === "string") names.push(s);
      autoCrowded = [f, Models.fromNames(names)];
    }
  }

  // --- warm start ---
  const warm = new Map<string, Rect | null>();
  for (const p of itemsOf(lookup(problem, "warm_start.placements"))) {
    const id = asStr(get(p, "id"));
    if (id === null) continue;
    const placed = asBool(get(p, "placed")) ?? true;
    const b = get(p, "box");
    let rect: Rect | null = null;
    if (b !== undefined) {
      const x = asF64(get(b, "x"));
      const y = asF64(get(b, "y"));
      const w = asF64(get(b, "w"));
      const h = asF64(get(b, "h"));
      if (x !== null && y !== null && w !== null && h !== null) rect = Rect.xywh(x, y, w, h);
    }
    warm.set(id, placed ? rect : null);
  }

  const m = new Model();
  m.canvas = canvas;
  m.labelArea = labelArea;
  m.leaderArea = leaderArea;
  m.extent = extent;
  m.toPx = toPx;
  m.items = items;
  m.vector = vector;
  m.rasters = rasters;
  m.avoidLabel = o.map("avoid.label");
  m.avoidLeader = o.map("avoid.leader");
  m.avoidBuffer = o.map("avoid.buffer");
  m.relaxable = o.strings("avoid.relaxable");
  m.placement = PlacementOpts.from(o);
  m.leaders = LeaderOpts.from(o);
  m.weights = Weights.from(o);
  m.solver = solver;
  m.ladder = ladder;
  m.degrade = DegradeOpts.from(o);
  m.output = OutputOpts.from(o);
  m.omission = omission;
  m.ties = ties;
  m.band = o.f64("priority.band");
  m.maxLabels = asU64(o.get("priority.budget.max_labels"));
  m.maxInkFraction = asF64(o.get("priority.budget.max_ink_fraction"));
  m.focus = focus;
  m.priorityValue = o.get("priority");
  m.autoCrowded = autoCrowded;
  m.gridCell = asF64(o.get("solver.grid_cell"));
  m.defaultEm = defaultEm;
  m.shaping = o.string("text.shaping");
  m.warm = warm;
  m.warnings = warnings;
  m.presetName = o.presetName;
  return m;
}

/** Bare base64 (no `.`; file paths must carry an extension). */
function looksBase64(s: string): boolean {
  if (s.length < 16) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const alnum = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (!alnum && c !== 0x2b && c !== 0x2f && c !== 0x3d && c !== 0x2d && c !== 0x5f && c !== 0x0a && c !== 0x0d && c !== 0x20) {
      return false;
    }
  }
  return true;
}

/** `parse_color`: `#rgb` or `#rrggbb`. */
function parseColor(s: string): [number, number, number] | null {
  if (!s.startsWith("#")) return null;
  const h = utf8.encode(s.slice(1));
  // u8::from_str_radix on a 1- or 2-byte slice
  const hex = (i: number, n: number): number => {
    const d = (c: number): number =>
      c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x61 && c <= 0x66 ? c - 0x57 : c >= 0x41 && c <= 0x46 ? c - 0x37 : -1;
    let k = i;
    const end = i + n;
    if (h[k] === 0x2b) k++;
    if (k >= end) return -1;
    let v = 0;
    for (; k < end; k++) {
      const x = d(h[k]!);
      if (x < 0) return -1;
      v = v * 16 + x;
    }
    return v;
  };
  if (h.length === 3) {
    const r = hex(0, 1);
    const g = hex(1, 1);
    const b = hex(2, 1);
    if (r < 0 || g < 0 || b < 0) return null;
    return [r * 17, g * 17, b * 17];
  }
  if (h.length === 6) {
    const r = hex(0, 2);
    const g = hex(2, 2);
    const b = hex(4, 2);
    if (r < 0 || g < 0 || b < 0) return null;
    return [r, g, b];
  }
  return null;
}

function rasterOpts(src: unknown, ptr: string): RasterOpts {
  const g = (k: string): unknown => sourceOpt(src, "obstacles.raster", k);
  const mode = asStr(g("mode")) ?? "ink";
  const bgs = asStr(g("ink.background"));
  const background = bgs !== null ? parseColor(bgs) : null;
  const inkThreshold = asF64(g("ink.threshold")) ?? 0.12;
  let m: RasterOpts["mode"];
  switch (mode) {
    case "alpha":
      m = { kind: "alpha", threshold: asF64(g("alpha.threshold")) ?? 0.1 };
      break;
    case "cost":
      m = { kind: "cost", invert: asBool(g("cost.invert")) ?? false };
      break;
    case "saliency":
      m = { kind: "saliency" };
      break;
    case "classmap": {
      const palette: [[number, number, number], string][] = [];
      const cm = get(src, "classmap");
      if (isObject(cm)) {
        for (const k of Object.keys(cm)) {
          const v = cm[k];
          if (v === undefined) continue;
          const c = parseColor(k);
          if (c === null) throw err(`${ptr}/classmap`, "pattern", `invalid colour ${k}`);
          palette.push([c, asStr(v) ?? "ink"]);
        }
      }
      m = {
        kind: "classmap",
        palette,
        tolerance: asF64(g("classmap_tolerance")) ?? 0.08,
        unmatchedInk: asStr(g("unmatched")) !== "ignore",
        background,
        inkThreshold,
      };
      break;
    }
    default:
      m = { kind: "ink", background, threshold: inkThreshold, dilate: (asU64(g("ink.dilate")) ?? 1) % 4294967296 };
  }
  const off = g("offset");
  return {
    mode: m,
    class: asStr(g("class")) ?? "ink",
    scale: asF64(g("scale")) ?? 1,
    offset: new P(asF64(at(off, 0)) ?? 0, asF64(at(off, 1)) ?? 0),
  };
}

function geomToPrim(g: Geom): Prim {
  switch (g.kind) {
    case "polygon": {
      const all: P[] = [];
      for (const r of g.rings) for (const p of r) all.push(p);
      return { kind: "polygon", rings: g.rings, evenOdd: g.evenOdd, bbox: bboxOf(all) };
    }
    case "polyline":
      return { kind: "polyline", points: g.points, hw: g.width * 0.5, closed: g.closed };
    case "rect":
      return { kind: "rect", rect: g.rect };
  }
}

/** Polygon rings of SVG geometry (fills; strokes become thin outlines; rects as rings). */
function geomsToRings(geoms: readonly Geom[]): P[][] {
  const rings: P[][] = [];
  for (const g of geoms) {
    switch (g.kind) {
      case "polygon":
        for (const r of g.rings) rings.push(r.slice());
        break;
      case "rect":
        rings.push(g.rect.corners());
        break;
      case "polyline":
        if (g.points.length >= 3) rings.push(g.points.slice());
        break;
    }
  }
  return rings;
}

/** Build a mark shape from a mark JSON object placed at `at` (canvas px): `[shape, tip]`. */
export function markShape(
  m: unknown,
  atp: P,
  toPx: Affine,
  svgs: readonly SvgEntry[],
  warnings: Issue[],
  ptr: string,
): [Shape, boolean] {
  const f = (k: string): number => asF64(get(m, k)) ?? 0;
  const shape = asStr(get(m, "shape")) ?? "circle";
  switch (shape) {
    case "ellipse":
      return [Shape.ellipse(atp, f("rx"), f("ry"), f("rotation")), false];
    case "rect":
      return [Shape.rect(atp, f("w"), f("h"), f("corner_radius"), f("rotation")), false];
    case "polygon": {
      const rel = asBool(get(m, "relative")) ?? false;
      const map = (p: P): P => (rel ? atp.add(p) : toPx.apply(p));
      const pv = get(m, "points");
      const rings: P[][] = [pointsOf(pv === undefined ? null : pv).map(map)];
      for (const h of itemsOf(get(m, "holes"))) rings.push(pointsOf(h).map(map));
      return [Shape.polygon(rings, false, atp), false];
    }
    case "path": {
      const rel = asBool(get(m, "relative")) ?? false;
      const d = asStr(get(m, "d")) ?? "";
      let subs;
      try {
        subs = flatten(d, 0.25);
      } catch (e) {
        if (e instanceof PathError) throw err(`${ptr}/d`, "pattern", `invalid path data at ${e.offset}: ${e.message}`);
        throw e;
      }
      const rings: P[][] = [];
      for (const s of subs) {
        if (s.points.length >= 3) rings.push(s.points.map((p) => (rel ? atp.add(p) : toPx.apply(p))));
      }
      if (rings.length === 0) {
        warnings.push(new Issue(ptr, "ignored", "path mark has no area; using a point"));
        return [Shape.circle(atp, 0), false];
      }
      return [Shape.polygon(rings, false, atp), false];
    }
    case "icon": {
      const w = f("w");
      const h = f("h");
      const tv = get(m, "tip");
      const tip = (tv !== undefined ? pointsOfSingle(tv) : null) ?? new P(w * 0.5, h);
      const tl = atp.sub(tip);
      const sil = get(m, "silhouette");
      const ring =
        sil !== undefined
          ? pointsOf(sil).map((p) => tl.add(p))
          : [tl, tl.add(new P(w, 0)), tl.add(new P(w, h)), tl.add(new P(0, h))];
      return [Shape.polygon([ring], false, atp), true];
    }
    case "from_svg": {
      const geoms: Geom[] = [];
      for (const [doc] of svgs) {
        const id = asStr(get(m, "svg_id"));
        if (id !== null) {
          const g = doc.geometryById(id);
          if (g !== null) geoms.push(...g);
        } else {
          const sel = asStr(get(m, "selector"));
          if (sel !== null) {
            try {
              geoms.push(...doc.geometryBySelector(sel));
            } catch (e) {
              throw err(`${ptr}/selector`, "pattern", errorMessage(e));
            }
          }
        }
      }
      const rings = geomsToRings(geoms);
      if (rings.length === 0) {
        warnings.push(new Issue(ptr, "ignored", "from_svg mark not found in the SVG background; using a point"));
        return [Shape.circle(atp, 2), false];
      }
      return [Shape.polygon(rings, false, atp), false];
    }
    default:
      return [Shape.circle(atp, f("r")), false];
  }
}

function wrapSpecOf(w: Record<string, unknown>, f: FontSel): WrapSpec {
  const mw = get(w, "max_width");
  const l = mw === undefined ? null : Length.fromValue(mw);
  const ml = asU64(get(w, "max_lines")) ?? 1;
  return {
    maxWidth: l !== null ? l.px(f.size) : null,
    maxLines: ml > 1 ? ml : 1,
    balance: asBool(get(w, "balance")) ?? true,
  };
}

function buildItem(
  i: number,
  it: unknown,
  ptr: string,
  o: Opts,
  defaultFont: FontSel,
  toPx: Affine,
  svgs: readonly SvgEntry[],
  autoMarks: boolean,
  usedSvgIds: string[],
  globalModels: Models,
  warnings: Issue[],
): Item {
  const id = asStr(get(it, "id")) ?? String(i);
  const anchorV = get(it, "anchor") ?? null;
  const labelV = get(it, "label") ?? null;
  // font: defaults ← label.font
  const font = fontOver(defaultFont, get(labelV, "font"));
  const em = font.size;
  const lenOf = (key: string, itemKey: unknown): number => {
    const l = itemKey === undefined ? null : Length.fromValue(itemKey);
    return (l ?? o.length(key)).px(em);
  };
  const ip = get(it, "placement");
  const padding = lenOf("defaults.padding", get(labelV, "padding"));
  const len: ItemLengths = {
    padding,
    buffer: lenOf("defaults.buffer", undefined),
    offset: lenOf("placement.offset", get(ip, "offset")),
    innerPadding: lenOf("placement.inner_padding", undefined),
    maxDistance: lenOf("placement.max_distance", undefined),
    minDistance: lenOf("placement.min_distance", undefined),
    leaderMin: lenOf("leaders.min_length", undefined),
    leaderMax: lenOf("leaders.max_length", undefined),
    anchorGap: lenOf("leaders.anchor_gap", undefined),
    clearance: lenOf("leaders.clearance", undefined),
    boundaryGap: lenOf("placement.boundary.gap", undefined),
    boundaryMargin: lenOf("placement.boundary.margin", undefined),
  };
  // anchor + mark
  const svgId = asStr(get(it, "svg_id"));
  let anchor: P;
  let shape: Shape;
  let area: Area | null = null;
  let tip = false;
  if (asStr(get(anchorV, "type")) === "area") {
    const pv = get(anchorV, "polygon");
    const rings: P[][] = [pointsOf(pv === undefined ? null : pv).map((p) => toPx.apply(p))];
    for (const h of itemsOf(get(anchorV, "holes"))) rings.push(pointsOf(h).map((p) => toPx.apply(p)));
    const [pole, poleDist] = polylabel(rings, false, 0.5);
    const areaShape = Shape.polygon(rings, false, pole);
    const dotV = get(anchorV, "dot");
    const dot = dotV !== undefined ? markShape(dotV, pole, toPx, svgs, warnings, `${ptr}/anchor/dot`)[0] : Shape.circle(pole, 2);
    anchor = pole;
    shape = dot;
    area = { shape: areaShape, pole, poleDist };
  } else {
    const atp = toPx.apply(new P(asF64(get(anchorV, "x")) ?? 0, asF64(get(anchorV, "y")) ?? 0));
    const markV = get(anchorV, "mark");
    let mark: unknown = markV !== undefined ? markV : o.get("defaults.mark");
    if (autoMarks && svgId !== null && markV === undefined) mark = { shape: "from_svg", svg_id: svgId };
    if (asStr(get(mark, "shape")) === "from_svg") {
      const sid = asStr(get(mark, "svg_id"));
      if (sid !== null) usedSvgIds.push(sid);
    }
    const [s, t] = markShape(mark, atp, toPx, svgs, warnings, `${ptr}/anchor/mark`);
    anchor = atp;
    shape = s;
    tip = t;
  }
  // label
  const textSpec = (v: unknown, f: FontSel): TextSpec => {
    let wrap: WrapSpec | null;
    const wv = get(v, "wrap");
    if (isObject(wv)) wrap = wrapSpecOf(wv, f);
    else if (wv === null) wrap = null;
    else {
      const dw = o.get("defaults.wrap");
      wrap = isObject(dw) ? wrapSpecOf(dw, f) : null;
    }
    let explicit: [number, number, string[]] | null = null;
    const ew = asF64(get(v, "width"));
    const eh = asF64(get(v, "height"));
    if (ew !== null && eh !== null) {
      const la = asArray(get(v, "lines"));
      const lines = la !== null ? la.filter((s): s is string => typeof s === "string") : [asStr(get(v, "text")) ?? ""];
      explicit = [ew, eh, lines];
    }
    const alts = asArray(get(v, "alternatives"));
    return {
      text: asStr(get(v, "text")) ?? "",
      alternatives: alts !== null ? alts.filter((s): s is string => typeof s === "string") : [],
      wrap,
      truncate: truncateParse(asStr(get(v, "truncate")) ?? o.string("defaults.truncate")),
      explicit,
      align: asStr(get(v, "align")) ?? "start",
      font: f.clone(),
    };
  };
  const fixed = (v: unknown): [FixedKind, number, number, LabelShape] => [
    asStr(get(v, "type")) === "box" ? FixedKind.Box : FixedKind.Icon,
    asF64(get(v, "width")) ?? 0,
    asF64(get(v, "height")) ?? 0,
    labelShapeParse(asStr(get(v, "shape")), get(v, "polygon")),
  ];
  let label: LabelSpec;
  const ltype = asStr(get(labelV, "type"));
  if (ltype === "icon" || ltype === "box") {
    const [fk, w, h, sh] = fixed(labelV);
    label = { kind: "fixed", fixed: fk, w, h, shape: sh };
  } else if (ltype === "composite") {
    const cfont = font.clone();
    const parts: PartSpec[] = [];
    for (const p of itemsOf(get(labelV, "parts"))) {
      if (asStr(get(p, "type")) === "text") parts.push({ kind: "text", spec: textSpec(p, fontOver(cfont, get(p, "font"))) });
      else {
        const [fk, w, h, sh] = fixed(p);
        parts.push({ kind: "fixed", fixed: fk, w, h, shape: sh });
      }
    }
    const gv = get(labelV, "gap");
    const gl = gv === undefined ? null : Length.fromValue(gv);
    label = {
      kind: "composite",
      row: asStr(get(labelV, "direction")) !== "column",
      gap: gl !== null ? gl.px(em) : 0,
      align: asStr(get(labelV, "align")) ?? "center",
      parts,
    };
  } else {
    label = { kind: "text", spec: textSpec(labelV, font) };
  }
  // per-item placement
  const mv = asArray(get(ip, "models"));
  const models = mv !== null ? Models.fromNames(mv.filter((s): s is string => typeof s === "string")) : globalModels;
  const internal = internalPolicyParse(asStr(get(ip, "internal")) ?? o.string("placement.internal"));
  const pov = get(ip, "position_order");
  const positions = positionOrder(pov !== undefined ? pov : o.get("placement.position_order"));
  const kw = get(it, "keep_with");
  let keepWith: KeepWith | null = null;
  if (typeof kw === "string") keepWith = { kind: "set", name: kw };
  else if (Array.isArray(kw)) keepWith = { kind: "ids", ids: kw.filter((s): s is string => typeof s === "string") };
  const attrs = get(it, "attrs");
  return new Item(
    i,
    id,
    anchor,
    shape,
    area,
    tip,
    label,
    font,
    len,
    models,
    internal,
    positions,
    attrs !== undefined ? attrs : {},
    asF64(get(it, "priority")),
    asI64(get(it, "tier")),
    asBool(get(it, "required")) ?? false,
    asStr(get(it, "group")),
    keepWith,
    svgId,
    it,
  );
}
