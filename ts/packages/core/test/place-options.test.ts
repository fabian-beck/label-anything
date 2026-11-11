// The options of a solve are checked at the boundary, with the errors of
// @label-anything/wasm (rust/crates/la-wasm/src/env.rs, js.rs): a wrong type is a
// TypeError, a wrong pixel count a RangeError — not an exception from inside the solver.
import { describe, expect, it } from "vitest";
import { place, validate, type LabelProblem, type PlaceOptions } from "../src/index.js";

const problem: LabelProblem = {
  canvas: { width: 200, height: 100 },
  items: [
    { id: "a", anchor: { type: "point", x: 50, y: 50 }, label: { type: "text", text: "Alpha" } },
    { id: "b", anchor: { type: "point", x: 54, y: 52 }, label: { type: "text", text: "Beta" } },
  ],
};
const bad = (options: unknown) => () => place(problem, options as PlaceOptions);

describe("place options", () => {
  it("rejects options of the wrong kind", () => {
    expect(bad(5)).toThrow(new TypeError("label-anything: the options must be an object (PlaceOptions)"));
    expect(bad({ measure: 5 })).toThrow(new TypeError("label-anything: options.measure must be a function"));
    expect(bad({ cost: "x" })).toThrow(new TypeError("label-anything: options.cost must be a function"));
    expect(bad({ raster: { width: 10, height: 10, data: new Uint8Array(7) } })).toThrow(RangeError);
    expect(bad({ raster: { width: 0, height: 10, data: new Uint8Array(0) } })).toThrow("options.raster.width must be a positive integer");
    expect(bad({ raster: { width: 1, height: 1, data: [0, 0, 0, 0] } })).toThrow("options.raster.data must be a Uint8Array");
  });

  it("null counts as not set", () => {
    const options = { measure: null, cost: null, priority: null, signal: null, raster: null, readFile: null };
    expect(place(problem, options as unknown as PlaceOptions).stats.placed).toBe(2);
    expect(place(problem, null as unknown as PlaceOptions).stats.placed).toBe(2);
  });

  it("checks what the callbacks return", () => {
    expect(bad({ cost: () => Number.NaN })).toThrow('the cost callback must return a finite number (got NaN for item "a")');
    expect(bad({ cost: () => undefined })).toThrow(TypeError);
    expect(bad({ measure: () => ({ width: Number.NaN, ascent: 8, descent: 2 }) })).toThrow("the measure callback must return null or {width, ascent, descent}");
    expect(bad({ priority: () => Number.NaN })).toThrow("the priority callback must return a finite number or [tier, score]");
    expect(bad({ priority: () => [1.5, 2] })).toThrow(TypeError);
    expect(place(problem, { priority: (_item, index) => [1, index], cost: () => 0.5 }).stats.placed).toBe(2);
  });

  it("readFile may return bytes or text", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect x="60" y="40" width="40" height="20"/></svg>';
    const withSvg: LabelProblem = { ...problem, obstacles: { svg: { path: "bg.svg" } } };
    const text = place(withSvg, { readFile: () => svg });
    const bytes = place(withSvg, { readFile: () => new TextEncoder().encode(svg) });
    expect(text.placements).toEqual(bytes.placements);
    expect(text.stats.placed).toBe(2);
    expect(() => place(withSvg, { readFile: (() => 5) as never })).toThrow();
  });

  it("an object with `aborted` cancels as an AbortSignal does", () => {
    expect(place(problem, { signal: { aborted: true } }).stats.cancelled).toBe(true);
    expect(place(problem, { signal: AbortSignal.abort() }).stats.cancelled).toBe(true);
    expect(place(problem, { signal: { aborted: false } }).stats.cancelled).toBe(false);
  });
});

describe("validate", () => {
  it("reads JSON text as place does", () => {
    expect(validate(JSON.stringify(problem))).toEqual(validate(problem));
    expect(validate(JSON.stringify(problem)).valid).toBe(true);
    const report = validate("{ not json");
    expect(report.valid).toBe(false);
    expect(report.errors[0]).toMatchObject({ pointer: "", code: "parse" });
  });
});
