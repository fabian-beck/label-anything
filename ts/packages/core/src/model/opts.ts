/**
 * Typed, resolved options (everything except per-item lengths); port of
 * `rust/crates/la-core/src/model/opts.rs`.
 *
 * Unit-only enums are numeric constants (`Pos.Top`, `LeaderStyle.Straight`, …) with
 * helper functions for Rust's methods; enums with data are discriminated unions.
 *
 * @module
 */

import { cmpF64, maxf } from "../math.js";
import { P } from "../geom/index.js";
import type { Opts } from "../options.js";
import { asU64, fmtF64, parseRustF64 } from "../json.js";

/** The 8 fixed label positions (Rust `enum Pos`, in declaration order). */
export const Pos = {
  Top: 0,
  Right: 1,
  Bottom: 2,
  Left: 3,
  TopRight: 4,
  BottomRight: 5,
  TopLeft: 6,
  BottomLeft: 7,
} as const;
export type Pos = (typeof Pos)[keyof typeof Pos];

/** `Pos::ALL`. */
export const POS_ALL: readonly Pos[] = [0, 1, 2, 3, 4, 5, 6, 7];

const POS_NAMES = ["top", "right", "bottom", "left", "top-right", "bottom-right", "top-left", "bottom-left"] as const;
/** Angle in degrees, counter-clockwise on screen from +x, by `Pos`. */
const POS_ANGLES = [90, 0, 270, 180, 45, 315, 135, 225] as const;
/** By angular index (Right, TopRight, Top, …). */
const POS_BY_ANGLE: readonly Pos[] = [
  Pos.Right,
  Pos.TopRight,
  Pos.Top,
  Pos.TopLeft,
  Pos.Left,
  Pos.BottomLeft,
  Pos.Bottom,
  Pos.BottomRight,
];
const POS_DIRS: readonly P[] = [
  new P(0, -1),
  new P(1, 0),
  new P(0, 1),
  new P(-1, 0),
  new P(1, -1),
  new P(1, 1),
  new P(-1, -1),
  new P(-1, 1),
];

/** `Pos::name`. */
export function posName(p: Pos): string {
  return POS_NAMES[p];
}

/** `Pos::parse`. */
export function posParse(s: string): Pos | null {
  const i = (POS_NAMES as readonly string[]).indexOf(s);
  return i < 0 ? null : (i as Pos);
}

/** `Pos::angle`: degrees, counter-clockwise on screen from +x (right = 0, top = 90). */
export function posAngle(p: Pos): number {
  return POS_ANGLES[p];
}

/** `Pos::dir`: screen direction (y down), not normalized: components in {-1, 0, 1}. */
export function posDir(p: Pos): P {
  return POS_DIRS[p]!;
}

/** `Pos::angular_index`: index in angular order starting at `Right`, counter-clockwise. */
export function posAngularIndex(p: Pos): number {
  return Math.trunc(POS_ANGLES[p] / 45);
}

/** `Pos::from_angular_index`. */
export function posFromAngularIndex(i: number): Pos {
  return POS_BY_ANGLE[i % 8]!;
}

/** Perceptual order (Bobák et al. 2026, PerceptPPO-like). */
export const PERCEPTUAL: readonly Pos[] = [
  Pos.Top,
  Pos.Right,
  Pos.Bottom,
  Pos.Left,
  Pos.TopRight,
  Pos.BottomRight,
  Pos.TopLeft,
  Pos.BottomLeft,
];

/** Cartographic (Imhof) order. */
export const CARTOGRAPHIC: readonly Pos[] = [
  Pos.TopRight,
  Pos.TopLeft,
  Pos.BottomRight,
  Pos.BottomLeft,
  Pos.Right,
  Pos.Left,
  Pos.Top,
  Pos.Bottom,
];

/** Position order: ranks of the enabled fixed positions. */
export function positionOrder(v: unknown): Pos[] {
  if (v === "cartographic") return CARTOGRAPHIC.slice();
  if (Array.isArray(v)) {
    const out: Pos[] = [];
    for (const s of v) {
      if (typeof s !== "string") continue;
      const p = posParse(s);
      if (p !== null && !out.includes(p)) out.push(p);
    }
    return out.length === 0 ? PERCEPTUAL.slice() : out;
  }
  return PERCEPTUAL.slice();
}

/** Candidate models as a bit set (Rust `struct Models(u8)`). */
export type Models = number;

export const Models = {
  ADJACENT: 1,
  SLIDER: 2,
  INTERNAL: 4,
  DISTANT: 8,
  BOUNDARY: 16,
  fromNames(names: readonly string[]): Models {
    let m = 0;
    for (const n of names) {
      switch (n) {
        case "adjacent":
          m |= 1;
          break;
        case "slider":
          m |= 2;
          break;
        case "internal":
          m |= 4;
          break;
        case "distant":
          m |= 8;
          break;
        case "boundary":
          m |= 16;
          break;
      }
    }
    return m;
  },
  has(m: Models, bit: number): boolean {
    return (m & bit) !== 0;
  },
  with(m: Models, bit: number): Models {
    return m | bit;
  },
} as const;

export const InternalPolicy = { Auto: 0, Prefer: 1, Allow: 2, Never: 3 } as const;
export type InternalPolicy = (typeof InternalPolicy)[keyof typeof InternalPolicy];

/** `InternalPolicy::parse`. */
export function internalPolicyParse(s: string): InternalPolicy {
  switch (s) {
    case "prefer":
      return InternalPolicy.Prefer;
    case "allow":
      return InternalPolicy.Allow;
    case "never":
      return InternalPolicy.Never;
    default:
      return InternalPolicy.Auto;
  }
}

export const LeaderStyle = { Straight: 0, Angles: 1, Orthogonal: 2, Elbow: 3, Curved: 4 } as const;
export type LeaderStyle = (typeof LeaderStyle)[keyof typeof LeaderStyle];

const STYLE_NAMES = ["straight", "angles", "orthogonal", "elbow", "curved"] as const;

/** `LeaderStyle::parse`. */
export function leaderStyleParse(s: string): LeaderStyle {
  switch (s) {
    case "angles":
      return LeaderStyle.Angles;
    case "orthogonal":
      return LeaderStyle.Orthogonal;
    case "elbow":
      return LeaderStyle.Elbow;
    case "curved":
      return LeaderStyle.Curved;
    default:
      return LeaderStyle.Straight;
  }
}

/** `LeaderStyle::name`. */
export function leaderStyleName(s: LeaderStyle): string {
  return STYLE_NAMES[s];
}

export const Port = { Nearest: 0, SideCenter: 1, Baseline: 2 } as const;
export type Port = (typeof Port)[keyof typeof Port];

export const Attach = { Auto: 0, Boundary: 1, Center: 2, Tip: 3 } as const;
export type Attach = (typeof Attach)[keyof typeof Attach];

/** Leader options. */
export class LeaderOpts {
  constructor(
    public style: LeaderStyle,
    public angles: number[],
    public port: Port,
    public attach: Attach,
    public minAngleBetween: number,
    public width: number,
  ) {}

  static from(o: Opts): LeaderOpts {
    // a.rem_euclid(360.0), sorted, deduplicated
    const angles = o.numbers("leaders.angles").map((a) => remEuclid(a, 360));
    angles.sort(cmpF64);
    const dedup: number[] = [];
    for (const a of angles) if (dedup.length === 0 || dedup[dedup.length - 1] !== a) dedup.push(a);
    let port: Port;
    switch (o.string("leaders.port")) {
      case "side-center":
        port = Port.SideCenter;
        break;
      case "baseline":
        port = Port.Baseline;
        break;
      default:
        port = Port.Nearest;
    }
    let attach: Attach;
    switch (o.string("leaders.attach")) {
      case "boundary":
        attach = Attach.Boundary;
        break;
      case "center":
        attach = Attach.Center;
        break;
      case "tip":
        attach = Attach.Tip;
        break;
      default:
        attach = Attach.Auto;
    }
    return new LeaderOpts(
      leaderStyleParse(o.string("leaders.style")),
      dedup,
      port,
      attach,
      o.f64("leaders.min_angle_between"),
      o.f64("leaders.width"),
    );
  }
}

/** Rust's `f64::rem_euclid` (`%` is fmod, exact). */
export function remEuclid(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? r + Math.abs(b) : r;
}

export const Omission = { Strict: 0, Prefix: 1, Weighted: 2 } as const;
export type Omission = (typeof Omission)[keyof typeof Omission];

/** Tie rule; `random` carries its PCG32 seed (a 64-bit integer as a bigint). */
export type Ties =
  | { kind: "input_order" }
  | { kind: "id" }
  | { kind: "anchor_x" }
  | { kind: "random"; seed: bigint };

export const Strategy = { Auto: 0, Greedy: 1, Local: 2, Exact: 3 } as const;
export type Strategy = (typeof Strategy)[keyof typeof Strategy];

/** One degradation-ladder step. */
export type Step =
  | { kind: "alternatives" }
  | { kind: "wrap" }
  | { kind: "truncate" }
  | { kind: "distant" }
  | { kind: "boundary" }
  | { kind: "evict_lower" }
  | { kind: "shrink"; f: number }
  | { kind: "soft_overlap" }
  | { kind: "omit" };

const SIMPLE_STEPS = ["alternatives", "wrap", "truncate", "distant", "boundary", "evict_lower", "soft_overlap", "omit"];

/** `Step::parse`. */
export function stepParse(s: string): Step | null {
  if (SIMPLE_STEPS.includes(s)) return { kind: s } as Step;
  if (!s.startsWith("shrink:")) return null;
  const f = parseRustF64(s.slice(7));
  return f === null ? null : { kind: "shrink", f };
}

/** `Step::name`. */
export function stepName(s: Step): string {
  return s.kind === "shrink" ? `shrink:${fmtF64(s.f)}` : s.kind;
}

/** Rust's derived `PartialEq` of `Step`. */
export function stepEq(a: Step, b: Step): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== "shrink" || a.f === (b as { f: number }).f;
}

/** Cost weights. */
export class Weights {
  position = 0;
  distance = 0;
  leader = 0;
  leaderLength = 0;
  bends = 0;
  shape = 0;
  edge = 0;
  ambiguity = 0;
  lookahead = 0;
  starve = 0;
  contrast = 0;
  straddle = 0;
  foreign = 0;
  leaderBorders = 0;
  stability = 0;

  static from(o: Opts): Weights {
    const w = new Weights();
    w.position = o.f64("weights.position");
    w.distance = o.f64("weights.distance");
    w.leader = o.f64("weights.leader");
    w.leaderLength = o.f64("weights.leader_length");
    w.bends = o.f64("weights.bends");
    w.shape = o.f64("weights.shape");
    w.edge = o.f64("weights.edge");
    w.ambiguity = o.f64("weights.ambiguity");
    w.lookahead = o.f64("weights.lookahead");
    w.starve = o.f64("weights.starve");
    w.contrast = o.f64("weights.contrast");
    w.straddle = o.f64("weights.straddle");
    w.foreign = o.f64("weights.foreign");
    w.leaderBorders = o.f64("weights.leader_borders");
    w.stability = o.f64("weights.stability");
    return w;
  }
}

/** Solver options. */
export class SolverOpts {
  constructor(
    public strategy: Strategy,
    public timeBudgetMs: number,
    public maxIterations: number,
    public seed: number,
  ) {}

  static from(o: Opts): SolverOpts {
    let strategy: Strategy;
    switch (o.string("solver.strategy")) {
      case "greedy":
        strategy = Strategy.Greedy;
        break;
      case "local":
        strategy = Strategy.Local;
        break;
      case "exact":
        strategy = Strategy.Exact;
        break;
      default:
        strategy = Strategy.Auto;
    }
    return new SolverOpts(
      strategy,
      o.f64("solver.time_budget_ms"),
      asU64(o.get("solver.max_iterations")) ?? 200000,
      asU64(o.get("solver.seed")) ?? 0,
    );
  }
}

/** Output options. */
export class OutputOpts {
  constructor(
    public debugSvg: boolean,
    public costBreakdown: boolean,
    public candidates: boolean,
    public itemShape: boolean,
  ) {}

  static from(o: Opts): OutputOpts {
    return new OutputOpts(
      o.bool("output.debug_svg"),
      o.bool("output.cost_breakdown"),
      o.bool("output.candidates"),
      o.bool("output.item_shape"),
    );
  }
}

/** Degradation options. */
export class DegradeOpts {
  constructor(
    public minScale: number,
    public wrapMaxLines: number,
    public softOverlapWeight: number,
  ) {}

  static from(o: Opts): DegradeOpts {
    const wml = asU64(o.get("degrade_options.wrap_max_lines")) ?? 3;
    return new DegradeOpts(
      o.f64("degrade_options.min_scale"),
      wml > 1 ? wml : 1,
      o.f64("degrade_options.soft_overlap_weight"),
    );
  }
}

/** Boundary model options. */
export interface BoundaryOpts {
  sides: string[];
  spread: boolean;
}

/**
 * When crowds get fan labels (spec §6.8): `Auto` crowds of items left without a label, when
 * the column places more labels; `Always` every crowd of two or more items, when the
 * column places at least as many.
 */
export const FanMode = { Auto: 0, Always: 1, Off: 2 } as const;
export type FanMode = (typeof FanMode)[keyof typeof FanMode];

function fanMode(s: string): FanMode {
  if (s === "always") return FanMode.Always;
  if (s === "off") return FanMode.Off;
  return FanMode.Auto;
}

/** Placement options that do not depend on the label's font size. */
export class PlacementOpts {
  constructor(
    public sliderPerGap: number,
    public kDistant: number,
    public distantRings: number,
    public distantDirections: number,
    public freeSpaceSeeds: boolean,
    public internalCircleRatio: number,
    public pruneFactor: number,
    public boundary: BoundaryOpts,
    public fan: FanMode,
    /** `placement.stubs: auto` (spec §6.9). */
    public stubs: boolean,
    /** `placement.own_nearest` (spec §4.4). */
    public ownNearest: boolean,
    /**
     * `placement.max_foreign`: the largest share of the box of an area item's label (not an
     * internal one) or of a label on a leader that may lie in other items' regions (spec §4.8).
     */
    public maxForeign: number,
  ) {}

  static from(o: Opts): PlacementOpts {
    const rings = asU64(o.get("placement.distant_rings")) ?? 4;
    const dirs = asU64(o.get("placement.distant_directions")) ?? 16;
    const prune = o.f64("placement.prune_factor");
    return new PlacementOpts(
      asU64(o.get("placement.slider_per_quadrant")) ?? 4,
      asU64(o.get("placement.k_distant")) ?? 24,
      rings > 1 ? rings : 1,
      dirs > 4 ? dirs : 4,
      o.bool("placement.free_space_seeds"),
      o.f64("placement.internal_circle_ratio"),
      maxf(prune, 1),
      { sides: o.strings("placement.boundary.sides"), spread: o.string("placement.boundary.align") === "spread" },
      fanMode(o.string("placement.fan")),
      o.string("placement.stubs") === "auto",
      o.bool("placement.own_nearest"),
      o.f64("placement.max_foreign"),
    );
  }
}
