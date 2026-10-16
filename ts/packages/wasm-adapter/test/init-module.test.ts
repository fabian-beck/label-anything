// initSync with a compiled WebAssembly.Module (fresh module state in this file).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { built, scatter, WASM_FILE } from "./helpers.js";

describe.skipIf(!built)("initSync(WebAssembly.Module)", () => {
  it("instantiates synchronously from a compiled module", async () => {
    const la = await import("../src/index.js");
    const module = new WebAssembly.Module(readFileSync(WASM_FILE));
    expect(la.isInitialized()).toBe(false);
    la.initSync(module);
    expect(la.isInitialized()).toBe(true);
    expect(la.place(scatter(3)).stats.placed).toBe(3);
    // the Node entry shares the instance
    const node = await import("../src/node.js");
    expect(node.isInitialized()).toBe(true);
    expect(node.place(scatter(3)).stats.placed).toBe(3);
  });
});
