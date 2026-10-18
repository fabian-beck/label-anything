// The playground's option controls write valid problems, and its merge and share-link
// helpers behave like the engine's merge rule.
import { validate } from "@label-anything/core";
import { describe, expect, it } from "vitest";
import { SECTIONS, type Control } from "../src/controls.js";
import { samePlacements } from "../src/engines.js";
import { fromBase64Url, getPath, merge, setPath, toBase64Url } from "../src/util.js";

const base = {
  canvas: { width: 300, height: 200 },
  items: [
    { id: "a", anchor: { type: "point", x: 100, y: 100 }, label: { type: "text", text: "Alpha" } },
    { id: "b", anchor: { type: "area", polygon: [[150, 20], [280, 20], [280, 180], [150, 180]] }, label: { type: "text", text: "Beta" } },
  ],
};

/** The values a control can write: every option, both ends of a slider, on and off. */
function samples(c: Control): unknown[] {
  switch (c.kind) {
    case "select":
    case "segmented":
      return c.options.map((o) => o.value);
    case "checks":
      return [c.options.map((o) => o.value), [c.options[0]!.value]];
    case "range": {
      const mid = c.log ? Math.sqrt(c.min * c.max) : c.min + Math.round((c.max - c.min) / 2 / c.step) * c.step;
      return [c.min, c.max, mid].map((n) => (c.encode ? c.encode(n) : n));
    }
    case "toggle":
      return ["on" in c ? c.on : true, "off" in c ? c.off : false];
    case "avoid":
      return ["hard", "ignore", 0, 2.5];
    default:
      return [];
  }
}

describe("option controls", () => {
  const controls = SECTIONS.flatMap((s) => s.controls);

  it("have unique keys", () => {
    const keys = controls.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  for (const c of controls.filter((c) => !c.key.startsWith("view."))) {
    it(`${c.key} writes only valid problems`, () => {
      for (const v of samples(c)) {
        const problem = setPath(structuredClone(base), c.key, v);
        // the degradation ladder must end with omit
        if (c.key === "degrade" && Array.isArray(v) && !v.includes("omit")) continue;
        const report = validate(problem);
        expect(report.errors, `${c.key} = ${JSON.stringify(v)}`).toEqual([]);
      }
    });
  }
});

describe("merge", () => {
  it("merges objects and replaces arrays and scalars", () => {
    const a = { placement: { models: ["adjacent", "slider"], offset: 1 }, preset: "map" };
    const b = { placement: { models: ["distant"] }, leaders: { style: "curved" } };
    expect(merge(a, b)).toEqual({ placement: { models: ["distant"], offset: 1 }, preset: "map", leaders: { style: "curved" } });
    expect(a.placement.models).toEqual(["adjacent", "slider"]);
  });

  it("keeps a value for undefined and replaces it with null", () => {
    expect(merge({ x: 1, y: 2 }, { x: undefined, y: null })).toEqual({ x: 1, y: null });
  });
});

describe("paths", () => {
  it("set and get dotted paths, removing emptied parents", () => {
    let o = setPath({}, "leaders.style", "elbow");
    expect(getPath(o, "leaders.style")).toBe("elbow");
    o = setPath(o, "leaders.style", undefined);
    expect(o).toEqual({});
  });
});

describe("share links", () => {
  it("round-trip UTF-8 text through base64url", () => {
    const text = JSON.stringify({ o: { leaders: { style: "curved" } }, j: '{"x": "Côte d’Ivoire ✓"}' });
    const enc = toBase64Url(text);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64Url(enc)).toBe(text);
  });
});

describe("samePlacements", () => {
  it("counts equal placements and names the first difference", () => {
    const p = (id: string, x: number) => ({ id, placed: true, box: { x, y: 0, w: 10, h: 10 } });
    const a = { placements: [p("a", 1), p("b", 2)] } as never;
    const b = { placements: [p("a", 1), p("b", 3)] } as never;
    expect(samePlacements(a, b)).toEqual({ same: 1, total: 2, firstDiff: "b" });
  });
});
