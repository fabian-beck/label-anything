/**
 * The logo's label: a box with rounded corners whose leader grows out of it. Where the
 * leader leaves the box, the box's edges flow into the leader's sides in concave fillets,
 * and the corners next to it give up their rounding — as the static logo draws it
 * (docs/_overrides/home.html, the files tools/logo/make_logo.py writes). The home page's
 * header (hero.ts) draws its name this way wherever the engine puts it.
 */

export type Pt = [number, number];
export type Box = { x: number; y: number; w: number; h: number };

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const pt = (p: Pt) => `${fmt(p[0])} ${fmt(p[1])}`;
const at = (p: Pt, d: Pt, t: number): Pt => [p[0] + d[0] * t, p[1] + d[1] * t];

/** The box, clockwise from its top-left corner, with a radius per corner (tl, tr, br, bl). */
function boxPath(b: Box, radii: number[]): string {
  const [tl, tr, br, bl] = radii as [number, number, number, number];
  const [x0, y0, x1, y1] = [b.x, b.y, b.x + b.w, b.y + b.h];
  const arc = (r: number, x: number, y: number) => (r > 0 ? `A${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(x)} ${fmt(y)}` : "");
  return (
    `M${fmt(x0 + tl)} ${fmt(y0)}H${fmt(x1 - tr)}${arc(tr, x1, y0 + tr)}V${fmt(y1 - br)}${arc(br, x1 - br, y1)}` +
    `H${fmt(x0 + bl)}${arc(bl, x0, y1 - bl)}V${fmt(y0 + tl)}${arc(tl, x0 + tl, y0)}Z`
  );
}

/**
 * One side of the leader where it leaves the box: the corner `x` it makes with the box's
 * edge `edge` (-1: it passes the box), the fillet from `t1` on the edge to `t2` on the
 * side, and how far along the leader the join must reach to cover the fillet.
 */
type Side = { x: Pt; t1: Pt; t2: Pt; reach: number; edge: number };

/**
 * The outline of the label's box `b` (corner radius `r`) with the start of its leader
 * grown out of it: the leader, `width` wide, leaves the box at `port` (on its edge)
 * towards `next`, and the fillets between the box's edges and the leader's sides have
 * radius `fillet`. One SVG path whose parts all run clockwise, so that they fill as one
 * shape; it covers the leader from the box out to the fillets, the rest of the leader is
 * drawn on its own. Without a leader (`port` or `next` null), the box.
 */
export function labelPath(b: Box, r: number, port: Pt | null, next: Pt | null, width: number, fillet: number): string {
  r = Math.max(0, Math.min(r, b.w / 2, b.h / 2));
  const radii = [r, r, r, r];
  const [x0, y0, x1, y1] = [b.x, b.y, b.x + b.w, b.y + b.h];
  const len = port && next ? Math.hypot(next[0] - port[0], next[1] - port[1]) : 0;
  if (!port || !next || !(len > 1e-6) || (next[0] > x0 && next[0] < x1 && next[1] > y0 && next[1] < y1)) return boxPath(b, radii);
  // the corners clockwise from the top-left; edge k runs from corner k to corner k + 1
  const corners: Pt[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const u: Pt = [(next[0] - port[0]) / len, (next[1] - port[1]) / len];
  const n: Pt = [-u[1], u[0]];
  const hw = width / 2;
  const along = (p: Pt) => (p[0] - port[0]) * u[0] + (p[1] - port[1]) * u[1];

  const side = (s: number): Side => {
    const o = at(port, n, s * hw);
    // where this side of the leader leaves the box, and through which edge
    let tin = -Infinity;
    let tout = Infinity;
    let edge = -1;
    for (const k of [0, 1]) {
      const [lo, hi, d, c] = k ? [y0, y1, u[1], o[1]] : [x0, x1, u[0], o[0]];
      if (Math.abs(d) < 1e-9) {
        if (c < lo || c > hi) tin = Infinity;
        continue;
      }
      const [ta, tb] = [(lo - c) / d, (hi - c) / d];
      tin = Math.max(tin, Math.min(ta, tb));
      if (Math.max(ta, tb) < tout) {
        tout = Math.max(ta, tb);
        edge = k ? (d > 0 ? 2 : 0) : d > 0 ? 1 : 3;
      }
    }
    // it passes the box (the leader leaves a corner along an edge): no fillet
    if (edge < 0 || tin > tout) return { x: o, t1: o, t2: o, reach: hw, edge: -1 };
    const x = at(o, u, tout);
    // along the edge away from the leader, towards the corner at that end
    const [ca, cb] = [corners[edge]!, corners[(edge + 1) % 4]!];
    const el = Math.hypot(cb[0] - ca[0], cb[1] - ca[1]) || 1;
    const toB = (cb[0] - ca[0]) * n[0] * s + (cb[1] - ca[1]) * n[1] * s > 0;
    const [end, a]: [Pt, Pt] = toB ? [cb, [(cb[0] - ca[0]) / el, (cb[1] - ca[1]) / el]] : [ca, [(ca[0] - cb[0]) / el, (ca[1] - cb[1]) / el]];
    // the fillet touches edge and side this far from their corner, as far as there is room
    const half = Math.acos(Math.max(-1, Math.min(1, a[0] * u[0] + a[1] * u[1]))) / 2;
    const room = Math.hypot(end[0] - x[0], end[1] - x[1]) - r;
    const tau = Math.max(0, Math.min(fillet / Math.max(Math.tan(half), 1e-6), room, (len - tout - hw) * 0.8));
    return { x, t1: at(x, a, tau), t2: at(x, u, tau), reach: tout + tau + hw, edge };
  };

  const sides = [side(1), side(-1)];
  if (sides.every((q) => q.edge < 0)) return boxPath(b, radii);
  // the corners next to the leader give up their rounding where the fillets begin
  corners.forEach((c, i) => {
    if (Math.hypot(c[0] - port[0], c[1] - port[1]) <= hw + 0.5) radii[i] = 0;
    for (const q of sides) {
      if (q.edge >= 0 && (q.edge === i || (q.edge + 1) % 4 === i)) radii[i] = Math.min(radii[i]!, Math.hypot(c[0] - q.t1[0], c[1] - q.t1[1]));
    }
  });
  // the join: one side's fillet, out along the leader, back along the other side's, and
  // across the box to where it began
  const far = Math.min(len, Math.max(...sides.map((q) => q.reach)));
  const ring = sides.flatMap((q, i) => {
    const pts = [q.t1, q.x, q.t2, at(q.x, u, far - along(q.x))];
    return i ? pts.reverse() : pts;
  });
  let area = 0;
  ring.forEach((v, i) => {
    const w = ring[(i + 1) % ring.length]!;
    area += v[0] * w[1] - w[0] * v[1];
  });
  // clockwise (on screen) like the box, so that where they overlap they add up
  const [p0, p1, p2, p3, p4, p5, p6, p7] = (area > 0 ? ring : ring.reverse()).map(pt);
  return boxPath(b, radii) + `M${p0}Q${p1} ${p2}L${p3}L${p4}L${p5}Q${p6} ${p7}Z`;
}
