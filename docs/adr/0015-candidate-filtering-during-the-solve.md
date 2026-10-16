# 0015 — Candidates are filtered against placed labels and item marks while they are generated

* Status: accepted (performance; spec §6.7)
* Date: 2026-10-16

## Context
Profiling the 2,000-label / 100k-point scenario and benchmark scenario 12 (1,206 long
class names) showed that items that do not fit run the whole degradation ladder, and
every step generates hundreds of candidates (wrapped, shrunk, distant, boundary
variants) of which > 95 % overlap labels that are already placed or other item marks.
Creating, storing, evaluating and later re-checking them dominated the solve (1.5 M
candidates, 3 s).

## Decision
* Candidates generated while labels are placed (ladder steps, on-demand distant
  candidates) are not stored when a placed label or leader of **higher or equal
  priority** blocks them (hard). They cannot be used while that label stays, and they
  can never be `evict_lower` targets or witnesses of a priority inversion, which only
  involve strictly lower-priority labels. Level-0 candidates are complete before the
  greedy pass starts, so local search keeps its insertion moves.
* Two occupancy grids make the rejection cheap and exact before leaders are built: one
  of placed rectangular labels (used only when all placed labels have a key ≤ the
  item's), and a static one of item marks (when labels may overlap no mark: `items` and
  the own-mark policy hard; internal candidates exempt). A box is rejected when its
  interior contains the center of an occupied cell (with a 2·EPS margin), which implies
  an overlap; overlaps thinner than a cell fall through to the exact test.
* Statically dropped candidates are counted per item and reported as `items` among the
  blocking classes, so explanations are unchanged.
* `DynIndex` queries return ids in bucket scan order (deterministic for a given history)
  instead of sorting them.

## Consequences
Placements are identical where the filter only removes candidates that could not be
used; on-demand distant candidates drop blocked positions before the `k_distant` cut,
which can only improve results. p2000: 3.0 s → 0.5 s; scenario 12: 0.72 s → 0.32 s.
Profile notes are in the commit messages (callgrind instruction counts: 12.9 G → 3.4 G
for p2000). The TypeScript port mirrors the same rules.
