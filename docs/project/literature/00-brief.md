# Shared brief for literature agents

## The library (Label Anything, github.com/fabian-beck/label-anything, v0.1, experimental)
A host-independent label placement engine (Rust core + bit-identical TypeScript port).
Places text/icon labels next to point/shape anchors in scatterplots, maps (vector/raster
backgrounds), node-link diagrams, illustrations, line charts.

Algorithm as implemented:
* Candidate model: 8 fixed adjacent positions (perceptual order top,right,bottom,left,
  corners; or Imhof cartographic order), slider positions (4 per quadrant) along the mark,
  internal positions (pole of inaccessibility) for large shapes, distant candidates with
  leaders (4 rings x 16 directions, 1.5-8 em, plus free-space seeds, keep 24 cheapest),
  boundary (margin) labels in one column per side, "fan" columns for crowds (e.g. crowded
  line-chart ends) after the search.
* Cost per candidate: soft coverage of obstacle classes (coverage grids + summed-area
  tables), buffer ring coverage (Mumtaz et al. 2019), leader cost (fixed + length + bends +
  covered classes), position rank, gap distance, shape penalty (wrap/shrink), canvas-edge
  proximity, ambiguity (label closer to another item's shape than its own), stability
  (displacement from previous frame's box), lookahead (candidates taken from unplaced items).
* Hard constraints checked exactly with vector geometry: no label overlaps, no covering
  marks, leaders never cross, leaders keep clearance from other marks, leader angular
  separation.
* Priority: lexicographic key (required, tier, reserved coverage, banded score); omission
  modes strict / prefix / weighted; "strict" = no label omitted while a lower-priority one
  blocks it (priority repair + removal test).
* Solver: greedy in priority bands, most-constrained item first, cheapest live candidate
  with lookahead; after each band a degradation ladder for unplaced items (alternatives ->
  wrap -> distant -> evict_lower -> shrink 0.85 -> soft_overlap -> omit). Then local search
  (relocate, swap, ejection-chain insert depth<=3, variant switch) with simulated annealing
  acceptance (geometric schedule, iteration budget not wall-clock, deterministic PCG32).
  Branch-and-bound exact search for small problems (<= 3000 candidates, 24 cheapest per item).
  Then fan labels, boundary re-stacking, uncross repair, priority repair, exact verification.
* Interactive use: warm start from previous frame's result; stability cost; warm boxes
  follow their anchors; "nudge" blocked boxes; keep leaders.
* Deterministic, iteration-budgeted.

## Known weaknesses (from the project's own benchmark docs)
1. Dense data loses labels: of 1000 airports on a world map 501 get a label; 2000 random
   points 872. Crowds keep few labels.
2. Local search adds only +0.7% priority-weighted placement over greedy+ladder (20x
   iterations: <= 1.7%). Optimization phase is weak.
3. Many leaders in crowded scenes (14 of 32 Gapminder labels), up to 8-11 em long, some
   across large marks.
4. Interactive: labels move 2.3-3.4 px per frame when warm-started; zooming makes >10% of
   labels flip sides per zoom step.
5. Performance: 2000 labels over 100k points take ~300 ms native (target 120 ms); 2/3 of
   time in greedy pass, mostly in the degradation ladder generating ~1M candidate boxes
   for labels that end up omitted (1509 of 2000 run the ladder, 1128 omitted).
6. Crowded line ends: column grows only as far as leaders stay within max_length.

Already cited by the project: Mumtaz/van Garderen/Beck/Weiskopf EuroVis 2019 short
(point labeling with leaders for convex polygons and scatterplots); Kittivorawong et al.
VIS 2020 (occupancy bitmap); Pavlovec & Čmolík TVCG 2022 (Rapid Labels GPU); Čmolík et
al. TVCG 2022 (Mixed labeling); Bekos/Niedermann/Nöllenburg CGF 2019 (external labeling
survey); Bobák/Čmolík/Čadík CVM 2026 (perceptual prioritization of label positions).

## Provenance rules (IMPORTANT)
For every source you report give:
* full citation: authors, year, title, venue, volume/issue/pages;
* DOI (and/or stable URL: publisher, arXiv, DBLP);
* how found: the search query (or link followed) and the date (today is 2026-10-18);
* what you actually read: "abstract", "full text", "publisher page", or "secondary
  source only (name it)";
* verification status: VERIFIED (you saw a publisher/DBLP/arXiv/DOI page confirming the
  bibliographic data) / PARTIAL (some data unconfirmed — say which) / UNVERIFIED (from
  memory; only include if clearly marked).
* 2-5 bullets of what the source claims or does (only what you read; mark your own
  interpretation as such);
* relevance to Label Anything: which component/weakness, and a concrete improvement idea.
Do NOT invent DOIs, page numbers or findings. If a DOI is unknown, say so. Prefer DBLP
(dblp.org) and doi.org lookups to confirm bibliographic data. Use WebSearch (mode
"standard" first) and WebFetch; load them with ToolSearch ("select:WebSearch,WebFetch").
