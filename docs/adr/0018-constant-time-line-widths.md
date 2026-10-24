# 0018 — Constant-time line widths from prepared texts

* Status: accepted
* Date: 2026-10-16
* Area: Text
* Affects: spec §5.2–5.3; performance, no behaviour change

## Context
Profiling benchmark scenario 12 (`metrics-attr-strict`: 1,206 long Java class names at
10 px, no wrap settings, so the `wrap` ladder step runs `extra_wrap_variants` with up to
3 lines) showed `labels::ladder_variants` at 22.5 % of all instructions, 16 % in
`extra_wrap_variants` alone. `balanced(N, M)` (§5.3) takes the width of the line from
every line start `s` to every break `k ≥ s`, O(B²) lines per text, and each went through
the `measure` callback: `Measurer::width` resolves the font, checks for complex scripts and
shapes the whole line again, ≈ 4,700 instructions per line.

## Decision
* Simple shaping (§5.2) adds up integer advances and pair-kerning adjustments, so a
  **prepared text** (`MeasuredText` in `label-anything-text` and `@label-anything/text`)
  gives the advance of any code point range in constant time after one linear pass:
  prefix sums of the advances plus, per kern lookup, the adjustments its walk adds from
  every position on. `advance_units(start, end)` equals `Font::advance_units` of the
  substring exactly, so widths are bit-identical.
* Kerning is not quite a sum over adjacent pairs, and the preparation follows the walk of
  §5.2 exactly: under IgnoreMarks the positions are the non-mark glyphs (a GDEF property,
  independent of the Unicode marks of the break rules), and a pair whose ValueFormat2 ≠ 0
  makes the walk skip its second glyph, so walks that start at different positions can
  visit different pairs. Per lookup, `walk[t]` is the sum the walk from position `t` adds
  to the end; a range adds `walk[first] − walk[stop]`, where `stop` is the first position
  the walk reaches at or after the range's last glyph. Within a run of consecutive
  skipping pairs a walk visits every other position, and a walk that starts before the run
  enters it at its first pair, so `stop` follows from the parity of the range's start and
  the run's start. Lookups without skipping pairs in a text are summed into one prefix-sum
  track per IgnoreMarks flag (the bundled Noto Sans has two kern lookups, both of that
  kind).
* The wrapping functions take a `Measure`: `Measure::Font { font, size }` (TypeScript: a
  `FontMeasure` `{ font, size }`) prepares each text once and measures its candidate lines
  from it; `Measure::Callback` (TypeScript: a function) keeps the per-line callback and its
  cache for host measurement and full shaping, whose widths are not sums over glyphs.
  `&closure` converts into a `Measure`, so callers of the closure API are unchanged.
* The core uses `Measure::Font` when `Measurer::width` would measure every string that
  wrapping and truncation produce with simple shaping: no host measurement callback, and
  `text.shaping` `simple`, or `auto` for a text without complex scripts (its lines,
  prefixes and `…` contain only its own code points and U+2026). `Env::has_measure_callback`
  says whether `Env::measure` may return `Some`; it defaults to `true`, which is always
  correct, and is `false` for `BasicEnv`, `NativeEnv`, the C ABI, the clockless
  environments of the CLI and of `place_oracle`, and a Python or WebAssembly solve without
  a `measure` callback. The TypeScript core mirrors it (`Env.hasMeasureCallback`,
  `Measurer.wrapMeasure`); without full shaping there, only the host measurement decides.

## Consequences
Results are unchanged, bit for bit: the text conformance cases run through both measures
(variants compared bit for bit), randomized tests compare every range of random texts and
of random kerning tables (marks, IgnoreMarks, skipping pairs) with simple shaping, and the
core compares both paths on every sample problem.

Profile note (callgrind, release build; scenario 12 `metrics-attr-strict` with
`solver.time_budget_ms: 1e6, max_iterations: 10000`, i.e. the default 10,000-move budget
without the wall-clock guards of ADR 0007, which otherwise fire at different points under
valgrind): 2,360 M → 2,076 M instructions (−12.0 %); `ladder_variants` 531 M → 247 M
(22.5 % → 11.9 % of the solve), `extra_wrap_variants` 376 M → 88 M, `Wrapper::balanced`
337 M → 58 M. A candidate line costs ≈ 110 instructions instead of ≈ 4,700, plus ≈ 13.5 k
per text for the preparation; `Font::advance_units` itself is unchanged. Wall clock
(median of 15): greedy phase 212 → 189 ms in this configuration, 228 → 188 ms as given.
Placements and all statistics except timings are byte-identical to the previous build in
this configuration on all 18 problems of scenario 12, and as given on the sample
problems. Where a wall-clock guard fires the results depend on timing in both builds, as
before: given as is, `metrics-attr-strict` comes close to the 300 ms guard of local
search, which cut it after 1,280 to 6,144 moves in 4 of 10 runs; the new build completed
all 10,000 moves in 9 of 10 runs, and those placed exactly the guard-free result.
TypeScript: `extraWrapVariants` over the same 1,206 names takes ≈ 40 ms with a
`FontMeasure` instead of ≈ 63 ms with the callback (Node 22).

What remains of `ladder_variants` is mostly `text_variant`, which measures the final lines
of every variant again with `Measurer::width` (also at every shrink scale), and the
candidate sort of `balanced` itself.
