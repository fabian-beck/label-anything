# Literature and improvement notes

What the research literature on label placement suggests for Label Anything: where the
engine stands against known methods, which of its algorithmic parts could still improve,
and where its building blocks come from. These are notes, not decisions: an idea below
becomes a change only with a measurement on the [benchmark](benchmark.md) and an ADR.

The notes were compiled on 2026-10-18 with an AI coding assistant (Claude Code): five
literature searches, one per topic, and a reading of the code. The working notes, one
section per source with the search query, what was read and how far the citation was
checked, are in [`docs/project/literature/`](gh:docs/project/literature/README.md);
[provenance](#provenance-of-these-notes) says what that means for the citations below.

## The starting point

The benchmark page lists what the engine does badly
([what the results show](benchmark.md#what-the-results-show),
[where the time goes](../benchmark.md#where-the-performance-targets-stand)). The searches
targeted these weaknesses:

| # | Weakness | Measured |
|---|---|---|
| W1 | dense data loses labels | 501 of 1,000 airports, 872 of 2,000 random points |
| W2 | the local search adds little | +0.7 % priority-weighted placement over greedy with the ladder; 20 times the iterations at most +1.7 % (M4) |
| W3 | many and long leaders in crowds | 14 of 32 Gapminder labels, up to 8–11 em, some across large marks |
| W4 | labels move and flip in animations | 2.3–3.4 px per frame; on the zoom-and-pan sequences 11.6–15.5 % of the labels change side per frame (ADR 0025), and the gallery flags more than 10 % per zoom step |
| W5 | large problems are slow | 2,000 labels over 100k points: ~300 ms natively (target 120 ms); two thirds in the greedy pass, mostly the ladder of labels omitted in the end |
| W6 | crowded line ends | a fan column grows only as far as its leaders stay within `leaders.max_length` |

## Summary

The engine already follows the literature in its main structure: candidate positions
(fixed and slider models, Formann & Wagner 1991, van Kreveld et al. 1999), a conflict
graph with priorities (an independent set problem, Agarwal et al. 1998), a greedy
construction followed by simulated annealing (Christensen et al. 1995), exact hard
constraints, mixed internal and external labels (Čmolík et al. 2022) and boundary columns
stacked by isotonic regression. Three gaps stand out:

1. **The optimization after the greedy pass is weak by construction** (W1, W2). The local
   search changes the set of labels only by inserting one (evicting labels of lower
   priority if need be), and the exact search runs only for problems with at most 3,000
   candidates, with a bound that ignores conflicts between the items still to decide. The
   literature's strongest methods for
   label-number maximization — POPMUSIC decomposition (Alvim & Taillard 2009, used in
   QGIS's labeling engine), independent-set local search with (1,2)-swaps (Andrade et al.
   2012) and Lagrangean bounds (Ribeiro et al. 2011) — fit the engine's deterministic,
   iteration-budgeted design. Before building any of them, an upper bound should tell
   whether the omitted labels of W1 are lost to geometry or to the algorithm.
2. **Labels without room are discovered expensively** (W5). Most of the time of the large
   problem goes into ladder variants of labels that are omitted anyway. A conservative
   "does the smallest variant fit anywhere within reach" test on the occupancy grid
   looked like a way to detect them before any candidate is built; measured, it is not
   (S1, ADR 0034).
3. **Animations are solved frame by frame** (W4). The dynamic-labeling literature gets
   consistency from zoom-aware selection (active ranges, Been et al. 2006, 2010) and from
   preferring a label's previous side (as MapLibre does) — both possible without the
   engine-side hysteresis that ADR 0026 rejected, because they change which candidate a
   label takes, not whether it is shown.

Learning-based placement (Bobák et al. 2024, Qu et al. 2025) is not a candidate for the
solver: it gives up determinism and the bit-identical TypeScript port, and generative
models are weakest at the part the engine solves combinatorially, choosing which labels to
show (Oucheikh & Harrie 2024).

## Improvement opportunities

Ranked within each area by expected effect. "Code" names where the change would go.

### Optimization (W1, W2)

**O1 — Measure the gap before optimizing further.** A Lagrangean relaxation of the
conflict constraints needs no LP solver, is deterministic and decomposes per item at every
subgradient step (Zoraster 1990; Ribeiro & Lorena 2008a, 2008b; Ribeiro et al. 2011,
which proved optimality on all but one of the literature instances). Its upper bound
("501 placed, at most N placeable") tells whether W1 is geometric or algorithmic; its
penalized costs can order the greedy pass and prune candidates. Offline, the ILPs of
Klau & Mutzel (2003, slider models) and Haunert & Wolff (2017, with label interactions)
give exact references for small benchmark scenes, and loaders for the published
point-labeling instances (the Lorena group's sets up to 13,206 points, Alvim & Taillard's
real-data instances, the dynaMIS data of Bhore et al. 2022) would compare the optimizer
with best-known results independently of the cost model. *Code:* `bench/` (new metric),
optionally `stats` in the result.

**O2 — POPMUSIC with the exact search as subproblem solver.** Take a seed item (unplaced
items first), its nearest items in the conflict graph up to a few hundred candidates,
fix all other labels, and solve the part exactly with the existing branch and bound,
starting from the current labels so that nothing gets worse; re-queue the part's items
after an improvement and stop when no seed is left or the budget is spent (Alvim &
Taillard 2009; the POPMUSIC parameters in QGIS's `libpal`; cluster decompositions in
Ribeiro & Lorena 2008a, 2008b; independent subproblems solved to optimality in Borowitz
et al. 2025; local exact re-solving inside QGIS in Klute et al. 2019). Today the exact
search never runs on the dense scenes: `auto` uses it only with at most 3,000 candidates
and a budget of at least 500 ms. *Code:* `rust/crates/la-core/src/lib.rs:210-218`,
`solver/exact.rs`, a new phase between local search and fan labels (and the TypeScript
port).

**O3 — A stronger branch and bound.** Three changes make O2 affordable:

* *Split into components.* The search runs over all items at once (`solver/exact.rs`);
  the connected components of the candidate conflict graph can be solved independently,
  because the priority objective of the `strict` and `weighted` modes and the cost are
  sums over items (not in `prefix` mode, whose objective depends on the global order).
  This is a code observation of these notes, not from a source.
* *A conflict-aware bound.* The bound "every remaining item at its cheapest candidate"
  (`solver/exact.rs:75`) ignores conflicts among the remaining items and counts
  candidates that already conflict with chosen ones. Forward checking (cheapest
  compatible candidate), clique-cover bounds (all candidates containing a common point
  conflict pairwise) or strip bounds for labels of one height (horizontal lines one label
  height apart, interval scheduling per line; Agarwal et al. 1998) are much tighter;
  LP-based MIS branch and cut solved map-labeling instances of up to 950 cities in 2000
  (Strijk et al. 2000; Verweij & Aardal 1999).
* *Order by fewest remaining candidates* within equal priority.

ADR 0014 should also say that the exact objective is the static cost only
(`exact.rs:212`).

**O4 — Neighbourhoods that change the number of labels.** *Measured on 2026-10-18 (ADR
0035): not adopted.* With the default priorities every item has its own key, so in
`strict` mode trading one label for two of lower priority makes the objective worse, and
the useful case — inserting a more important label — is already the eviction move. Where
weights add up or keys tie, a prototype added up to 1 % labels (one to three accepted
swaps per solve). The text below is the idea as first written.

The local search keeps the priority objective from ever getting worse
(`solver/local.rs`), so annealing acts on cost alone and the label count rises only
through `try_insert`. The independent-set
literature's workhorse is the (1,2)-swap: remove one label, insert two; Andrade et al.
(2012) find one, or show that none exists, in linear time; online reductions speed it up
further (Dahlum et al. 2016; Lamm et al. 2017; weighted: Großmann et al. 2024). With
priorities, a swap may remove a label of lower or equal key and insert two that the
priority objective values more. Searches may also pass through states with conflicting
labels: in the model of Mauri et al. (2010) every point gets a position and only
conflict-free labels count, and the notes recall (from memory, not from the source) the
annealing of Christensen et al. (1995) working the same way. Keeping the best-so-far
snapshot, as `local.rs` already does, keeps the returned result from getting worse.
Smaller points from the code:

* relocations draw an item uniformly (`local.rs:211`); drawing near unplaced items
  concentrates the work where labels are missing (the intensification of POPMUSIC and
  clustering search);
* the schedule cools from T₀ to T₀/1000 in 10,000 moves — about five moves per item for
  2,000 items, where classical schedules make the trials per temperature proportional to
  the problem size (Johnson et al. 1989; recalled in the notes, not read); since 20
  times the iterations add at most 1.7 %, the neighbourhood matters more than the
  length;
* `try_insert` takes the first ejection chain that works (`local.rs:354`) instead of the
  cheapest of those tried (Glover 1996, unverified).

**O5 — Continuous sliders where room is scarce.** Sliders label more points than fixed
positions "in theory and in practice" (van Kreveld et al. 1999). Instead of four sampled
slider positions per quadrant, the free interval along a side, given the placed
neighbours, yields the position closest to the preferred one with a single interval
computation (exact slider models: Klau & Mutzel 2003). Useful inside O2's subproblems and
in the ladder.

### Speed (W5)

**S1 — Detect labels without room before the ladder.** *Measured on 2026-10-18 (ADR 0034):
not adopted.* On the 2,000-label problem, 1,128 items run the ladder and are omitted; only
18 of them have every candidate box rejected by the occupancy grids — the others fail on
discrete positions, the label margin and overlaps thinner than a cell, which only the
exact test sees. A sound pretest therefore skips almost nothing. The same profile led to
resolving the item option defaults once (−3.3 % instructions). The text below is the idea
as first written.

Before an item runs the ladder, test conservatively whether the smallest box the ladder
could produce (after `wrap` and the last `shrink`) fits anywhere within reach of the item
(anchor ± `max_distance` or `max_length`): mark the cells occupied by hard obstacles and
by labels of equal or higher key, build a summed-area table of them, and look for a free
window of that size; a second table answers "any fit in this rectangle" in constant time
per item. When nothing fits, the item skips the steps that only generate candidates
(keeping `evict_lower` when labels of lower key lie within reach, and `soft_overlap`). The
occupancy grid and its summed-area table exist already (`grid/occupancy.rs`, ADR 0015);
the approach follows the occupancy bitmaps of Kittivorawong et al. (2020) and Pavlovec &
Čmolík (2022) and the conflict particles of Luboschik et al. (2008); exact
largest-empty-rectangle algorithms (Naamad et al. 1984; Chazelle et al. 1986) are
background, not needed. Caveat: candidates the ladder builds are reused by the local
search, so skipping them can change results even when the ladder would not have placed the
label; the explanation of the omission (`reason`, `blocked_by`, 13 % of the time) must
stay the same. The specification already promises early rejection by the distance
transform (spec §4.7), which the code does not do: the transform drives only the
free-space seeds (`leaders.rs:272-275`).

**S2 — Safe reduction rules.** Wagner et al. (2001) shrink the conflict graph without
losing an optimal solution (a candidate without conflicts is taken and its item's other
candidates deleted; further rules, from memory in the notes, cover pairs and cliques) and
report near-optimal results with a simple heuristic at a fraction of the time of
simulated annealing. Dominated candidates — no cheaper than another candidate of the same
item and conflicting with a superset of what it conflicts with — can be dropped too.
*Code:* before the greedy pass and inside O2's subproblems.

**S3 — Candidates from free space.** Distant candidates are 4 rings × 16 directions plus up
to 8 free-space seeds, of which 24 are kept. Generating them at maxima of the distance
transform where the box fits, and measuring clearance at the label's aspect ratio (an L∞
distance on coordinates scaled by height/width instead of the Euclidean one, in the
distance transform and in `polylabel`), would make seeds and internal positions the
centres of the largest boxes rather than the largest circles (Luboschik et al. 2008; Mote
2007; Lhuillier et al. 2019).

**S4 — Incremental re-solves.** In interactive use, keep the previous placement fixed and
re-solve only the items whose warm box became infeasible, the items entering the view, and
their conflict neighbours (dynamic independent sets: Bhore et al. 2022); place anchors in a
band outside the canvas too, as MapLibre does with 100 px of padding "so that the bulk of
the changes occur offscreen". Helps W4 as well.

### Leaders and crowds (W1, W3, W6)

**L1 — Choose a column's members and slots together.** A fan or boundary column is
stacked by isotonic regression and its slots assigned by the Hungarian method
(`solver/repair.rs:13-121`) — the standard technique, which the `directlabels` R package
uses too; members that do not fit are evicted and the column is laid out again. A
one-dimensional dynamic program over the sorted anchors can select members by priority and
place them in one pass, with each member's window given by `max_length` and the column's
distance; trying a few distances gives the best column (dynamic programs for boundary
labeling with length and bend costs: Bekos et al. 2007; Benkert et al. 2009). ADR 0022
already notes that a column is a joint decision; this makes it an optimal one.

**L2 — More than one column.** When a column is full within `max_length`, a second column
further out, or a column on the other side, takes the rest (multi-stack and multi-sided
boundary labeling: Nöllenburg et al. 2010; Kindermann et al. 2016). For line charts,
`directlabels` labels whichever end of the series is more spread out.

**L3 — Contour labeling for two-dimensional crowds.** Where fans do not form (a crowd
surrounded by other marks, as in Gapminder), labels on an offset contour around the crowd,
ordered by angle and connected by straight leaders, cannot cross and have bounded length
(radial contour labeling: Niedermann et al. 2017; focus regions: Fink et al. 2012;
excentric labeling: Fekete & Plaisant 1999, Bertini et al. 2009).

**L4 — Route leaders around large marks.** A distant candidate whose straight leader runs
too close to a large mark is rejected (or costs, when soft). Trying other start points on
the shape, a one-bend leader, or a leader along the descent of the density field
(Lhuillier et al. 2019) first would keep more labels near their marks; mixing leader
types restores feasibility in boundary labeling (Bekos et al. 2010).

**L5 — One bend, not two, in orthogonal columns.** The readability study of Barth et al.
(2019) recommends `po` leaders (one bend) as the best compromise between task performance
and preference and does not recommend `opo` (from the abstract). *Corrected on
2026-10-18 (ADR 0036):* spec §7 said that the `orthogonal` style draws `opo` leaders to
boundary labels, which is what this note first took over; both implementations draw `po`
leaders. The spec and the leaders tutorial now say so, and a conformance case checks it.

**L6 — A budget for leaders in the scene.** A cost or limit on the number and total length
of leaders would make an 11 em leader compete with omission at the scene level (clutter-aware
layout: Meng et al. 2015; layout metrics: Hartmann et al. 2005).

### Interactive stability (W4)

**D1 — Zoom-consistent selection.** For hosts that zoom (maps, zoomable scatterplots), solve
from coarse to fine levels and carry each label into the next level at its candidate and
side, letting only new items compete for the room left; or, for fixed-offset candidates,
compute for each item the zoom from which a candidate stays free and filter per frame
(active ranges: Been et al. 2006, 2010; approximation: Liao et al. 2016; disk labels:
Krumpe 2018; rotating maps: Gemsa et al. 2016a). Labels kept when zooming in
(`nesting`) then approach 100 % and their side flips 0, and a view's labels no longer
depend on the path to it. Caveat: two labels facing each other can separate, collide and
separate again as the scale grows, so a lock-in must allow one switch; general dynamic
point labeling is PSPACE-complete (Buchin & Gerrits 2013).

**D2 — Keep the side first.** When the warm box and its nudges are not free, try the
candidates on the label's previous side before all others, and charge a side change
explicitly; MapLibre runs such a pass ("prefer placement using same anchor, if it's still
available"). Today the stability term counts distance only and is capped, so a flip to the
other side costs about as much as any move of 5 em. This changes which candidate a label
takes, not whether it is shown, so strict priority is unaffected — the objection of ADR
0026 to hysteresis. ADR 0025 measured a stability term that keeps growing and found more
labels added and removed; this pass must be measured on the same sequences.

**D3 — Transitions planned by the engine.** The result could say per changed label whether
it should slide or fade: slide only when the interpolated boxes stay clear of the others,
else fade (transition models with overlap bounds: Depian et al. 2023; 300 ms fades in map
renderers). `LabelMotion` (ADR 0026) would follow the plan instead of always gliding.

**D4 — A speed limit.** A soft limit on how far a label's offset may change per solve, with
farther moves allowed only as fade-out and fade-in at a higher cost (the speed–overlap
trade-off of de Berg & Gerrits 2013; temporally coherent real-time labeling: Vaaraniemi et
al. 2012).

**D5 — Known frame sequences.** For an exported animation or a recorded camera path, choose
per label long intervals at one candidate with few switches (trajectory-based and temporal
map labeling: Gemsa et al. 2013, Barth et al. 2016; temporally stable boundary labels:
Bobák et al. 2020). This also gives the benchmark a reference for the interactive mode.

**D6 — A density budget across zoom.** A label budget per view after the radical law
N_d = N_s·√(M_s/M_d) (Töpfer & Pillewizer 1966), filled in priority order, leaves room
that late labels would otherwise take and lose at the next step (adaptive information
density: Tatzgern et al. 2016).

**D7 — Benchmark additions.** Zoom-out steps and round trips (does the same view get the
same labels?), a flicker count (a label shown, hidden and shown again within a few frames),
and the distribution of label speed per frame (scenario 11 zooms in only).

### Cost model and evaluator

**Q1 — Report quality per criterion.** The evaluator already measures overlaps, coverage,
leaders, ambiguity and positions; the formal evaluations of van Dijk et al. (2002) and Fan
et al. (2005) and the multi-criteria models of Rylov & Reimer (2014, 2015) add criteria the
cost model lacks, such as contrast against a raster basemap and its layer hierarchy (Rylov
& Reimer 2015).

**Q2 — Weights backed by studies.** The perceptual position order rests on a study (Bobák et
al.; the project cites it as CVM 2026; the searches found the preprint arXiv:2407.11996 but
no CVM record). Participants of Scheuerman et al. (2023) preferred labels aligned with
their point over labels close to it, which suggests an alignment term. No study was found
that measures to which point a reader assigns a label, so the `ambiguity` term has no
perceptual calibration; a pairwise-comparison study like that of Bobák et al. (2024) could
provide one.

## Provenance of the building blocks

Where the algorithms already in the code come from, and whether the code matches. Status
as in the bibliography.

| Building block | Code | Source | Status | Matches? |
|---|---|---|---|---|
| summed-area tables | `grid/mod.rs`, `grid/occupancy.rs`, ADR 0005 | Crow 1984 | VERIFIED-SEARCH | yes; ADR 0005 does not cite it |
| exact Euclidean distance transform | `grid/dt.rs` | Felzenszwalb & Huttenlocher 2012; Meijster et al. 2000 | VERIFIED-SEARCH; PARTIAL | a hybrid: Meijster's column pass, Felzenszwalb–Huttenlocher's row pass; spec §4.7 cites only the latter |
| pole of inaccessibility | `geom/polygon.rs:205` | Garcia-Castellanos & Lombardo 2007; Agafonkin 2016 (polylabel) | VERIFIED-SEARCH | follows polylabel, with iteration caps and deterministic ties; largest inscribed circle, not box (S3) |
| PCG32 | `la-expr/src/det_math/pcg.rs` | O'Neill 2014 | VERIFIED-SEARCH | PCG-XSH-RR 64/32; `next_below` is Lemire's (2019) multiply-shift without its rejection step, so slightly biased (at most n/2³²), undocumented |
| simulated annealing | `solver/local.rs` | Metropolis et al. 1953; Kirkpatrick et al. 1983; Christensen et al. 1995; Johnson et al. 1989 | VERIFIED-SEARCH | yes; T₀ is the median of the *positive* probe deltas, the spec (§10.2) says "median \|Δ\|" |
| ejection chains | `solver/local.rs:354-544` | Glover 1996 | UNVERIFIED | depth ≤ 3 as in the spec; first feasible chain, not the best |
| most-constrained item first | `solver/greedy.rs` | Brélaz 1979; Haralick & Elliott 1980 | UNVERIFIED | fewest live level-0 candidates, without regard to their cost |
| lookahead | `solver/greedy.rs:541`, spec §8 | no label-placement source found; value ordering in constraint satisfaction (Geelen 1992; Frost & Dechter 1995) | UNVERIFIED | ignores what the neighbours' killed candidates cost |
| branch and bound | `solver/exact.rs` | Verweij & Aardal 1999; Klau & Mutzel 2003 | UNVERIFIED; VERIFIED-SEARCH | same conflict-graph model, much weaker bound (O3) |
| leader uncrossing by exchange | `solver/repair.rs:507` | the exchange argument of boundary labeling (Bekos et al. 2007) | UNVERIFIED for the argument | yes; runs only when leaders are soft |
| column stacking, slot assignment | `solver/repair.rs:13-121` | pool adjacent violators (Ayer et al. 1955); Hungarian method (Kuhn 1955; Munkres 1957) | UNVERIFIED | yes |
| balanced wrapping | `la-text/src/wrap.rs:276` | contrast: Knuth & Plass 1981 | UNVERIFIED | smallest maximum line width by search with greedy fitting, optimal for the box; lines come out top-heavy |
| curve flattening, grid traversal | `la-svg/src/flatten.rs`, `grid/raster.rs` | Wang 1984 via Filip et al. 1986; Amanatides & Woo 1987 | UNVERIFIED | yes |
| slider model | `candidates.rs` | van Kreveld et al. 1999 | VERIFIED-SEARCH | sampled (4 per quadrant), not continuous (O5) |
| buffer ring | `cost.rs` | Mumtaz et al. 2019 (cited) | not checked | — |
| position orders | `model/opts.rs` | perceptual: Bobák et al. (cited); cartographic: Imhof 1975 | PARTIAL | the exact cartographic order could not be traced to Imhof's text |
| ambiguity term | `cost.rs`, spec §8 | criteria in van Dijk et al. 2002, Rylov & Reimer 2014 | not compared | a linear ramp on the difference of distances |

Small fixes this suggests: cite the sources in ADR 0005, `dt.rs`, `polygon.rs`, `pcg.rs`,
`local.rs` and `flatten.rs`; correct spec §4.7 (no early rejection by the distance
transform) and §10.2 (positive deltas); document the bias of `next_below` (removing it
changes every seeded result, so it needs a version note); add arXiv:2407.11996 to the
Bobák et al. entry of `CITATION.cff` once the CVM record is confirmed.

## Suggested order

1. Measurement: O1's upper bound and literature instances, D7's benchmark additions.
   Both are cheap and decide how much O2–O4 can gain.
2. S2: safe reductions of the candidates (S1 was measured and dropped, ADR 0034).
3. O3, then O2 on top of it (O4 was measured and dropped, ADR 0035).
4. D2 (small, measurable on scenario 11), then D1 for zooming hosts.
5. L1 for columns (L5 holds already, ADR 0036); L2–L4 as the gallery shows need.

## Provenance of these notes

* **How.** On 2026-10-18 an AI coding assistant (Claude Code) ran five searches in parallel
  from one brief ([`00-brief.md`](gh:docs/project/literature/00-brief.md)): optimization,
  dynamic labeling, leaders, quality and speed, and the sources of the building blocks.
  The coordinating session added the independent-set local-search literature, checked the
  claims about the code against the source (file and line references above) and wrote
  this page.
* **What was read.** The environment could not open publisher, DOI, DBLP or arXiv pages;
  only a web search tool worked, plus GitHub. Every statement about a paper rests on its
  abstract or record as quoted in search results — no full text was read. The MapLibre
  source, the Mapbox GL wiki and the `directlabels` and `ggrepel` sources were read in full
  on GitHub.
* **Verification levels.** VERIFIED-SEARCH: authors, venue, volume, pages and DOI appeared
  in search results citing a publisher, DBLP, repository or indexing record (not opened).
  PARTIAL: some fields only from a citing paper, or missing. UNVERIFIED: from memory, not
  checked; DOIs of such entries are marked "(memory)". Where two searches reached
  different levels, the higher one is given.
* **Limits.** The searches shared a budget of 200 web searches, which ran out; the open
  items are listed at the end of each notes file. Statements a notes file marks as
  interpretation or memory are not from the source.
* **Before citing** a source of this page in a paper, an ADR or `CITATION.cff`, open it and
  check the citation and the claim.

Notes files: [a — optimization](gh:docs/project/literature/a-optimization.md) ·
[b — dynamic labeling](gh:docs/project/literature/b-dynamic-labeling.md) ·
[c — leaders](gh:docs/project/literature/c-leaders.md) ·
[d — quality and speed](gh:docs/project/literature/d-quality-and-speed.md) ·
[e — building blocks](gh:docs/project/literature/e-provenance-of-building-blocks.md).

## Bibliography

Grouped by topic; the letter is the notes file with the details (search query, what was
read, open questions). "–" = no DOI found.

### Point labeling as optimization

| Reference | DOI / URL | Status | Notes |
|---|---|---|---|
| Agarwal, van Kreveld, Suri (1998). Label placement by maximum independent set in rectangles. *Comput. Geom.* 11(3–4):209–218 | 10.1016/S0925-7721(98)00028-5 | VERIFIED-SEARCH (DOI from citing papers) | a |
| Alvim, Taillard (2009). POPMUSIC for the point feature label placement problem. *EJOR* 192(2):396–413 | 10.1016/j.ejor.2007.10.002 | VERIFIED-SEARCH | a |
| Andrade, Resende, Werneck (2012). Fast local search for the maximum independent set problem. *J. Heuristics* 18(4):525–547 | DOI not confirmed | VERIFIED-SEARCH (venue, volume, pages) | this page |
| Bhore, Li, Nöllenburg (2022). An algorithmic study of fully dynamic independent sets for map labeling. *ACM JEA* 27:1–36; ESA 2020 | 10.1145/3514240; 10.4230/LIPIcs.ESA.2020.19 | VERIFIED-SEARCH | a, b |
| Borowitz, Großmann, Schulz (2025). Optimal neighborhood exploration for dynamic independent sets. ALENEX 2025; arXiv:2407.06912 | 10.1137/1.9781611978339.1 | VERIFIED-SEARCH | this page |
| Christensen, Marks, Shieber (1995). An empirical study of algorithms for point-feature label placement. *ACM TOG* 14(3):203–232 | 10.1145/212332.212334 | VERIFIED-SEARCH | a, d, e |
| Dahlum, Lamm, Sanders, Schulz, Strash, Werneck (2016). Accelerating local search for the maximum independent set problem. SEA 2016, LNCS 9685:118–133; arXiv:1602.01659 | DOI not confirmed | VERIFIED-SEARCH (arXiv listing, pages from a citing record) | this page |
| Formann, Wagner (1991). A packing problem with applications to lettering of maps. SoCG '91, 281–288 | 10.1145/109648.109680 | PARTIAL (DOI not tied to an ACM page) | a |
| Großmann, Lamm, Schulz, Strash (2024). Finding near-optimal weight independent sets at scale. *JGAA* 28(1):439–473 | 10.7155/jgaa.v28i1.2997 | VERIFIED-SEARCH | this page |
| Guerine, Rosseti, Plastino (2020). A hybrid data mining heuristic to solve the point-feature cartographic label placement problem. *ITOR* 27:1189–1209 | 10.1111/itor.12666 | VERIFIED-SEARCH (author order differs between sources) | a |
| Haunert, Wolff (2017). Beyond maximum independent set: an extended integer programming formulation for point labeling. *ISPRS IJGI* 6(11):342 | 10.3390/ijgi6110342 | VERIFIED-SEARCH | a |
| Klau, Mutzel (2003). Optimal labeling of point features in rectangular labeling models. *Math. Program.* 94(2–3):435–458 | 10.1007/s10107-002-0327-9 | VERIFIED-SEARCH | a, e |
| Klute, Li, Löffler, Nöllenburg, Schmidt (2019). Exploring semi-automatic map labeling. SIGSPATIAL '19, 13–22; arXiv:1910.07799 | 10.1145/3347146.3359359 | PARTIAL (DOI from a reference list) | a |
| Lamm, Sanders, Schulz, Strash, Werneck (2017). Finding near-optimal independent sets at scale. *J. Heuristics* 23(4):207–229 | 10.1007/s10732-017-9337-x | VERIFIED-SEARCH | a, this page |
| Laurent, Taillard et al. libpal (PAL), the labeling library of QGIS (software, GPL) | https://api.qgis.org/api/pal_8h_source.html | VERIFIED-SEARCH (header content); co-author Ertz unverified | a |
| Mauri, Ribeiro, Lorena (2010). A new mathematical model and a Lagrangean decomposition for the point-feature cartographic label placement problem. *Comput. Oper. Res.* 37(12):2164–2172 | DOI not confirmed | PARTIAL | a |
| Poon, Shin, Strijk, Uno, Wolff (2004). Labeling points with weights. *Algorithmica* 38(2):341–362 | 10.1007/s00453-003-1063-0 | VERIFIED-SEARCH | a |
| Rabello, Mauri, Ribeiro, Lorena (2014). A clustering search metaheuristic for the point-feature cartographic label placement problem. *EJOR* 234(3):802–808 | 10.1016/j.ejor.2013.10.021 | VERIFIED-SEARCH | a |
| Ribeiro, Lorena (2008a). Lagrangean relaxation with clusters for point-feature cartographic label placement problems. *Comput. Oper. Res.* 35(7):2129– | 10.1016/j.cor.2006.09.024 | PARTIAL (from a reference list) | a |
| Ribeiro, Lorena (2008b). Column generation approach for the point-feature cartographic label placement problem. *J. Comb. Optim.* 15(2):147–164 | 10.1007/s10878-007-9073-5 | VERIFIED-SEARCH | a |
| Ribeiro, Mauri, Lorena (2011). A Lagrangean decomposition for the maximum independent set problem applied to map labeling. *Oper. Res. Int. J.* 11(3):229–243 | 10.1007/s12351-009-0075-1 | VERIFIED-SEARCH | a |
| Rylov, Reimer (2014). A comprehensive multi-criteria model for high cartographic quality point-feature label placement. *Cartographica* 49(1):52–68 | 10.3138/carto.49.1.2137 | PARTIAL (secondary sources only) | a, d |
| Strijk, Verweij, Aardal (2000). Algorithms for maximum independent set applied to map labelling. Tech. rep. UU-CS-2000-22, Utrecht University | https://ics-archive.science.uu.nl/research/techreps/repo/CS-2000/2000-22.pdf | VERIFIED-SEARCH | a |
| van Kreveld, Strijk, Wolff (1999). Point labeling with sliding labels. *Comput. Geom.* 13(1):21–47 | 10.1016/S0925-7721(99)00005-X | VERIFIED-SEARCH | a |
| Verner, Wainwright, Schoenefeld (1997). Placing text labels on maps and diagrams using genetic algorithms with masking. *INFORMS J. Comput.* 9(3):266–275 | 10.1287/ijoc.9.3.266 | VERIFIED-SEARCH | a |
| Verweij, Aardal (1999). An optimisation algorithm for maximum independent set with applications in map labelling. ESA '99, LNCS 1643:426–437 | 10.1007/3-540-48481-7_37 (memory) | UNVERIFIED | a, e |
| Wagner, Wolff, Kapoor, Strijk (2001). Three rules suffice for good label placement. *Algorithmica* 30(2):334–349 | 10.1007/s00453-001-0009-7 | VERIFIED-SEARCH (rules 2 and 3 from memory) | a, d |
| Yamamoto, Câmara, Lorena (2002). Tabu search heuristic for point-feature cartographic label placement. *GeoInformatica* 6:77–90 | 10.1023/A:1013720231747 | VERIFIED-SEARCH | a |
| Zoraster (1990). The solution of large 0–1 integer programming problems encountered in automated cartography. *Oper. Res.* 38(5):752–759 | 10.1287/opre.38.5.752 | VERIFIED-SEARCH | a |

### Learning-based placement

| Reference | DOI / URL | Status | Notes |
|---|---|---|---|
| Bobák, Čmolík, Čadík (2024). Reinforced labels: multi-agent deep reinforcement learning for point-feature label placement. *IEEE TVCG* 30(9):5908–5922 | 10.1109/TVCG.2023.3313729 | VERIFIED-SEARCH | a, d |
| Cao, Zhang, Li, Ren, Chen (2026). Progressive reinforcement learning for point-feature label placement in map annotation. *ISPRS IJGI* 15(4):162 | 10.3390/ijgi15040162 | VERIFIED-SEARCH (results not seen) | a |
| Oucheikh, Harrie (2024). A feasibility study of applying generative deep learning models for map labeling. *Cartogr. Geogr. Inf. Sci.* | DOI not confirmed | PARTIAL | a |
| Qu, Zhang, Che, Chen, Ling (2025). Graph transformer for label placement. *IEEE TVCG* 31(1):1257–1267 | 10.1109/TVCG.2024.3456141 | PARTIAL (DOI from the authors' GitHub) | a, d |
| Shomer, Xu (2025). Automated label placement on maps via large language models. arXiv:2507.22952 | arXiv:2507.22952 | VERIFIED-SEARCH (listing only) | a, d |
| Zhang, Che, Chen, Huang, Ling, Qu (2025). Mixture of cluster-guided experts for retrieval-augmented label placement. IEEE VIS 2025 | – | PARTIAL (program listing only) | a |

### Dynamic and interactive labeling

| Reference | DOI / URL | Status | Notes |
|---|---|---|---|
| Barth, Niedermann, Nöllenburg, Strash (2016). Temporal map labeling: a new unified framework with experiments. SIGSPATIAL '16, art. 23 | 10.1145/2996913.2996957 | VERIFIED-SEARCH | b |
| Been, Daiches, Yap (2006). Dynamic map labeling. *IEEE TVCG* 12(5):773–780 | 10.1109/TVCG.2006.136 | VERIFIED-SEARCH (DOI from a citing paper) | b, d |
| Been, Nöllenburg, Poon, Wolff (2010). Optimizing active ranges for consistent dynamic map labeling. *Comput. Geom.* 43(3):312–328 | – | PARTIAL | b |
| Bobák, Čmolík, Čadík (2020). Temporally stable boundary labeling for interactive and non-interactive dynamic scenes. *Comput. Graph.* 91:265–278 | 10.1016/j.cag.2020.08.005 | VERIFIED-SEARCH | b |
| Buchin, Gerrits (2013). Dynamic point labeling is strongly PSPACE-complete. ISAAC 2013, LNCS 8283:262–272 | – | PARTIAL | b |
| de Berg, Gerrits (2012). Approximation algorithms for free-label maximization. *Comput. Geom.* 45(4):153–168 | 10.1016/j.comgeo.2011.10.004 | PARTIAL | b |
| de Berg, Gerrits (2013). Labeling moving points with a trade-off between label speed and label overlap. ESA 2013, LNCS 8125:373–384 | – | PARTIAL | b |
| Depian, Li, Nöllenburg, Wulms (2023). Transitions in dynamic point labeling. GIScience 2023, LIPIcs 277:2 | 10.4230/LIPIcs.GIScience.2023.2 | VERIFIED-SEARCH | b |
| Gedicke, Bonerath, Niedermann, Haunert (2021). Zoomless maps: external labeling methods for the interactive exploration of dense point sets at a fixed map scale. *IEEE TVCG* 27(2):1247–1256 | 10.1109/TVCG.2020.3030399 | VERIFIED-SEARCH | b |
| Gedicke, Jabrayilov, Niedermann, Mutzel, Haunert (2021). Point feature label placement for multi-page maps on small-screen devices. *Comput. Graph.* 100:66–80 | 10.1016/j.cag.2021.07.019 | VERIFIED-SEARCH | b |
| Gemsa, Niedermann, Nöllenburg (2013). Trajectory-based dynamic map labeling. ISAAC 2013, LNCS 8283:413–423; arXiv:1309.3963 | – | PARTIAL | b |
| Gemsa, Nöllenburg, Rutter (2016a). Consistent labeling of rotating maps. *JoCG* 7(1):308–331 | 10.20382/jocg.v7i1a15 | VERIFIED-SEARCH | b |
| Gemsa, Nöllenburg, Rutter (2016b). Evaluation of labeling strategies for rotating maps. *ACM JEA* 21(1), art. 1.4 | 10.1145/2851493 | VERIFIED-SEARCH | b |
| Kouřil et al. (2019). Labels on levels: labeling of multi-scale multi-instance and crowded 3D biological environments. *IEEE TVCG* 25(1):977–986 | 10.1109/TVCG.2018.2864491 | PARTIAL | b |
| Krumpe (2018). Labeling points of interest in dynamic maps using disk labels. GIScience 2018, LIPIcs 114:8 | 10.4230/LIPIcs.GISCIENCE.2018.8 | VERIFIED-SEARCH | b |
| Liao, Liang, Poon (2016). Approximation algorithms on consistent dynamic map labeling. *Theor. Comput. Sci.* 640:84–93 | – | PARTIAL | b |
| Maass, Döllner (2006). Efficient view management for dynamic annotation placement in virtual landscapes. Smart Graphics 2006, LNCS 4073:1–12 | 10.1007/11795018_1 | VERIFIED-SEARCH | b |
| MapLibre GL JS (`placement.ts`, `collision_index.ts`, `cross_tile_symbol_index.ts`) and the Mapbox GL Native wiki page "Collision Detection" (software, not peer-reviewed) | https://github.com/maplibre/maplibre-gl-js | read in full on GitHub | b, d |
| Mote (2007). Fast point-feature label placement for dynamic visualizations. *Inf. Vis.* 6(4):249–260 | 10.1057/palgrave.ivs.9500163 | VERIFIED-SEARCH (year given as 2007 or 2008) | b, d |
| Tatzgern, Kalkofen, Grasset, Schmalstieg (2014). Hedgehog labeling: view management techniques for external labels in 3D space. IEEE VR 2014, 27–32 | 10.1109/VR.2014.6802046 | VERIFIED-SEARCH | b |
| Tatzgern et al. (2016). Adaptive information density for augmented reality displays. IEEE VR 2016, 83–92 | 10.1109/VR.2016.7504691 | VERIFIED-SEARCH | b |
| Töpfer, Pillewizer (1966). The principles of selection. *Cartogr. J.* 3(1):10–16 | – | PARTIAL | b |
| Vaaraniemi, Treib, Westermann (2012). Temporally coherent real-time labeling of dynamic scenes. COM.Geo 2012 | – | PARTIAL | b |

### Leaders and external labeling

| Reference | DOI / URL | Status | Notes |
|---|---|---|---|
| Ali, Hartmann, Strothotte (2005). Label layout for interactive 3D illustrations. *J. WSCG* 13(1):1–8 | – | VERIFIED-SEARCH | c |
| Barth, Gemsa, Niedermann, Nöllenburg (2019). On the readability of leaders in boundary labeling. *Inf. Vis.* 18(1):110–132 | 10.1177/1473871618799500 | VERIFIED-SEARCH | c |
| Bekos, Cornelsen, Fink, Hong, Kaufmann, Nöllenburg, Rutter, Symvonis (2015). Many-to-one boundary labeling with backbones. *JGAA* 19(3):779–816 | 10.7155/jgaa.00379 | VERIFIED-SEARCH | c |
| Bekos, Kaufmann, Nöllenburg, Symvonis (2010). Boundary labeling with octilinear leaders. *Algorithmica* 57(3):436–461 | 10.1007/s00453-009-9283-6 | VERIFIED-SEARCH | c |
| Bekos, Kaufmann, Symvonis, Wolff (2007). Boundary labeling: models and efficient algorithms for rectangular maps. *Comput. Geom.* 36(3):215–236 | 10.1016/j.comgeo.2006.05.003 | VERIFIED-SEARCH | c, e |
| Benkert, Haverkort, Kroll, Nöllenburg (2009). Algorithms for multi-criteria boundary labeling. *JGAA* 13(3):289–317 | 10.7155/jgaa.00189 | VERIFIED-SEARCH | c |
| Bertini, Rigamonti, Lalanne (2009). Extended excentric labeling. *Comput. Graph. Forum* 28(3):927–934 | 10.1111/j.1467-8659.2009.01456.x | VERIFIED-SEARCH | c |
| Čmolík, Bittner (2010). Layout-aware optimization for interactive labeling of 3D models. *Comput. Graph.* 34(4):378–387 | 10.1016/j.cag.2010.05.002 (reconstructed) | PARTIAL | b, c |
| directlabels, R package (T. D. Hocking) — line-end label stacking (software) | https://github.com/tdhock/directlabels | source read on GitHub | c |
| Fekete, Plaisant (1999). Excentric labeling: dynamic neighborhood labeling for data visualization. CHI '99, 512–519 | 10.1145/302979.303148 | PARTIAL | c |
| Fink, Haunert, Schulz, Spoerhase, Wolff (2012). Algorithms for labeling focus regions. *IEEE TVCG* 18(12):2583–2592 | 10.1109/TVCG.2012.193 | VERIFIED-SEARCH | c |
| ggrepel, R package (K. Slowikowski) (software) | https://github.com/slowkow/ggrepel | documentation read on GitHub | c |
| Hartmann, Götzelmann, Ali, Strothotte (2005). Metrics for functional and aesthetic label layouts. Smart Graphics 2005, LNCS 3638:115–126 | 10.1007/11536482_10 | PARTIAL | c, d |
| Heinsohn, Gerasch, Kaufmann (2014). Boundary labeling methods for dynamic focus regions. PacificVis 2014, 243–247 | 10.1109/PacificVis.2014.20 | PARTIAL | c |
| Kindermann, Niedermann, Rutter, Schaefer, Schulz, Wolff (2016). Multi-sided boundary labeling. *Algorithmica* 76(1):225–258 | 10.1007/s00453-015-0028-4 | VERIFIED-SEARCH | c |
| Lhuillier, van Garderen, Weiskopf (2019). Density-based label placement. *Vis. Comput.* 35(6–8):1041–1052 | 10.1007/s00371-019-01686-7 | VERIFIED-SEARCH | c |
| Lin, Kao, Yen (2008). Many-to-one boundary labeling. *JGAA* 12(3):319–356 | 10.7155/jgaa.00169 | VERIFIED-SEARCH | c |
| Löffler, Nöllenburg, Staals (2016). Mixed map labeling. *JOSIS* 13:3–32 | 10.5311/JOSIS.2016.13.264 | VERIFIED-SEARCH | c |
| Meng, Zhang, Liu, Liu (2015). Clutter-aware label layout. PacificVis 2015, 207–214 | DOI not confirmed | PARTIAL | c |
| Niedermann, Haunert (2019). Focus+context map labeling with optimized clutter reduction. *Int. J. Cartogr.* 5(2–3):158–177 | 10.1080/23729333.2019.1613072 | PARTIAL | c |
| Niedermann, Nöllenburg, Rutter (2017). Radial contour labeling with straight leaders. PacificVis 2017, 295–304; arXiv:1702.01799 | 10.1109/PACIFICVIS.2017.8031608 | PARTIAL (DOI from a citing paper) | c |
| Nöllenburg, Polishchuk, Sysikaski (2010). Dynamic one-sided boundary labeling. ACM GIS '10, 310–319 | 10.1145/1869790.1869834 | VERIFIED-SEARCH | c |
| Wolff, Knipping, van Kreveld, Strijk, Agarwal (2000). A simple and efficient algorithm for high-quality line labeling. *Innovations in GIS VII*, 147–159 | – | PARTIAL (year differs between sources) | c |

### Quality, perception and fast placement

| Reference | DOI / URL | Status | Notes |
|---|---|---|---|
| Bobák, Čmolík, Čadík. From top-right to user-right: perceptual prioritization of point-feature label positions. arXiv:2407.11996 (cited by the project as CVM 2026) | arXiv:2407.11996 | PARTIAL (no CVM record found) | d |
| Chazelle, Drysdale, Lee (1986). Computing the largest empty rectangle. *SIAM J. Comput.* 15(1):300–315 | DOI not confirmed | VERIFIED-SEARCH (volume, pages) | d |
| Fan, Zhang, Du (2005). Quality evaluation model for map labeling. *Geo-spatial Inf. Sci.* 8(1):72–78 | 10.1007/BF02826996 | VERIFIED-SEARCH | d |
| Imhof (1975). Positioning names on maps. *Am. Cartogr.* 2(2):128–144 | 10.1559/152304075784313304 (memory) | PARTIAL (secondary sources) | d, e |
| Kittivorawong, Moritz, Wongsuphasawat, Heer (2020). Fast and flexible overlap detection for chart labeling with occupancy bitmap. IEEE VIS 2020 Short Papers (cited) | 10.1109/VIS47514.2020.00027 | PARTIAL | d |
| Luboschik, Schumann, Cords (2008). Particle-based labeling: fast point-feature labeling without obscuring other visual features. *IEEE TVCG* 14(6):1237–1244 | 10.1109/TVCG.2008.152 | VERIFIED-SEARCH | d |
| Naamad, Lee, Hsu (1984). On the maximum empty rectangle problem. *Discrete Appl. Math.* 8(3):267–277 | DOI not confirmed | PARTIAL | d |
| Ooms, Kellens, Fack (2009). Dynamic map labeling for users. ICC 2009, Santiago | – | PARTIAL | d |
| Pavlovec, Čmolík (2022). Rapid labels: point-feature labeling on GPU. *IEEE TVCG* 28(1):604–613 (cited) | 10.1109/TVCG.2021.3114854 | VERIFIED-SEARCH | d |
| Petzold, Gröger, Plümer (2003). Fast screen map labeling — data structures and algorithms. ICC 2003, Durban, 288–298 | – | PARTIAL | d |
| Rylov, Reimer (2015). Improving label placement quality by considering basemap detail with a raster-based approach. *GeoInformatica* 19(3):463–486 | 10.1007/s10707-014-0214-6 | VERIFIED-SEARCH | d |
| Scheuerman, Harman, Goldstein, Acklin, Michael (2023). Visual preferences in map label placement. *Discov. Psychol.* 3(1) | 10.1007/s44202-023-00088-0 | VERIFIED-SEARCH | d |
| Theophil, Schödl (2006). An efficient algorithm for scatter chart labeling. AAAI 2006, 1064–1069 | – | VERIFIED-SEARCH | d |
| van Dijk, van Kreveld, Strijk, Wolff (2002). Towards an evaluation of quality for names placement methods. *IJGIS* 16(7):641–661 | 10.1080/13658810210138742 | VERIFIED-SEARCH | d |
| Wolff, Strijk. The map-labeling bibliography (web resource, last updated about 2009) | https://i11www.iti.kit.edu/map-labeling/bibliography/ | PARTIAL | d |
| Yoeli (1972). The logic of automated map lettering. *Cartogr. J.* 9:99–108 | 10.1179/000870472787352505 | PARTIAL | d |

### Building blocks

| Reference | DOI / URL | Status | Notes |
|---|---|---|---|
| Agafonkin (2016). A new algorithm for finding a visual center of a polygon (polylabel). Mapbox blog | https://blog.mapbox.com/a-new-algorithm-for-finding-a-visual-center-of-a-polygon-7c77e6492fbc | VERIFIED-SEARCH | e |
| Amanatides, Woo (1987). A fast voxel traversal algorithm for ray tracing. Eurographics '87 | – | UNVERIFIED | e |
| Ayer, Brunk, Ewing, Reid, Silverman (1955). An empirical distribution function for sampling with incomplete information. *Ann. Math. Stat.* 26(4):641–647 | 10.1214/aoms/1177728423 (memory) | UNVERIFIED | e |
| Brélaz (1979). New methods to color the vertices of a graph. *CACM* 22(4):251–256 | 10.1145/359094.359101 (memory) | UNVERIFIED | e |
| Crow (1984). Summed-area tables for texture mapping. SIGGRAPH '84, *Comput. Graph.* 18(3):207–212 | 10.1145/800031.808600 (a second DOI, 10.1145/964965.808600, also appears) | VERIFIED-SEARCH | e |
| Felzenszwalb, Huttenlocher (2012). Distance transforms of sampled functions. *Theory Comput.* 8(19):415–428 | 10.4086/toc.2012.v008a019 | VERIFIED-SEARCH | e |
| Filip, Magedson, Markot (1986). Surface algorithms using bounds on derivatives. *Comput. Aided Geom. Des.* 3(4) (Wang's formula) | – | UNVERIFIED | e |
| Frost, Dechter (1995). Look-ahead value ordering for constraint satisfaction problems. IJCAI '95 | – | UNVERIFIED | e |
| Garcia-Castellanos, Lombardo (2007). Poles of inaccessibility: a calculation algorithm for the remotest places on Earth. *Scott. Geogr. J.* 123(3):227–233 | 10.1080/14702540801897809 | VERIFIED-SEARCH (secondary bibliographies) | e |
| Geelen (1992). Dual viewpoint heuristics for binary constraint satisfaction problems. ECAI '92 | – | UNVERIFIED | e |
| Glover (1996). Ejection chains, reference structures and alternating path methods for traveling salesman problems. *Discrete Appl. Math.* 65:223–253 | 10.1016/0166-218X(94)00037-E (memory) | UNVERIFIED | e |
| Haralick, Elliott (1980). Increasing tree search efficiency for constraint satisfaction problems. *Artif. Intell.* 14(3):263–313 | 10.1016/0004-3702(80)90051-X (memory) | UNVERIFIED | e |
| Johnson, Aragon, McGeoch, Schevon (1989). Optimization by simulated annealing: an experimental evaluation; part I, graph partitioning. *Oper. Res.* 37(6):865–892 | 10.1287/opre.37.6.865 | VERIFIED-SEARCH | e |
| Kirkpatrick, Gelatt, Vecchi (1983). Optimization by simulated annealing. *Science* 220(4598):671–680 | 10.1126/science.220.4598.671 | VERIFIED-SEARCH | e |
| Knuth, Plass (1981). Breaking paragraphs into lines. *Softw. Pract. Exp.* 11(11):1119–1184 | 10.1002/spe.4380111102 (memory) | UNVERIFIED | e |
| Kuhn (1955). The Hungarian method for the assignment problem. *Nav. Res. Logist. Q.* 2:83–97; Munkres (1957). Algorithms for the assignment and transportation problems. *J. SIAM* 5(1):32–38 | 10.1002/nav.3800020109 (memory) | UNVERIFIED | e |
| Lemire (2019). Fast random integer generation in an interval. *ACM TOMACS* 29(1) | 10.1145/3230636 | PARTIAL | e |
| Meijster, Roerdink, Hesselink (2000). A general algorithm for computing distance transforms in linear time. ISMM 2000, *Comput. Imaging Vis.* 18:331–340 | 10.1007/0-306-47025-X_36 | PARTIAL | e |
| Metropolis, Rosenbluth, Rosenbluth, Teller, Teller (1953). Equation of state calculations by fast computing machines. *J. Chem. Phys.* 21(6):1087–1092 | 10.1063/1.1699114 | VERIFIED-SEARCH | e |
| O'Neill (2014). PCG: a family of simple fast space-efficient statistically good algorithms for random number generation. Tech. rep. HMC-CS-2014-0905, Harvey Mudd College | https://www.pcg-random.org/ | VERIFIED-SEARCH | e |
