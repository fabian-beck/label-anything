// Port of the unit tests of rust/crates/la-core/src/options.rs (same names), plus checks
// of the TypeScript specifics (per-implementation defaults, absent vs null, copies).
import { describe, expect, it } from "vitest";
import { PRESETS } from "../src/generated/spec-data.js";
import { DATA_KEYS, deepMerge, defaultOf, lookup, Opts, preset, sourceOpt } from "../src/options.js";
import { Length } from "../src/units.js";

describe("options", () => {
  it("precedence", () => {
    const p = { preset: "scatter", placement: { offset: 5 }, items: [] };
    const o = new Opts(p);
    expect(o.f64("placement.offset")).toBe(5);
    expect(o.strings("placement.models")).toEqual(["adjacent", "slider", "distant"]);
    // per-implementation default: Rust 100, TypeScript 250
    expect(o.f64("solver.time_budget_ms")).toBe(250);
    const m = o.map("avoid.label");
    expect(m["points"]).toBe(0.3);
    expect(m["labels"]).toBe("hard");
    const auto = new Opts({ items: [] });
    expect(auto.presetName).toBe("auto");
    expect(auto.strings("placement.models")).toEqual(["adjacent", "slider"]);
  });

  it("merges only the option sections", () => {
    expect(DATA_KEYS).toEqual(["items", "obstacles", "warm_start"]);
    const problem = {
      items: [{ id: "a" }],
      obstacles: { vector: [] },
      warm_start: null,
      canvas: { width: 10, height: 20 },
    };
    const o = new Opts(problem);
    expect(lookup(o.merged, "items")).toBeUndefined();
    expect(lookup(o.merged, "obstacles")).toBeUndefined();
    expect(lookup(o.merged, "warm_start")).toBeUndefined();
    expect(o.f64("canvas.height")).toBe(20);
    expect(o.userSets(problem, "warm_start")).toBe(true);
    expect(o.userSets(problem, "canvas.padding")).toBe(false);
    // the merged options are a copy: neither the problem nor the presets change
    (o.merged as { canvas: { width: number } }).canvas.width = 99;
    expect(problem.canvas.width).toBe(10);
    const s = new Opts({ preset: "scatter" });
    (s.given("avoid.label") as Record<string, unknown>)["points"] = 7;
    expect((PRESETS["scatter"]!.options as { avoid: { label: Record<string, unknown> } }).avoid.label["points"]).toBe(0.3);
  });

  it("resolves defaults, null and missing values", () => {
    const o = new Opts({ preset: "none", canvas: { padding: null }, leaders: { width: 3 }, placement: { offset: "1.5em" } });
    expect(o.presetName).toBe("none");
    expect(o.preset).toBe(preset("none"));
    // an explicit null falls back to the default
    expect(o.given("canvas.padding")).toBeUndefined();
    expect(o.get("canvas.padding")).toBe(4);
    expect(o.f64("leaders.width")).toBe(3);
    expect(o.length("placement.offset")).toEqual(Length.Em(1.5));
    expect(o.length("defaults.padding")).toEqual(Length.Em(0.15));
    expect(o.length("no.such.key")).toEqual(Length.Px(0));
    expect(o.get("no.such.key")).toBeNull();
    expect(o.bool("canvas.allow_outside")).toBe(false);
    expect(o.bool("placement.free_space_seeds")).toBe(true);
    expect(o.string("leaders.style")).toBe("straight");
    expect(o.string("leaders.width")).toBe("");
    expect(o.numbers("leaders.angles")).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
    expect(o.strings("leaders.angles")).toEqual([]);
    // the default map, then the given keys
    const m = new Opts({ preset: "none", avoid: { leader: { ink: 1, lines: "hard" } } }).map("avoid.leader");
    expect(Object.keys(m)).toEqual(["leaders", "labels", "items", "ink", "*", "lines"]);
    expect(m["ink"]).toBe(1);
    // unknown or non-string presets fall back to the defaults table's preset
    expect(new Opts({ preset: 3 }).presetName).toBe("auto");
    expect(new Opts({ preset: "constructor" }).preset).toBeNull();
    expect(new Opts(null).merged).toBeNull();
  });

  it("lookup, deepMerge, defaultOf and sourceOpt", () => {
    const v = { a: { b: { c: 1, n: null } }, u: undefined };
    expect(lookup(v, "a.b.c")).toBe(1);
    expect(lookup(v, "a.b.n")).toBeNull();
    expect(lookup(v, "a.b.x")).toBeUndefined();
    expect(lookup(v, "a.b.c.d")).toBeUndefined();
    expect(lookup(v, "u")).toBeUndefined();
    expect(lookup(v, "toString")).toBeUndefined();
    expect(deepMerge({ a: { x: 1, y: [1] }, b: 2 }, { a: { y: [2], z: 3 }, c: 4 })).toEqual({
      a: { x: 1, y: [2], z: 3 },
      b: 2,
      c: 4,
    });
    expect(deepMerge({ a: 1 }, 5)).toBe(5);
    const merged = deepMerge({}, JSON.parse('{"__proto__": {"polluted": 1}}')) as Record<string, unknown>;
    expect(Object.keys(merged)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(defaultOf("solver.time_budget_ms", "rust")).toBe(100);
    expect(defaultOf("solver.time_budget_ms", "ts")).toBe(250);
    expect(defaultOf("constructor", "ts")).toBeNull();
    const d = defaultOf("avoid.buffer", "ts") as Record<string, unknown>;
    d["items"] = 5;
    expect(defaultOf("avoid.buffer", "ts")).toEqual({ items: 1, leaders: 0.5 });
    expect(sourceOpt({ mode: "alpha" }, "obstacles.raster", "mode")).toBe("alpha");
    expect(sourceOpt({ mode: null }, "obstacles.raster", "mode")).toBe("ink");
    expect(sourceOpt({ ink: { threshold: 0.3 } }, "obstacles.raster", "ink.threshold")).toBe(0.3);
    expect(sourceOpt({}, "obstacles.raster", "offset")).toEqual([0, 0]);
  });
});
