# E — Provenance of the algorithms already in the code

Agent E, 2026-10-18. Scope: find the original or canonical source for each building block
that Label Anything already implements, give the code location (repository
this repository, read-only), and say whether the code matches the original.

## How far the checks went (read this first)

* **WebFetch could not reach any host** (`getaddrinfo ENOTFOUND`, tried once on
  dash.harvard.edu). The coordinator confirmed that dblp.org, doi.org, crossref and
  springer fail in the same way. So no publisher, DBLP or DOI page was opened directly.
* **Search budget.** 14 WebSearch queries went through (log at the end). The 15th
  returned *"this turn's web search budget is used up (limit: 200 WebSearch calls per
  turn, shared by every agent in it)"*. After that nothing more could be checked.
* **Verification labels used here:**
  * **VERIFIED-SEARCH**: search result summaries citing the publisher, PubMed, INFORMS,
    theoryofcomputing.org, SIGGRAPH history or the author's site confirmed the
    bibliographic data. The page itself was not opened.
  * **PARTIAL**: some fields were confirmed by search and others were not. The note says
    which.
  * **UNVERIFIED (from memory)**: not checked at all in this session. A DOI is given only
    where I am confident, and it is marked "DOI from memory, must be checked". Otherwise
    it says "DOI not confirmed". **These entries need a verification pass in a later
    session** before anything is cited.
* "What I read" is never more than search summaries and abstract snippets. No full text
  was read. Statements about what a paper "does" in UNVERIFIED entries are my
  recollection and are marked as such.
* The TypeScript port mirrors every Rust location given below (for example
  `ts/packages/core/src/solver/local.ts:111,135` holds the same T0 and schedule code). Only
  Rust paths are given.

---

## 1. Summed-area tables (constant-time area queries)

**Code.**
* `rust/crates/la-core/src/grid/mod.rs:99-137`: `Sat::from_coverage`, a `(rows+1)×(cols+1)`
  table of prefix sums of the `u8` coverage grid, using wrapping `u32` arithmetic.
* `grid/mod.rs:146`: `block`, the 4-lookup inclusion–exclusion.
* `grid/mod.rs:164-200`: `integral`, the exact integral over a rectangle that is not
  aligned to the grid. It splits each axis into at most 3 parts (`axis_parts`, `:235`) and
  sums the ≤ 9 blocks with fractional weights.
* `grid/occupancy.rs:78-90`: `freeze` builds a SAT for the occupancy grid. The query is at
  `:174-177`.
* Docs: `docs/adr/0005-coverage-grids-and-summed-area-tables.md`, `spec/spec.md:146`
  (§4.1).

**What it does.** Each obstacle class gets a per-class coverage grid (0..255 per cell) and
a SAT. A label box's covered area is then answered with 16 lookups and one float
combination, for any position of the box.

**Source.** Crow, F. C. (1984). *Summed-area tables for texture mapping.* Proc. SIGGRAPH '84
(11th annual conference, Minneapolis, July 23–27, 1984), pp. 207–212. Also listed as
*Computer Graphics* 18(3). ACM.
* DOI: **10.1145/800031.808600** (proceedings record). A second DOI,
  10.1145/964965.808600, appears through a dx.doi.org link. My interpretation: it is the
  *Computer Graphics* 18(3) journal-issue record of the same paper, since ACM often keeps
  both. The search summarizer guessed it was a typo. This is not resolved.
* How found: WebSearch "Crow 1984 "Summed-area tables for texture mapping" SIGGRAPH
  Computer Graphics 18(3) 207-212 doi", 2026-10-18. Hits: history.siggraph.org (?p=107462),
  researchr.org bibtex, a VT SIGGRAPH bibliography.
* Read: search summaries only (abstract fragment).
* Status: **VERIFIED-SEARCH** (pages, venue, DOI 800031). The 964965 variant is
  unresolved.
* What it claims (from the abstract fragment and the SIGGRAPH history summary):
  * one table of values holds the integral over the texture, not the texture itself;
  * this allows more general (rectangular box) texture filtering than mip maps.

**Match or deviation.** The core matches Crow (table of integrals, 4-corner
inclusion–exclusion). Engineering additions, none of which needs a fix:
* `u8` quantized coverage with **wrapping** `u32` sums. My reasoning: differences taken in
  Z/2³² are exact whenever the true block sum is below 2³². This answers the precision
  growth of SAT entries without 64-bit storage.
* Fractional rectangles are handled by a 3×3 decomposition. This is exact for
  piecewise-constant coverage and, as the ADR notes, equivalent to bilinearly
  interpolating the SAT.
* The `u8` grid is dropped after the SAT is built (cells are SAT differences), so memory
  is 4 B per cell and class.
* Suggested doc change: cite Crow 1984 in ADR 0005 and spec §4.1. The "integral image" of
  Viola & Jones (computer vision) is the same structure (UNVERIFIED, not searched).

---

## 2. Distance transform (`grid/dt.rs`)

**Code.**
* `rust/crates/la-core/src/grid/dt.rs:1`: the module doc already says "Exact Euclidean
  distance transform (Felzenszwalb & Huttenlocher 2012)".
* `dt.rs:9-39`: `dt1d`, the F&H 1-D squared-distance transform as the lower envelope of
  parabolas. It keeps the `v` and `z` arrays, computes the intersection
  `s = ((f[q]+q²) − (f[v[k]]+v[k]²)) / (2q − 2v[k])`, and uses `INF = 1e20` as F&H do.
* `dt.rs:45-113`: `distance_transform`.
  * **Column phase**: not the parabola envelope. It does two linear sweeps (down, then up)
    and stores the squared distance to the nearest occupied cell of the column.
  * **Row phase**: F&H `dt1d` per row, in parallel.
  * The test `column_sweeps_equal_the_envelope_pass` (`dt.rs:200ff`) checks that the
    result is identical to the two-pass F&H transform.
* `dt.rs:116-151`: `dt_maxima`, the local maxima in the 8-neighbourhood with a plateau
  tie-break. These are the free-space seeds.
* Callers:
  * `obstacles.rs:366-399` builds the DT from the static hard classes plus item marks
    plus outside-label-area, with seeds of minimum clearance 0.4 em;
  * `leaders.rs:323-368` (`item_seeds`, `free_space_seeds`) takes up to 8 seeds with
    clearance ≥ the label half-height.
* Spec: `spec/spec.md:438-443` (§4.7) names "Felzenszwalb–Huttenlocher".

**Sources.**
1. Felzenszwalb, P. F., & Huttenlocher, D. P. (2012). *Distance transforms of sampled
   functions.* Theory of Computing 8, article 19, pp. 415–428.
   * DOI **10.4086/toc.2012.v008a019**.
   * How found: WebSearch "Felzenszwalb Huttenlocher "Distance transforms of sampled
     functions" Theory of Computing 2012 volume 8 doi …", 2026-10-18. Hits:
     theoryofcomputing.org/articles/v008a019 (bibtex, abstract), cs.brown.edu/~pff/dt.
   * Read: search summaries of the abstract and bibtex.
   * Status: **VERIFIED-SEARCH** (volume, article number, pages, DOI; published
     2012-09-02; CC-BY).
   * Claims (abstract): linear-time algorithms for distance transforms of *sampled
     functions*, which generalizes the binary-image DT; a fast exact Euclidean DT of
     binary images follows from it. A C++ reference implementation is on the authors'
     site.
2. Meijster, A., Roerdink, J. B. T. M., & Hesselink, W. H. (2000). *A general algorithm for
   computing distance transforms in linear time.* In Mathematical Morphology and its
   Applications to Image and Signal Processing (ISMM 2000), Computational Imaging and
   Vision vol. 18, pp. 331–340. Springer (Kluwer).
   * DOI **10.1007/0-306-47025-X_36**.
   * How found: WebSearch "Meijster Roerdink Hesselink "A general algorithm for computing
     distance transforms in linear time" 2000 …", 2026-10-18. Hits: bibbase,
     research.rug.nl, academia.edu.
   * Read: search summary.
   * Status: **PARTIAL**. Series, volume, pages and DOI come from one bibliographic record.
     The conference location is conflicting (Palo Alto vs. another), and one listing says
     2002.
   * Claims (summary): two phases, first column-wise scans, then row-wise scans; exact
     Euclidean, Manhattan and chessboard DTs.
3. Rosenfeld–Pfaltz chamfer DT: **not used** by the code (the code computes exact Euclidean
   distances), so it was not searched.

**Match or deviation.**
* It is an **exact EDT** and matches the sources. Precisely, the code is a hybrid: Meijster
  et al.'s phase 1 (column scans) plus F&H's 1-D envelope for phase 2. Both should be
  cited. The current doc comment cites only F&H.
* **Distances run between cell centres**, and a cell counts as occupied if any geometry
  touches it. So the clearance to the true geometry is off by up to about half a cell
  diagonal (≤ 2.8 px at the largest 4 px cell). This is my analysis; it is harmless for
  seeds, which are only proposals.
* **Spec/code mismatch.** Spec §4.7 says the DT "drives free-space seeds … and early
  rejection". A grep finds only seed use (`leaders.rs:327` is the only reader of `fs.dt`
  outside `dt.rs`), so either the spec or the code should be updated. If the DT is ever
  used for rejection, subtract half a cell diagonal to keep it conservative.
* **Isotropic metric for anisotropic labels.** Seeds need clearance ≥ the label
  *half-height* (`leaders.rs:359-368`). The half-width is ignored, so many seeds cannot
  hold a wide label and are rejected later.
  * Improvement idea (own): F&H's separable scheme supports per-axis scaling directly.
    Running the row pass with `f(q) + (s·(q−p))²`, `s = h/w`, gives a DT whose maxima are
    centres of the largest boxes with the label's aspect ratio (an elliptical
    approximation).
  * An L∞ variant (also linear time, Meijster) on x-scaled coordinates gives exactly the
    largest inscribed axis-aligned box of that aspect ratio.
  * This bears on weakness 3 (long leaders, leaders across marks) and weakness 1 (dense
    scenes), because the seeds would fit the label.

---

## 3. Pole of inaccessibility for internal labels

**Code.**
* `rust/crates/la-core/src/geom/polygon.rs:201-304`: `polylabel(rings, even_odd,
  precision)`.
* Callers:
  * `model/mod.rs:352-357`: `Item::pole()`, lazily, precision 0.5 px;
  * `model/mod.rs:1552`: area anchors;
  * `candidates.rs:934-993`: `internal()`. Area anchors use the pole plus grid samples
    ordered by signed distance, keeping the top 8. Polygon marks use the pole plus the
    reference point. A candidate is accepted iff the label box grown by `inner_padding`
    lies inside the shape.
* Spec: `spec/spec.md:639, 660` (§6.3, §6.5) says "polylabel, precision 0.5 px".

**Sources.**
1. Garcia-Castellanos, D., & Lombardo, U. (2007). *Poles of inaccessibility: A calculation
   algorithm for the remotest places on earth.* Scottish Geographical Journal 123(3),
   227–233.
   * DOI **10.1080/14702540801897809**.
   * How found: WebSearch "Garcia-Castellanos Lombardo 2007 "Poles of inaccessibility …"
     Scottish Geographical Journal 123(3) doi", 2026-10-18. Hits: Esri ArcGIS blog (full
     reference with volume, issue and pages), UCSB geography page and the R package
     polylabelr docs (DOI).
   * Read: secondary sources only (Esri blog, UCSB, polylabelr summaries).
   * Status: **VERIFIED-SEARCH** (from secondary bibliographies, not the T&F page).
   * Claims (secondary): an iterative method that tests candidate points (about 80,000
     points per pole), applied to continents and islands.
2. Agafonkin, V. (2016, Aug 15). *A new algorithm for finding a visual center of a
   polygon.* Mapbox blog.
   * URL: https://blog.mapbox.com/a-new-algorithm-for-finding-a-visual-center-of-a-polygon-7c77e6492fbc
   * Code: github.com/mapbox/polylabel. Not peer-reviewed.
   * How found: WebSearch "Agafonkin 2016 Mapbox blog "A new algorithm for finding a
     visual center of a polygon" polylabel", 2026-10-18.
   * Read: search summary of the post's opening.
   * Status: **VERIFIED-SEARCH** (URL, author, date).
   * Claims (post opening): the target is the pole of inaccessibility (the interior point
     farthest from an edge). It is a fast heuristic with a precision parameter, for Mapbox
     GL label placement. It replaces earlier approaches that needed a constrained Delaunay
     triangulation or a straight skeleton.
   * Secondary sources mention quadtree subdivision. GEOS and PostGIS have ports
     (J. Topf blog).

**Match or deviation.** The code matches polylabel's algorithm structure, as I recall it
(the details below were not confirmed from the source code in this session):
* initial cells of size `min(w,h)` over the outer ring's bounding box;
* cell potential `d + h·√2`;
* a max-heap on potential;
* the initial best is the better of centroid and bbox centre;
* prune when `max − best ≤ precision`;
* split into 4.

Deviations, all engineering:
* (a) at most 4096 starting cells for extreme aspect ratios;
* (b) an iteration cap `clamp(5e7/edges, 256, 100000)`, so on huge polygons the result is
  no longer guaranteed within `precision`;
* (c) ties broken deterministically by insertion sequence.

Conceptual deviation: polylabel maximizes **Euclidean** clearance, i.e. the largest
inscribed *circle*. Labels are wide rectangles, so the pole can fail `contains_rect` while
a box of the label's size fits elsewhere. The grid samples in `internal()` partly cover
this for area anchors, but polygon *marks* only try the pole and the reference point.
* Improvement idea (own): run polylabel with the **L∞ distance on coordinates scaled by
  h/w**. The point maximizing it is the centre of the largest inscribed axis-aligned box
  with the label's aspect ratio. The quadtree bound still holds with potential `d + h`
  for L∞.
* This helps internal and mixed labeling (Čmolík et al. 2022 are already cited by the
  project).

---

## 4. PCG32 random number generator

**Code.**
* `rust/crates/la-expr/src/det_math/pcg.rs` (whole file):
  * multiplier `6364136223846793005`;
  * fixed increment `1442695040888963407`;
  * seeding `state = 0; step(); state += seed; step()`;
  * XSH-RR output `((old >> 18) ^ old) >> 27`, rotated by `old >> 59`.
* Users:
  * `solver/local.rs:87` (seed `solver.seed ^ 0x9E3779B9`);
  * `priority.rs:351` (random tie-break permutation);
  * `grid/occupancy.rs:242` (tests).
* Spec: `spec/spec.md:1112-1126` (§10.4). `docs/adr/0007` and `ts/packages/core/src/pcg.ts`
  (16-bit limbs). Test vectors: `conformance/math/pcg32.json`.

**Source.** O'Neill, M. E. (2014). *PCG: A family of simple fast space-efficient
statistically good algorithms for random number generation.* Technical report
HMC-CS-2014-0905, Harvey Mudd College, 5 Sept 2014.
* URL: https://www.pcg-random.org/pdf/hmc-cs-2014-0905.pdf (BibTeX at
  pcg-random.org/paper.html).
* DOI: none known. It is a technical report; a TOMS-format version exists but its
  publication status was not confirmed.
* How found: WebSearch "O'Neill 2014 "PCG: A Family of Simple Fast Space-Efficient
  Statistically Good Algorithms for Random Number Generation" HMC-CS-2014-0905 Harvey
  Mudd", 2026-10-18.
* Read: search summary.
* Status: **VERIFIED-SEARCH** (report number, date, author).
* Claims (summary): passes a fast, medium-quality generator's output (an LCG) through a
  permutation function to improve statistical quality; 64- and 128-bit variants; multiple
  streams.

**Match or deviation.**
* **Matches PCG-XSH-RR 64/32** in the single-stream ("oneseq") form, as far as I recall
  the reference C library (`pcg_oneseq_64_xsh_rr_32`, srandom = `state=0; step; state+=seed;
  step`). The multiplier is the standard 64-bit LCG multiplier PCG uses, and the increment
  is PCG's default increment. The reference C code was not re-checked in this session.
* `next_below(n) = (u32·n) >> 32` (`pcg.rs:50-53`) is Lemire's multiply-shift **without**
  the rejection step, so it is slightly biased (relative bias ≤ n/2³²). This is harmless
  for annealing and tie-breaking, but the doc should say "biased by at most n/2³²" or add
  Lemire's rejection test.
  * Source: Lemire, D. (2019). *Fast random integer generation in an interval.* ACM
    Transactions on Modeling and Computer Simulation 29(1). DOI **10.1145/3230636**;
    arXiv:1805.10941.
  * How found: WebSearch "Lemire "Fast random integer generation in an interval" ACM
    TOMACS 29(1) 2019 doi 10.1145/3230636", 2026-10-18 (arXiv, TELUQ repository hits).
  * Read: search summary.
  * Status: **PARTIAL** (venue, volume, issue, DOI confirmed; article number and pages
    not).
  * Claims (summary): an *unbiased* method that avoids division in most cases, used by
    Go's shuffle.
* `shuffle` is Durstenfeld's form of the Fisher–Yates shuffle (from the end). Source:
  Durstenfeld, R. (1964). *Algorithm 235: Random permutation.* CACM 7(7), 420.
  **UNVERIFIED (from memory)**; DOI from memory, must be checked: 10.1145/364520.364540.

---

## 5. Simulated annealing / Metropolis acceptance (`solver/local.rs`)

**Code.**
* `rust/crates/la-core/src/solver/local.rs:96-122`: **T0**. Up to 50 probes. Each probe
  takes a random item; if it is placed, it takes a random usable candidate of that item
  and records Δ of the **static** cost if Δ > 0. T0 is the **median of the positive Δs**,
  falling back to 0.1, with a minimum of 1e-6.
* `local.rs:123,149`: schedule `T(it) = T0 · (10⁻³)^(it/N)`, an exponential (continuous
  geometric) decay to T0/1000 over the iteration budget.
* `local.rs:231, 267`: Metropolis test `Δ ≤ 0 || u < exp(−Δ/T)` for relocate and swap.
* `local.rs:292-305`: the best-so-far state is restored at the end.
* Insertion moves (`local.rs:153-210`) are **not** subject to Metropolis. They are taken
  whenever they improve the priority objective.
* Budget: `rust/crates/la-core/src/lib.rs:196-197`:
  `iters = min(max_iterations, budget_ms·100, 400·n)`, i.e. 10,000 moves at the default
  100 ms (`docs/adr/0007`, `docs/concepts/solver.md`).
* Spec: `spec/spec.md:1047-1056` (§10.2).

**Sources.**
1. Kirkpatrick, S., Gelatt, C. D., & Vecchi, M. P. (1983). *Optimization by simulated
   annealing.* Science 220(4598), 671–680.
   * DOI **10.1126/science.220.4598.671**.
   * How found: WebSearch "Kirkpatrick Gelatt Vecchi 1983 "Optimization by simulated
     annealing" Science 220(4598) 671-680 doi", 2026-10-18 (PubMed 17813860).
   * Read: abstract (search summary).
   * Status: **VERIFIED-SEARCH**.
   * Claims (abstract): connects statistical mechanics and combinatorial optimization;
     annealing in solids as a model for optimizing large systems; tested on TSPs with up
     to several thousand cities.
2. Metropolis, N., Rosenbluth, A. W., Rosenbluth, M. N., Teller, A. H., & Teller, E. (1953).
   *Equation of state calculations by fast computing machines.* J. Chemical Physics 21(6),
   1087–1092.
   * DOI **10.1063/1.1699114**.
   * How found: WebSearch "Metropolis Rosenbluth Teller 1953 "Equation of state
     calculations by fast computing machines" …", 2026-10-18.
   * Read: abstract (search summary).
   * Status: **VERIFIED-SEARCH**.
   * Claims: a Monte Carlo integration over configuration space (the origin of the
     Metropolis acceptance rule).
3. Christensen, J., Marks, J., & Shieber, S. (1995). *An empirical study of algorithms for
   point-feature label placement.* ACM Transactions on Graphics 14(3), 203–232.
   * DOI **10.1145/212332.212334**. Earlier version: MERL TR94-12 (1994).
   * How found: WebSearch "Christensen Marks Shieber 1995 "An empirical study …" ACM TOG
     14(3) 203-232 doi …", 2026-10-18. Free PDF at
     dash.harvard.edu/bitstream/1/2032678/2/AnEmpiricalStudy.pdf, which could not be
     fetched (DNS).
   * Read: search summaries.
   * Status: **VERIFIED-SEARCH** (bibliographic data).
   * SA parameters, **secondary only**: Harvard "carto notes"
     (eecs.harvard.edu/~shieber/Distrib/Sources/cartographica-figures/carto-notes.pdf) and
     MERL TR96-04, found with WebSearch ""point-feature label placement" simulated
     annealing schedule Christensen "initial temperature" …", 2026-10-18:
     * the initial temperature is "chosen so that P = 2/3 when ΔE = 1", where P is the
       probability of *undoing* a worsening move (P = 1 − e^(−ΔE/T)). So a unit-worse
       move is accepted with probability 1/3, T0 = 1/ln 3;
     * "periodically the temperature decreases by 10 percent" (MERL TR96-04 calls it a
       "standard geometric schedule");
     * a Java port (gpx2map docs) decreases T by 10 % every N iterations, where N is the
       number of labels.

     The stage length and stopping rule were **not** confirmed. I recall "20n tries / 5n
     successes per stage", but this is UNVERIFIED and should not be cited.
4. Edmondson, S., Christensen, J., Marks, J., & Shieber, S. (1996). *A general cartographic
   labelling algorithm.* Cartographica 33(4).
   * MERL TR96-04 (shadow.merl.com/publications/docs/TR96-04.pdf).
   * Status: **PARTIAL**. The search results confirm a 1996 Cartographica paper by these
     four authors (MERL TR96-04) that uses SA with a geometric schedule. The title, volume,
     issue and pages are from memory. DOI not confirmed.
5. US patent 7,414,637, *"Placement of map labels"* (image-ppubs.uspto.gov/…/7414637). Found
   in the same Christensen search.
   * Read: search summary only.
   * Status: **PARTIAL** (number and title from the result; assignee, inventors and date
     not seen).
   * Claim (summary): the start temperature comes from the **average non-improving Δ over
     the first n = 50 passes** with initial acceptance probability h₀ = 1/3. The
     temperature is then multiplied by λ = 0.9 periodically.
   * This is the **closest known precedent** to the code's "Δ statistic of 50 probe
     moves".
6. Johnson, D. S., Aragon, C. R., McGeoch, L. A., & Schevon, C. (1989). *Optimization by
   simulated annealing: An experimental evaluation; Part I, graph partitioning.* Operations
   Research 37(6), 865–892.
   * DOI **10.1287/opre.37.6.865**.
   * How found: WebSearch "Johnson Aragon McGeoch Schevon 1989 …", 2026-10-18 (INFORMS
     page, RePEc, author PDF at faculty.washington.edu/aragon/pubs/annealing-pt1a.pdf).
   * Read: abstract (search summary).
   * Status: **VERIFIED-SEARCH**.
   * Claims (abstract): a parameterized generic annealing implementation; beats
     Kernighan–Lin on large sparse random graphs but not on geometric graphs.
   * My **unverified recollection** of the body: the default parameters are INITPROB ≈ 0.4
     (T0 chosen so that about 40 % of uphill moves are accepted), TEMPFACTOR 0.95, and
     SIZEFACTOR × neighbourhood-size trials per temperature. To be checked in the PDF.
7. Zoraster, S. (1997). *Practical results using simulated annealing for point feature
   label placement.* Cartography and Geographic Information Systems 24(4).
   * Status: **UNVERIFIED**. The search did not find the paper. Pages and DOI are unknown.
8. Ben-Ameur, W. (2004). *Computing the initial temperature of simulated annealing.*
   Computational Optimization and Applications 29(3), 369–385.
   * Status: **UNVERIFIED** (this search hit the exhausted budget). DOI not confirmed.
   * Canonical reference for choosing T0 from a target acceptance ratio (my recollection).

**Match or deviation.**
* The Metropolis acceptance and the geometric decay match the classics.
* The T0 rule is in the same family as Christensen et al., the patent and Johnson et al.:
  at T0 the *median* uphill probe move is accepted with probability e⁻¹ ≈ 0.37, close to
  Christensen's 1/3 and to Johnson's ~0.4 (my recollection). So T0 is defensible.
  * Cite Christensen et al. 1995 (and Johnson et al. 1989) in spec §10.2.
  * Small fix: the spec says "median |Δ|", but the code takes the median of **positive**
    Δs only. Also, probes on unplaced items are skipped, so fewer than 50 samples may be
    used.
* **T0 uses static cost only**, while acceptance uses static + dynamic cost
  (`item_cost`). In dense scenes the dynamic terms (soft overlaps, buffers) may dominate,
  making T0 mis-scaled. Own observation.
* **Schedule length is the important deviation** (own analysis, relevant to weakness 2):
  * T0 → T0/1000 equals ln(1000)/ln(1/0.9) ≈ 65.6 stages of a 10 % geometric schedule.
  * With the default 10,000 moves that is about 150 moves per "stage" and about 5 moves
    per item in total for n = 2000. Even 20× iterations give about 100 moves per item.
  * The classical schedules (Christensen et al.; Johnson et al.'s SIZEFACTOR rule) scale
    the trials per temperature with n, so every label is tried several times per
    temperature.
  * In addition, `local.rs:212-221` spends iterations on no-ops: a randomly drawn
    *unplaced* item, `k == cur`, an unusable candidate, or ≥ 2 blockers. With about half
    the items unplaced in dense scenes, a large share of the budget does nothing.
  * Ideas:
    * draw relocations from the *placed* list;
    * draw preferentially from items in conflict or with unplaced neighbours (my
      recollection is that Christensen et al. limit moves to labels in conflict;
      UNVERIFIED);
    * set the budget per item and per temperature stage rather than a flat count, which
      can stay deterministic.
* Insertions bypass Metropolis (they are priority improvements) and the best-so-far state
  is restored. Both are reasonable and need no source.

---

## 6. Ejection chains (insert move)

**Code.**
* `rust/crates/la-core/src/solver/local.rs:351-489`: `try_insert`.
  * The unplaced item `u` tries ≤ 12 of its cheapest usable candidates, starting from a
    random offset.
  * A free candidate is placed directly.
  * With ≤ 2 blockers, the blockers are lifted, `u` is placed, and each blocker is
    re-placed by `relocate_chain` (depth 2).
  * Otherwise priority-improving eviction is tried.
* `local.rs:494-544`: `relocate_chain`. It takes the cheapest free candidate. If none is
  free, it scans the first 16 candidates for one with exactly 1 blocker, displaces that
  blocker and recurses. Undo goes through a transaction log (`Tx`, `local.rs:319-352`).
* Spec: §10.2 "ejection chain of depth ≤ 3".

**Source.** Glover, F. (1996). *Ejection chains, reference structures and alternating path
methods for traveling salesman problems.* Discrete Applied Mathematics 65(1–3), 223–253.
* **UNVERIFIED (from memory)**; DOI from memory, must be checked:
  10.1016/0166-218X(94)00037-E.
* Search budget was exhausted before this could be searched.
* What it does (recollection): compound moves in which one element's change "ejects"
  another, which in turn moves; trial solutions are evaluated along the chain and the best
  level is kept.

**Match or deviation.** The structure matches an ejection chain (insert → displaced label →
displaced label, depth ≤ 3). Deviations (own, based on the code):
* (a) the chain is **feasibility-driven, first-found**. Glover-style chains evaluate the
  objective at each level and pick the best trial. Here neither the cost of the chain nor
  alternative chains are compared; the chain is accepted whenever the priority objective
  improves.
* (b) only blockers with exactly one conflict are followed beyond the first level.
* (c) the 12 and 16 candidate caps.

Ideas:
* evaluate the 2–3 best complete chains and take the cheapest;
* allow chains whose end item is *unplaced but lower priority* (an eviction at the end of
  a chain).

Related label-specific local search: POPMUSIC for PFLP (Alvim & Taillard 2009, EJOR).
**UNVERIFIED**, not searched.

---

## 7. Most-constrained-first greedy ordering (`solver/greedy.rs`)

**Code.**
* `rust/crates/la-core/src/solver/greedy.rs:175-197`: within each priority band, a
  `BinaryHeap` keyed `(Reverse(live_count), Reverse(rank))`. The item with the **fewest
  live level-0 candidates** goes first; ties go to the higher priority.
* `greedy.rs:398-431` (`commit`): placing a label kills the conflicting live candidates of
  other undecided items and **re-queues** them with their new count (lazy deletion with a
  `cnt != live` check at `:186`).
* Spec §10.1. Brief: "most-constrained item first".

**Sources (all UNVERIFIED; searches exhausted).**
* Brélaz, D. (1979). *New methods to color the vertices of a graph.* CACM 22(4), 251–256.
  DOI from memory, must be checked: 10.1145/359094.359101. DSatur colours next the vertex
  with the largest *saturation* (distinct colours among its neighbours), with degree as
  tie-break.
* Haralick, R. M., & Elliott, G. L. (1980). *Increasing tree search efficiency for
  constraint satisfaction problems.* Artificial Intelligence 14(3), 263–313. DOI from
  memory, must be checked: 10.1016/0004-3702(80)90051-X. This is the "fail-first"
  principle: choose next the variable with the fewest remaining values (MRV).
* Golomb & Baumert (1965), *Backtrack programming*, J. ACM: often credited as the earliest
  smallest-domain-first heuristic. UNVERIFIED, no further data.
* Label-placement specific: Wagner, F., Wolff, A., Kapoor, V., & Strijk, T. (2001).
  *Three rules suffice for good label placement.* Algorithmica 30(2), 334–349. DOI not
  confirmed.
  * Recollection: rule-based reduction on the candidate conflict graph (a candidate
    without conflicts is taken; a point with a single candidate left fixes it).
  * Their heuristic phase deletes the candidate with the *most conflicts* at the point with
    the *most remaining candidates*. This is the same "constrainedness" idea, applied from
    the other side.

**Match or deviation.** It is MRV / fail-first, the dynamic analogue of DSatur, applied per
priority band. Deviations (own, based on the code):
* `live` counts only **level-0, statically feasible, already generated** candidates.
  Lazily generated distant candidates (`best_level0` adds "late" ones) and ladder variants
  are not counted, so items with good distant options look more constrained than they are.
* All candidates count equally, whatever their cost. An item with 1 cheap and 7 terrible
  live candidates counts as "8".

Idea: a cost-weighted count (for example the number of candidates within Δ of the item's
best, or Σ e^(−cost/τ)).

---

## 8. Lookahead cost (fraction of other items' candidates killed)

**Code.**
* `rust/crates/la-core/src/solver/greedy.rs:477-539` (`best_level0`): the 8 cheapest live
  candidates (`LOOKAHEAD_TOP`, `:34`) are re-scored with base cost + lookahead.
* `greedy.rs:541-581` (`lookahead`): Σ over undecided items j of
  `killed_j / live_j · w_lookahead`, plus `w_starve · #{j : killed_j ≥ live_j}`.
* Spec: `spec/spec.md:912-914` (§8): "unplaced items j of the same or lower key (greedy
  only)".

**Sources (UNVERIFIED; searches exhausted).** No label-placement paper with exactly this
term was found or recalled with confidence. The closest canonical sources are
*value-ordering* heuristics in constraint satisfaction:
* Frost, D., & Dechter, R. (1995). *Look-ahead value ordering for constraint satisfaction
  problems.* Proc. IJCAI-95, pp. 572–578 (pages from memory). DOI: none (IJCAI
  proceedings).
  * Recollection: it ranks the values of the current variable by their effect on the
    domains of future variables. Variants count removed values ("min-conflicts"), maximize
    the smallest remaining domain, or weight domains, and treat a domain wipe-out as worst.
* Geelen, P. A. (1992). *Dual viewpoint heuristics for binary constraint satisfaction
  problems.* Proc. ECAI-92, pp. 31–35 (from memory). The "promise" of a value is the
  product of the remaining domain sizes of future variables; zero means a wipe-out.
* "Least-constraining value" is the textbook name.
* Label placement: conflict-count candidate costs appear in Yamamoto, Câmara & Lorena
  2002 (Tabu search for PFLP, GeoInformatica 6(1)) and in Zoraster's IP heuristics.
  UNVERIFIED.

**Match or deviation.** My interpretation:
* `Σ killed_j/live_j` is a first-order approximation of −log of Geelen's promise:
  `log Π (live_j − k_j)/live_j ≈ −Σ k_j/live_j` for small `k_j/live_j`.
* `starve` is the wipe-out term.

So the heuristic has a sound CSP lineage, and citing Frost & Dechter or Geelen would
ground it. Deviations:
* it covers only the top 8 candidates by base cost;
* it covers only undecided items;
* it ignores candidate costs of the neighbours (killing a neighbour's *best* candidate
  costs the same as killing its worst).

Idea: weight killed candidates by their cost rank, or use the increase in the neighbour's
*best remaining cost* ("regret"). Regret-based ordering is standard in assignment
heuristics (no source verified).

---

## 9. Branch and bound exact search (`solver/exact.rs`)

**Code.**
* `rust/crates/la-core/src/solver/exact.rs`:
  * `:61-131` `dfs`, a DFS over items in **priority order**, each item trying its
    candidates cheapest first and then "unplaced";
  * `:75-87` the **bound** "every remaining item placed at its cheapest candidate" (no
    compatibility check);
  * `:144-150` the 24 cheapest *feasible* candidates per item;
  * `:153` give up if the pool has more than 3000 candidates;
  * `:157-174` the pairwise conflict lists.
* `rust/crates/la-core/src/lib.rs:216-217`: node budget `max(budget·2000, 10000)`.
* `docs/adr/0014-exact-search-branch-and-bound.md`.

**Sources (UNVERIFIED; searches exhausted).**
* Verweij, B., & Aardal, K. (1999). *An optimisation algorithm for maximum independent set
  with applications in map labelling.* Algorithms – ESA '99, LNCS 1643, pp. 426–437,
  Springer. DOI from memory, must be checked: 10.1007/3-540-48481-7_37. Recollection:
  branch-and-cut for maximum (weighted) independent set on the candidate conflict graph,
  with clique inequalities in the LP relaxation; solves map-labelling instances to
  optimality.
* Klau, G. W., & Mutzel, P. (2003). *Optimal labeling of point features in rectangular
  labeling models.* Mathematical Programming 94(2–3), 435–458. DOI from memory, must be
  checked: 10.1007/s10107-002-0327-9. Recollection: an exact approach based on a
  pair-of-constraint-graphs formulation, including the slider models.
* Haunert, J.-H., & Wolff, A. (2017). *Beyond maximum independent set: an extended integer
  programming formulation for point labeling.* ISPRS Int. J. Geo-Information 6(11), 342.
  UNVERIFIED, DOI not confirmed. Relevant because the problem here is weighted and
  lexicographic, not plain MIS.

**Match or deviation.** It is a plain DFS branch and bound on a conflict-graph
independent-set formulation, the same model as Verweij & Aardal, but with a much weaker
bound. Own analysis:
* (a) the bound counts a remaining item even when all its candidates conflict with the
  current partial solution. *Forward checking* fixes this cheaply: per remaining item,
  take the cheapest candidate still compatible, and add no priority weight if none is
  left. It tightens both the priority and the cost parts.
* (b) no clique bound. For a set of items whose candidates pairwise conflict (a clique in
  the item-conflict graph), at most k of them can be placed. Verweij & Aardal's clique
  inequalities are the LP form of this.
* (c) the order is fixed priority order. MRV order within an equal-priority run (as in §7)
  usually shrinks the tree.
* (d) the objective is **static cost only**. Dynamic soft terms (soft label–label overlaps,
  buffers between labels) used by local search are ignored, so "optimal" here can differ
  from the local-search objective. This should be stated in the ADR.
* (e) it is "exact" only over the 24 cheapest feasible candidates per item. The ADR says
  so.

---

## 10. Leader uncrossing by swapping (`solver/repair.rs`)

**Code.**
* `rust/crates/la-core/src/solver/repair.rs:505-587`: `uncross`. It runs only when leader
  crossings are soft (`:508`), for up to 50 rounds. For a pair (i, j) of crossing leaders,
  it moves i's box to j's box centre and vice versa (`moved_to`, `:589-614`, rebuilding
  straight leaders to the nearest box point). It accepts when the summed leader length
  strictly decreases and both are feasible and free, and restarts the scan after each
  swap.
* Called at `lib.rs:224`. Spec §10.3.

**Sources (UNVERIFIED; searches exhausted).**
* Bekos, M. A., Kaufmann, M., Symvonis, A., & Wolff, A. (2007). *Boundary labeling: Models
  and efficient algorithms for rectangular maps.* Computational Geometry: Theory and
  Applications 36(3), 215–236. DOI from memory, must be checked:
  10.1016/j.comgeo.2006.05.003. Recollection: proves that a labeling with minimum total
  leader length has no crossings, for straight/po-type leaders to boundary labels, using
  the exchange argument.
* Folklore exchange argument: for two crossing straight segments, swapping their
  endpoints strictly reduces the total length (triangle inequality). So a minimum-length
  perfect matching of points in the plane is non-crossing. My recollection is that this is
  also a classical Putnam problem. Atallah 1985 (J. Computer and System Sciences 31(1)) is
  sometimes cited for computing non-crossing matchings. All UNVERIFIED.

**Match or deviation.** It is the classical 2-exchange. Deviations (own analysis):
* (a) leaders end at the *nearest point of the box* and start at the *mark boundary*, not
  at fixed points. So the triangle-inequality guarantee does not carry over, and the code
  correctly tests "length decreases" explicitly;
* (b) it does not check that the swapped pair is actually uncrossed afterwards. A swap can
  shorten the total and still cross. Termination holds anyway, because each swap strictly
  reduces total length and there is a 50-round cap;
* (c) boxes of different sizes are swapped centre-to-centre, which may make one
  infeasible; this is checked;
* (d) cost: O(50·n²) pair scans with a restart after each swap.

With the default hard `leader_leaders` setting, this never runs.

---

## 11. Balanced line wrapping

**Code.**
* `rust/crates/la-text/src/wrap.rs:276-330`: `balanced(n, max_width)`.
  * It collects every candidate line width (the width of every possible line between
    break opportunities), sorts them, and **binary-searches the smallest width w for which
    the greedy (first-fit) wrap needs ≤ n lines**.
  * It returns the greedy wrap at that w.
* `wrap.rs:212`: `greedy`.
* `wrap.rs:550-575`: `extra_wrap_variants` produces balanced variants for n = 2..max_lines
  (the ladder's `wrap` step).
* `rust/crates/la-core/src/labels.rs:309-385`: callers.
* Spec: §5.3 (`spec/spec.md:524ff`).

**Sources (UNVERIFIED; searches exhausted).**
* Knuth, D. E., & Plass, M. F. (1981). *Breaking paragraphs into lines.* Software: Practice
  and Experience 11(11), 1119–1184. DOI from memory, must be checked:
  10.1002/spe.4380111102. Recollection: total-fit line breaking that minimizes a sum of
  "demerits" (based on squared adjustment ratios) by dynamic programming over feasible
  breakpoints; first-fit is the baseline.
* W3C CSS Text Module Level 4, `text-wrap: balance`. Recollection: user agents choose
  breaks that equalize line lengths while keeping the line count. Non-normative about the
  algorithm. UNVERIFIED.

**Match or deviation.** This is **not** Knuth–Plass. It solves the **min–max line width**
problem for a fixed maximum line count, which is the right objective for a label box: the
box width is the widest line, and the box height is set by the line count. Binary search
over candidate widths with a greedy feasibility test is exact for this objective (own
reasoning: for a fixed width, first-fit minimizes the line count, and the line count is
monotone in the width). It is optimal for box size.

Deviation and idea: among all wraps with max width ≤ w*, greedy picks the **most
top-heavy** one (early lines filled to w*, the last line possibly short). A second pass,
Knuth–Plass-style DP minimizing Σ (w* − width_i)² subject to width_i ≤ w* and the same n,
keeps the same box and gives visually more balanced lines. Suggested doc change: cite
Knuth–Plass as background and state the min–max objective explicitly.

---

## 12. Coverage rasterization and SVG/Bézier flattening

**Code.**
* Flattening: `rust/crates/la-svg/src/flatten.rs`.
  * `:1-12` module doc;
  * `:52-62` `bezier_segments`, **Wang's formula** `n = ceil(sqrt(k·M/tol))`, with
    `M = max|P_i − 2P_{i+1} + P_{i+2}|`, `k = 1/4` (quadratic) or `3/4` (cubic), uniform
    parameter steps after applying the CTM (`:139-185`);
  * `:30-50` `arc_segments`, the sagitta formula `n = ceil(Δ / (2·acos(1 − tol/r)))` with
    r = the largest singular value of the ellipse map, at least one segment per 90°;
  * tolerance 0.25 px (`spec/spec.md:104, 256`); `docs/adr/0013-svg-implementation.md:43`.
* Coverage: `rust/crates/la-core/src/grid/raster.rs`.
  * `:1-6` 4×4 supersampling per cell into 16-bit sample masks, union by OR, plus a TOUCH
    bit;
  * `:329-415` `polygon`, an active-edge scanline fill with even-odd and nonzero rules at
    sample centres;
  * `:141-218` `touch_segment`, a grid traversal (tMax/tDelta stepping);
  * `:437` `into_coverage`, quantizing to `u8`, with touched cells ≥ 1.

**Sources (UNVERIFIED; searches exhausted).**
* Wang Guo-Zhao (1984), the subdivision bound for Bézier curves, published in Chinese
  (Zhejiang University). Usually cited through secondary sources such as Filip, Magedson &
  Markot (1986), *Surface algorithms using bounds on derivatives*, Computer Aided Geometric
  Design 3(4), 295–311 (DOI not confirmed). Recollection: the chord deviation over a
  parameter step Δt is ≤ (1/8)·max‖x''‖·Δt², and for degree d, max‖x''‖ ≤ d(d−1)·max‖Δ²P‖.
  This gives `n ≥ sqrt(d(d−1)·M / (8·tol))`, i.e. k = 2/8 = 1/4 for quadratics and
  6/8 = 3/4 for cubics. **The code's constants match this derivation.**
* Alternative (non-peer-reviewed): R. Levien, "Flattening quadratic Béziers" (blog, 2019),
  near-optimal adaptive subdivision with fewer segments. UNVERIFIED.
* Grid traversal: Amanatides, J., & Woo, A. (1987). *A fast voxel traversal algorithm for
  ray tracing.* Eurographics '87, pp. 3–10. UNVERIFIED, DOI not confirmed. The code's
  `tmx/tmy/tdx/tdy` stepping is exactly this algorithm (own reading).
* Scanline polygon fill with an active edge table: textbook (Foley, van Dam et al.). No
  specific source checked.

**Match or deviation.**
* Wang's bound: matches; uniform steps are conservative. More segments than needed, but
  only coverage and collision accuracy depend on it.
* Arc sagitta with r = the largest singular value: my reasoning is that it is conservative,
  because the ellipse is a contraction of the circle of radius r, so chord errors shrink.
* Supersampled coverage has a quantization error of up to 1/16 of a cell per boundary
  cell. "Touch" marking makes "any coverage" conservative, which is consistent with
  ADR 0005.
* No change needed beyond citing Wang/Filip and Amanatides–Woo in ADR 0013 and spec §4.2.

---

## 13. Buffer ring cost and the two position orders

**Code.**
* Buffer ring: `rust/crates/la-core/src/cost.rs`.
  * `:127-196` other items' coverage in the ring;
  * `:234-241` per-class coverage in the ring.
  * Ring = the label box grown by `buffer`, minus the box. Cost =
    `w·covered(ring)/area(ring)`.
  * `spec/spec.md:880, 899`; `spec/defaults.md:34` ("Soft ambiguity buffer ring … (Mumtaz
    et al. 2019)"), default 0.3 em.
* Position orders: `rust/crates/la-core/src/model/opts.rs:90-111`.
  * `PERCEPTUAL` = T, R, B, L, TR, BR, TL, BL ("Bobák et al. 2026, PerceptPPO-like");
  * `CARTOGRAPHIC` = TR, TL, BR, BL, R, L, T, B ("Imhof");
  * `spec/spec.md:621-623`; `docs/concepts/candidates.md:19-21`.
* Position cost `w_position·rank/8` (`cost.rs:260`).

**Sources.**
* Mumtaz, H., van Garderen, M., Beck, F., & Weiskopf, D. (2019). *Point labeling with
  leaders for convex polygons and scatterplots* (title as given in `CITATION.cff`).
  EuroVis 2019 Short Papers.
  * Status: **not checked** in this session (no search budget left). Already cited by the
    project.
  * Whether the paper defines the buffer as an annulus fraction (as the code does) could
    not be confirmed.
* Imhof, E. (1975). *Positioning names on maps.* The American Cartographer 2(2), 128–144.
  * **UNVERIFIED (from memory)**; DOI from memory, must be checked:
    10.1559/152304075784313304.
  * The task asked for this citation to be verified. **It could not be verified**: search
    budget exhausted.
  * The **exact order TR, TL, BR, BL, R, L, T, B could not be traced to Imhof's text**. My
    recollection is that the four-corner part (TR > TL > BR > BL) is the ranking usually
    attributed to Imhof and Yoeli (1972, The Cartographic Journal) and reproduced in
    Christensen et al. 1995. The QGIS "cartographic" placement mode uses an order close to
    the code's (TR, TL, BR, BL, R, L, then slightly offset top and bottom), citing
    Krygier & Wood. All UNVERIFIED; this needs a check against the Imhof PDF.
  * Until then, the docs could say "after Imhof (1975) and common cartographic practice".
* Bobák, P., Čmolík, L., & Čadík, M. (2026). *From top-right to user-right: Perceptual
  prioritization of point-feature label positions.* CVM 2026. Already cited by the
  project. **Not checked**.

**Match or deviation.**
* The buffer ring is a plain area fraction, which is fine. One note: the ring is
  rectangular, so corners count fully although they are farther from the label than the
  sides. A distance-weighted ring (for example a falloff with distance from the box) would
  match the "visual crowding" intent better. Own idea, no source.
* Position cost is linear in rank (0..7)/8. Perceptual studies might support non-uniform
  gaps between ranks (Bobák et al. may give per-position preference values). Check the
  paper. Own idea.

---

## 14. Ambiguity term (label–feature association measured by distance)

**Code.**
* `rust/crates/la-core/src/cost.rs:280-290`: the term.
* `cost.rs:312-342`: for a box, `clamp((d_own − d_other)/em + 0.5, 0, 1)` when another
  item's shape is within `d_own + 0.5 em` of the box.
* `cost.rs:344-366`: for leaders, at the port, `1 − d_other/(2 em)` when another item is
  closer than the own one.
* `spec/spec.md:905-907` (§8).

**Sources (UNVERIFIED; searches exhausted).**
* van Dijk, S., van Kreveld, M., Strijk, T., & Wolff, A. (2002). *Towards an evaluation of
  quality for names placement methods.* Int. J. Geographical Information Science 16(7),
  641–661. DOI not confirmed. Recollection: formalizes cartographic quality criteria for
  name placement, including unambiguous *association* of a name with its feature.
* Rylov, M. A., & Reimer, A. W. (2014). *A comprehensive multi-criteria model for
  high-cartographic-quality point-feature label placement.* Cartographica 49(1), 52–68.
  DOI not confirmed.
* Rylov, M. A., & Reimer, A. W. (2015). *Improving label placement quality by considering
  basemap detail with a raster-based approach.* GeoInformatica 19(3), 463–486. DOI not
  confirmed. Recollection: multi-criteria costs including label–feature association and
  competition with neighbouring features; raster-based background analysis, conceptually
  close to the coverage grids here.
* Imhof 1975 (above): the principle that a name must be clearly associated with its
  object.

**Match or deviation.** Not checked against the sources. As implemented, it is a linear
ramp in signed distance difference, with half cost when equidistant. A plausible,
simple operationalization; no deviation can be claimed without reading the sources.

---

## Extra building blocks found while tracing (not in the task list)

| Block | Code | Canonical source (status) | Note |
|---|---|---|---|
| Bounded isotonic stacking (pool adjacent violators) for boundary columns | `solver/repair.rs:13-57` (`stack`) | Ayer, Brunk, Ewing, Reid & Silverman (1955), Annals of Mathematical Statistics 26(4), 641–647; DOI from memory 10.1214/aoms/1177728423. **UNVERIFIED** | Own check: gaps are removed by an offset transform, then PAV; clamping to `[lo, hi−offs]` is optimal for constant bounds on an isotonic sequence. Correct. |
| Hungarian assignment (boundary slots) | `solver/repair.rs:59-121`, used at `:235` | Kuhn (1955), Naval Research Logistics Quarterly 2, 83–97 (DOI from memory 10.1002/nav.3800020109); Munkres (1957), J. SIAM 5(1). **UNVERIFIED** | O(n³) potentials / shortest-augmenting-path form (the widely circulated "e-maxx" formulation). Matches. |
| Fisher–Yates shuffle, multiply-shift bounded integers | `la-expr/src/det_math/pcg.rs:50-70` | Durstenfeld 1964 (UNVERIFIED); Lemire 2019 (PARTIAL, §4) | Bounded draw lacks Lemire's rejection step, so it is slightly biased. |
| Grid traversal for "touch" marking | `grid/raster.rs:141-218` | Amanatides & Woo 1987 (UNVERIFIED) | Exact match of the stepping scheme. |
| Wang's formula, sagitta | `la-svg/src/flatten.rs:30-62` | §12 | Matches. |

---

## Cross-cutting improvement ideas (own interpretation, ranked)

1. **Annealing schedule length (weakness 2).**
   * 10,000 moves for 2000 items is about 5 moves per item over about 66 "10 % stages".
     The classical PFLP annealing (Christensen et al. 1995, secondary sources) and Johnson
     et al. (1989) scale trials per temperature with n.
   * Many iterations are no-ops (an unplaced item drawn for a relocation).
   * Sample from placed and conflicted items, and scale the per-stage budget with n.
   * Also put T0 on the same (static + dynamic) cost scale as acceptance.
2. **Aspect-aware clearance (weaknesses 1 and 3, internal labels).** Use an L∞ distance on
   h/w-scaled coordinates (or a scaled Euclidean distance) in polylabel and in the free-space
   DT, so poles and seeds are centres of the largest boxes with the label's aspect ratio.
   Both F&H/Meijster and polylabel generalize directly.
3. **Branch and bound.** Add forward checking (cheapest *compatible* candidate) and simple
   clique bounds (Verweij & Aardal). Order by MRV within equal priority. State in ADR 0014
   that the objective is static-only.
4. **Greedy ordering and lookahead.** Use cost-aware constrainedness (count near-best
   candidates) and cost-aware lookahead (regret: the increase of the neighbour's best
   remaining cost). Cite the CSP lineage (Haralick–Elliott, Brélaz, Frost–Dechter,
   Geelen) after verification.
5. **Ejection chains.** Compare the cost of complete chains (the Glover style), not
   first-found feasibility.
6. **Docs.**
   * Spec §4.7 claims DT-based early rejection, which is not in the code.
   * Spec §10.2 says "median |Δ|", but the code takes the median of positive Δ.
   * Cite Crow (ADR 0005), Meijster plus F&H (dt.rs), Garcia-Castellanos plus Agafonkin
     (polylabel), O'Neill and Lemire (pcg.rs), Metropolis, Kirkpatrick and Christensen
     (local.rs), Knuth–Plass as contrast (wrap.rs), Wang/Filip (flatten.rs).
   * The `next_below` bias should be documented.

---

## Query log (WebSearch, mode "standard", 2026-10-18)

1. `Crow 1984 "Summed-area tables for texture mapping" SIGGRAPH Computer Graphics 18(3) 207-212 doi`
2. `Felzenszwalb Huttenlocher "Distance transforms of sampled functions" Theory of Computing 2012 volume 8 doi 10.4086/toc.2012.v008a019`
3. `Meijster Roerdink Hesselink "A general algorithm for computing distance transforms in linear time" 2000 Mathematical Morphology doi`
4. `Garcia-Castellanos Lombardo 2007 "Poles of inaccessibility: A calculation algorithm for the remotest places on earth" Scottish Geographical Journal 123(3) doi`
5. `Agafonkin 2016 Mapbox blog "A new algorithm for finding a visual center of a polygon" polylabel`
6. `O'Neill 2014 "PCG: A Family of Simple Fast Space-Efficient Statistically Good Algorithms for Random Number Generation" HMC-CS-2014-0905 Harvey Mudd`
7. `Lemire "Fast random integer generation in an interval" ACM Transactions on Modeling and Computer Simulation 29(1) 2019 doi 10.1145/3230636`
8. `Kirkpatrick Gelatt Vecchi 1983 "Optimization by simulated annealing" Science 220(4598) 671-680 doi`
9. `Metropolis Rosenbluth Teller 1953 "Equation of state calculations by fast computing machines" Journal of Chemical Physics 21(6) 1087 doi 10.1063/1.1699114`
10. `Christensen Marks Shieber 1995 "An empirical study of algorithms for point-feature label placement" ACM Transactions on Graphics 14(3) 203-232 doi 10.1145/212332.212334`
11. `Christensen Marks Shieber simulated annealing label placement initial temperature "1/log 3" temperature decreased 10% "20n"`
12. `Zoraster 1997 "Practical results using simulated annealing for point feature label placement" Cartography and Geographic Information Systems 24(4)` (paper not found)
13. `"point-feature label placement" simulated annealing schedule Christensen "initial temperature" "2/3" "temperature is decreased by 10 percent"`
14. `Johnson Aragon McGeoch Schevon 1989 "Optimization by simulated annealing: an experimental evaluation; part I, graph partitioning" Operations Research 37(6) 865-892 doi`
15. `Ben-Ameur 2004 "Computing the initial temperature …"`: **refused (search budget exhausted)**.

WebFetch: `https://dash.harvard.edu/bitstream/1/2032678/2/AnEmpiricalStudy.pdf`, which
failed with ENOTFOUND.

**Still to verify in a follow-up session:**
* Glover 1996; Brélaz 1979; Haralick & Elliott 1980; Wagner et al. 2001;
* Frost & Dechter 1995; Geelen 1992;
* Verweij & Aardal 1999; Klau & Mutzel 2003; Haunert & Wolff 2017;
* Bekos et al. 2007; Knuth & Plass 1981; Wang 1984 / Filip et al. 1986; Amanatides & Woo
  1987;
* Imhof 1975 (including the position order); Mumtaz et al. 2019 (buffer definition);
  Bobák et al. 2026;
* van Dijk et al. 2002; Rylov & Reimer 2014/2015;
* Zoraster 1997; Ben-Ameur 2004; Edmondson et al. 1996 (title, volume, pages);
* Ayer et al. 1955; Kuhn 1955; Durstenfeld 1964;
* the Christensen et al. SA stage length and stopping rule (needs the full text).
