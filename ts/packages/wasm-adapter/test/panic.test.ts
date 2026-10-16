// Rust panics and traps become JavaScript errors, and the instance is replaced afterwards.
import { beforeAll, describe, expect, it } from "vitest";
import { built, scatter } from "./helpers.js";

type Wasm = typeof import("../src/node.js");
type Api = typeof import("../src/api.js");
let la: Wasm;
let hooks: Api["testHooks"];

function thrown(f: () => unknown): Error {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }
  throw new Error("expected an exception");
}

describe.skipIf(!built)("abnormal exits", () => {
  beforeAll(async () => {
    la = await import("../src/node.js");
    hooks = (await import("../src/api.js")).testHooks;
    la.validate({}); // instantiate
  });

  it("a panic is an Error with the panic message; the next call gets a fresh instance", () => {
    const e = thrown(() => hooks.panic("boom"));
    expect(e.message).toMatch(/^label-anything: internal error \(Rust panic\): panicked at .*boom$/s);
    expect(hooks.callDepth()).toBe(0);
    expect(la.place(scatter(4)).stats.hard_violations).toBe(0);
    expect(thrown(() => hooks.panic("again")).message).toMatch(/again$/); // the hook survives the reset
    expect(la.place(scatter(4)).stats.placed).toBe(4);
  });

  it("a trap (no panic hook involved) is reported and recovered from", () => {
    const e = thrown(() => hooks.trap());
    expect(e.message).toMatch(/internal error \(the WebAssembly instance trapped: RuntimeError: unreachable/);
    expect(e.cause).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(hooks.callDepth()).toBe(0);
    expect(la.place(scatter(4)).stats.placed).toBe(4);
  });

  it("a panic in a nested call (from a callback) resets the instance after the outer call", () => {
    let inner: unknown;
    const e = thrown(() =>
      la.place(scatter(4), {
        progress: () => {
          try {
            hooks.panic("nested");
          } catch (x) {
            inner = x;
            throw x;
          }
        },
      }),
    );
    expect(e).toBe(inner);
    expect(e.message).toMatch(/nested$/);
    expect(hooks.callDepth()).toBe(0);
    expect(la.place(scatter(4)).stats.placed).toBe(4);
  });

  it("a callback exception is not an abnormal exit", () => {
    const boom = new Error("user");
    let caught: unknown;
    try {
      la.place(scatter(3), { cost: () => { throw boom; } });
    } catch (x) {
      caught = x;
    }
    expect(caught).toBe(boom);
    expect(hooks.callDepth()).toBe(0);
  });
});
