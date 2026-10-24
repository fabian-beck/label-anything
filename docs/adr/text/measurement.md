# Text measurement

A bundled font and a simple shaper that adds integers give bit-identical text widths in
Rust and TypeScript; prepared texts make the width of any line constant-time.

## Context
Text widths must agree between Rust and TypeScript (within 0.01 px for the bundled font),
and the browser and WebAssembly packages must stay small. Wrapping measures many candidate
lines per label: the balanced wrap (spec §5.3) takes the width from every line start to
every break, quadratically many lines per text, and measuring each through the general
measuring function cost about 4,700 instructions.

## Decision
- **Font**: Noto Sans 2.015 Regular and Bold (SIL OFL 1.1), subset to Latin, Greek and
  Cyrillic with punctuation, hinting removed (`tools/fonts/subset.py`). Only a
  metrics-only copy without outlines is embedded (≈ 80 KB, 28 KB gzipped); the copies with
  outlines (≈ 243 KB) are for drawing.
- **Simple shaping** (spec §5.2): cmap, hmtx advances and GPOS pair kerning, summed as
  integers in font units and scaled once at the end, so widths are bit-identical.
- **Full shaping** for complex scripts exists in Rust only (rustybuzz). TypeScript
  measures them with simple shaping unless the host passes a `measure` callback or sizes.
- **Prepared texts** (`MeasuredText`): since simple shaping only adds, one pass over a
  text yields prefix sums of advances and kerning, and the width of any range of it costs
  constant time and equals measuring the substring — including kerning walks that skip a
  glyph and IgnoreMarks. The core uses them whenever simple shaping measures everything
  wrapping produces (no host measurement callback); host measurement and full shaping,
  whose widths are not sums, keep the per-line callback.

## Consequences
Latin, Greek and Cyrillic labels measure the same everywhere; other scripts need fonts
from the host, and complex scripts in TypeScript a host measurement. A candidate line
costs about 110 instructions instead of 4,700: wrapping the 1,206 long class names of
benchmark scenario 12 went from 22.5 % to 11.9 % of the solve, with results unchanged bit
for bit.
