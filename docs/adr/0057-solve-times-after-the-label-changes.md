# 0057 — Solve times after the label changes: ellipse distances in closed form, a lighter local search, freed memory kept

* Status: accepted (Rust `la-core` and `la-cli`, TypeScript `@label-anything/core`; placements unchanged, the last digits of a few costs change)
* Date: 2026-10-24

## Context
After ADR 0050–0055 the solves were slower on some problems. Timed against the main
branch before ADR 0050, single-threaded in steady state (`--warmup`, median of 3–5 runs,
the engine's own `runtime_ms`), the 94 benchmark, sample, tutorial, showcase and
playground problems that stay within the time guards took 2.9 % longer in all (2,749 ms
against 2,671 ms); most were as fast or faster, as the ink boxes of ADR 0052 conflict
less, but some were much slower. Instruction counts (callgrind, `--no-clock`) and the
solves' phases showed five causes:

* **Ellipse marks.** The distance from an ellipse to a box was a ternary search of 60
  steps along each side of the box: about 490 point-to-ellipse distances, each a
  bisection of up to 64 steps. On the node-link graph with ellipse and rectangle marks
  (`lesmis-shapes`) it took 82 % of the main branch's instructions. The own-mark rule of
  ADR 0051/0054 measured every candidate's distance to its own mark, and step 6 of the
  evaluation measured the same distance again for the distance term: 1.46 G instructions
  became 2.49 G, 357 ms 636 ms, and both hit the time guard.
* **Text ink.** A one-line label measured the ink of its line twice, as its first and as
  its last line (2 % of the 1,206-item priority problem).
* **Memory.** In steady state, mimalloc v3 returned memory freed by one solve to the
  system (it purges what stays free for a while), and the next solve faulted it in again;
  with transparent huge pages that cost 20–50 ms of system time now and then, more often
  on the branch (whose allocations happened to commit 79 MiB instead of 46 MiB in a row of
  solves, without allocating more: the heap peaks were 9.6 MB on both). The CLI's
  `Cargo.toml` already meant freed memory to be reused.
* **The local search.** The label spacing of ADR 0054 makes more candidates conflict, so
  more insertions fail and the local search runs about three times as many relocation
  chains on line-end labels and dense maps (life expectancy, 62 lines: 2,496 instead of
  824). A chain looks for a free candidate of the label it moves; finding none, it
  computed the whole conflict set of each of the label's first 16 candidates again, to
  find one with a single blocker. And every placement and removal marked the label in the
  occupancy grid of placed labels (about 350 cells of 2 px for a 100 px label), which only
  candidate generation reads.
* **More work.** The ink boxes let more candidates through (the 2,000-label performance
  problem places 994 labels instead of 871, from 59,678 candidates instead of 51,326).

## Decision
* **Ellipse to box in closed form.** For a box disjoint from a convex shape, the nearest
  point of the box is one of its corners, or lies inside a side, straight across from the
  shape's extreme point in that side's normal direction. The distance is the least of the
  four corners' distances and of the gaps to the ellipse's four axis-extreme points (its
  support points) that face a side within its span: four point-to-ellipse distances
  instead of about 490. Degenerate ellipses, which `signed_distance` treats as discs, keep
  the search. Rust and TypeScript compute it alike; it matches the search within 1e-9 on
  2,000 random ellipses and boxes (a unit test).
* **The own distance once.** The evaluation reuses the distance of the own-mark rule for
  the distance term.
* **Ink once** for a label of one line.
* **Relocation chains reuse their first scan.** The scan for a free candidate notes the
  first blocker of each of the first 16 candidates; whether it is the only one is then
  asked directly (the first conflict other than it) instead of computing the whole
  conflict set again. Every branch of a chain restores the placement it changes, so the
  blockers stay valid. Rust and TypeScript (`firstConflict` takes an item to leave out).
* **Occupancy marks deferred** in the Rust state, as the TypeScript state already did:
  placements and removals are logged, a placement removed before the grid is read again
  cancels out, and the rest are applied in order when candidate generation reads the
  grid, which then is the grid it was before.
* **Verification** collects the placed labels with leaders, and their boxes, once instead
  of computing two boxes for every pair of placed labels (Rust; the TypeScript
  candidates keep their boxes, and its loop now runs over labels with leaders only).
* **The CLI keeps freed memory** (mimalloc's purge delay −1, unless `MIMALLOC_PURGE_DELAY`
  is set): repeated solves in one process (`--warmup`, `bench`, `serve`) reuse it.

Tried and dropped: visiting a relocation's candidates by their static cost, which bounds
the total from below, and stopping at the first that could not win. It left every result
unchanged (121 problems compared), but most cheap candidates of a dense map are not free,
so the sorting cost more than it saved (+7 % on the playground's map).

## Consequences
* The ellipse distance changes the last digits of a few costs (the geometry oracle: 2 of
  3,508 values; the parity fixtures: 3 costs of `place-stubs-mark-shapes`, no placement);
  the other changes leave every result as it was (121 problems compared field by field).
* Instructions of one solve, main → before → now: `lesmis-shapes` 1.46 G → 2.49 G →
  123 M; the conformance sample `shapes-nodes` 49 → 76 → 16 M; the shapes tutorial 74 →
  102 → 34 M; the 62 line-end labels of life expectancy 468 → 808 → 686 M; the
  playground's map 760 → 1,115 → 930 M; the straight-leaders tutorial 31 → 45 → 38 M;
  the 2,000-label problem 1.91 → 2.10 → 2.05 G. On the line-end labels the chains alone
  save 5.5 %, the deferred marks another 8.7 %.
* Timed as above, the 97 problems that stay within the time guards take 3,158 ms in all,
  5.5 % less than on main (3,341 ms); the geometric mean of the ratio to main is 0.86, and
  65 problems are more than 5 % faster than on main, 14 more than 5 % slower (with the
  first four changes alone: 3,329 ms, 0.95, 41 and 22). `lesmis-shapes` takes 14.9 ms
  instead of 363 ms (main, at the time guard).
* The TypeScript engine (median of 5 solves after 3 warm-ups; main → before → now):
  `lesmis-shapes` 405 → 722 → 50 ms, `shapes-nodes` 14.6 → 24.1 → 7.1 ms, the shapes
  tutorial 24.7 → 39.3 → 17.0 ms, 200 labels 37.7 → 59.7 → 37.7 ms, the playground's map
  150 → 233 → 167 ms, the line-end labels 136 → 217 → 187 ms.
* What stays slower is more work for better results: the 2,000-label problem takes 11 %
  longer than on main (224 ms against 199 ms with `bench.perf`; the target of 120 ms is
  missed by both) for 14 % more labels; the line-end labels of life expectancy (65 ms
  against 41 ms, 37 labels instead of 35) and the playground's map (86 ms against 75 ms,
  132 labels instead of 125) search longer under the label spacing; the 250 European
  airports in prefix mode get 193 labels instead of 54, in 29 ms instead of 24 ms.
* The WebAssembly module grows by 1,374 bytes to 999,934 bytes gzipped: 66 bytes under
  the budget of 1 MB that CI checks.
* `conformance/geometry/core-geometry.json` and the parity fixture
  `place-stubs-mark-shapes.json` were regenerated.
