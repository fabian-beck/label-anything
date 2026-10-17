/** Draws a result as SVG: one `<path>` per leader and one `<text>` per label. */
import type { LabelResult } from "@label-anything/core";
import type { CssFont } from "./measure.js";
import { SVG_NS } from "./svg.js";

export type Placement = LabelResult["placements"][number];
type Leader = NonNullable<Placement["leader"]>;
type TextInfo = NonNullable<Placement["text"]>;
type Box = NonNullable<Placement["box"]>;

export interface RenderOptions {
  /** The font the labels were measured with. */
  font: CssFont;
  /** CSS class prefix (default `la`): `la-labels`, `la-label`, `la-leader`. */
  className?: string;
  /** Text colour (default `currentColor`). */
  fill?: string;
  /** Halo colour drawn under the text (e.g. `white` on maps); `false`/undefined: none. */
  halo?: string | false;
  /** Halo width in px (default 3). */
  haloWidth?: number;
  /** Leader colour (default `currentColor`) and width (default 1). */
  leaderStroke?: string;
  leaderWidth?: number;
  /** Draws icon/box parts of composite labels (default: nothing). */
  renderPart?: (part: NonNullable<Placement["parts"]>[number], placement: Placement, parent: SVGGElement) => void;
  /** Called for each label element, e.g. to add event handlers or titles. */
  decorate?: (text: SVGTextElement, placement: Placement) => void;
  /** Opacity per label id, e.g. of labels fading in or out (`LabelMotion`); absent: 1. */
  opacity?: ReadonlyMap<string, number>;
  /** Opacity of the leaders per label id (absent: the label's). */
  leaderOpacity?: ReadonlyMap<string, number>;
}

function el<K extends keyof SVGElementTagNameMap>(doc: Document, tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = doc.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** SVG path data of a leader (polyline, quadratic curve, plus the underline if any). */
export function leaderPath(leader: Leader): string {
  let d: string;
  if (leader.curve && leader.curve.length === 3) {
    const [s, c, e] = leader.curve as [number, number][];
    d = `M${r2(s![0])},${r2(s![1])}Q${r2(c![0])},${r2(c![1])} ${r2(e![0])},${r2(e![1])}`;
  } else {
    d = leader.points.map((p, i) => `${i ? "L" : "M"}${r2(p[0])},${r2(p[1])}`).join("");
  }
  if (leader.underline && leader.underline.length >= 2) {
    d += leader.underline.map((p, i) => `${i ? "L" : "M"}${r2(p[0])},${r2(p[1])}`).join("");
  }
  return d;
}

function textElement(doc: Document, box: Box, t: TextInfo, o: RenderOptions, cls: string): SVGTextElement {
  const x = box.x + (t.x_offset ?? 0);
  const attrs: Record<string, string | number> = { class: `${cls}-label`, x: r2(x), y: r2(box.y + (t.baseline_offsets[0] ?? 0)) };
  if (t.font_size !== o.font.size) attrs["font-size"] = r2(t.font_size);
  if (t.font_weight !== undefined && t.font_weight !== o.font.weight) attrs["font-weight"] = t.font_weight;
  const text = el(doc, "text", attrs);
  if (t.lines.length === 1) {
    text.textContent = t.lines[0] ?? "";
  } else {
    t.lines.forEach((line, i) => {
      const span = el(doc, "tspan", { x: r2(x), y: r2(box.y + (t.baseline_offsets[i] ?? 0)) });
      span.textContent = line;
      text.appendChild(span);
    });
  }
  return text;
}

/**
 * Replaces the content of `group` with the placed labels and leaders of `result` (canvas
 * px). Labels get `data-id` attributes; leaders are drawn below the texts.
 */
export function renderLabels(group: SVGGElement | Element, result: LabelResult, options: RenderOptions): void {
  const doc = group.ownerDocument;
  const cls = options.className ?? "la";
  const leaders = el(doc, "g", {
    class: `${cls}-leaders`,
    fill: "none",
    stroke: options.leaderStroke ?? "currentColor",
    "stroke-width": options.leaderWidth ?? 1,
  });
  const f = options.font;
  const textAttrs: Record<string, string | number> = {
    class: `${cls}-texts`,
    "font-family": f.family,
    "font-size": f.size,
    "font-weight": f.weight,
    fill: options.fill ?? "currentColor",
  };
  if (f.italic) textAttrs["font-style"] = "italic";
  if (options.halo) {
    Object.assign(textAttrs, {
      stroke: options.halo,
      "stroke-width": options.haloWidth ?? 3,
      "stroke-linejoin": "round",
      "paint-order": "stroke",
    });
  }
  const texts = el(doc, "g", textAttrs);
  for (const p of result.placements) {
    if (!p.placed || !p.box) continue;
    const op = options.opacity?.get(p.id);
    const lop = options.leaderOpacity?.get(p.id) ?? op;
    for (const leader of p.leaders ?? (p.leader ? [p.leader] : [])) {
      const path = el(doc, "path", { class: `${cls}-leader`, d: leaderPath(leader), "data-id": leader.member ?? p.id });
      if (lop !== undefined && lop < 1) path.setAttribute("opacity", String(r3(lop)));
      leaders.appendChild(path);
    }
    const g = el(doc, "g", { class: `${cls}-item`, "data-id": p.id });
    if (op !== undefined && op < 1) g.setAttribute("opacity", String(r3(op)));
    if (p.parts && p.parts.length) {
      for (const part of p.parts) {
        if (part.type === "text" && part.text) g.appendChild(textElement(doc, part.box, part.text, options, cls));
        else options.renderPart?.(part, p, g);
      }
    } else if (p.text) {
      g.appendChild(textElement(doc, p.box, p.text, options, cls));
    } else {
      options.renderPart?.({ type: "box", box: p.box }, p, g);
    }
    for (const t of Array.from(g.children)) {
      if (t.tagName.toLowerCase() === "text") {
        t.setAttribute("data-id", p.id);
        options.decorate?.(t as SVGTextElement, p);
      }
    }
    if (g.childNodes.length) texts.appendChild(g);
  }
  group.replaceChildren(leaders, texts);
}

/**
 * A copy of `result` with every placed label (and its leaders) moved by its anchor's
 * displacement, for following moving anchors (pan/zoom) until the next solve.
 */
export function followAnchors(
  result: LabelResult,
  before: ReadonlyMap<string, readonly [number, number]>,
  after: ReadonlyMap<string, readonly [number, number]>,
): LabelResult {
  const placements = result.placements.map((p) => {
    const a = before.get(p.id);
    const b = after.get(p.id);
    if (!p.placed || !p.box || !a || !b) return b || !p.placed ? p : { ...p, placed: false };
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (dx === 0 && dy === 0) return p;
    const move = (q: readonly number[]): [number, number] => [q[0]! + dx, q[1]! + dy];
    const moveLeader = (l: Leader): Leader => ({
      ...l,
      points: l.points.map(move) as Leader["points"],
      port: move(l.port),
      underline: l.underline ? l.underline.map(move) : l.underline,
      curve: l.curve ? l.curve.map(move) : l.curve,
    });
    const out: Placement = { ...p, box: { ...p.box, x: p.box.x + dx, y: p.box.y + dy } };
    if (p.leader) out.leader = moveLeader(p.leader);
    if (p.leaders) out.leaders = p.leaders.map(moveLeader);
    if (p.parts) out.parts = p.parts.map((part) => ({ ...part, box: { ...part.box, x: part.box.x + dx, y: part.box.y + dy } }));
    return out;
  });
  return { ...result, placements };
}
