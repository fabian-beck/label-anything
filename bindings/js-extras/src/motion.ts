/**
 * Calm transitions between solves. A new result does not replace the drawn labels at
 * once:
 *
 * * a shown label that the solver moved stays where it is until the new place has held
 *   for `moveDelay`, so a label moves at most about once per `moveDelay`, and not at all
 *   when the solver soon puts it back; it moves at once when a label shown at its new
 *   place needs the room or when it covers the anchor of another item (a dragged node);
 * * a label that moves a little glides to its new place; one that jumps further (to the
 *   other side of its point, onto a leader) fades out where it is and fades in at the new
 *   place instead of sweeping across the drawing;
 * * a label that appears waits `appearDelay` before it fades in, and shows only if it is
 *   still placed then, so labels that come and go within a few solves never show;
 * * a label that disappears stays where it was for `holdTime` before it fades out, so a
 *   label that is back within that time never blinks;
 * * labels do not come to rest on top of each other. Between solves labels follow their
 *   anchors and linger, so two of them can meet; the less important one (gone from the
 *   results, else lower priority, else shown later) fades out, after 150 ms when both are
 *   in the latest result (a new solve usually separates them before), until it has been
 *   clear for `appearDelay`; a new label waits until the labels that make way for it are
 *   gone.
 *
 * ```js
 * const motion = new LabelMotion();
 * motion.target(result);                       // after every solve
 * const f = motion.frame(anchors);             // on every animation frame while motion.moving
 * renderLabels(group, f.result, { font, opacity: f.opacity, leaderOpacity: f.leaderOpacity });
 * ```
 *
 * Positions are kept relative to each label's anchor (`placement.anchor`, which results
 * report), so the labels move with their points between solves; labels in a column (fan
 * and boundary labels) stay where the column is, their leaders follow the points. Moves
 * follow a critically damped spring (no overshoot; a move that is retargeted mid-way bends
 * smoothly into the new one); fades are linear. The engine's results stay as they are
 * (every one free of overlaps); only what is drawn, and when, changes.
 */
import type { LabelResult } from "@label-anything/core";
import type { Anchors } from "./stable.js";

type Placement = LabelResult["placements"][number];
type Leader = NonNullable<Placement["leader"]>;
type TextInfo = NonNullable<Placement["text"]>;
type Pt = [number, number];
type Box = [number, number, number, number];

export interface MotionOptions {
  /**
   * Transition time in ms (default 300): moves settle and fades complete within it. 0 draws
   * every result as it is (no delays, no collision fading either).
   */
  duration?: number;
  /** Fade in the labels of the first result too (default `false`: they appear at once). */
  fadeInFirst?: boolean;
  /**
   * A label that appears waits this long (ms) and shows only if it is still placed then
   * (default 250). The same delay applies before a label hidden by a collision returns.
   */
  appearDelay?: number;
  /**
   * A label that disappears from the results stays this long (ms) where it was, following
   * its anchor, before it fades out (default 500), unless a shown label needs its place or
   * it covers the anchor of another item.
   */
  holdTime?: number;
  /**
   * A shown label that the solver moved stays where it is until the new place has held
   * this long (ms; default 500), unless a label at its new place needs the room or it
   * covers the anchor of another item.
   */
  moveDelay?: number;
  /** Of two labels that meet, the less important one fades out (default `true`). */
  collisions?: boolean;
  /**
   * A move longer than this many label heights fades out and in instead of gliding
   * (default 2; `Infinity`: always glide).
   */
  jump?: number;
}

/** The labels as they are drawn at one moment. */
export interface MotionFrame {
  /**
   * The visible placements at their current boxes (text scaled with the box, leaders
   * attached), including the labels that are fading out (as placed). Labels waiting to
   * appear or hidden by a collision are left out.
   */
  result: LabelResult;
  /** Opacity per label id, for labels fading in or out (absent: 1). */
  opacity: Map<string, number>;
  /** Opacity of the leaders per label id, for leaders fading out (absent: the label's). */
  leaderOpacity: Map<string, number>;
}

/**
 * A place to move to: the placement, the anchor it was solved for, the box relative to it
 * (to the canvas for labels in a column: `fixed`).
 */
interface Target {
  p: Placement;
  a: Pt;
  fixed: boolean;
  tOff: Pt;
  tSize: Pt;
}

interface Label {
  id: string;
  /** The placement drawn: the target, or the last one while the label fades out. */
  p: Placement;
  /** The anchor `p` was placed for. */
  a: Pt;
  /** Placed in the latest result. */
  live: boolean;
  /** Priority rank of the latest placement (0 = most important). */
  rank: number;
  /** In every result since (ms). */
  born: number;
  /** Left the results at (ms). */
  gone: number;
  /** Visible since (ms); `Infinity`: not shown yet. */
  shown: number;
  /** Hidden: a more important shown label overlaps it. */
  blocked: boolean;
  /** Overlapped by a more important label since (ms; `Infinity`: not). */
  hitSince: number;
  /** Not shown yet: labels that make way for it are still fading out. */
  waits: boolean;
  /** Clear again since (ms), after a collision. */
  clear: number;
  /** A lingering label (gone from the results) that a shown label needs room from: it fades for good. */
  released: boolean;
  /** A place the solver moved it to, not taken yet (`moveDelay`), and since when (ms). */
  pend: Target | null;
  pendSince: number;
  /** A jump: the place it fades in at once it has faded out here, and since when (ms). */
  next: Target | null;
  nextSince: number;
  /** `off` and `tOff` are relative to the canvas (a label in a column), not to the anchor. */
  fixed: boolean;
  /** Box origin relative to the anchor (or the canvas), its velocity (px/ms) and its target. */
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

function targetOf(p: Placement, anchors: Anchors | undefined): Target {
  const a = anchorOf(p, anchors);
  const b = p.box!;
  // a column stays where it is while the points move; the leaders follow them
  const fixed = p.model === "fan" || p.model === "boundary";
  const o = fixed ? [0, 0] : a;
  return { p, a, fixed, tOff: [b.x - o[0], b.y - o[1]], tSize: [b.w, b.h] };
}

/** A label's offset `o` in the frame of target `t` (relative to its anchor, or to the canvas). */
function inFrame(l: { fixed: boolean }, o: Pt, t: Target): Pt {
  if (l.fixed === t.fixed) return o;
  return t.fixed ? [o[0] + t.a[0], o[1] + t.a[1]] : [o[0] - t.a[0], o[1] - t.a[1]];
}

const rankOf = (p: Placement): number => {
  const r = (p.priority as { rank?: number } | undefined)?.rank;
  return typeof r === "number" ? r : Number.POSITIVE_INFINITY;
};

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
  if (t.x_offsets) out.x_offsets = t.x_offsets.map((x) => x * s);
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

/** How long (ms) two labels of the latest result may overlap before the less important one gives way. */
const MEET = 150;

/** Boxes accepted so far, bucketed for overlap queries. */
class BoxGrid {
  #cells = new Map<number, Box[]>();
  static readonly CELL = 64;

  #keys(b: Box, f: (k: number) => void): void {
    const c = BoxGrid.CELL;
    const x0 = Math.floor(b[0] / c);
    const y0 = Math.floor(b[1] / c);
    const x1 = Math.floor((b[0] + b[2]) / c);
    const y1 = Math.floor((b[1] + b[3]) / c);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) f(x * 73856093 + y * 19349663);
  }

  add(b: Box): void {
    this.#keys(b, (k) => {
      const list = this.#cells.get(k);
      if (list) list.push(b);
      else this.#cells.set(k, [b]);
    });
  }

  /** Overlaps an accepted box by more than `tol` px in both directions. */
  hits(b: Box, tol: number): boolean {
    let hit = false;
    this.#keys(b, (k) => {
      if (hit) return;
      for (const o of this.#cells.get(k) ?? []) {
        if (b[0] < o[0] + o[2] - tol && o[0] < b[0] + b[2] - tol && b[1] < o[1] + o[3] - tol && o[1] < b[1] + b[3] - tol) {
          hit = true;
          return;
        }
      }
    });
    return hit;
  }
}

/** Anchor points, bucketed: does a box cover one, other than the label's own? */
class PointGrid {
  #cells = new Map<number, [string, number, number][]>();
  static readonly CELL = 64;

  add(id: string, x: number, y: number): void {
    const k = Math.floor(x / PointGrid.CELL) * 73856093 + Math.floor(y / PointGrid.CELL) * 19349663;
    const list = this.#cells.get(k);
    if (list) list.push([id, x, y]);
    else this.#cells.set(k, [[id, x, y]]);
  }

  /** A point other than `own` lies inside the box, more than 1 px from its edges. */
  covers(b: Box, own: string): boolean {
    const c = PointGrid.CELL;
    for (let x = Math.floor(b[0] / c); x <= Math.floor((b[0] + b[2]) / c); x++) {
      for (let y = Math.floor(b[1] / c); y <= Math.floor((b[1] + b[3]) / c); y++) {
        for (const [id, px, py] of this.#cells.get(x * 73856093 + y * 19349663) ?? []) {
          if (id !== own && px > b[0] + 1 && px < b[0] + b[2] - 1 && py > b[1] + 1 && py < b[1] + b[3] - 1) return true;
        }
      }
    }
    return false;
  }
}

export class LabelMotion {
  #duration: number;
  #omega: number;
  #fadeInFirst: boolean;
  #delay: number;
  #hold: number;
  #moveDelay: number;
  #collisions: boolean;
  #jump: number;
  #labels = new Map<string, Label>();
  #first = true;
  #t = 0;
  #result: LabelResult | undefined;
  /** Hidden labels may be clear after a new result: the next frame checks. */
  #check = false;

  constructor(options: MotionOptions = {}) {
    this.#duration = Math.max(0, options.duration ?? 300);
    // a critically damped spring is within 2 % of its target after ω·t = 6: (1 + 6)·e⁻⁶
    this.#omega = this.#duration > 0 ? 6 / this.#duration : 0;
    this.#fadeInFirst = options.fadeInFirst ?? false;
    const on = this.#duration > 0;
    this.#delay = on ? Math.max(0, options.appearDelay ?? 250) : 0;
    this.#hold = on ? Math.max(0, options.holdTime ?? 500) : 0;
    this.#moveDelay = on ? Math.max(0, options.moveDelay ?? 500) : 0;
    this.#collisions = on && (options.collisions ?? true);
    this.#jump = options.jump ?? 2;
  }

  /** The latest result passed to `target`. */
  get result(): LabelResult | undefined {
    return this.#result;
  }

  /** Whether labels are still moving, fading or waiting to (draw another frame). */
  get moving(): boolean {
    if (this.#check) return true;
    for (const l of this.#labels.values()) {
      if (!l.live || l.pend || l.next || l.oldOpacity > 0) return true;
      if (!settled(l.off, l.vel, l.tOff) || !settled(l.size, l.vsize, l.tSize)) return true;
      // fading, or waiting to appear
      if (l.opacity !== (l.blocked ? 0 : 1)) return true;
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
      const t = targetOf(p, anchors);
      const l = this.#labels.get(p.id);
      if (!l) {
        this.#labels.set(p.id, {
          id: p.id, p, a: t.a, live: true, rank: rankOf(p), born: instant ? -Infinity : now, gone: Infinity,
          shown: instant ? now : Infinity, blocked: false, hitSince: Infinity, waits: false, clear: -Infinity,
          released: false, pend: null, pendSince: 0, next: null, nextSince: 0,
          fixed: t.fixed, off: [...t.tOff], vel: [0, 0], tOff: t.tOff, size: [...t.tSize], vsize: [0, 0], tSize: t.tSize,
          opacity: instant ? 1 : 0, old: null, oldOpacity: 0,
        });
        continue;
      }
      l.rank = rankOf(p);
      if (!l.live) {
        // back while it lingers or fades: it carries on from where it is
        l.live = true;
        l.released = false;
        l.gone = Infinity;
      }
      if (instant) {
        l.pend = l.next = null;
        this.#glide(l, t);
        this.#snap(l);
        continue;
      }
      this.#offer(l, t, now);
    }
    for (const l of this.#labels.values()) {
      if (seen.has(l.id) || !l.live) continue;
      l.live = false;
      l.gone = now;
      l.pend = null;
      // a label that never showed simply does not appear
      if (instant || (l.shown === Infinity && l.opacity <= 0)) this.#labels.delete(l.id);
    }
    this.#check = this.#collisions && [...this.#labels.values()].some((l) => l.blocked);
  }

  /** A place from the solver: taken at once, or after `moveDelay` while the label is shown. */
  #offer(l: Label, t: Target, now: number): void {
    const same =
      l.fixed === t.fixed &&
      Math.hypot(t.tOff[0] - l.tOff[0], t.tOff[1] - l.tOff[1]) <= 0.5 &&
      Math.abs(t.tSize[0] - l.tSize[0]) <= 0.5 &&
      Math.abs(t.tSize[1] - l.tSize[1]) <= 0.5;
    if (same || l.next || l.opacity <= 0 || this.#moveDelay === 0) {
      l.pend = null;
      this.#retarget(l, t, now);
      return;
    }
    if (!l.pend) l.pendSince = now;
    l.pend = t;
  }

  /** Takes the place the solver moved the label to, at `now` (ms). */
  #adopt(l: Label, now: number): void {
    const t = l.pend!;
    l.pend = null;
    this.#retarget(l, t, now);
  }

  /** A new place for a label at `now` (ms): glide there, or fade out and in for a jump. */
  #retarget(l: Label, t: Target, now: number): void {
    const far = this.#jump * Math.max(t.tSize[1], 1);
    const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (l.next) {
      // a jump under way: back near the place it fades at cancels it
      if (dist(t.tOff, inFrame(l, l.tOff, t)) <= far) {
        l.next = null;
        this.#glide(l, t);
      } else {
        l.next = t;
      }
      return;
    }
    if (l.opacity > 0 && dist(t.tOff, inFrame(l, l.off, t)) > far) {
      l.next = t;
      l.nextSince = now;
      return;
    }
    this.#glide(l, t);
    if (l.opacity <= 0) this.#snap(l);
  }

  #glide(l: Label, t: Target): void {
    const had = leadersOf(l.p);
    if (had.length && !leadersOf(t.p).length && l.opacity > 0) {
      l.old = { leaders: had, a: l.a, box: [l.p.box!.x, l.p.box!.y], size: [l.p.box!.w, l.p.box!.h] };
      l.oldOpacity = 1;
    } else if (leadersOf(t.p).length) {
      l.old = null;
      l.oldOpacity = 0;
    }
    l.p = t.p;
    l.a = t.a;
    // into the frame of the new place (to or from a column)
    l.off = inFrame(l, l.off, t);
    l.fixed = t.fixed;
    l.tOff = t.tOff;
    l.tSize = t.tSize;
  }

  /** The opacity a label is heading for at `now`, and since when (ms). */
  #want(l: Label, now: number): [number, number] {
    if (l.next) return [0, l.nextSince];
    if ((l.live && (l.blocked || l.waits)) || (!l.live && l.released)) return [0, -Infinity];
    if (l.live) {
      // it waits after it appeared, and after a collision
      const at = Math.max(l.shown === Infinity ? l.born + this.#delay : -Infinity, l.clear + this.#delay);
      return now < at ? [0, -Infinity] : [1, at];
    }
    const at = l.gone + this.#hold;
    return now < at ? [l.opacity > 0 ? 1 : 0, -Infinity] : [0, at];
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
    if (this.#collisions) {
      const points = new PointGrid();
      if (anchors) for (const [id, a] of anchors) points.add(id, a[0], a[1]);
      else for (const l of this.#labels.values()) points.add(l.id, l.a[0], l.a[1]);
      this.#collide((l) => {
        const cur = anchors?.get(l.id);
        return cur ? [cur[0], cur[1]] : l.a;
      }, points, now);
      this.#check = false;
    }
    for (const l of this.#labels.values()) {
      if (l.opacity <= 0) continue;
      const cur = anchors?.get(l.id);
      const a: Pt = cur ? [cur[0], cur[1]] : l.a;
      const o: Pt = l.fixed ? [0, 0] : a;
      const box: Pt = [o[0] + l.off[0], o[1] + l.off[1]];
      const boxTo: Pt = [o[0] + l.tOff[0], o[1] + l.tOff[1]];
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
        leaderOpacity.set(l.id, l.oldOpacity * l.opacity);
      } else if (l.p.leader !== undefined || l.p.leaders) {
        out.leader = leaders[0] ?? null;
        if (l.p.leaders) out.leaders = leaders;
      }
      if (l.opacity < 1) opacity.set(l.id, l.opacity);
      (l.live && !l.next ? live : fading).push(out);
    }
    const base = this.#result ?? ({ version: "1", placements: [], stats: {} } as unknown as LabelResult);
    return { result: { ...base, placements: [...fading, ...live] }, opacity, leaderOpacity };
  }

  /**
   * Shown labels do not overlap: labels that are (or are about to be) visible claim their
   * boxes in order — labels at the place of the latest result first, then labels still at
   * an older place (`moveDelay`), then lingering and jumping labels; within each, lower
   * priority rank first, then the one shown longer — and a label whose box overlaps a
   * claimed one makes way: a label at an older place moves to its new one at once, a
   * lingering one fades, and a label of the latest result is hidden once the overlap has
   * lasted 150 ms (until the next solve, which usually separates them). A label at an
   * older place or a lingering one that covers the anchor of another item makes way too.
   * A label that has not started to fade in waits until the labels that make way for it
   * have faded out.
   */
  #collide(at: (l: Label) => Pt, points: PointGrid, now: number): void {
    const contenders: Label[] = [];
    for (const l of this.#labels.values()) {
      if (l.opacity > 0 || (l.live && !l.next && (l.shown !== Infinity || now - l.born >= this.#delay))) contenders.push(l);
    }
    const group = (l: Label) => (!l.live || l.next ? 2 : l.pend ? 1 : 0);
    contenders.sort((a, b) => group(a) - group(b) || a.rank - b.rank || a.shown - b.shown || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // labels of the latest result claim the place they glide to, the others the one they are at
    const claim = (l: Label, a: Pt): Box => {
      const [o, s] = l.live && !l.next ? [l.tOff, l.tSize] : [l.off, l.size];
      const base = l.fixed ? [0, 0] : a;
      return [base[0]! + o[0], base[1]! + o[1], s[0], s[1]];
    };
    const grid = new BoxGrid();
    const leaving = new BoxGrid();
    const claimed: [Label, Box][] = [];
    for (const l of contenders) {
      const a = at(l);
      let box = claim(l, a);
      if (l.pend && (grid.hits(box, 1) || points.covers(box, l.id))) {
        // its old place is needed, or covers another item: it moves to the new one now
        this.#adopt(l, now);
        if (l.next) {
          if (l.opacity > 0) leaving.add(box);
          continue;
        }
        box = claim(l, a);
      } else if (!l.live && points.covers(box, l.id)) {
        // a lingering label that covers another item goes
        l.released = true;
        if (l.opacity > 0) leaving.add(box);
        continue;
      }
      const hit = grid.hits(box, 1);
      if (!hit || (l.live && !l.next && !l.blocked && now - Math.min(l.hitSince, now) < MEET)) {
        // free, or two labels of the latest result that met only just now: a new solve
        // usually separates them before they have to give way
        if (hit) l.hitSince = Math.min(l.hitSince, now);
        else l.hitSince = Infinity;
        grid.add(box);
        claimed.push([l, box]);
        if (l.blocked) {
          l.blocked = false;
          l.clear = now;
        }
        continue;
      }
      if (l.live && !l.next) l.blocked = true;
      else if (!l.live) l.released = true;
      if (l.opacity > 0) leaving.add(box);
    }
    for (const [l, box] of claimed) l.waits = l.opacity === 0 && leaving.hits(box, 1);
  }

  /** Ends every transition: labels at their targets, gone ones removed. */
  finish(): void {
    for (const l of [...this.#labels.values()]) {
      if (!l.live) {
        this.#labels.delete(l.id);
        continue;
      }
      const t = l.pend ?? l.next;
      l.pend = l.next = null;
      if (t) this.#glide(l, t);
      this.#snap(l);
      l.opacity = l.blocked ? 0 : 1;
      l.waits = false;
      l.clear = -Infinity;
      if (l.shown === Infinity) l.shown = this.#t;
    }
  }

  /** Forgets every label (the next result appears at once, as the first). */
  clear(): void {
    this.#labels.clear();
    this.#first = true;
    this.#result = undefined;
  }

  #snap(l: Label): void {
    l.off = [...l.tOff];
    l.vel = [0, 0];
    l.size = [...l.tSize];
    l.vsize = [0, 0];
    l.old = null;
    l.oldOpacity = 0;
  }

  #advance(now: number): void {
    const dt = Math.max(0, now - this.#t);
    this.#t = Math.max(this.#t, now);
    if (dt === 0 || this.#duration === 0) return;
    const fade = dt / this.#duration;
    for (const l of [...this.#labels.values()]) {
      if (l.pend && now - l.pendSince >= this.#moveDelay) this.#adopt(l, l.pendSince + this.#moveDelay);
      spring(l.off, l.vel, l.tOff, dt, this.#omega);
      spring(l.size, l.vsize, l.tSize, dt, this.#omega);
      const [want, at] = this.#want(l, now);
      // the part of the step since it started heading there
      const f = Math.min(dt, now - at) / this.#duration;
      if (l.opacity < want) {
        l.opacity = Math.min(want, l.opacity + f);
      } else if (l.opacity > want) {
        // jumps and collisions clear the way twice as fast
        const quick = l.next !== null || l.blocked || l.released;
        l.opacity = Math.max(want, l.opacity - (quick ? 2 * f : f));
      }
      if (l.opacity > 0 && l.shown === Infinity) l.shown = now;
      if (l.next && l.opacity <= 0) {
        // faded out at the old place: in at the new one
        this.#glide(l, l.next);
        l.next = null;
        this.#snap(l);
      }
      if (l.oldOpacity > 0) {
        l.oldOpacity = Math.max(0, l.oldOpacity - fade);
        if (l.oldOpacity === 0) l.old = null;
      }
      if (!l.live && l.opacity <= 0 && (l.released || now - l.gone >= this.#hold)) this.#labels.delete(l.id);
    }
  }
}
