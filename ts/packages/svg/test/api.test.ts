// Public API behaviour: results instead of exceptions, measure callback, lookups, fuzzing.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ClassRule,
  type Geometry,
  Selector,
  classify,
  elementById,
  elementGeometry,
  matches,
  outline,
  parseSelector,
  parseSvg,
  select,
  selectElements,
  subtreePrimitives,
} from "../src/index.js";

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

describe("api", () => {
  it("returns structured errors and validates options", () => {
    for (const [svg, code] of [
      ["", "parse"],
      ["<svg", "parse"],
      ["<svg><g></svg>", "parse"],
      ["<html/>", "invalid_value"],
      ["<x:svg xmlns:x='urn:other'/>", "invalid_value"],
    ] as const) {
      const r = parseSvg(svg);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(code);
    }
    const svg = "<svg width='10' height='10'><rect width='5' height='5'/></svg>";
    for (const opts of [{ tolerance: 0 }, { tolerance: Number.NaN }, { canvas: { width: 0, height: 10 } }, { ascent: Infinity }]) {
      const r = parseSvg(svg, opts);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("invalid_value");
    }
    // Non-string input (from JS callers) is an error, not an exception.
    const r = parseSvg(42 as unknown as string);
    expect(r.ok).toBe(false);
    const scene = ok(parseSvg(svg));
    for (const bad of ["", "a[", "a >", ":hover", "a + b", "[x~=y]", "#", ".", "a,", "::before", "a]"]) {
      const c = classify(scene, [{ selector: bad, class: "x" }], "ink");
      expect(c.ok, bad).toBe(false);
      if (!c.ok) expect(c.error.code).toBe("pattern");
      const s = select(scene, bad);
      expect(s.ok).toBe(false);
      expect(parseSelector(bad).ok).toBe(false);
    }
  });

  it("calls the measure callback with size, first family and weight", () => {
    const calls: [string, number, string, number][] = [];
    const svg =
      "<svg width='100' height='100'><text x='0' y='20' font-family=\"'My Font', serif\" font-weight='bold' font-size='10'>abc</text></svg>";
    const scene = ok(
      parseSvg(svg, {
        measure: (t, size, fam, w) => {
          calls.push([t, size, fam, w]);
          return 42;
        },
        ascent: 0.9,
        descent: 0.3,
      }),
    );
    expect(calls).toEqual([["abc", 10, "My Font", 700]]);
    const p = scene.primitives[0]!;
    expect(p.type).toBe("rect");
    if (p.type === "rect") {
      expect(p.x).toBeCloseTo(0, 12);
      expect(p.y).toBeCloseTo(11, 12);
      expect(p.w).toBe(42);
      expect(p.h).toBeCloseTo(12, 12);
    }
    const nan = ok(parseSvg(svg, { measure: () => Number.NaN }));
    const q = nan.primitives[0]!;
    expect(q.type === "rect" && q.w === 0).toBe(true);
    // A throwing callback becomes a structured error.
    const thrown = parseSvg(svg, {
      measure: () => {
        throw new Error("boom");
      },
    });
    expect(thrown.ok).toBe(false);
  });

  it("classifies, selects and outlines", () => {
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'>" +
      "<defs><circle id='m' r='2'/></defs>" +
      "<g id='g1' class='pts'><use id='u1' href='#m' x='10' y='10'/><use href='#m' x='20' y='10'/></g>" +
      "<path id='p' d='M 0 50 L 100 50' stroke='black' fill='none'/>" +
      "<rect id='r' x='5' y='60' width='10' height='10' stroke='red'/></svg>";
    const scene = ok(parseSvg(svg));
    const rules: ClassRule[] = [
      { selector: "circle", class: "never" },
      { selector: ".pts use", class: "points" },
      { selector: "path", class: "ignore" },
    ];
    expect(ok(classify(scene, rules, "ink")).map((c) => c.class)).toEqual(["points", "points", "ink", "ink"]);
    for (let k = 1; k < scene.primitives.length; k++) {
      expect(scene.primitives[k - 1]!.element).toBeLessThanOrEqual(scene.primitives[k]!.element);
    }
    const g1 = elementById(scene, "g1")!;
    expect(subtreePrimitives(scene, g1)).toHaveLength(2);
    expect(subtreePrimitives(scene, 999)).toHaveLength(0);
    expect(elementGeometry(scene, "u1")).toHaveLength(1);
    expect(elementGeometry(scene, "missing")).toBeUndefined();
    expect(ok(select(scene, "g, use"))).toHaveLength(2);
    const kinds = outline(subtreePrimitives(scene, 0)).map((g: Geometry) => g.type);
    expect(kinds).toEqual(["polygon", "polygon", "polyline", "polygon"]);
    const sel = ok(parseSelector("use"));
    expect(sel).toBeInstanceOf(Selector);
    expect(selectElements(scene, sel)).toHaveLength(2);
    expect(matches(scene, elementById(scene, "u1")!, sel)).toBe(true);
    expect(matches(scene, -1, sel)).toBe(false);
    // JSON round trip keeps lookups working (the id map is rebuilt).
    const copy = JSON.parse(JSON.stringify(scene));
    expect(elementGeometry(copy, "u1")).toHaveLength(1);
  });

  it("keeps attribute maps safe for any attribute name", () => {
    const scene = ok(parseSvg("<svg width='10' height='10' __proto__='x' constructor='y'><rect width='1' height='1'/></svg>"));
    const attrs = scene.elements[0]!.attributes;
    expect(Object.keys(attrs)).toEqual(["width", "height", "__proto__", "constructor"]);
    expect(attrs["__proto__"]).toBe("x");
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype);
    expect(ok(select(scene, "[constructor=y]"))).toHaveLength(1);
    expect(ok(select(scene, "[toString]"))).toHaveLength(0);
  });

  it("never throws on random input", () => {
    const base =
      "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='80' viewBox='0 0 50 40'><style>.a{fill:red}</style>" +
      "<defs><path id='m' d='M0 0 L 5 5 A 3 3 0 1 1 1 1 Z'/></defs><g class='a' transform='rotate(10)'>" +
      "<use href='#m' x='3'/><text x='1' y='9' font-size='4'>a<tspan dy='1em'>b</tspan></text>" +
      "<rect width='10%' height='5' rx='1'/></g></svg>";
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const r = parseSvg(s);
        expect(typeof r.ok).toBe("boolean");
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.nat(base.length), fc.nat(10), fc.string({ maxLength: 8 }), (at, del, ins) => {
        const s = base.slice(0, at) + ins + base.slice(at + del);
        const r = parseSvg(s, { canvas: { width: 120, height: 90 } });
        expect(typeof r.ok).toBe("boolean");
        if (r.ok) {
          const c = classify(r.value, [{ selector: ":small", class: "s" }], "ink");
          expect(c.ok).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
