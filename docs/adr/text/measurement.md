# Text measurement

A bundled font and a simple shaper that adds integers give bit-identical text widths in
Rust and TypeScript; prepared texts make the width of any line constant-time, and label
boxes fit the ink of their text.

## Context
Text widths must agree between Rust and TypeScript (within 0.01 px for the bundled font),
and the browser and WebAssembly packages must stay small. Wrapping measures many candidate
lines per label: the balanced wrap (spec §5.3) takes the width from every line start to
every break, quadratically many lines per text, and measuring each through the general
measuring function cost about 4,700 instructions.

A text label's box spanned the font's ascender and descender (1.069 and 0.293 em) plus the
padding, while capitals reach 0.714 em above the baseline and descenders 0.24 em below it.
Beside its mark a label's letters stood about 3.3 px off it, above or below it 6–7 px: on
the economies chart of the home page `SAU` above Saudi Arabia's bubble stood about as near
Spain's.

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
- **Ink boxes** (spec §5.2): the metrics fonts carry the vertical bounds of every glyph in a
  private table `LAvb` (`tools/fonts/bounds.py`, 4 bytes per glyph; every other table
  stays as it was). A text block spans from the ink top of its first line to the ink bottom
  of its last, plus the padding. An edge keeps the ascent or descent where its line has no
  ink, for fonts without `LAvb`, with full shaping, and whenever the host measures vertical
  metrics, which say nothing of the bundled font's glyphs. The width stays the advance
  width, which the host's text layout uses.

## Consequences
Latin, Greek and Cyrillic labels measure the same everywhere; other scripts need fonts
from the host, and complex scripts in TypeScript a host measurement. A candidate line
costs about 110 instructions instead of 4,700: wrapping the 1,206 long class names of
benchmark scenario 12 went from 22.5 % to 11.9 % of the solve, with results unchanged bit
for bit. A label above or below its mark stands as close to it as one beside it (`Alpha`
at 12 px is 15.6 px high instead of 19.9), and more labels fit: the economies chart labeled
174 of 195 countries instead of 158, the playground's map 148 labels instead of 125. Hosts
that draw at the reported baselines need no change. SVG text obstacles keep boxes from the
ascender to the descender, as text drawn by others may reach that far.

## Alternatives
- **Less padding or a smaller offset**: would have moved labels beside their marks too,
  where the gap was right.
