// The browser entry (index.ts) needs init() first; it is tested here in Node with the
// bytes of the module (each test file runs with a fresh module state).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { built, scatter, WASM_FILE } from "./helpers.js";

describe.skipIf(!built)("browser entry", () => {
  it("throws a clear error before init()", async () => {
    const la = await import("../src/index.js");
    expect(la.isInitialized()).toBe(false);
    expect(() => la.place(scatter(2))).toThrow(/not initialized: call `await init\(\)`/);
    expect(() => la.validate({})).toThrow(/not initialized/);
    expect(() => la.renderDebugSvg(scatter(2), {} as never)).toThrow(/not initialized/);
    expect(la.VERSION).toBe("0.1.0"); // constants need no instance
  });

  it("works after await init(bytes); init is idempotent", async () => {
    const la = await import("../src/index.js");
    const pending = la.init(readFileSync(WASM_FILE));
    expect(la.init()).toBe(pending); // a second call while loading returns the same promise
    await pending;
    expect(la.isInitialized()).toBe(true);
    await la.init(); // already initialized: nothing to fetch
    la.initSync(new Uint8Array(0)); // no-op once initialized
    const r = la.place(scatter(5));
    expect(r.stats.placed).toBe(5);
    expect(la.validate(scatter(1)).valid).toBe(true);
  });

  it("exports the same names as the Node entry", async () => {
    const browser = Object.keys(await import("../src/index.js")).sort();
    const node = Object.keys(await import("../src/node.js")).sort();
    expect(node).toEqual(browser);
    expect(browser).toEqual(
      ["PlaceError", "VERSION", "features", "init", "initSync", "isInitialized", "place", "renderDebugSvg", "validate"].sort(),
    );
  });
});
