/**
 * Canvas drawing of results: leaders, label boxes and texts (black on translucent white,
 * the project's neutral style), and the diagnostic overlays (collision boxes, omitted
 * items, candidates, the selection).
 */
import type { LabelResult } from "@label-anything/core";

export type Placement = LabelResult["placements"][number];
type Leader = NonNullable<Placement["leader"]>;
type TextInfo = NonNullable<Placement["text"]>;
export type Candidate = NonNullable<LabelResult["candidates"]>[number];

/** The family the engine measures with by default (its bundled Noto Sans), as loaded by style.css. */
export const LABEL_FAMILY = '"LA Noto Sans", "Noto Sans", sans-serif';

export type LabelStyle = "box" | "halo" | "plain";

export function cssFont(t: TextInfo): string {
  return `${t.font_weight ?? 400} ${t.font_size}px ${LABEL_FAMILY}`;
}

function leaderPath(ctx: CanvasRenderingContext2D, l: Leader): void {
  ctx.beginPath();
  if (l.curve && l.curve.length === 3) {
    const [s, c, e] = l.curve as [number, number][];
    ctx.moveTo(s![0], s![1]);
    ctx.quadraticCurveTo(c![0], c![1], e![0], e![1]);
  } else {
    l.points.forEach((p, i) => (i ? ctx.lineTo(p[0]!, p[1]!) : ctx.moveTo(p[0]!, p[1]!)));
  }
  if (l.underline && l.underline.length >= 2) {
    l.underline.forEach((p, i) => (i ? ctx.lineTo(p[0]!, p[1]!) : ctx.moveTo(p[0]!, p[1]!)));
  }
}

const leadersOf = (p: Placement): Leader[] => p.leaders ?? (p.leader ? [p.leader] : []);

function texts(p: Placement): { box: NonNullable<Placement["box"]>; text: TextInfo }[] {
  if (p.parts && p.parts.length) {
    return p.parts.filter((q) => q.type === "text" && q.text).map((q) => ({ box: q.box, text: q.text! }));
  }
  return p.text && p.box ? [{ box: p.box, text: p.text }] : [];
}

/** Draws placed labels with their leaders; `opacity` per id for labels fading in or out. */
export function drawLabels(
  ctx: CanvasRenderingContext2D,
  result: LabelResult,
  style: LabelStyle,
  opacity?: ReadonlyMap<string, number>,
  leaderOpacity?: ReadonlyMap<string, number>,
  dim?: (id: string) => number,
): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#2b2f36";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const p of result.placements) {
    if (!p.placed || !p.box) continue;
    const a = (leaderOpacity?.get(p.id) ?? opacity?.get(p.id) ?? 1) * (dim?.(p.id) ?? 1);
    if (a <= 0) continue;
    ctx.globalAlpha = a;
    for (const l of leadersOf(p)) {
      // a stub (placement.stubs) is drawn lighter, without the dot at its start
      if (l.stub) {
        ctx.globalAlpha = a * 0.7;
        leaderPath(ctx, l);
        ctx.stroke();
        ctx.globalAlpha = a;
        continue;
      }
      leaderPath(ctx, l);
      ctx.stroke();
      const s = l.points[0];
      if (s) {
        ctx.beginPath();
        ctx.arc(s[0]!, s[1]!, 1.4, 0, Math.PI * 2);
        ctx.fillStyle = "#2b2f36";
        ctx.fill();
      }
    }
  }
  ctx.textBaseline = "alphabetic";
  for (const p of result.placements) {
    if (!p.placed || !p.box) continue;
    const a = (opacity?.get(p.id) ?? 1) * (dim?.(p.id) ?? 1);
    if (a <= 0) continue;
    ctx.globalAlpha = a;
    if (style === "box") {
      ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
      roundRect(ctx, p.box.x, p.box.y, p.box.w, p.box.h, 2);
      ctx.fill();
    }
    for (const { box, text } of texts(p)) {
      ctx.font = cssFont(text);
      const x = box.x + (text.x_offset ?? 0);
      text.lines.forEach((line, i) => {
        const y = box.y + (text.baseline_offsets[i] ?? 0);
        if (style === "halo") {
          ctx.lineWidth = 3;
          ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
          ctx.strokeText(line, x, y);
        }
        ctx.fillStyle = "#000000";
        ctx.fillText(line, x, y);
      });
    }
  }
  ctx.restore();
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const ACCENT = "#3949ab";

/** The collision boxes of the placed labels, colored by candidate model. */
export function drawBoxes(ctx: CanvasRenderingContext2D, result: LabelResult): void {
  ctx.save();
  ctx.lineWidth = 1;
  for (const p of result.placements) {
    if (!p.placed || !p.box) continue;
    ctx.strokeStyle = MODEL_COLORS[p.model ?? "adjacent"] ?? ACCENT;
    ctx.setLineDash(p.model === "adjacent" ? [] : [3, 2]);
    ctx.strokeRect(p.box.x + 0.5, p.box.y + 0.5, p.box.w - 1, p.box.h - 1);
  }
  ctx.restore();
}

export const MODEL_COLORS: Record<string, string> = {
  adjacent: "#3949ab",
  slider: "#00897b",
  internal: "#6d4c41",
  distant: "#c2185b",
  boundary: "#ef6c00",
  fan: "#7b1fa2",
};

/** Rings at the anchors of items without a label. */
export function drawOmitted(ctx: CanvasRenderingContext2D, result: LabelResult, anchors: ReadonlyMap<string, readonly [number, number]>): void {
  ctx.save();
  ctx.strokeStyle = "#c62828";
  ctx.lineWidth = 1.5;
  for (const p of result.placements) {
    if (p.placed) continue;
    const a = anchors.get(p.id);
    if (!a) continue;
    ctx.beginPath();
    ctx.arc(a[0], a[1], 5, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Every candidate of one item: feasible ones solid, infeasible dashed, the chosen one thick. */
export function drawCandidates(ctx: CanvasRenderingContext2D, candidates: readonly Candidate[], chosen: Placement | undefined): void {
  ctx.save();
  ctx.lineWidth = 1;
  for (const c of candidates) {
    ctx.strokeStyle = c.feasible ? MODEL_COLORS[c.model] ?? ACCENT : "rgba(120, 120, 120, 0.55)";
    ctx.setLineDash(c.feasible ? [] : [2, 3]);
    ctx.globalAlpha = c.feasible ? 0.75 : 0.5;
    ctx.strokeRect(c.box.x + 0.5, c.box.y + 0.5, c.box.w - 1, c.box.h - 1);
  }
  if (chosen?.box) {
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = ACCENT;
    ctx.strokeRect(chosen.box.x, chosen.box.y, chosen.box.w, chosen.box.h);
  }
  ctx.restore();
}

/** Outline of the hovered or selected label, and of the labels in an omitted item's way. */
export function drawHighlight(ctx: CanvasRenderingContext2D, p: Placement | undefined, color = ACCENT, width = 2): void {
  if (!p?.placed || !p.box) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  roundRect(ctx, p.box.x - 1, p.box.y - 1, p.box.w + 2, p.box.h + 2, 3);
  ctx.stroke();
  ctx.restore();
}

/** Vector obstacles of the problem, outlined by class. */
export function drawObstacles(ctx: CanvasRenderingContext2D, obstacles: { vector?: unknown[] } | undefined): void {
  const layers = (obstacles?.vector ?? []) as {
    class: string;
    points?: number[][];
    r?: number;
    circles?: number[][];
    rects?: number[][];
    polygons?: number[][][];
    polylines?: number[][][];
    width?: number;
  }[];
  ctx.save();
  ctx.globalAlpha = 0.85;
  layers.forEach((layer, i) => {
    const color = ["#d81b60", "#00897b", "#f4511e", "#5e35b1", "#039be5"][i % 5]!;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1, layer.width ?? 1);
    for (const p of layer.points ?? []) {
      ctx.beginPath();
      ctx.arc(p[0]!, p[1]!, layer.r ?? 2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const c of layer.circles ?? []) {
      ctx.beginPath();
      ctx.arc(c[0]!, c[1]!, c[2]!, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const r of layer.rects ?? []) ctx.strokeRect(r[0]!, r[1]!, r[2]!, r[3]!);
    for (const line of layer.polylines ?? []) {
      ctx.beginPath();
      line.forEach((p, j) => (j ? ctx.lineTo(p[0]!, p[1]!) : ctx.moveTo(p[0]!, p[1]!)));
      ctx.stroke();
    }
    for (const poly of layer.polygons ?? []) {
      ctx.beginPath();
      poly.forEach((p, j) => (j ? ctx.lineTo(p[0]!, p[1]!) : ctx.moveTo(p[0]!, p[1]!)));
      ctx.closePath();
      ctx.stroke();
    }
  });
  ctx.restore();
}

/**
 * The naive alternative for comparison: every label right above its anchor's top-right,
 * whatever it covers (what a plotting library does by default).
 */
export function drawNaive(
  ctx: CanvasRenderingContext2D,
  items: readonly { id: string; text: string; x: number; y: number; r: number }[],
  fontSize: number,
): void {
  ctx.save();
  ctx.font = `400 ${fontSize}px ${LABEL_FAMILY}`;
  ctx.textBaseline = "alphabetic";
  for (const it of items) {
    const x = it.x + it.r + 1;
    const y = it.y - it.r - 1;
    const w = ctx.measureText(it.text).width;
    ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
    ctx.fillRect(x - 1, y - fontSize * 0.95, w + 2, fontSize * 1.25);
    ctx.fillStyle = "#000000";
    ctx.fillText(it.text, x, y);
  }
  ctx.restore();
}

/** The label box under a point (topmost first), among placed labels. */
export function labelAt(result: LabelResult | undefined, x: number, y: number): Placement | undefined {
  if (!result) return undefined;
  for (let i = result.placements.length - 1; i >= 0; i--) {
    const p = result.placements[i]!;
    const b = p.box;
    if (p.placed && b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return p;
  }
  return undefined;
}
