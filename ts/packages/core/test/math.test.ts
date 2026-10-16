// Port of the unit tests of rust/crates/la-core/src/math.rs, plus the porting helpers.
import { describe, expect, it } from "vitest";
import { USIZE_MAX, clampf, cmpF64, cmpStr, len2d, maxf, minf, signEps, toIndex } from "../src/math.js";

describe("math", () => {
  it("minf_maxf_ignore_nan", () => {
    const nan = NaN;
    expect(minf(nan, 1)).toBe(1);
    expect(minf(1, nan)).toBe(1);
    expect(maxf(nan, 1)).toBe(1);
    expect(maxf(1, nan)).toBe(1);
    expect(Number.isNaN(minf(nan, nan)) && Number.isNaN(maxf(nan, nan))).toBe(true);
    expect(minf(2, -3)).toBe(-3);
    expect(maxf(2, -3)).toBe(2);
    expect(minf(-Infinity, 0)).toBe(-Infinity);
    // ties keep the first operand
    expect(minf(-0, 0)).toBe(-0);
    expect(minf(0, -0)).toBe(0);
    expect(maxf(-0, 0)).toBe(-0);
    expect(maxf(0, -0)).toBe(0);
  });

  it("cmp_f64_orders_nan_last", () => {
    expect(cmpF64(1, 2)).toBe(-1);
    expect(cmpF64(-0, 0)).toBe(0);
    expect(cmpF64(NaN, 1)).toBe(1);
    expect(cmpF64(1, NaN)).toBe(-1);
    expect(cmpF64(NaN, NaN)).toBe(0);
    expect(cmpF64(Infinity, NaN)).toBe(-1);
    const xs = [3, NaN, -1, Infinity, -Infinity, 0, NaN, 2];
    xs.sort(cmpF64);
    expect(xs.slice(0, 6)).toEqual([-Infinity, -1, 0, 2, 3, Infinity]);
    expect(Number.isNaN(xs[6]) && Number.isNaN(xs[7])).toBe(true);
  });

  it("cmp_str_is_code_point_order", () => {
    const s = ["b", "a", "\u{ffff}", "\u{10000}", "\u{e000}", "ab", "", "\u{1f600}x", "\u{1f600}"];
    s.sort(cmpStr);
    expect(s).toEqual(["", "a", "ab", "b", "\u{e000}", "\u{ffff}", "\u{10000}", "\u{1f600}", "\u{1f600}x"]);
    expect(cmpStr("x", "x")).toBe(0);
    // UTF-16 order would put U+10000 (a surrogate pair) before U+FFFF
    expect("\u{10000}" < "\u{ffff}").toBe(true);
    expect(cmpStr("\u{10000}", "\u{ffff}")).toBe(1);
  });

  it("to_index_saturates_like_as_usize", () => {
    expect(toIndex(3.9)).toBe(3);
    expect(toIndex(-0.5)).toBe(0);
    expect(toIndex(-0)).toBe(0);
    expect(toIndex(-7)).toBe(0);
    expect(toIndex(NaN)).toBe(0);
    expect(toIndex(Infinity)).toBe(USIZE_MAX);
    expect(toIndex(1e30)).toBe(USIZE_MAX);
    expect(toIndex(2 ** 60 + 0.0)).toBe(2 ** 60);
  });

  it("small_helpers", () => {
    expect(len2d(3, 4)).toBe(5);
    expect(clampf(5, 0, 1)).toBe(1);
    expect(clampf(-5, 0, 1)).toBe(0);
    expect(clampf(0.5, 1, 0)).toBe(1); // reversed bounds return lo
    expect(Number.isNaN(clampf(NaN, 0, 1))).toBe(true);
    expect(signEps(1e-13, 1e-12)).toBe(0);
    expect(signEps(-2, 1e-12)).toBe(-1);
    expect(signEps(2, 1e-12)).toBe(1);
  });
});
