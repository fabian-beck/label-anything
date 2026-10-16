// Unit tests of the internal modules (mirrors rust/crates/la-svg/src/unit_tests.rs).

import { describe, expect, it } from "vitest";
import { parseColorAlpha, parsePaint } from "../src/color.js";
import { parseDeclarations, parseStylesheet } from "../src/css.js";
import { Flattener, arcSegments, MAX_CURVE_SEGMENTS } from "../src/flatten.js";
import { type Affine, IDENTITY, affine, apply } from "../src/geom.js";
import { parseFirstLength, parseLength, parseNumberList, resolveLength, scanNumber } from "../src/num.js";
import { parsePath } from "../src/path.js";
import { parseSelectorList } from "../src/selector.js";
import { type Computed, type Specified, applyDecl, compute, firstFamily, initialStyle } from "../src/style.js";
import { DEFAULT_ASPECT_RATIO, parseAspectRatio, parseTransform, parseViewBox, viewBoxTransform } from "../src/transform.js";
import type { Point } from "../src/types.js";

describe("numbers and lengths", () => {
  it("scans SVG numbers", () => {
    expect(scanNumber("1.5.5", 0)).toEqual([1.5, 3]);
    expect(scanNumber("1.5.5", 3)).toEqual([0.5, 5]);
    expect(scanNumber("-1-2", 0)).toEqual([-1, 2]);
    expect(scanNumber("1e5x", 0)).toEqual([1e5, 3]);
    expect(scanNumber("1e", 0)).toEqual([1, 1]);
    expect(scanNumber("1em", 0)).toEqual([1, 1]);
    expect(scanNumber("+.5", 0)).toEqual([0.5, 3]);
    expect(scanNumber("1.", 0)).toEqual([1, 2]);
    expect(scanNumber("2E-1", 0)).toEqual([0.2, 4]);
    for (const bad of [".", "-", "e5", "", "+e", "1e400"]) expect(scanNumber(bad, 0)).toBeNull();
    expect(parseNumberList("1,2 3 , 4")).toEqual([[1, 2, 3, 4], true]);
    expect(parseNumberList("1 2 x 3")).toEqual([[1, 2], false]);
  });

  it("parses and resolves lengths", () => {
    expect(parseLength(" 12.5PX ")).toEqual({ v: 12.5, unit: "px" });
    expect(parseLength("50%")!.unit).toBe("%");
    for (const bad of ["10 px", "auto", "1furlong"]) expect(parseLength(bad)).toBeNull();
    expect(resolveLength(parseLength("1in")!, 16, 0)).toBeCloseTo(96, 12);
    expect(resolveLength(parseLength("3pt")!, 16, 0)).toBeCloseTo(4, 12);
    expect(resolveLength(parseLength("2em")!, 10, 0)).toBe(20);
    expect(resolveLength(parseLength("1ex")!, 10, 0)).toBe(5);
    expect(resolveLength(parseLength("25.4mm")!, 16, 0)).toBeCloseTo(96, 12);
    expect(resolveLength(parseLength("50%")!, 16, 300)).toBe(150);
    expect(parseFirstLength("10 20 30")!.v).toBe(10);
    expect(parseFirstLength("5em,6")!.unit).toBe("em");
  });
});

describe("path data", () => {
  it("parses commands", () => {
    expect(parsePath("M 0 0 10 10 L 20 0")).toEqual([
      { k: "M", x: 0, y: 0 },
      { k: "L", x: 10, y: 10 },
      { k: "L", x: 20, y: 0 },
    ]);
    expect(parsePath("m 1 1 2 2 z m 3 3 h 1 v 1")).toEqual([
      { k: "M", x: 1, y: 1 },
      { k: "L", x: 3, y: 3 },
      { k: "Z" },
      { k: "M", x: 4, y: 4 },
      { k: "L", x: 5, y: 4 },
      { k: "L", x: 5, y: 5 },
    ]);
    expect(parsePath("M0 0 C 0 10 10 10 10 0 S 20 -10 20 0")[2]).toEqual({ k: "C", x1: 10, y1: -10, x2: 20, y2: -10, x: 20, y: 0 });
    expect(parsePath("M0 0 Q 5 10 10 0 T 20 0 T 30 0")[3]).toEqual({ k: "Q", x1: 25, y1: 10, x: 30, y: 0 });
    expect(parsePath("M0 0 L 1 1 T 5 5")[2]).toEqual({ k: "Q", x1: 1, y1: 1, x: 5, y: 5 });
    expect(parsePath("M0 0 a1 1 0 0110 10")[1]).toEqual({ k: "A", rx: 1, ry: 1, rot: 0, large: false, sweep: true, x: 10, y: 10 });
    expect(parsePath("M 0 0 L 10 10 L 5")).toHaveLength(2);
    expect(parsePath("M 0 0 L 10 10 X 5 5")).toHaveLength(2);
    expect(parsePath("L 10 10")).toEqual([]);
    expect(parsePath("M 0 0 z 1 1")).toHaveLength(2);
    expect(parsePath("")).toEqual([]);
  });
});

describe("transforms and viewBox", () => {
  it("parses transform lists", () => {
    expect(apply(parseTransform("translate(10, 20) scale(2)")!, 1, 1)).toEqual([12, 22]);
    const p = apply(parseTransform("rotate(90 10 10)")!, 20, 10);
    expect(p[0]).toBeCloseTo(10, 12);
    expect(p[1]).toBeCloseTo(20, 12);
    const q = apply(parseTransform("skewX(45)")!, 0, 10);
    expect(q[0]).toBeCloseTo(10, 12);
    expect(parseTransform("matrix(1,2,3,4,5,6)")).toEqual(affine(1, 2, 3, 4, 5, 6));
    for (const bad of ["translate(1,2,3)", "rotate(1 2)", "foo(1)", "translate(1", "scale()", "matrix(1 2 3 4 5)", "translate 1 2"]) {
      expect(parseTransform(bad), bad).toBeNull();
    }
    expect(parseTransform("")).toBe(IDENTITY);
  });

  it("parses viewBox and preserveAspectRatio", () => {
    expect(parseViewBox("0 0 100 50")).toEqual([0, 0, 100, 50]);
    expect(parseViewBox("-1,-2,3,4")).toEqual([-1, -2, 3, 4]);
    for (const bad of ["0 0 0 10", "0 0 10", "0 0 10 10 5"]) expect(parseViewBox(bad)).toBeNull();
    expect(parseAspectRatio("none").align).toBeNull();
    expect(parseAspectRatio("xMaxYMin slice")).toEqual({ align: [1, 0], slice: true });
    expect(parseAspectRatio("defer xMinYMax")).toEqual({ align: [0, 1], slice: false });
    for (const bad of ["bogus", "xMinYMin meet extra", "xMi€YMin", "YMinxMin"]) expect(parseAspectRatio(bad)).toBe(DEFAULT_ASPECT_RATIO);
    expect(apply(viewBoxTransform([0, 0, 10, 10], DEFAULT_ASPECT_RATIO, 100, 50), 10, 10)).toEqual([75, 50]);
  });
});

describe("colors", () => {
  it("parses paints and alpha", () => {
    expect(parseColorAlpha("SteelBlue")).toBe(1);
    expect(parseColorAlpha("transparent")).toBe(0);
    expect(parseColorAlpha("#abc")).toBe(1);
    expect(parseColorAlpha("#abc0")).toBe(0);
    expect(parseColorAlpha("#00000080")).toBe(128 / 255);
    expect(parseColorAlpha("#abcde")).toBeNull();
    expect(parseColorAlpha("rgba(1, 2, 3, 0.25)")).toBe(0.25);
    expect(parseColorAlpha("rgb(1 2 3 / 50%)")).toBe(0.5);
    expect(parseColorAlpha("hsl(1, 2%, 3%)")).toBe(1);
    expect(parseColorAlpha("rgba(1, 2, 3, 7)")).toBe(1);
    expect(parseColorAlpha("rgb(1,2,3")).toBeNull();
    expect(parseColorAlpha("notacolor")).toBeNull();
    expect(parsePaint("none")).toEqual({ k: "none" });
    expect(parsePaint("url(#g) red")).toEqual({ k: "url", id: "g", fallback: { k: "color", alpha: 1 } });
    expect(parsePaint("url('#g')")).toEqual({ k: "url", id: "g", fallback: null });
    expect(parsePaint("url(x.svg#g)")).toEqual({ k: "url", id: null, fallback: null });
    expect(parsePaint("url(#g) url(#h)")).toBeNull();
    expect(parsePaint("ab€x")).toBeNull();
  });
});

describe("css", () => {
  it("parses style sheets and declarations", () => {
    const rules = parseStylesheet(
      '/* x { fill: red } */ @import url(a.css); @media print { rect { fill: none } } rect, .a > circle { fill: red; stroke: blue !important } a:hover { fill: none } text { content: "}"; font: 12px sans-serif } <!-- --> g{}',
    );
    expect(rules).toHaveLength(2);
    expect(rules[0]!.selectors).toHaveLength(2);
    expect(rules[0]!.decls[1]).toEqual({ name: "stroke", value: "blue", important: true });
    expect(rules[1]!.decls).toHaveLength(2);
    const d = parseDeclarations("FILL: Red ; stroke:url(data:a;b) ; ;bogus; :x; font-size: 12px!IMPORTANT");
    expect(d).toEqual([
      { name: "fill", value: "Red", important: false },
      { name: "stroke", value: "url(data:a;b)", important: false },
      { name: "font-size", value: "12px", important: true },
    ]);
  });
});

describe("selectors", () => {
  it("computes specificity and rejects unsupported syntax", () => {
    const cases: [string, [number, number, number]][] = [
      ["rect", [0, 0, 1]],
      ["*", [0, 0, 0]],
      ["circle.outlier[data-k=1]", [0, 2, 1]],
      ["#a.b:small", [1, 2, 0]],
      ["g > .c [x='y']", [0, 2, 1]],
    ];
    for (const [s, spec] of cases) expect(parseSelectorList(s, "rules")[0]!.specificity, s).toEqual(spec);
    expect(() => parseSelectorList(":small", "css")).toThrow();
    expect(() => parseSelectorList("svg|rect", "rules")).toThrow();
    const esc = parseSelectorList("#\\31 23, .a\\.b", "rules");
    expect(esc[0]!.compounds[0]!.ids).toEqual(["123"]);
    expect(esc[1]!.compounds[0]!.classes).toEqual(["a.b"]);
  });
});

function styleOf(decls: [string, string][], parent: Computed): Computed {
  const s: Specified = {};
  const ctx = { urlExists: (id: string) => id === "g", paints: new Map() };
  for (const [n, v] of decls) applyDecl(s, n, v, true, ctx);
  return compute(s, parent, null);
}

describe("styles", () => {
  it("cascades and inherits", () => {
    const root = initialStyle();
    const p = styleOf([["font", "italic bold 12px/1.5 'Open Sans', arial"]], root);
    expect([p.font_size, p.font_weight, p.font_family]).toEqual([12, 700, "'Open Sans', arial"]);
    expect(firstFamily(p.font_family)).toBe("Open Sans");
    expect(firstFamily(" a , b")).toBe("a");
    expect(firstFamily("")).toBe("sans-serif");
    let c = styleOf(
      [
        ["font-size", "150%"],
        ["font-weight", "bolder"],
      ],
      p,
    );
    expect([c.font_size, c.font_weight]).toEqual([18, 900]);
    c = styleOf(
      [
        ["font-size", "larger"],
        ["font-weight", "lighter"],
      ],
      p,
    );
    expect(c.font_size).toBeCloseTo(14.4, 12);
    expect(c.font_weight).toBe(400);
    expect(
      styleOf(
        [
          ["font-size", "-1px"],
          ["font-size", "x-large"],
        ],
        root,
      ).font_size,
    ).toBe(24);
    c = styleOf(
      [
        ["fill", "red"],
        ["fill", "bogus"],
        ["opacity", "50%"],
        ["text-anchor", "middle"],
      ],
      root,
    );
    expect([c.fill, c.opacity, c.anchor]).toEqual([1, 0.5, "middle"]);
    expect(styleOf([["fill", "url(#nope)"]], root).fill).toBeNull();
    c = styleOf(
      [
        ["fill", "url(#g)"],
        ["dominant-baseline", "central"],
      ],
      root,
    );
    expect([c.fill, c.baseline]).toEqual([1, "middle"]);
    const parent = styleOf(
      [
        ["opacity", "0.5"],
        ["display", "none"],
        ["fill", "none"],
      ],
      root,
    );
    const child = styleOf([], parent);
    expect([child.opacity, child.display_none, child.fill]).toEqual([1, false, null]);
    const child2 = styleOf(
      [
        ["opacity", "inherit"],
        ["fill", "initial"],
      ],
      parent,
    );
    expect([child2.opacity, child2.fill]).toEqual([0.5, 1]);
  });
});

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function maxDeviation(curve: (t: number) => Point, pts: Point[]): number {
  let worst = 0;
  for (let k = 0; k <= 2000; k++) {
    const p = curve(k / 2000);
    let d = Infinity;
    for (let i = 1; i < pts.length; i++) d = Math.min(d, segDist(p, pts[i - 1]!, pts[i]!));
    worst = Math.max(worst, d);
  }
  return worst;
}

describe("flattening", () => {
  it("stays within the tolerance for transformed cubics and arcs", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed / 2147483648) * 400 - 200;
    };
    const m: Affine = affine(1.3, 0.2, -0.4, 0.9, 5, 7);
    for (const tol of [0.05, 0.25, 1]) {
      for (let n = 0; n < 50; n++) {
        const c = [rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd()];
        const f = new Flattener(m, tol);
        f.moveTo(c[0]!, c[1]!);
        f.cubicTo(c[2]!, c[3]!, c[4]!, c[5]!, c[6]!, c[7]!);
        const sub = f.finishAll()!;
        const cubic = (t: number): Point => {
          const mt = 1 - t;
          const x = mt * mt * mt * c[0]! + 3 * mt * mt * t * c[2]! + 3 * mt * t * t * c[4]! + t * t * t * c[6]!;
          const y = mt * mt * mt * c[1]! + 3 * mt * mt * t * c[3]! + 3 * mt * t * t * c[5]! + t * t * t * c[7]!;
          return apply(m, x, y);
        };
        if (sub.length > 0) expect(maxDeviation(cubic, sub[0]!.pts)).toBeLessThanOrEqual(tol * 1.0001);
        const rx = Math.abs(c[0]!) / 4 + 1;
        const ry = Math.abs(c[1]!) / 4 + 1;
        const phi = (c[2]! * Math.PI) / 180;
        const at = (th: number): Point => [
          c[3]! + rx * Math.cos(th) * Math.cos(phi) - ry * Math.sin(th) * Math.sin(phi),
          c[4]! + rx * Math.cos(th) * Math.sin(phi) + ry * Math.sin(th) * Math.cos(phi),
        ];
        const p0 = at(0.3);
        const p1 = at(2.9);
        const g = new Flattener(m, tol);
        g.moveTo(p0[0], p0[1]);
        g.arcTo(rx, ry, c[2]!, false, true, p1[0], p1[1]);
        const arc = g.finishAll()!;
        const curve = (t: number): Point => {
          const q = at(0.3 + 2.6 * t);
          return apply(m, q[0], q[1]);
        };
        expect(maxDeviation(curve, arc[0]!.pts)).toBeLessThanOrEqual(tol * 1.0001);
      }
    }
    expect(arcSegments(30, 2 * Math.PI, 0.1)).toBe(39);
    expect(arcSegments(0.01, 2 * Math.PI, 0.25)).toBe(4);
    expect(arcSegments(1e300, 1, 0.25)).toBe(MAX_CURVE_SEGMENTS);
  });
});
