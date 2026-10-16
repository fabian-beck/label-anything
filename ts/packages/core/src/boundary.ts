/**
 * Boundary labeling (spec §6.6): labels stacked in the canvas margins with leaders; port
 * of `rust/crates/la-core/src/boundary.rs`.
 *
 * Candidates are generated per item and side: the label is placed in the margin at the
 * height of its anchor (the joint assignment of slots happens in the solver's boundary
 * pass, which re-packs labels on each side without crossings).
 *
 * @module
 */

import { Cand, KEEP_BOX, type KeepFn, Kind, Leader, SIDE_BOUNDARY } from "./candidates.js";
import { P, Rect } from "./geom/index.js";
import type { Variant } from "./labels.js";
import { leaderStart } from "./leaders.js";
import { clampf } from "./math.js";
import { type Item, LeaderStyle, type Model } from "./model/index.js";
import type { Obstacles } from "./obstacles.js";

export function sideCode(side: string): number {
  switch (side) {
    case "left":
      return 0;
    case "right":
      return 1;
    case "top":
      return 2;
    default:
      return 3;
  }
}

/** The label area used for boundary slots. */
export function slotArea(model: Model, obs: Obstacles): Rect | null {
  return obs.labelArea ?? model.canvas;
}

/** Leader points from `start` to the port of a boundary label (orthogonal/elbow styles). */
function boundaryPoints(style: LeaderStyle, horizontal: boolean, start: P, port: P): P[] {
  if (style === LeaderStyle.Orthogonal || style === LeaderStyle.Elbow) {
    if (horizontal) {
      if (Math.abs(start.y - port.y) < 1e-9) return [start, port];
      let mid: P;
      if (style === LeaderStyle.Elbow) {
        const dy = port.y - start.y;
        const sx = port.x >= start.x ? 1 : -1;
        mid = new P(start.x + sx * Math.abs(dy), port.y);
      } else mid = new P(start.x, port.y);
      if ((port.x - mid.x) * (port.x - start.x) <= 0) return [start, port];
      return [start, mid, port];
    }
    if (Math.abs(start.x - port.x) < 1e-9) return [start, port];
    return [start, new P(port.x, start.y), port];
  }
  return [start, port];
}

/** Build the leader of a boundary label whose port is `port` on `side`. */
export function boundaryLeader(model: Model, item: Item, side: number, port: P): Leader {
  const style = model.leaders.style;
  const start = leaderStart(model, item, port);
  return new Leader(boundaryPoints(style, side <= 1, start, port), style);
}

/**
 * A boundary candidate of variant `vi` whose label center coordinate along the side is
 * `pos` (y for left/right, x for top/bottom).
 */
export function slotCandidate(
  model: Model,
  area: Rect,
  item: Item,
  vi: number,
  v: Variant,
  side: number,
  pos: number,
  rank: number,
): Cand {
  const margin = item.len.boundaryMargin;
  const hw = v.w * 0.5;
  const hh = v.h * 0.5;
  let rect: Rect;
  let port: P;
  switch (side) {
    case 0: {
      const x0 = area.x0 + margin;
      rect = new Rect(x0, pos - hh, x0 + v.w, pos + hh);
      port = new P(x0 + v.w, pos);
      break;
    }
    case 1: {
      const x1 = area.x1 - margin;
      rect = new Rect(x1 - v.w, pos - hh, x1, pos + hh);
      port = new P(x1 - v.w, pos);
      break;
    }
    case 2: {
      const y0 = area.y0 + margin;
      rect = new Rect(pos - hw, y0, pos + hw, y0 + v.h);
      port = new P(pos, y0 + v.h);
      break;
    }
    default: {
      const y1 = area.y1 - margin;
      rect = new Rect(pos - hw, y1 - v.h, pos + hw, y1);
      port = new P(pos, y1 - v.h);
    }
  }
  const c = new Cand(item.index, vi, v.level, Kind.Boundary, SIDE_BOUNDARY, rank, rect);
  c.bside = side;
  const l = boundaryLeader(model, item, side, port);
  if (l.len > 0) c.leaders.push(l);
  return c;
}

const OFFSETS = [0, -1, 1, -2, 2, -3, 3];

/**
 * Boundary candidates for the given variants. Label boxes for which `keep(vi, box)` is
 * false are skipped before their leaders are built.
 */
export function boundaryCandidates(
  model: Model,
  obs: Obstacles,
  item: Item,
  variants: readonly Variant[],
  vis: readonly number[],
  keep: KeepFn,
  out: Cand[],
): void {
  const area = obs.labelArea ?? model.canvas;
  if (area === null) return;
  const margin = item.len.boundaryMargin;
  const style = model.leaders.style;
  const it = item.index;
  for (const vi of vis) {
    const v = variants[vi]!;
    const hw = v.w * 0.5;
    const hh = v.h * 0.5;
    for (const side of model.placement.boundary.sides) {
      // a label longer than the side cannot be stacked along it
      const vertical = side === "left" || side === "right";
      if ((vertical && v.h > area.h()) || (!vertical && v.w > area.w())) continue;
      // candidate rows: at the anchor height and a few offsets (for packing)
      for (let k = 0; k < OFFSETS.length; k++) {
        const off = OFFSETS[k]!;
        let rx0: number;
        let ry0: number;
        let rx1: number;
        let ry1: number;
        let px: number;
        let py: number;
        if (vertical) {
          const y = clampf(item.anchor.y + off * v.h, area.y0 + hh, area.y1 - hh);
          ry0 = y - hh;
          ry1 = y + hh;
          py = y;
          if (side === "left") {
            const x0 = area.x0 + margin;
            rx0 = x0;
            rx1 = x0 + v.w;
            px = x0 + v.w;
          } else {
            const x1 = area.x1 - margin;
            rx0 = x1 - v.w;
            rx1 = x1;
            px = x1 - v.w;
          }
        } else {
          const x = clampf(item.anchor.x + off * v.w, area.x0 + hw, area.x1 - hw);
          rx0 = x - hw;
          rx1 = x + hw;
          px = x;
          if (side === "top") {
            const y0 = area.y0 + margin;
            ry0 = y0;
            ry1 = y0 + v.h;
            py = y0 + v.h;
          } else {
            const y1 = area.y1 - margin;
            ry0 = y1 - v.h;
            ry1 = y1;
            py = y1 - v.h;
          }
        }
        const kb = KEEP_BOX;
        kb[0] = rx0;
        kb[1] = ry0;
        kb[2] = rx1;
        kb[3] = ry1;
        if (!keep(vi)) continue;
        const rect = new Rect(rx0, ry0, rx1, ry1);
        const port = new P(px, py);
        const start = leaderStart(model, item, port);
        const pts = boundaryPoints(style, vertical, start, port);
        const c = new Cand(it, vi, v.level, Kind.Boundary, SIDE_BOUNDARY, 9 + k * 0.25, rect);
        c.bside = sideCode(side);
        const l = new Leader(pts, style);
        if (l.len > 0) c.leaders.push(l);
        out.push(c);
      }
    }
  }
}
