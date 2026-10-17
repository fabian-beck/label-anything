/**
 * Smooth transitions between solves. A new result does not replace the drawn labels at
 * once: labels that moved glide to their new place, labels that appear fade in and labels
 * that disappear fade out, and all of them keep following their anchors meanwhile. A
 * label that disappears for a solve or two only dims instead of blinking.
 *
 * ```js
 * const motion = new LabelMotion();
 * motion.target(result);                       // after every solve
 * const f = motion.frame(anchors);             // on every animation frame while motion.moving
 * renderLabels(group, f.result, { font, opacity: f.opacity, leaderOpacity: f.leaderOpacity });
 * ```
 *
 * Positions are kept relative to each label's anchor (`placement.anchor`, which results
 * report), so the labels move with their points between solves. Moves follow a critically
 * damped spring (no overshoot; a move that is retargeted mid-way bends smoothly into the
 * new one); fades are linear.
 */
import type { LabelResult } from "@label-anything/core";
import type { Anchors } from "./stable.js";

type Placement = LabelResult["placements"][number];
type Leader = NonNullable<Placement["leader"]>;
type TextInfo = NonNullable<Placement["text"]>;
type Pt = [number, number];

export interface MotionOptions {
  /** Transition time in ms (default 300): moves settle and fades complete within it; 0: none. */
  duration?: number;
  /** Fade in the labels of the first result too (default `false`: they appear at once). */
  fadeInFirst?: boolean;
}

/** The labels as they are drawn at one moment. */
export interface MotionFrame {
  /**
   * The placements at their current boxes (text scaled with the box, leaders attached),
   * including the labels that are fading out (as placed).
   */
  result: LabelResult;
  /** Opacity per label id, for labels fading in or out (absent: 1). */
  opacity: Map<string, number>;
  /** Opacity of the leaders per label id, for leaders fading out (absent: the label's). */
  leaderOpacity: Map<string, number>;
}

interface Label {
  id: string;
  /** The placement drawn: the target, or the last one while the label fades out. */
  p: Placement;
  /** The anchor `p` was placed for. */
  a: Pt;
  /** Placed in the latest result. */
  live: boolean;
  /** Box origin relative to the anchor, its velocity (px/ms) and its target. */
  off: Pt;
  vel: Pt;
  tOff: Pt;
  /** Box size, its rate of change and its target. */
  size: Pt;
  vsize: Pt;
  tSize: Pt;
  opacity: number;
  /** Leaders of the previous placement that fade out (the new one has none). */
  old: { leaders: Leader[]; a: Pt; box: Pt; size: Pt } | null;
  oldOpacity: number;
}

const leadersOf = (p: Placement): Leader[] => p.leaders ?? (p.leader ? [p.leader] : []);

function anchorOf(p: Placement, anchors: Anchors | undefined): Pt {
  if (p.anchor) return [p.anchor[0], p.anchor[1]];
  const a = anchors?.get(p.id);
  // without an anchor the box stays where it is
  return a ? [a[0], a[1]] : [0, 0];
}

/** One spring component: exact solution of the critically damped oscillator over `dt`. */
function spring(x: Pt, v: Pt, target: Pt, dt: number, w: number): void {
  const k = Math.exp(-w * dt);
  for (let i = 0; i < 2; i++) {
    const e0 = x[i]! - target[i]!;
    const c = v[i]! + w * e0;
    const e1 = (e0 + c * dt) * k;
    const v1 = (v[i]! - w * c * dt) * k;
    if (Math.abs(e1) < 0.01 && Math.abs(v1) < 1e-4) {
      x[i] = target[i]!;
      v[i] = 0;
    } else {
      x[i] = target[i]! + e1;
      v[i] = v1;
    }
  }
}

const settled = (x: Pt, v: Pt, t: Pt) => x[0] === t[0] && x[1] === t[1] && v[0] === 0 && v[1] === 0;

function scaleText(t: TextInfo, s: number): TextInfo {
  if (s === 1) return t;
  const out: TextInfo = {
    ...t,
    font_size: t.font_size * s,
    baseline_offsets: t.baseline_offsets.map((b) => b * s),
  };
  if (t.x_offset !== undefined) out.x_offset = t.x_offset * s;
  if (t.line_widths) out.line_widths = t.line_widths.map((w) => w * s);
  return out;
}

/**
 * A leader moved along with its label: the points after the first move with the label's
 * box (`box`, at `boxRef` when the leader was made, scaled by `s`), the first with the
 * anchor (`a`, at `aRef`). The start of a straight leader also turns with its port while
 * the box glides: it stays at its distance from the anchor, and is exact again when the
 * box arrives (`boxTo`).
 */
function moveLeader(l: Leader, a: Pt, aRef: Pt, box: Pt, boxRef: Pt, s: Pt, boxTo: Pt): Leader {
  const onBox = (q: readonly number[], b: Pt = box): [number, number] => [
    b[0] + (q[0]! - boxRef[0]) * s[0],
    b[1] + (q[1]! - boxRef[1]) * s[1],
  ];
  const port = onBox(l.port);
  const s0 = l.points[0]!;
  let start: [number, number] = [a[0] + s0[0]! - aRef[0], a[1] + s0[1]! - aRef[1]];
  if (l.points.length === 2 && l.member === undefined && (box[0] !== boxTo[0] || box[1] !== boxTo[1])) {
    const r = Math.hypot(s0[0]! - aRef[0], s0[1]! - aRef[1]);
    const toward = (q: Pt): Pt => {
      const dx = q[0] - a[0];
      const dy = q[1] - a[1];
      const d = Math.hypot(dx, dy) || 1;
      return [a[0] + (dx / d) * r, a[1] + (dy / d) * r];
    };
    const now = toward(port);
    const end = toward(onBox(l.port, boxTo));
    start = [start[0] + now[0] - end[0], start[1] + now[1] - end[1]];
  }
  const pts = l.points.map((q, i) => (i === 0 ? start : onBox(q)));
  const out: Leader = { ...l, points: pts as Leader["points"], port };
  if (l.underline) out.underline = l.underline.map((q) => onBox(q));
  if (l.curve && l.curve.length === 3) out.curve = [start, onBox(l.curve[1]!), onBox(l.curve[2]!)];
  return out;
}

export class LabelMotion {
  #duration: number;
  #omega: number;
  #fadeInFirst: boolean;
  #labels = new Map<string, Label>();
  #order: string[] = [];
  #first = true;
  #t = 0;
  #result: LabelResult | undefined;

  constructor(options: MotionOptions = {}) {
    this.#duration = Math.max(0, options.duration ?? 300);
    // a critically damped spring is within 2 % of its target after ω·t = 6: (1 + 6)·e⁻⁶
    this.#omega = this.#duration > 0 ? 6 / this.#duration : 0;
    this.#fadeInFirst = options.fadeInFirst ?? false;
  }

  /** The latest result passed to `target`. */
  get result(): LabelResult | undefined {
    return this.#result;
  }

  /** Whether labels are still moving or fading (draw another frame). */
  get moving(): boolean {
    for (const l of this.#labels.values()) {
      if (l.opacity !== (l.live ? 1 : 0) || l.oldOpacity > 0) return true;
      if (!settled(l.off, l.vel, l.tOff) || !settled(l.size, l.vsize, l.tSize)) return true;
    }
    return false;
  }

  /**
   * Moves the labels towards a new result, from where they are at `now` (ms). `anchors`:
   * the positions the result was solved for, for placements without `anchor`.
   */
  target(result: LabelResult, anchors?: Anchors, now: number = performance.now()): void {
    this.#advance(now);
    const instant = this.#duration === 0 || (this.#first && !this.#fadeInFirst);
    this.#first = false;
    this.#result = result;
    const seen = new Set<string>();
    for (const p of result.placements) {
      if (!p.placed || !p.box) continue;
      seen.add(p.id);
      const a = anchorOf(p, anchors);
      const tOff: Pt = [p.box.x - a[0], p.box.y - a[1]];
      const tSize: Pt = [p.box.w, p.box.h];
      const l = this.#labels.get(p.id);
      if (!l || l.opacity <= 0) {
        // appears: at its place, fading in
        this.#labels.set(p.id, {
          id: p.id, p, a, live: true,
          off: [...tOff], vel: [0, 0], tOff,
          size: [...tSize], vsize: [0, 0], tSize,
          opacity: instant ? 1 : 0, old: null, oldOpacity: 0,
        });
        continue;
      }
      // visible: glides from where it is now
      const had = leadersOf(l.p);
      if (had.length && !leadersOf(p).length) {
        l.old = { leaders: had, a: l.a, box: [l.p.box!.x, l.p.box!.y], size: [l.p.box!.w, l.p.box!.h] };
        l.oldOpacity = instant ? 0 : 1;
      } else if (leadersOf(p).length) {
        l.old = null;
        l.oldOpacity = 0;
      }
      Object.assign(l, { p, a, live: true, tOff, tSize });
      if (instant) this.#snap(l);
    }
    for (const l of this.#labels.values()) {
      if (seen.has(l.id)) continue;
      l.live = false;
      if (instant) this.#labels.delete(l.id);
    }
    this.#order = [...this.#labels.keys()];
  }

  /**
   * The labels at `now` (ms), each moved along with its anchor: `anchors` maps ids to the
   * anchors' current positions (default: where the latest result placed them).
   */
  frame(anchors?: Anchors, now: number = performance.now()): MotionFrame {
    this.#advance(now);
    const opacity = new Map<string, number>();
    const leaderOpacity = new Map<string, number>();
    const fading: Placement[] = [];
    const live: Placement[] = [];
    for (const id of this.#order) {
      const l = this.#labels.get(id);
      if (!l) continue;
      const cur = anchors?.get(id);
      const a: Pt = cur ? [cur[0], cur[1]] : l.a;
      const box: Pt = [a[0] + l.off[0], a[1] + l.off[1]];
      const boxTo: Pt = [a[0] + l.tOff[0], a[1] + l.tOff[1]];
      const pb = l.p.box!;
      const s: Pt = [l.size[0] / (pb.w || 1), l.size[1] / (pb.h || 1)];
      const out: Placement = { ...l.p, box: { x: box[0], y: box[1], w: l.size[0], h: l.size[1] } };
      out.anchor = [a[0], a[1]];
      if (l.p.text) out.text = scaleText(l.p.text, s[1]);
      if (l.p.parts) {
        out.parts = l.p.parts.map((part) => {
          const q: typeof part = {
            ...part,
            box: { x: box[0] + (part.box.x - pb.x) * s[0], y: box[1] + (part.box.y - pb.y) * s[1], w: part.box.w * s[0], h: part.box.h * s[1] },
          };
          if (part.text) q.text = scaleText(part.text, s[1]);
          return q;
        });
      }
      const leaders = leadersOf(l.p).map((ld) => moveLeader(ld, a, l.a, box, [pb.x, pb.y], s, boxTo));
      if (!leaders.length && l.old && l.oldOpacity > 0) {
        // the previous leaders, attached to the gliding box, fade out
        const o = l.old;
        const so: Pt = [l.size[0] / (o.size[0] || 1), l.size[1] / (o.size[1] || 1)];
        const moved = o.leaders.map((ld) => moveLeader(ld, a, o.a, box, o.box, so, box));
        out.leader = moved[0]!;
        if (moved.length > 1) out.leaders = moved;
        leaderOpacity.set(id, l.oldOpacity * l.opacity);
      } else if (l.p.leader !== undefined || l.p.leaders) {
        out.leader = leaders[0] ?? null;
        if (l.p.leaders) out.leaders = leaders;
      }
      if (l.opacity < 1) opacity.set(id, l.opacity);
      (l.live ? live : fading).push(out);
    }
    const base = this.#result ?? ({ version: "1", placements: [], stats: {} } as unknown as LabelResult);
    return { result: { ...base, placements: [...fading, ...live] }, opacity, leaderOpacity };
  }

  /** Ends every transition: labels at their targets, gone ones removed. */
  finish(): void {
    for (const l of [...this.#labels.values()]) {
      if (!l.live) this.#labels.delete(l.id);
      else this.#snap(l);
    }
    this.#order = this.#order.filter((id) => this.#labels.has(id));
  }

  /** Forgets every label (the next result appears at once, as the first). */
  clear(): void {
    this.#labels.clear();
    this.#order = [];
    this.#first = true;
    this.#result = undefined;
  }

  #snap(l: Label): void {
    l.off = [...l.tOff];
    l.vel = [0, 0];
    l.size = [...l.tSize];
    l.vsize = [0, 0];
    l.opacity = 1;
    l.old = null;
    l.oldOpacity = 0;
  }

  #advance(now: number): void {
    const dt = Math.max(0, now - this.#t);
    this.#t = Math.max(this.#t, now);
    if (dt === 0 || this.#duration === 0) return;
    const fade = dt / this.#duration;
    for (const l of [...this.#labels.values()]) {
      spring(l.off, l.vel, l.tOff, dt, this.#omega);
      spring(l.size, l.vsize, l.tSize, dt, this.#omega);
      l.opacity = l.live ? Math.min(1, l.opacity + fade) : Math.max(0, l.opacity - fade);
      if (l.oldOpacity > 0) {
        l.oldOpacity = Math.max(0, l.oldOpacity - fade);
        if (l.oldOpacity === 0) l.old = null;
      }
      if (!l.live && l.opacity === 0) this.#labels.delete(l.id);
    }
  }
}
