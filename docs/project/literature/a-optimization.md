# A. Combinatorial optimization for point-feature label placement (PFLP)

Topic agent A. Target weaknesses from the brief (00-brief.md): (1) dense data loses labels, (2) local search
adds only +0.7% over greedy+ladder, (5) time spent in the degradation ladder on labels that end
up omitted.

## Method and verification limits (read first)

* Date of all searches: 2026-10-18.
* **WebFetch could not resolve any host** (dblp.org, doi.org, api.crossref.org, dspace.library.uu.nl
  all failed with ENOTFOUND), and curl from the shell is blocked by the egress proxy (403). So
  **no publisher, DBLP or DOI page was opened directly**. All verification comes from WebSearch
  results: the search tool returns result URLs plus a summary that quotes the indexed pages
  (publisher pages, IDEAS/RePEc, IAOR, institutional repositories, Unpaywall DOI records, arXiv
  listings, citing papers' reference lists).
* Verification levels used here (as set by the coordinating session):
  * **VERIFIED-SEARCH**: bibliographic data (authors, venue, volume/pages, DOI) confirmed by search
    results that cite a publisher / repository / indexing page, named in the entry; page not opened.
  * **PARTIAL**: some fields confirmed only by a citing paper's reference list, or missing; said which.
  * **UNVERIFIED**: could not be confirmed; listed only at the end.
* "What I read" is always at most "abstract (as quoted in search summary)". No full text was read.
* The shared WebSearch budget (200 calls per turn, shared among agents) ran out before I could
  check: Araujo et al. (hybrid PFLP), Cravo/Ribeiro/Lorena GRASP (Computers & Geosciences), the
  Mauri et al. CEC 2022 Jaccard paper's DOI, and Yamamoto & Lorena's constructive GA. Those are
  listed as open items at the end.
* Repository context used for the "relevance" notes (read-only, nothing modified):
  `rust/crates/la-core/src/solver/exact.rs`, `local.rs`, `greedy.rs`, `rust/crates/la-core/src/lib.rs`.
  Key facts from the code:
  * `exact::run` returns immediately if the pool (<= 24 cheapest feasible candidates per item)
    exceeds 3000 candidates; `lib.rs` runs it only for `Strategy::Exact` or `Auto` with
    `cands.len() <= 3000` and `time_budget_ms >= 500`. So **exact search never runs on the dense
    scenes where weakness 1 shows up**.
  * The B&B bound in `exact.rs` is "every remaining item placed at its cheapest candidate", i.e. it
    ignores conflicts among the remaining items (the trivial bound), so pruning is weak.
  * The conflict graph for exact is built by an O(pool^2) pair loop with a bbox pre-filter.
  * `local.rs` keeps the invariant "the priority objective never gets worse" for every accepted
    move; SA acceptance applies only to cost. Count can rise only via the insertion move
    (ejection chain depth <= 3, 12 insert tries).
  * `greedy.rs::place_item` runs the full ladder (alternatives, wrap, distant, evict_lower,
    shrink, soft_overlap) for every item whose level-0 candidates are all blocked, with no early
    "this item cannot be placed" test.

---

## 1. Conflict-graph / maximum independent set (MIS) formulations and approximation

### 1.1 Formann & Wagner 1991 — the classic 4-position model and its hardness

* **Citation:** Michael Formann, Frank Wagner. 1991. A packing problem with applications to
  lettering of maps. In *Proceedings of the 7th Annual Symposium on Computational Geometry (SCG/SoCG
  '91)*, ACM, pp. 281–288.
* **DOI:** 10.1145/109648.109680 (given in the search summary; I could not tie it to a specific
  ACM page in the results).
* **How found:** WebSearch "Formann Wagner 1991 "A packing problem with applications to lettering
  of maps" SoCG" (2026-10-18). Results included the DBLP person page (dblp.org/pid/89/3150), a
  Springer chapter link, the KIT map-labeling pages (i11www.iti.kit.edu/map-labeling/points/one-square/...).
* **What I read:** secondary sources only (KIT map-labeling problem/algorithms pages, via search summary).
* **Verification:** PARTIAL. Venue/year/pages consistent across DBLP-listing and KIT pages
  (one citing reference says 281–290, probably a typo); DOI not confirmed on an ACM page.
* **Claims (as reported by secondary sources):**
  * Problem: label each point with an axis-parallel square of maximum common size that has the point
    as a corner (4-position model, size maximization rather than number maximization).
  * The decision problem is NP-complete (reduction from 3-SAT).
  * An O(n log n) algorithm achieves at least half the optimal label size; no polynomial-time
    algorithm can guarantee better than 50% unless P = NP.
* **Relevance to Label Anything:** background only (size maximization is not the library's
  objective). It is the origin of the 4-position model whose 8-position extension the library
  uses. The 2-SAT structure behind the Formann–Wagner algorithm (each point has two choices
  per axis) is my own note: it suggests a cheap feasibility check for "can all items in this small
  cluster be placed at their 4 corner positions", but this was not read in the source.

### 1.2 Agarwal, van Kreveld, Suri 1998 — MIS in rectangles

* **Citation:** Pankaj K. Agarwal, Marc van Kreveld, Subhash Suri. 1998. Label placement by maximum
  independent set in rectangles. *Computational Geometry: Theory and Applications* 11(3–4):209–218.
  (Earlier version at CCCG 1997.)
* **DOI:** 10.1016/S0925-7721(98)00028-5
* **How found:** WebSearch "Agarwal van Kreveld Suri "Label placement by maximum independent set in
  rectangles" Computational Geometry" and a second query restricted to dblp.org (2026-10-18).
  Results: Utrecht technical report (ics-archive.science.uu.nl/research/techreps/repo/CS-1998/1998-04.pdf),
  journal PDF copy (cglab.ca/~morin/teaching/484/notes/mis-rectangles.pdf), Utrecht DSpace record
  1874/18908, and several arXiv papers whose reference lists give the DOI.
* **What I read:** abstract (quoted in search summary).
* **Verification:** VERIFIED-SEARCH for authors/venue/volume/pages (journal PDF header
  "Computational Geometry 11 (1998) 209-218" quoted in the summary); DOI from citing papers'
  reference lists (issue given as 11(3) or 11(3–4) depending on the citing source).
* **Claims (abstract):**
  * Label placement reduces to selecting a maximum set of pairwise non-overlapping rectangles from the
    candidate rectangles (MIS in the rectangle intersection graph); NP-hard.
  * O(log n)-approximation for arbitrary axis-parallel rectangles in O(n log n) time.
  * 2-approximation in O(n log n) when all rectangles have unit height; (1+1/k)-approximation in
    O(n log n + n^(2k−1)) time for any integer k >= 1 (a PTAS).
* **Relevance:** Text labels of one font size are close to unit-height rectangles. The
  line-stabbing idea behind the unit-height results (my recollection, not read here: horizontal
  lines spaced one label height apart; each rectangle is stabbed by exactly one line; solve the
  rows by interval scheduling, then combine rows) gives a **conflict-graph upper bound and a
  decomposition into nearly independent horizontal strips**. Concretely for `exact.rs`: an upper
  bound on how many labels fit can be computed per strip with 1D interval scheduling (all
  candidates stabbed by the same line that pairwise overlap in x form cliques), which is much
  tighter than the current "all remaining items can be placed" bound. Also a principled
  initial solution (2-approx) for dense scenes.

### 1.3 van Kreveld, Strijk, Wolff 1999 — sliding labels (origin of the slider model)

* **Citation:** Marc van Kreveld, Tycho Strijk, Alexander Wolff. 1999. Point labeling with sliding
  labels. *Computational Geometry: Theory and Applications* 13(1):21–47. (TR UU-CS-1998-40.)
* **DOI:** 10.1016/S0925-7721(99)00005-X
* **How found:** WebSearch "van Kreveld Strijk Wolff "Point labeling with sliding labels"
  Computational Geometry 13" and "\"Point labeling with sliding labels\" "S0925-7721(99)00005-X"…"
  (2026-10-18). Results: TU Eindhoven research portal (research.tue.nl/en/publications/point-labeling-with-sliding-labels/),
  Utrecht DSpace 1874/18936 (open-access PDF), Crossref reference list in an IJGI article giving the DOI.
* **What I read:** abstract (quoted in search summary).
* **Verification:** VERIFIED-SEARCH (vol 13, issue 1, pp. 21–47 from TU/e portal; DOI from Crossref
  reference data of a citing IJGI paper).
* **Claims (abstract):**
  * Labels may slide continuously along their point instead of using a finite set of positions;
    "continuously sliding labels allow more points to be labeled both in theory and in practice".
  * Defines six labeling models (the fixed-position and slider models, e.g. 1-, 2-, 4-position and
    1-slider, 2-slider, 4-slider) and compares how many more points each model can label.
  * Maximizing the number of labeled points is NP-hard in the most general slider model.
  * A PTAS and a simple factor-2 approximation for each new model; experiments comparing models
    and against algorithms from the literature.
* **Relevance:** This is the origin of the slider model the library approximates with "4 slider
  positions per quadrant". Weakness 1 (dense data loses labels): the paper's main empirical claim
  is that sliders label more points. Improvement idea: inside the subproblem solver (see Idea 1
  in the summary), replace the 4 discrete slider samples by a *continuous* slide along each side:
  for a candidate side, compute the free interval(s) along that side given the fixed neighbours
  (1D interval subtraction of blocked x- or y-ranges), and place at the interval point closest to
  the preferred offset. This recovers placements that fall between samples without generating
  more candidate boxes (it also helps weakness 5 by replacing many sampled boxes with one
  interval computation).

### 1.4 Poon, Shin, Strijk, Uno, Wolff 2003/2004 — labeling points with weights

* **Citation:** Sheung-Hung Poon, Chan-Su Shin, Tycho Strijk, Takeaki Uno, Alexander Wolff.
  Labeling points with weights. *Algorithmica* 38(2):341–362 (online 2003, issue 2004). Conference
  version: ISAAC 2001, LNCS 2223, pp. 610–622 (four authors, without Uno).
* **DOI:** 10.1007/s00453-003-1063-0
* **How found:** WebSearch "Poon Zhu Chin "A polynomial time approximation scheme for the label
  placement problem" weighted" and "Poon Shin Strijk Uno Wolff "Labeling points with weights"
  Algorithmica volume pages" (2026-10-18). Results: Springer article page, doi.org link,
  BibSonomy, University of Nottingham Ningbo and TU/e research portals.
* **What I read:** bibliographic records and a one-line content summary from search results; no abstract text.
* **Verification:** VERIFIED-SEARCH (Springer record: Algorithmica 38, 341–362; year listed as
  2004 by Springer and 2003 by BibSonomy/Nottingham).
* **Claims (from search summary):** factor-2 approximation and a PTAS for the weighted case in
  fixed-position models (and slider models, per my recollection; not confirmed). A 2008 arXiv
  paper ("Trimming of Graphs, with Application to Point Labeling", arXiv:0802.2854) says Poon et al.
  left open a PTAS for weighted unit-height 1-slider labeling and supplies one.
* **About "Poon/Zhu/Chin PTAS":** I found no paper with that title. The closest is C.K. Poon,
  B. Zhu, F. Chin, "A polynomial time solution for labeling a rectilinear map", SoCG 1997 (listed
  in the HKU repository hub.hku.hk/handle/10722/152268); DOI and content not confirmed — PARTIAL,
  not used further.
* **Relevance:** Label Anything's "weighted" omission mode is exactly weighted label-number
  maximization. The weighted 2-approximation (line stabbing + per-row weighted interval
  scheduling, my reading) is a *weighted* upper bound usable for the optimality-gap report and
  for B&B pruning in weighted mode (the current exact bound adds every remaining item's weight).

### 1.5 Wagner, Wolff, Kapoor, Strijk 2001 — "Three rules suffice" (conflict-graph reductions)

* **Citation:** Frank Wagner, Alexander Wolff, Vikas Kapoor, Tycho Strijk. 2001. Three rules
  suffice for good label placement. *Algorithmica* 30(2):334–349.
* **DOI:** 10.1007/s00453-001-0009-7
* **How found:** WebSearch "Wagner Wolff Kapoor Strijk "Three rules suffice for good label
  placement" Algorithmica" (2026-10-18). Results: TU/e research portal, Unpaywall record of the
  DOI, IAOR record, author PDF (i11www.iti.kit.edu/~awolff/pub/wwks-3rsgl-01.pdf), Utrecht TR 2001-44.
* **What I read:** abstract (quoted in search summary); one secondary claim from the thesis
  "Fast Point-Feature Label Placement for Dynamic Visualizations" (arXiv:1209.5766).
* **Verification:** VERIFIED-SEARCH.
* **Claims (abstract):**
  * Separates the geometric part (candidate generation) from the combinatorial part, which is
    captured by the conflict graph of candidates.
  * Gives rules that shrink the conflict graph **without losing optimal solutions**; combined with
    a simple heuristic they yield near-optimal labelings.
  * Secondary (arXiv:1209.5766): the algorithm performs comparably to simulated annealing at much
    lower running time.
* **Relevance (weaknesses 2 and 5):** These reduction rules (from my memory, not confirmed here:
  L1 "a candidate with no conflicts is taken and the item's other candidates are deleted"; L2
  "if p_i conflicts only with q_k, and q_j conflicts only with p_k, take p_i and q_j"; L3 "if an
  item has one candidate left and its conflict neighbours form a clique, take it") are cheap,
  local and deterministic. They can run (a) before the greedy pass to fix safe placements and
  delete candidates early, shrinking both the greedy pass and the ladder's candidate pool; (b)
  as kernelization inside each POPMUSIC subproblem before B&B. The paper's Phase II heuristic
  ("repeatedly delete the candidate of maximum conflict degree, re-applying the rules") is a
  candidate-elimination alternative to the current "most-constrained item first" greedy that
  could be tried on the 2000-random-points benchmark.

### 1.6 Strijk, Verweij, Aardal 2000 — MIS algorithms applied to map labelling (heuristics + branch-and-cut)

* **Citation:** Tycho Strijk, Bram Verweij, Karen Aardal. 2000. Algorithms for maximum independent
  set applied to map labelling. Technical Report UU-CS-2000-22, Department of Information and
  Computing Sciences, Utrecht University (PDF dated 27 Sept 2000).
* **DOI:** none (technical report). Stable URLs: research-portal.uu.nl/en/publications/algorithms-for-maximum-independent-set-applied-to-map-labelling/ ,
  ics-archive.science.uu.nl/research/techreps/repo/CS-2000/2000-22.pdf , dspace.library.uu.nl/handle/1874/18989
* **How found:** WebSearch "Strijk Verweij Aardal "Algorithms for maximum independent set applied
  to map labelling" technical report" (2026-10-18).
* **What I read:** abstract-level summary (search summary of the repository record and PDF).
* **Verification:** VERIFIED-SEARCH (Utrecht research portal record).
* **Claims:**
  * Map labelling (non-overlapping axis-parallel squares anchored at points) is formulated as MIS on
    the conflict graph.
  * Several heuristics, some taking an LP solution as input, and a branch-and-cut algorithm for
    exact optimality.
  * Instances with up to 950 cities solved to optimality in reasonable time.
  * Related: Verweij & Aardal, ESA 1999, "An optimisation algorithm for maximum independent set
    with applications in map labelling" (seen only in a reference list; not verified).
* **Note on the brief:** the brief mentions "Strijk et al. 2000 'Placing labels in multiple map
  layers / simple heuristics'". I could not find a paper with that title; this 2000 Strijk et al.
  report (heuristics + exact MIS) is the closest match and is what I cover.
* **Relevance:** Direct evidence that exact MIS with LP-based bounding scales to ~1000 points
  (2000-era hardware). The library's B&B has no LP or clique bound. Improvement (my
  interpretation): add a **clique-cover bound** to `exact.rs` (point-stabbing cliques: all
  candidates containing a common sample point pairwise conflict; greedy clique partition of the
  remaining candidates; bound = sum over cliques of the max weight in the clique, capped by the
  per-item bound). This is the combinatorial analogue of the clique inequalities used in
  LP-based MIS branch-and-cut (the specific inequalities used in this report are not confirmed).

### 1.7 Lamm, Sanders, Schulz, Strash, Werneck 2017 — MIS at scale (reductions + evolutionary)

* **Citation:** Sebastian Lamm, Peter Sanders, Christian Schulz, Darren Strash, Renato F. Werneck.
  2017. Finding near-optimal independent sets at scale. *Journal of Heuristics* 23(4):207–229.
  Preprint arXiv:1509.00764.
* **DOI:** 10.1007/s10732-017-9337-x
* **How found:** WebSearch "Lamm Sanders Schulz Strash Werneck "Finding near-optimal independent
  sets at scale" Journal of Heuristics" (2026-10-18). Results: IDEAS/RePEc record, Univ. Vienna
  eprints, ar5iv of arXiv:1509.00764.
* **What I read:** abstract (journal abstract via IDEAS summary; arXiv abstract via search summary).
* **Verification:** VERIFIED-SEARCH.
* **Claims (abstract):**
  * An evolutionary algorithm combined with kernelization (data reduction rules) and an exact
    branch-and-reduce approach.
  * Removing vertices likely to be in large independent sets makes further reductions more
    effective; this speeds up computation and reaches much larger instances than previous work.
  * A weighted follow-up exists (Großmann, Lamm, Schulz, Strash, "Finding Near-Optimal Weight
    Independent Sets at Scale", JGAA 2024; seen in results, not verified further).
* **Relevance:** General-purpose MIS state of the art; not label-specific. Two transferable ideas
  for the library (my interpretation): (1) **reduce-then-search**: apply exact reductions
  (degree-0/1, domination, simplicial/clique vertices — standard MIS reductions, generalizing
  Wagner et al.'s rules) to the candidate conflict graph before B&B or local search; (2)
  **"inexact reduction" of likely-in-solution vertices** = commit confidently placed labels (e.g.
  conflict-free, high-priority) to shrink the remaining problem, which is what makes local
  exact search affordable on dense instances. The (1,2)-swap local search of Andrade–Resende–Werneck
  that KaMIS builds on is from my memory, not verified here.

### 1.8 Bhore, Li, Nöllenburg 2020/2022 — fully dynamic MIS for map labeling

* **Citation:** Sujoy Bhore, Guangping Li, Martin Nöllenburg. 2022. An algorithmic study of fully
  dynamic independent sets for map labeling. *ACM Journal of Experimental Algorithmics* 27:1–36.
  Preliminary version: ESA 2020, LIPIcs 173, article 19.
* **DOI:** 10.1145/3514240 (JEA); 10.4230/LIPIcs.ESA.2020.19 (ESA, from the DROPS bibtex URL in results)
* **How found:** WebSearch "Bhore Li Nöllenburg "An Algorithmic Study of Fully Dynamic Independent
  Sets for Map Labeling" ACM Journal of Experimental Algorithmics" (2026-10-18). Results: TU Wien
  reposiTUm record and VoR PDF, DROPS (drops.dagstuhl.de), BGU CRIS, arXiv:2002.07611.
* **What I read:** abstract (search summary of reposiTUm record).
* **Verification:** VERIFIED-SEARCH.
* **Claims (abstract):**
  * Maintain a large independent set of axis-parallel rectangular labels as labels appear/disappear;
    sublinear update time.
  * A dynamic 2-approximation for unit-height, arbitrary-width rectangles.
  * Experiments on synthetic and real map-labeling instances: dynamic approaches much faster than
    recomputing statically; **greedy augmentation of approximate solutions substantially improves
    solution size**.
  * Code and benchmark data: dyna-mis.github.io/dynaMIS.
* **Relevance:** (a) Weakness 2: "approximate solution + greedy augmentation" is a cheap
  post-pass that the paper found effective; the library already does greedy, but could seed it from
  a line-stabbing 2-approx (Section 1.2) instead of priority order alone in `prefix`/`weighted`
  modes. (b) Benchmark data source (see Section 5). (c) Interactive use (weakness 4, outside my
  focus): dynamic MIS maintenance as a model for warm starts.

---

## 2. Exact methods, ILP, Lagrangean bounds

### 2.1 Zoraster 1990 — Lagrangian heuristic for label placement as a 0-1 IP

* **Citation:** Steven Zoraster. 1990. The solution of large 0–1 integer programming problems
  encountered in automated cartography. *Operations Research* 38(5):752–759.
* **DOI:** 10.1287/opre.38.5.752
* **How found:** WebSearch "Zoraster 1990 "The solution of large 0-1 integer programming problems
  encountered in automated cartography" Operations Research 38(5) Lagrangian" (2026-10-18).
  Results: INFORMS page pubsonline.informs.org/doi/10.1287/opre.38.5.752, IDEAS/RePEc, IAOR record.
* **What I read:** abstract (search summary).
* **Verification:** VERIFIED-SEARCH.
* **Claims (abstract):**
  * Map label placement modeled as a multiple-choice 0-1 integer program (one position per label).
  * A Lagrangian heuristic exploiting the problem structure gives cost-effective solutions for
    problems with tens of thousands of variables and thousands of constraints.
* **Relevance:** Shows that Lagrangian relaxation works on exactly the library's structure
  (choose at most one candidate per item; pairwise conflicts) **without an LP solver**, which
  matters for a dependency-free, deterministic Rust/TS core. See Idea 3 in the summary.

### 2.2 Klau & Mutzel 2003 — optimal labeling in rectangular (incl. slider) models

* **Citation:** Gunnar W. Klau, Petra Mutzel. 2003. Optimal labeling of point features in
  rectangular labeling models. *Mathematical Programming* 94(2–3):435–458.
* **DOI:** 10.1007/s10107-002-0327-9
* **How found:** WebSearch "Klau Mutzel "Optimal labeling of point features in rectangular labeling
  models" Mathematical Programming" (2026-10-18). Results: Unpaywall DOI record, IAOR record
  (iaorifors.com/paper/42930), an LNCS 2000 bib entry for the conference version (Klau:2000:OLP).
* **What I read:** abstract (search summary).
* **Verification:** VERIFIED-SEARCH (IAOR + Unpaywall DOI record).
* **Claims (abstract):**
  * Label number maximization (NP-hard) for discrete models (point at a label corner) and slider
    models (point on the label boundary).
  * A pair of constraint graphs for horizontal and vertical relations, linked by extra constraints,
    yields a 0-1 ILP.
  * First algorithm, to the authors' knowledge, computing provably optimal solutions in slider models.
* **Relevance:** (a) Offline ground truth: optimal solutions for small/medium benchmark scenes in
  slider models, to measure how far greedy+ladder+LS is from optimal (is the +0.7% from local
  search small because greedy is near-optimal or because LS is weak?). (b) The constraint-graph
  view (horizontal/vertical order relations instead of pairwise box conflicts) is a different way
  to represent sliding labels continuously; my interpretation: a per-subproblem continuous
  slider placement could use the same "order + separation" constraints solved by longest paths
  once the relative order of neighbouring labels is fixed.

### 2.3 Strijk et al. 2000 (see 1.6) — branch-and-cut for MIS in map labelling

(Covered in Section 1.6.)

### 2.4 Ribeiro & Lorena 2008 — Lagrangean relaxation with clusters

* **Citation:** Glaydston Mattos Ribeiro, Luiz Antonio Nogueira Lorena. 2008. Lagrangean relaxation
  with clusters for point-feature cartographic label placement problems. *Computers & Operations
  Research* 35(7):2129–2140 (end page not confirmed).
* **DOI:** 10.1016/j.cor.2006.09.024
* **How found:** WebSearch "Ribeiro Lorena "Lagrangean relaxation with clusters for point-feature
  cartographic label placement problems" Computers & Operations Research" and a second query with
  the DOI (2026-10-18). Results: Crossref reference list of a citing paper (ref with DOI and start
  page 2129), a journal issue index (vol 35 issue 7, July 2008).
* **What I read:** no abstract of this paper; the abstract of the closely related Pesquisa
  Operacional 2006 paper by the same authors ("Lagrangean relaxation bounds for point-feature
  cartographic label placement problem", SciELO: www.scielo.br/j/pope/a/ygC3CSqhJcXMFM9Mcc5d74f/ ;
  volume/pages not confirmed).
* **Verification:** PARTIAL (volume/issue/start page/DOI from a Crossref reference list and a
  journal index; author list and end page not seen on a record page).
* **Claims (from the related 2006 abstract and from the 2008 JOCO abstract that builds on it):**
  * PFCLP modeled on a conflict graph (vertices = candidate positions, edges = potential overlaps).
  * The conflict graph is first partitioned into clusters; a Lagrangean relaxation is applied
    after the partition (relaxing the edges between clusters), giving tight lower and upper bounds.
* **Relevance:** The cluster partition is the same object a POPMUSIC-style decomposition needs;
  relaxing only inter-cluster conflicts and solving each cluster exactly (with the existing B&B)
  gives both a heuristic solution and an upper bound. See Idea 3.

### 2.5 Ribeiro & Lorena 2008 — column generation (Dantzig–Wolfe) for PFCLP

* **Citation:** Glaydston Mattos Ribeiro, Luiz Antonio Nogueira Lorena. 2008. Column generation
  approach for the point-feature cartographic label placement problem. *Journal of Combinatorial
  Optimization* 15(2):147–164.
* **DOI:** 10.1007/s10878-007-9073-5
* **How found:** WebSearch "Ribeiro Lorena "Column generation approach for the point-feature
  cartographic label placement problem" Journal of Combinatorial Optimization 15" (2026-10-18).
  Results: IDEAS/RePEc record (ideas.repec.org/a/spr/jcomop/v15y2008i2d10.1007_s10878-007-9073-5.html),
  DBLP person page mirror (dblp1.uni-trier.de/pid/68/5459.html).
* **What I read:** abstract (search summary of IDEAS record).
* **Verification:** VERIFIED-SEARCH.
* **Claims (abstract):**
  * Column generation based on the Lagrangean relaxation with clusters for conflict-graph problems.
  * The graph is split into clusters feeding a restricted master problem in a Dantzig–Wolfe
    decomposition; cluster subproblems resemble small PFCLPs and generate improving columns.
  * On literature instances: better solutions than all previously known in reasonable time, and
    optimal solutions for some large instances.
* **Relevance:** Evidence that "cluster subproblems solved exactly + coordination" beats
  monolithic metaheuristics on the standard instances. For the library, the cheap analogue is
  POPMUSIC (no master LP), possibly with Lagrangean coordination (Idea 1 + 3).

### 2.6 Mauri, Ribeiro, Lorena 2010 — new 0-1 model + Lagrangean decomposition

* **Citation:** Geraldo Regis Mauri, Glaydston Mattos Ribeiro, Luiz Antonio Nogueira Lorena. 2010.
  A new mathematical model and a Lagrangean decomposition for the point-feature cartographic label
  placement problem. *Computers & Operations Research* 37(12):2164–2172.
* **DOI:** not confirmed (search results did not show it).
* **How found:** WebSearch "Mauri Ribeiro Lorena "A new mathematical model and a Lagrangean
  decomposition for the point-feature cartographic label placement problem"" and a follow-up with
  volume/pages (2026-10-18). Result: FAPESP Biblioteca Virtual record
  (bv.fapesp.br/en/publicacao/30882/...), MaRDI portal.
* **What I read:** short abstract text via search summary.
* **Verification:** PARTIAL (authors, volume, issue, pages confirmed by FAPESP record; DOI unknown).
* **Claims:** proposes a 0-1 ILP for PFCLP whose objective is to maximize the number of
  conflict-free ("free") labels, solved with a Lagrangean decomposition. (Details of formulation and
  results not seen.)
* **Relevance:** The "maximize free labels" objective is exactly label-number maximization with
  all-labels-placed semantics (labels in conflict count as not placed), which is the objective
  the Christensen-style SA optimizes. Supports Idea 3 (bounds) and Idea 5 (count-changing search).

### 2.7 Ribeiro, Mauri, Lorena 2011 — Lagrangean decomposition for MIS applied to map labeling

* **Citation:** Glaydston Mattos Ribeiro, Geraldo Regis Mauri, Luiz Antonio Nogueira Lorena. 2011.
  A Lagrangean decomposition for the maximum independent set problem applied to map labeling.
  *Operational Research* 11(3):229–243.
* **DOI:** 10.1007/s12351-009-0075-1
* **How found:** WebSearch "\"A lagrangean decomposition for the maximum independent set problem
  applied to map labeling\" Operational Research 10.1007/s12351-009-0075-1" (2026-10-18).
  Results: IAOR record (iaorifors.com/paper/71811), Unpaywall DOI record.
* **What I read:** abstract (search summary of IAOR record).
* **Verification:** VERIFIED-SEARCH (author order as listed by IAOR: G. Ribeiro, G. R. Mauri,
  L. A. N. Lorena; IAOR dates the issue Nov 2011).
* **Claims (abstract):**
  * Map labeling modeled as MIS on a conflict graph; exact techniques struggle on some instances.
  * Lagrangean decomposition: partition the conflict graph into smaller subproblems, duplicate
    some decision variables, relax the copy-equality constraints in a Lagrangean way.
  * Proved optimality on all but one of the literature instances tested; beat a commercial solver.
* **Relevance:** Strongest evidence in this set that **decomposition + Lagrangean bounds can
  certify optimality on the standard PFLP instances**. For Label Anything this means an
  "optimality gap" report is achievable without an LP solver, and that the dense benchmark
  scenes could be checked for how many labels are geometrically achievable.

### 2.8 Haunert & Wolff 2017 — beyond MIS: extended ILP for point labeling

* **Citation:** Jan-Henrik Haunert, Alexander Wolff. 2017. Beyond maximum independent set: an
  extended integer programming formulation for point labeling. *ISPRS International Journal of
  Geo-Information* 6(11):342. (Extended version of an ISPRS Congress 2016 paper, Int. Arch.
  Photogramm. Remote Sens. Spatial Inf. Sci. XLI-B2:109.)
* **DOI:** 10.3390/ijgi6110342
* **How found:** WebSearch "Haunert Wolff "Beyond Maximum Independent Set: An Extended Integer
  Programming Formulation for Point Labeling" ISPRS International Journal of Geo-Information"
  (2026-10-18). Results: MDPI page (www.mdpi.com/2220-9964/6/11/342/htm), Würzburg OPUS PDF,
  Crossref record.
* **What I read:** abstract (search summary of MDPI page).
* **Verification:** VERIFIED-SEARCH.
* **Claims (abstract):**
  * Maximizing total label weight ignores interactions between labels and tends to pack labels so
    densely that they hide the background; whether a label causes ambiguous label–point association
    depends on which other labels are placed.
  * Extended model formulated as an ILP; optimal solutions in reasonable time on random point sets
    and a city data set.
  * A relaxation of the ILP yields a simple, efficient heuristic that was near-optimal on their
    instances.
  * Optimal solutions are useful as benchmarks for faster heuristics; exact methods can be too slow
    for real-time use.
* **Relevance:** Label Anything already has interaction costs (ambiguity, lookahead, buffer
  coverage) that the plain MIS model lacks; this paper is the closest exact formulation of such
  pairwise interactions. Ideas: (a) use their ILP offline on small bench scenes to obtain exact
  references *including* ambiguity terms; (b) their relaxation-based heuristic supports a
  relaxation-guided greedy (Idea 3).

---

## 3. Metaheuristics

### 3.1 Christensen, Marks, Shieber 1995 — empirical study incl. simulated annealing

* **Citation:** Jon Christensen, Joe Marks, Stuart Shieber. 1995. An empirical study of algorithms
  for point-feature label placement. *ACM Transactions on Graphics* 14(3):203–232. (MERL TR94-12.)
* **DOI:** 10.1145/212332.212334
* **How found:** WebSearch "Christensen Marks Shieber "An empirical study of algorithms for
  point-feature label placement" ACM Transactions on Graphics 14(3) 203-232 doi" (2026-10-18).
  Results: Harvard DASH record (dash.harvard.edu/entities/publication/73120378-7f0c-...) giving the
  DOI, DASH PDF, MERL TR94-12.
* **What I read:** abstract (search summary); one secondary claim from the Edmondson, Christensen,
  Marks, Shieber Cartographica paper (via Shieber's carto-notes page).
* **Verification:** VERIFIED-SEARCH (DOI from Harvard DASH record; vol/issue/pages from the
  paper header quoted in summary). DASH lists Shieber first; the paper header and TR list
  Christensen first.
* **Claims (abstract + secondary):**
  * PFLP and most interesting variants are NP-hard.
  * Two new heuristics: discrete gradient descent and simulated annealing; compared with
    previously known methods.
  * Secondary (Edmondson et al.): the stochastic/heuristic techniques all outperform depth-first
    search by a wide margin. (My recollection, not verified here: SA was the best overall in the
    TOG study, and its objective counts labels in conflict, with conflicting labels deleted at
    the end, i.e. SA moves may temporarily worsen the number of conflict-free labels.)
* **Relevance (weakness 2):** The library's SA (`local.rs`) only anneals the *cost* and forbids
  any move that reduces the priority objective. This is the main structural difference from
  the SA that made SA successful for label-number maximization. See Idea 5.

### 3.2 Verner, Wainwright, Schoenefeld 1997 — genetic algorithm with masking

* **Citation:** Oleg V. Verner, Roger L. Wainwright, Dale A. Schoenefeld. 1997. Placing text labels
  on maps and diagrams using genetic algorithms with masking. *INFORMS Journal on Computing*
  9(3):266–275.
* **DOI:** 10.1287/ijoc.9.3.266
* **How found:** WebSearch "Verner Wainwright Schoenefeld "Placing text labels on maps and diagrams
  using genetic algorithms with masking" INFORMS Journal on Computing" (2026-10-18). Results:
  INFORMS PDF URL (pubsonline.informs.org/doi/pdf/10.1287/ijoc.9.3.266), IAOR record, DBLP person pages.
* **What I read:** abstract (search summary).
* **Verification:** VERIFIED-SEARCH.
* **Claims (abstract):**
  * GA for PFLP; "masking" keeps good subsequences of chromosomes from being disrupted by crossover
    and mutation.
  * Performed well on random point sets and US map data; significantly better than other PFLP
    algorithms from the literature (at the time).
* **Relevance:** Low direct value for a deterministic, time-budgeted engine (population methods
  are expensive). The masking idea corresponds to "freeze conflict-free regions and only perturb
  conflicting ones", which POPMUSIC (3.4) does more cheaply.

### 3.3 Yamamoto, Câmara, Lorena 2002 — tabu search

* **Citation:** Missae Yamamoto, Gilberto Câmara, Luiz Antonio Nogueira Lorena. 2002. Tabu search
  heuristic for point-feature cartographic label placement. *GeoInformatica* 6(1):77–90 (issue
  number 1 not confirmed; "GeoInformatica 6, 77–90 (2002)" per Springer citation line).
* **DOI:** 10.1023/A:1013720231747
* **How found:** WebSearch "Yamamoto Câmara Lorena "Tabu search heuristic for point-feature
  cartographic label placement" GeoInformatica 6" (2026-10-18). Results: Springer article page
  (link.springer.com/article/10.1023/A:1013720231747), Crossref reference data in a citing paper.
* **What I read:** abstract (search summary of the Springer page).
* **Verification:** VERIFIED-SEARCH (first names of the first author from memory; search showed
  "Yamamoto, M.").
* **Claims (abstract):**
  * Label placement treated as combinatorial optimization; tabu search evaluated on real and
    random test cases.
  * Compared with simulated annealing and a genetic algorithm, tabu search had the best quality and
    was efficient; recommended for point-feature label placement.
* **Relevance:** Tabu memory is a deterministic alternative to SA randomization for escaping local
  optima, and it is what POPMUSIC/PAL use inside subproblems (see 3.4/3.5). For the library:
  a short tabu list on (item, candidate) pairs in `local.rs` would stop the relocate/swap moves
  from cycling, but the bigger gain is expected from changing the neighbourhood (Ideas 1 and 5).

### 3.4 Alvim & Taillard 2009 — POPMUSIC for PFLP

* **Citation:** Adriana C. F. Alvim, Éric D. Taillard. 2009. POPMUSIC for the point feature label
  placement problem. *European Journal of Operational Research* 192(2):396–413. (Earlier: MIC 2005
  conference paper and a 2005 technical report, per the KIT map-labeling bibliography.)
* **DOI:** 10.1016/j.ejor.2007.10.002 (from a Crossref reference entry; IDEAS record confirms
  vol/issue/pages).
* **How found:** WebSearch "Alvim Taillard "POPMUSIC for the point feature label placement problem"
  European Journal of Operational Research 192" (2026-10-18). Results: IDEAS/RePEc record
  (ideas.repec.org/a/eee/ejores/v192y2009i2p396-413.html), KIT map-labeling bibliography, MDPI IJGI
  5(9):159 paper describing it, arXiv:2303.01388 describing it.
* **What I read:** abstract (search summary of IDEAS record); secondary descriptions from MDPI IJGI
  5(9):159 and arXiv:2303.01388.
* **Verification:** VERIFIED-SEARCH.
* **Claims (abstract + secondary):**
  * A new PFLP heuristic built on the POPMUSIC framework (Partial OPtimization Metaheuristic Under
    Special Intensification Conditions).
  * Better than other recent metaheuristics; running time grows roughly linearly with problem size;
    tested up to 10 million points; new real-data instances with more than 13,000 labels.
  * Secondary (arXiv:2303.01388): POPMUSIC divides the problem into subproblems that are optimized
    with tabu search.
  * Secondary (Klute et al. 2019, arXiv:1910.07799, describing the QGIS implementation): starts from
    an initial solution and repeatedly runs a bounded local search from individual features,
    stopping once every feature has been examined (the POPMUSIC framework of Taillard and Voss).
* **Relevance (weaknesses 1, 2; core recommendation):** POPMUSIC is the best fit for the library's
  architecture (deterministic, iteration-budgeted, has an exact solver for small problems). See
  Idea 1: seeds = items (unplaced first), part = seed + its r nearest items in the conflict graph,
  subproblem = all candidates of the part with labels outside the part fixed, solved by the
  existing `exact.rs` B&B with the current labels as incumbent; on improvement re-insert the
  part's items into the seed set; stop when the seed set is empty or the budget is spent. This
  gives the exact solver work on dense scenes where it currently returns early (pool > 3000).

### 3.5 PAL / libpal (QGIS labeling engine) — POPMUSIC in production

* **Citation (software):** libpal — Automated Placement of Labels Library. Copyright (C) 2008
  Maxence Laurent, MIS-TIC, HEIG-VD University of Applied Sciences, Western Switzerland; contact
  Éric Taillard. GPL v3 or later. Integrated in QGIS (`src/core/pal/pal.h`).
* **DOI:** none. Stable URL: https://api.qgis.org/api/pal_8h_source.html (QGIS API docs; versions
  2.18 through 4.1-master appear in results).
* **How found:** WebSearch "PAL label placement library Ertz Laurent Taillard QGIS POPMUSIC HEIG-VD"
  (2026-10-18).
* **What I read:** QGIS API source-header pages (as quoted in search summary).
* **Verification:** VERIFIED-SEARCH for the header content. **Olivier Ertz's co-authorship is
  UNVERIFIED** (no result named him); no publication describing libpal was found.
* **Claims (header):**
  * GPL library for automated label placement, copyright Maxence Laurent (HEIG-VD), contact Éric
    Taillard.
  * Header contains a "POPMUSIC Tuning" block (a POPMUSIC radius parameter with default 30, tabu
    iteration limits, tenure, candidate list size) in QGIS 3.22/3.24 docs.
  * QGIS 3.x docs label one search method "the worst but fastest method".
* **Relevance:** Shows POPMUSIC + tabu is production-proven in the most widely used open-source
  GIS labeling engine; the "radius" parameter is the size r of a POPMUSIC part, a concrete knob to
  copy (the library would use a candidate-count cap, e.g. <= 300–3000 candidates per part, so
  the B&B finishes within its node budget).

### 3.6 Klute, Li, Löffler, Nöllenburg, Schmidt 2019 — exact vs heuristic MIS inside QGIS

* **Citation:** Fabian Klute, Guangping Li, Raphael Löffler, Martin Nöllenburg, Manuela Schmidt.
  2019. Exploring semi-automatic map labeling. In *Proc. 27th ACM SIGSPATIAL International
  Conference on Advances in Geographic Information Systems (SIGSPATIAL '19)*, pp. 13–22.
  Extended version arXiv:1910.07799.
* **DOI:** 10.1145/3347146.3359359 (from a citing paper's reference list)
* **How found:** WebSearch ""Exploring Semi-Automatic Map Labeling" Klute Löffler Nöllenburg
  SIGSPATIAL 2019 POPMUSIC QGIS" and a second query for the DOI/pages (2026-10-18). Results:
  arXiv abs/pdf, Utrecht research portal (pages 13–22), TU Wien reposiTUm.
* **What I read:** abstract (search summary of arXiv listing); one description of QGIS's POPMUSIC
  from the arXiv full text as quoted in a search summary.
* **Verification:** PARTIAL (authors/venue/pages from Utrecht portal and arXiv; DOI only from a
  reference list).
* **Claims (abstract):**
  * Human-in-the-loop workflow: compute a good initial labeling, an expert edits locally,
    algorithms update after each edit.
  * Simulation experiment in QGIS comparing exact and heuristic algorithms; algorithms integrated
    into QGIS's labeling engine (which uses PAL).
* **Relevance:** Practical evidence that exact (MIS/ILP-based) and heuristic local re-optimization
  can run inside an interactive labeling engine on real maps, i.e. local exact repair after a
  change is affordable. For the library: the same "local exact re-solve around the change"
  maps to warm-start repair and to POPMUSIC parts seeded at items whose anchors moved.

### 3.7 Rabello, Mauri, Ribeiro, Lorena 2014 — Clustering Search

* **Citation:** Rodrigo L. Rabello, Geraldo R. Mauri, Glaydston M. Ribeiro, Luiz A. N. Lorena. 2014.
  A clustering search metaheuristic for the point-feature cartographic label placement problem.
  *European Journal of Operational Research* 234(3):802–808. (First names of first author from
  memory; search showed "Rabello".)
* **DOI:** 10.1016/j.ejor.2013.10.021
* **How found:** WebSearch "Rabello Mauri Ribeiro Lorena "A clustering search metaheuristic for the
  point-feature cartographic label placement problem" EJOR 234" (2026-10-18). Result: IDEAS/RePEc
  record (ideas.repec.org/a/eee/ejores/v234y2014i3p802-808.html).
* **What I read:** abstract (search summary).
* **Verification:** VERIFIED-SEARCH.
* **Claims (abstract):**
  * Clustering Search (CS) metaheuristic for PFCLP (a later source describes it as simulated
    annealing enhanced with a clustering mechanism).
  * Instances with up to 13,206 points, "the same used in several recent and important
    researches"; matched all known optima and improved best-known solutions where optima are unknown.
* **Relevance:** Benchmark anchor (13,206-point instances) and evidence that SA-based search with
  intensification in promising regions works for label count maximization. Intensifying search
  where conflicts concentrate = seed POPMUSIC parts at items with omitted neighbours.

### 3.8 Guerine, Rosseti, Plastino 2020 — hybrid data-mining heuristic

* **Citation:** Marcos Guerine, Isabel Rosseti, Alexandre Plastino. 2020. A hybrid data mining
  heuristic to solve the point-feature cartographic label placement problem. *International
  Transactions in Operational Research* 27:1189–1209 (issue number not confirmed). One source lists
  the author order as Rosseti, Guerine, Plastino.
* **DOI:** 10.1111/itor.12666
* **How found:** WebSearch "Guerine Rosseti Plastino "A hybrid data mining heuristic to solve the
  point-feature cartographic label placement problem" International Transactions in Operational
  Research" (2026-10-18). Results: vLex article page with front matter ("Int. Trans. Op. Res. 27
  (2020) 1189–1209"), BrCris record.
* **What I read:** abstract and front matter (search summary).
* **Verification:** VERIFIED-SEARCH (author order uncertain, as noted).
* **Claims (abstract):**
  * Variant: label as many points as possible without conflicts.
  * Builds on Clustering Search; first use of data mining to improve CS and SA-based heuristics
    (frequent patterns from elite solutions guide construction).
  * Better solutions than the original CS for the same time; found almost all known optima and
    improved most best results for large instances.
* **Relevance:** Interpretation: "mine frequent (item, candidate) choices from good solutions and
  fix them" is a cheap way to shrink the search; in the library, labels that are identical across
  the greedy result and several LS restarts (different seeds) could be frozen, and the remaining
  budget concentrated on the unstable region. Moderate value; mention as optional.

### 3.9 Rylov & Reimer 2014 — comprehensive multi-criteria PFLP model

* **Citation:** Maxim A. Rylov, Andreas W. Reimer. 2014. A comprehensive multi-criteria model for
  high cartographic quality point-feature label placement. *Cartographica* 49(1):52–68.
* **DOI:** 10.3138/carto.49.1.2137 (as given in search summary; not tied to a publisher page)
* **How found:** WebSearch "Rylov Reimer "A comprehensive multi-criteria model for high
  cartographic quality point-feature label placement" Cartographica 49" (2026-10-18). Results:
  Project MUSE issue listing (muse.jhu.edu/issue/29696), Heidelberg GIScience blog, MDPI IJGI
  6(11):342 (Haunert & Wolff) discussing it, Rylov dissertation PDF.
* **What I read:** secondary sources only (Heidelberg GIScience blog; Haunert & Wolff 2017 as
  quoted in search summary).
* **Verification:** PARTIAL (journal issue confirmed via Project MUSE listing; DOI not tied to a
  publisher page; no abstract read).
* **Claims (secondary):**
  * Model complies with almost all well-defined cartographic placement principles for PFLP,
    allowing a significant increase in label density without loss of legibility (Heidelberg blog).
  * Handles graphical clutter and ambiguous label–point association (Haunert & Wolff).
  * Solved with greedy, discrete gradient descent and simulated annealing, which give good solutions
    without optimality guarantees (Haunert & Wolff).
* **Relevance:** Closest published analogue of the library's multi-term cost model. Main lesson for
  this topic (my interpretation): with a rich cost model, the optimizer must handle a
  lexicographic "count first, then quality" objective; Rylov–Reimer handle it with SA over the
  full model, which again points at allowing count-changing moves in SA (Idea 5).

---

## 4. Learning-based recent work (2019–2026)

### 4.1 Bobák, Čmolík, Čadík 2024 — Reinforced Labels (multi-agent deep RL)

* **Citation:** Petr Bobák, Ladislav Čmolík, Martin Čadík. 2024. Reinforced Labels: Multi-agent deep
  reinforcement learning for point-feature label placement. *IEEE Transactions on Visualization and
  Computer Graphics* 30(9):5908–5922. Preprint arXiv:2303.01388 (March 2023).
* **DOI:** 10.1109/TVCG.2023.3313729 (from the Brno University of Technology FIT record; not
  confirmed on IEEE Xplore)
* **How found:** WebSearch "Bobák Čmolík Čadík "Reinforced Labels: …" IEEE TVCG doi" and "arXiv
  2303.01388 Reinforced Labels abstract …" (2026-10-18). Results: arXiv, VUT FIT result record
  (www.fit.vut.cz/research/result/c185209/), CTU DCGI publication page, project page
  cphoto.fit.vutbr.cz/reinforced-labels/.
* **What I read:** abstract (search summary).
* **Verification:** VERIFIED-SEARCH (volume/issue/pages from VUT record; DOI from the same record's
  early-access entry).
* **Claims (abstract):**
  * First machine-learning-driven labeling method: each label is an agent; multi-agent deep RL.
  * Higher completeness (number of placed labels) than a random untrained agent and than the
    compared human-designed methods; a user study also preferred it.
  * Slower; suited to precomputed labelings where completeness matters (maps, technical drawings,
    medical atlases).
* **Relevance:** Confirms there is headroom in completeness over hand-crafted heuristics, but the
  approach conflicts with the library's determinism, bit-identical Rust/TS ports, and time budget.
  Not a recommended solver component; possibly a reference point when benchmarking completeness
  (they publish a supplement and project page).

### 4.2 Qu, Zhang, Che, Chen, Ling 2025 — Graph Transformer for Label Placement (LPGT)

* **Citation:** Jingwei Qu, Pingshun Zhang, Enyu Che, Yinan Chen, Haibin Ling. 2025. Graph
  transformer for label placement. *IEEE Transactions on Visualization and Computer Graphics*
  31(1):1257–1267 (IEEE VIS 2024).
* **DOI:** 10.1109/TVCG.2024.3456141 (from the authors' GitHub citation; not confirmed on IEEE Xplore)
* **How found:** WebSearch "graph neural network label placement point features learning
  overlap-free labels 2024 OR 2025" and ""Graph Transformer for Label Placement" Qu Ling IEEE
  Transactions on Visualization and Computer Graphics 2025 31 doi" (2026-10-18). Results: IEEE VIS
  2024 program page, author PDF (www3.cs.stonybrook.edu/~hling/publication/LPGT-vis24.pdf),
  github.com/JingweiQu/LPGT.
* **What I read:** abstract-level description (search summary).
* **Verification:** PARTIAL (volume/pages from a citing bibliography; DOI from GitHub).
* **Claims:** labels as graph nodes, label–label interactions as edges; label placement as node
  position prediction with a graph transformer using edge-level attention; new dataset AMIL
  (appliance manual illustrations). Search results did not say whether outputs are overlap-free.
* **Relevance:** Low for the optimizer. A learned model could at most provide a candidate-ranking
  prior; it does not give feasibility guarantees, which the library checks exactly anyway.

### 4.3 Zhang, Che, Chen, Huang, Ling, Qu 2025 — Mixture of Cluster-guided Experts (IEEE VIS 2025)

* **Citation:** Pingshun Zhang, Enyu Che, Yinan Chen, Bingyao Huang, Haibin Ling, Jingwei Qu. 2025.
  Mixture of cluster-guided experts for retrieval-augmented label placement. IEEE VIS 2025 full
  paper (session "Ordering and Layout", 5 Nov 2025).
* **DOI:** unknown.
* **How found:** WebSearch "\"Mixture of Cluster-guided Experts for Retrieval-Augmented Label
  Placement\" IEEE VIS 2025" (2026-10-18). Results: IEEE VIS 2025 program pages
  (aa.ieeevis.org/year/2025/program/paper_4becbe1b-2bde-4b12-adfd-e45a36678884.html).
* **What I read:** program listing only (title, authors, session).
* **Verification:** PARTIAL (no publication record or DOI seen).
* **Relevance:** Listed for completeness of the 2024–2026 learning-based landscape; no content read.

### 4.4 Oucheikh & Harrie 2024 — generative deep learning for map labeling (feasibility study)

* **Citation:** Rachid Oucheikh, Lars Harrie. 2024. A feasibility study of applying generative deep
  learning models for map labeling. *Cartography and Geographic Information Science* (2024;
  volume/issue/pages not confirmed).
* **DOI:** unknown (journal prefix 10.1080/15230406; exact DOI not seen).
* **How found:** WebSearch "Oucheikh Harrie generative deep learning map labeling feasibility study
  Cartography and Geographic Information Science" and two follow-ups (2026-10-18). Results: Lund
  University publication pages (www.gis.lu.se/lars-harrie/publication/44c1bca6-73cc-4137-bda2-a4ef28bbfe12).
* **What I read:** abstract (search summary of the Lund page).
* **Verification:** PARTIAL (title/authors/journal/year confirmed; volume/pages/DOI not).
* **Claims (abstract):** CycleGAN and Pix2Pix trained on labeled maps predict label positions on
  unlabeled raster maps; compared with manual labeling and an optimization-based method; models
  find appropriate positions but in this implementation are poor at selecting which labels to show
  and at sizing them.
* **Relevance:** Shows that label *selection* (the MIS part, weakness 1) is precisely what
  generative models do poorly; keeps combinatorial optimization as the right tool for selection.

### 4.5 Cao, Zhang, Li, Ren, Chen 2026 — progressive reinforcement learning for PFLP

* **Citation:** Wen Cao, Yinbao Zhang, Runsheng Li, Liqiu Ren, He Chen. 2026. Progressive
  reinforcement learning for point-feature label placement in map annotation. *ISPRS International
  Journal of Geo-Information* 15(4):162 (published 9 April 2026).
* **DOI:** 10.3390/ijgi15040162
* **How found:** WebSearch "ISPRS International Journal of Geo-Information 2026 volume 15 article 162
  label placement" and the title query (2026-10-18). Result: MDPI PDF
  (mdpi-res.com/d_attachment/ijgi/ijgi-15-00162/article_deploy/ijgi-15-00162.pdf).
* **What I read:** first part of the abstract (truncated in the search summary).
* **Verification:** VERIFIED-SEARCH for bibliographic data; results not seen.
* **Claims (abstract, partial):** PFLP framed as NP-hard discrete optimization; argues SA/GA get stuck
  in local optima and model conflicts poorly; a single agent makes sequential placement decisions
  with a "staircase-like" policy from exploration to exploitation. Results not seen.
* **Relevance:** Recent (2026) evidence that the community still sees SA/GA local optima as the
  bottleneck in dense PFLP, consistent with weakness 2. No transferable mechanism confirmed.

### 4.6 Other recent items seen but not assessed

* Harry Shomer, Jiejun Xu. 2025. Automated label placement on maps via large language models.
  arXiv:2507.22952 (AI4DE workshop at KDD'25). VERIFIED-SEARCH (arXiv listing); content not read.
  Not relevant to the optimizer.
* "Constraint-Safe Graph-Context Scoring for Stable Point-Feature Labels Under Text-Width and
  Accessibility-Inspired Profiles", arXiv:2609.19848 (Sept 2026). Only the introduction was visible
  in a search summary (an 8-candidate "LABELSENSE-Pilot" with graph-context summaries of local
  competition per candidate); authors not seen. PARTIAL. Possibly relevant to candidate scoring
  ("local competition" features resemble the library's lookahead), not assessed.

---

## 5. Standard benchmark instance sets

What I could confirm (all VERIFIED-SEARCH only at the level of "the abstract says so"):

* **Lorena-group PFCLP instances (INPE/LAC, Brazil).** Used by Ribeiro & Lorena (2008, 2011),
  Mauri et al. (2010), Rabello et al. (2014), Guerine et al. (2020), and a 2022 IEEE CEC paper by
  Mauri, L. H. N. Lorena, L. A. N. Lorena, Chaves (Jaccard-index overlap measure; FAPESP record
  bv.fapesp.br/en/publicacao/220805). Abstracts say "instances proposed in the literature" and
  "up to 13,206 points". I could not find a download page (lac.inpe.br) in search results.
* **Alvim & Taillard real-data instances**: the 2009 EJOR abstract says they introduced real-data
  instances with more than 13,000 labels and tested up to 10 million points (random). The 13,206-point
  instances used by Rabello et al. are plausibly these (my inference, not confirmed).
* **Christensen–Marks–Shieber random instances** (TOG 1995): widely used, but I could not confirm
  their parameters via search. UNVERIFIED (memory): uniform random points on a 792x612 region,
  30x7 labels, 4 candidate positions, n = 100…1500. Must be checked in the DASH PDF before use.
* **Yamamoto–Câmara–Lorena** (2002) used "real and random test cases" (abstract). The specific sets
  (sizes 25…1000 points, 25 instances each) are UNVERIFIED (memory).
* **dynaMIS benchmark data** (Bhore, Li, Nöllenburg 2022): synthetic and real-world map-labeling
  instances, published at dyna-mis.github.io/dynaMIS (per the reposiTUm abstract).
* **Haunert & Wolff 2017**: random point sets and an existing city data set (abstract).

**Relevance:** The library's bench (`bench/`) already has scene generators and baselines. Adding a
loader for PFLP literature instances (4 or 8 fixed positions, unit labels, no obstacles) would allow
(a) comparison to the published optimal/best-known label counts (Ribeiro et al. 2011 proved
optimality on almost all of them; Rabello et al. 2014 matched optima), which isolates the
optimizer's quality from the library's cost model; (b) a regression metric "gap to best known" for
any solver change (POPMUSIC, bounds, moves). The dense instances are exactly the regime of
weakness 1.

---

## 6. Improvement ideas for Label Anything (ranked)

Each idea names the component, the weakness, and the supporting sources. Ideas marked
"interpretation" go beyond what the sources state.

1. **POPMUSIC-style local optimization with the existing exact B&B as the subproblem solver**
   (weaknesses 1, 2). Seeds: unplaced items first (those that ran the ladder), then placed items
   in priority order. Part: seed + the r nearest items in the candidate conflict graph (cap by total
   candidates, e.g. 200–1000, so `exact.rs` finishes within a small node budget). Labels outside the
   part are fixed obstacles; candidates conflicting with them are dropped. Incumbent = current
   labels, so it never gets worse (matches the existing invariant). On improvement, re-insert the
   part's items as seeds; stop when no seeds remain or the deterministic budget is spent.
   Currently `exact::run` returns early when the pool exceeds 3000 candidates, so exact search never
   helps on the dense scenes. Supports: Alvim & Taillard 2009 (3.4); libpal (3.5);
   Ribeiro & Lorena 2008 clusters/column generation (2.4, 2.5); Ribeiro, Mauri, Lorena 2011 (2.7).

2. **Conflict-aware upper bound in `exact.rs`** (weakness 2; makes Idea 1 fast). Replace "each
   remaining item at its cheapest candidate" with a clique-cover bound: greedily partition the
   remaining items' candidates into cliques of mutually overlapping boxes (point-stabbing cliques,
   or Agarwal-style horizontal-line strips with 1D interval reasoning); bound = sum of per-clique
   max weight, capped by the per-item bound. Interpretation, motivated by Agarwal, van Kreveld,
   Suri 1998 (1.2), Strijk, Verweij, Aardal 2000 LP-based branch-and-cut (1.6), Klau & Mutzel 2003 (2.2).

3. **Lagrangean relaxation: optimality-gap report plus guidance** (weaknesses 1, 2, 5). Relax the
   pairwise or clique conflict constraints with multipliers; each subgradient step decomposes per
   item (pick the best candidate under penalized weights), costs O(#candidates + #conflicts), needs
   no LP solver and is deterministic. Outputs: (a) an upper bound on attainable (priority-weighted)
   labels, reported in benchmark/explain output ("501 placed, at most N placeable"), which tells
   whether weakness 1 is geometric or algorithmic; (b) penalized costs as a better greedy order
   (Lagrangean heuristic); (c) reduced-cost pruning of candidates that cannot appear in a better
   solution. Supports: Zoraster 1990 (2.1); Ribeiro & Lorena 2008 (2.4, 2.5); Mauri et al. 2010 (2.6);
   Ribeiro, Mauri, Lorena 2011 (2.7); Haunert & Wolff 2017 relaxation heuristic (2.8).

4. **Doomed-label detection before the degradation ladder** (weakness 5). (a) Apply conflict-graph
   reduction rules (Wagner et al. 2001, 1.5; MIS kernelization, Lamm et al. 2017, 1.7) once before
   greedy and inside subproblems. (b) Before running ladder steps for item i, run a cheap
   conservative test (interpretation): if a clique/strip bound over the region reachable by i (anchor
   ± max leader length + label size) shows that already placed labels of priority >= i plus hard
   obstacles leave no room for even the smallest variant (shrink 0.85), skip straight to omit (in
   strict mode keep evict_lower only when lower-priority labels lie in that region). (c) Use the
   Lagrangean bound per cluster (Idea 3): if a cluster can hold at most k labels and its k
   highest-priority items are placed, the rest are doomed. Targets the ~1M candidate boxes
   generated for the 1128 omitted labels.

5. **Allow count-changing moves in local search** (weakness 2). `local.rs` forbids any move that
   lowers the priority objective, so SA only anneals cost. Options (interpretation): (a)
   priority-neutral plateau moves (remove one label, insert another of equal key/weight) and
   (1,2)-swaps (remove one, insert two) as first-class moves; (b) Christensen-style objective
   inside SA (labels may temporarily conflict or be removed, penalized by weight), keeping the
   best-so-far snapshot so the returned result still never gets worse. Supports: Christensen,
   Marks, Shieber 1995 (3.1); Rabello et al. 2014 and Guerine et al. 2020 SA-based CS (3.7, 3.8);
   Mauri et al. 2010 "free labels" objective (2.6); (1,2)-swap local search from MIS literature (memory, unverified).

6. **Continuous sliders inside subproblems** (weakness 1, partly 5). Replace the 4 sampled slider
   positions per quadrant with a free-interval computation along each label side when a subproblem
   or ladder step looks for room: same or fewer boxes, more placements. Supports: van Kreveld,
   Strijk, Wolff 1999 (1.3) (sliders label more points "in theory and in practice"); Klau & Mutzel
   2003 (2.2) (exact slider models); Poon et al. 2003/2004 (1.4) (weighted slider approximations).

7. **Benchmark the optimizer on literature PFLP instances and against exact optima** (all
   weaknesses; measurement). Add loaders for Lorena-group / Alvim–Taillard / dynaMIS instances and
   compute optima offline (ILP of Haunert & Wolff 2017 or Klau & Mutzel 2003) for small bench scenes;
   report the gap. Supports: 2.7, 3.4, 3.7, 1.8, 2.8, Section 5.

8. (Low priority) **Learning-based methods**: not recommended as solver components (determinism,
   bit-identical TS port, time budget). Reinforced Labels (4.1) is a useful completeness reference;
   Oucheikh & Harrie (4.4) shows generative models are weak at label selection, the part the MIS
   machinery handles.

---

## 7. Open items / not verified

* Yamamoto & Lorena, "A constructive genetic approach to point-feature cartographic label placement"
  (c. 2005, Springer book chapter in *Metaheuristics: Progress as Real Problem Solvers*): **UNVERIFIED**,
  not found in two searches; only a secondary mention (MDPI IJGI 8(5):237) of Yamamoto & Lorena's
  constructive GA giving good results up to 1000 points.
* Araujo et al. (hybrid/recent PFLP heuristic): **not searched** (search budget exhausted).
* Cravo, Ribeiro, Lorena 2008 GRASP for PFCLP (Computers & Geosciences): seen only as a mention in
  results ("a GRASP based on the conflict graph"); bibliographic data not verified.
* Mauri, Lorena, Lorena, Chaves, IEEE CEC 2022, Jaccard-index PFCLP: seen in FAPESP record summary;
  DOI not verified.
* "Trimming of Graphs, with Application to Point Labeling" (arXiv:0802.2854): PTAS for weighted
  unit-height 1-slider labeling; authors not confirmed in results (memory: Erlebach, Hagerup,
  Jansen, Minzlaff, Wolff).
* Christensen et al. instance parameters and Yamamoto et al. instance sizes: UNVERIFIED (see Section 5).
