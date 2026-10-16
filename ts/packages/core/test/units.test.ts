// Port of the unit tests of rust/crates/la-core/src/units.rs (same names), plus checks of
// the places where JavaScript and Rust string/number parsing differ.
import { describe, expect, it } from "vitest";
import { Length } from "../src/units.js";

describe("units", () => {
  it("parses_units", () => {
    expect(Length.parse("12px")).toEqual(Length.Px(12));
    expect(Length.parse("9pt")).toEqual(Length.Px(12));
    expect(Length.parse("0.5em")!.px(12)).toBe(6);
    expect(Length.parse(".5em")!.px(10)).toBe(5);
    expect(Length.parse("3 px")).toBeNull();
    expect(Length.parse("3")).toBeNull();
    expect(Length.fromValue(4)).toEqual(Length.Px(4));
  });

  it("follows Rust's f64 grammar and trim", () => {
    expect(Length.parse("5.px")).toEqual(Length.Px(5));
    expect(Length.parse("-.5em")).toEqual(Length.Em(-0.5));
    expect(Length.parse("-3px")).toEqual(Length.Px(-3));
    for (const bad of [".px", "-px", "--3px", "3-px", "1.2.3px", "1e3px", "+3px", "px", "", "3PX", "３px"]) {
      expect(Length.parse(bad), bad).toBeNull();
    }
    // str::trim removes Unicode White_Space (U+0085 included, U+FEFF not), unlike String.trim
    expect(Length.parse(" \t2px\n")).toEqual(Length.Px(2));
    expect(Length.parse("\u00852px　")).toEqual(Length.Px(2));
    expect(Length.parse("﻿2px")).toBeNull();
    // not finite
    expect(Length.parse(`1${"0".repeat(400)}px`)).toBeNull();
    expect(Length.parse("4pt")!.px(0)).toBe((4 * 4) / 3);
    expect(Length.fromValue(true)).toBeNull();
    expect(Length.fromValue(null)).toBeNull();
    expect(Length.Em(2).px(7)).toBe(14);
  });
});
