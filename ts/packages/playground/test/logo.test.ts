// The logo's label (src/logo.ts): its leader grows out of the box wherever it leaves it —
// the corners next to it square off, the fillets begin on the box's edges — and every part
// of the outline runs clockwise, so that the parts fill as one shape.
import { describe, expect, it } from "vitest";
import { labelPath, type Pt } from "../src/logo.js";

const box = { x: 0, y: 0, w: 200, h: 50 };
const [R, WIDTH, FILLET] = [12, 6, 20];

/** The subpaths of a path of absolute M, H, V, L, Q, A and Z commands: their end points, and the arcs' radii. */
function parse(d: string): { pts: Pt[]; arcs: number }[] {
  const out: { pts: Pt[]; arcs: number }[] = [];
  let at: Pt = [0, 0];
  for (const [, cmd, args] of d.matchAll(/([MHVLQAZ])([^MHVLQAZ]*)/g)) {
    const n = args!.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === "M") out.push({ pts: [], arcs: 0 });
    const sub = out[out.length - 1]!;
    if (cmd === "H") at = [n[0]!, at[1]];
    else if (cmd === "V") at = [at[0], n[0]!];
    else if (cmd !== "Z") at = [n[n.length - 2]!, n[n.length - 1]!];
    if (cmd === "A") sub.arcs++;
    if (cmd !== "Z") sub.pts.push(at);
  }
  return out;
}

/** Twice the signed area (positive: clockwise on screen, where y points down). */
const area = (pts: Pt[]) => pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * p[1], 0);

/** The radius of the box's bottom-right corner: the right edge ends that far above the bottom. */
const bottomRight = (d: string) => box.y + box.h - Number(/V([-\d.]+)/.exec(d)![1]);

describe("labelPath", () => {
  it("is the box with four rounded corners without a leader", () => {
    for (const [port, next] of [
      [null, null],
      [[100, 50], [100, 50]],
      [[100, 50], [100, 20]],
    ] as [Pt | null, Pt | null][]) {
      const parts = parse(labelPath(box, R, port, next, WIDTH, FILLET));
      expect(parts.length).toBe(1);
      expect(parts[0]!.arcs).toBe(4);
    }
  });

  it("squares the corner the leader leaves from, and the fillets begin on its edges", () => {
    const d = labelPath(box, R, [200, 50], [240, 90], WIDTH, FILLET);
    const [outline, join] = parse(d);
    expect(outline!.arcs).toBe(3);
    expect(bottomRight(d)).toBe(0);
    // the leader's sides meet the edges WIDTH / 2 · √2 from the corner, the fillets begin
    // FILLET · tan(22.5°) further on
    const reach = (WIDTH / 2) * Math.SQRT2 + FILLET * Math.tan(Math.PI / 8);
    const onEdges = join!.pts.filter((p) => Math.abs(p[0] - 200) < 0.01 || Math.abs(p[1] - 50) < 0.01);
    expect(onEdges.map((p) => Math.max(200 - p[0], 50 - p[1])).sort((a, b) => a - b)).toEqual([expect.closeTo(reach, 1), expect.closeTo(reach, 1)]);
  });

  it("keeps the corners round where the leader leaves the middle of an edge", () => {
    const [outline, join] = parse(labelPath(box, R, [100, 50], [100, 90], WIDTH, FILLET));
    expect(outline!.arcs).toBe(4);
    const base = join!.pts.filter((p) => p[1] === 50).map((p) => p[0]);
    expect(Math.min(...base)).toBeCloseTo(100 - WIDTH / 2 - FILLET, 1);
    expect(Math.max(...base)).toBeCloseTo(100 + WIDTH / 2 + FILLET, 1);
  });

  it("rounds a corner less the nearer the leader leaves to it", () => {
    const radii = [120, 150, 170, 185, 192, 196, 199, 200].map((x) => bottomRight(labelPath(box, R, [x, 50], [x + 10, 90], WIDTH, FILLET)));
    expect(radii[0]).toBe(R);
    for (let i = 1; i < radii.length; i++) expect(radii[i]!).toBeLessThanOrEqual(radii[i - 1]! + 1e-9);
    expect(radii[radii.length - 1]).toBe(0);
  });

  it("runs clockwise in every part, wherever the leader leaves", () => {
    const leaders: [Pt, Pt][] = [
      [[200, 50], [240, 90]], // bottom-right corner
      [[0, 0], [-30, -20]], // top-left corner
      [[200, 0], [260, -10]], // top-right corner, shallow
      [[0, 50], [-50, 70]], // bottom-left corner
      [[100, 50], [100, 90]], // bottom edge
      [[100, 0], [90, -40]], // top edge, oblique
      [[0, 25], [-40, 25]], // left side's centre (elbow)
      [[200, 25], [240, 25]], // right side's centre
      [[200, 50], [260, 50]], // a corner, along an edge
      [[197, 50], [197, 80]], // next to a corner
    ];
    for (const [port, next] of leaders) {
      const parts = parse(labelPath(box, R, port, next, WIDTH, FILLET));
      expect(parts.length).toBe(2);
      for (const p of parts) expect(area(p.pts)).toBeGreaterThan(0);
    }
  });

  it("keeps the fillets on a short leader", () => {
    // the join reaches no further than the leader
    const [, join] = parse(labelPath(box, R, [100, 50], [100, 56], WIDTH, FILLET));
    for (const p of join!.pts) expect(p[1]).toBeLessThanOrEqual(56 + 1e-9);
  });
});
