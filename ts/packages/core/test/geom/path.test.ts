// Port of the unit tests of rust/crates/la-core/src/geom/path.rs.
import { describe, expect, it } from "vitest";
import { P } from "../../src/geom/index.js";
import { PathError, flatten } from "../../src/geom/path.js";

function flattenError(d: string): PathError {
  try {
    flatten(d, 0.25);
  } catch (e) {
    if (e instanceof PathError) return e;
    throw e;
  }
  throw new Error(`no error for ${d}`);
}

describe("geom::path", () => {
  it("simple_square", () => {
    const p = flatten("M0 0 H10 V10 H0 Z", 0.25);
    expect(p.length).toBe(1);
    expect(p[0]!.closed).toBe(true);
    expect(p[0]!.points.length).toBe(4);
  });

  it("relative_and_implicit", () => {
    const p = flatten("m10,10 5,0 0,5 z m 20 0 l 1 1", 0.25);
    expect(p.length).toBe(2);
    expect(p[0]!.points[1]!.eq(new P(15, 10))).toBe(true);
    expect(p[1]!.points[0]!.eq(new P(30, 10))).toBe(true);
  });

  it("circle_by_arcs_is_round", () => {
    const p = flatten("M 10 0 A 10 10 0 1 1 -10 0 A 10 10 0 1 1 10 0 Z", 0.1);
    const pts = p[0]!.points;
    expect(pts.length).toBeGreaterThan(16);
    for (const q of pts) expect(Math.abs(q.len() - 10)).toBeLessThan(0.11);
  });

  it("cubic_flatness", () => {
    const p = flatten("M0 0 C 0 10 10 10 10 0", 0.05);
    expect(p[0]!.points.length).toBeGreaterThan(4);
    expect(p[0]!.points[p[0]!.points.length - 1]!.eq(new P(10, 0))).toBe(true);
  });

  it("errors_have_offsets", () => {
    const e = flattenError("M0 0 L 10");
    expect(e.offset).toBeGreaterThanOrEqual(8);
    expect(() => flatten("X 1 2", 0.25)).toThrow(PathError);
  });

  it("error_messages_and_offsets_match_rust", () => {
    expect(flattenError("M0 0 L 10").message).toBe("expected a number");
    expect(flattenError("M0 0 L 10").offset).toBe(9);
    expect(flattenError("X 1 2").message).toBe("unknown path command 'X'");
    expect(flattenError("X 1 2").offset).toBe(0);
    expect(flattenError("1 2").message).toBe("expected a path command");
    expect(flattenError("M 0 0 A 1 1 0 2 0 5 5").message).toBe("expected an arc flag (0 or 1)");
    expect(flattenError("M 0 0 A 1 1 0 2 0 5 5").offset).toBe(14);
    expect(flattenError("M 1e999 0").message).toBe("invalid number");
    // offsets are UTF-8 byte offsets; the lexer stops at the first non-ASCII character
    expect(flattenError("M 0 0 é").offset).toBe(6);
  });
});
