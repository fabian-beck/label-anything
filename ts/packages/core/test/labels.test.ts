// Port of the unit tests of rust/crates/la-core/src/labels.rs.
import { describe, expect, it } from "vitest";
import { BasicEnv, type Env } from "../src/env.js";
import { Measurer, bundledFonts } from "../src/labels.js";
import { FontSel } from "../src/model/index.js";
import { OptionsEnv } from "../src/place.js";

/** An environment that declares a host measurement callback (the default). */
const hostMeasure: Env = {};

describe("labels", () => {
  // TypeScript has no full shaping, so unlike in Rust only the host measurement decides.
  it("wrap_measure_uses_the_font_for_simple_shaping_without_host_measurement", () => {
    const font = new FontSel("default", 400, false, 12, 1.2, null);
    const width = (): number => 0;
    const prepared = (env: Env, shaping: string): boolean => {
      const measure = new Measurer(bundledFonts(), env, shaping).wrapMeasure(font, 1.5, width);
      if (typeof measure === "function") return false;
      expect(measure.size).toBe(18);
      return true;
    };
    for (const shaping of ["auto", "simple", "full"]) {
      expect(prepared(new BasicEnv(), shaping)).toBe(true);
      expect(prepared(hostMeasure, shaping)).toBe(false);
    }
    expect(prepared(new OptionsEnv({}), "auto")).toBe(true);
    expect(prepared(new OptionsEnv({ measure: () => null }), "auto")).toBe(false);
  });
});
