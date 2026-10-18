// Font file errors point at the font.file that names the file (as the Rust core does;
// rust/crates/la-cli/tests/cli.rs font_errors_point_at_the_font_file).
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { PlaceError } from "../src/api.js";
import { placeWith } from "../src/place.js";

/** Every file reads as bytes that are no font. */
const garbage: Env = { readFile: () => new Uint8Array([1, 2, 3, 4]) };

function errorOf(problem: unknown): [string, string, string] {
  try {
    placeWith(problem, garbage);
  } catch (e) {
    expect(e).toBeInstanceOf(PlaceError);
    const err = (e as PlaceError).errors[0]!;
    return [err.pointer, err.code, err.message];
  }
  throw new Error("expected a PlaceError");
}

const item = (label: Record<string, unknown>) => ({ anchor: { type: "point", x: 10, y: 10 }, label });

describe("font errors", () => {
  it("point at the defaults, the label or the composite part", () => {
    const msg = "invalid font: not a TrueType/OpenType font";
    expect(errorOf({ defaults: { font: { file: "a.ttf" } }, items: [item({ type: "text", text: "A" })] })).toEqual([
      "/defaults/font/file",
      "invalid_value",
      msg,
    ]);
    expect(errorOf({ items: [item({ type: "text", text: "A", font: { file: "b.ttf" } })] })[0]).toBe("/items/0/label/font/file");
    const parts = [{ type: "icon", width: 4, height: 4 }, { type: "text", text: "A", font: { file: "c.ttf" } }];
    expect(errorOf({ items: [item({ type: "composite", parts })] })[0]).toBe("/items/0/label/parts/1/font/file");
  });
});
