# D: Quality criteria, perception/evaluation, fast and scalable placement

Topic owner: literature agent D. Date of all searches: 2026-10-18.
Targets: weakness 5 (2000 labels over 100k points take ~300 ms, target 120 ms; ~1M ladder
candidate boxes made for labels that are omitted in the end), the cost model (ambiguity,
position preference, buffer, background coverage) and the evaluator.

## How this was verified (read first)

* **WebFetch could not reach any host** in this environment (dblp.org, doi.org,
  api.crossref.org, arxiv.org, research.tue.nl all returned `ENOTFOUND`). curl from the
  shell is refused by the egress proxy (403). The GitHub MCP tool can reach only
  fabian-beck/label-anything, so the MapLibre source could not be read either.
* So **every check was done with WebSearch only**. The search tool returns result URLs and
  a summary written by the search model from those pages. I never opened a page myself.
* Status labels used below (they follow the coordinator's instruction):
  * **VERIFIED-SEARCH**: the bibliographic data (authors, title, venue, volume/issue/pages,
    DOI) appeared in search results that came from a DBLP, publisher, DOI or arXiv page
    (named in the entry). I did not open the page directly.
  * **PARTIAL**: some of the data was confirmed that way, and the entry says which fields
    were not.
  * **UNVERIFIED**: from memory. Every such statement is marked "(from memory, UNVERIFIED)".
* "What I actually read" is always at best the **abstract or a secondary summary that the
  search tool returned**. Never full text.
* **The shared web-search budget (200 calls per turn, shared by all agents) ran out**
  before I finished. Some checks that were planned could not be done: DBLP lookups for
  Kittivorawong, Pavlovec and Been; the mechanism details of particle-based labeling; the
  Rylov & Reimer criteria list. These gaps are marked in the entries.
* Findings about the repository come from reading its code (read-only):
  `rust/crates/la-core/src/solver/greedy.rs` (`place_item`, the ladder loop),
  `solver/mod.rs` (`ladder_candidates`, `ensure_distant`), `grid/occupancy.rs`
  (an occupancy bitset plus a summed-area table, built once the grid is frozen),
  `grid/dt.rs` (exact Euclidean distance transform, Felzenszwalb & Huttenlocher, used for
  the distant "free-space seeds" in `obstacles.rs`).

---

## A. Cartographic quality rules and how they were formalized

### A1. Imhof 1975, Positioning names on maps
* **Citation:** Eduard Imhof (1975). Positioning names on maps. *The American
  Cartographer* 2(2):128–144. English version of "Die Anordnung der Namen in der Karte"
  (1962).
* **DOI:** not confirmed. No publisher page appeared in the results, so I give none.
* **How found:** WebSearch `Imhof 1975 "Positioning names on maps" The American
  Cartographer` (2026-10-18).
* **What I read:** secondary sources only: Wikipedia "Typography (cartography)", the
  reference list of arXiv 1501.07188 (Label Placement in Road Maps), and an AutoCarto 9
  paper ("Automated names placement in a non-interactive environment", cartogis.org).
* **Status:** PARTIAL. Volume, issue and pages agree across secondary reference lists.
  No publisher page seen. DOI unknown.
* **Claims (as given by the secondary sources):**
  * Fundamental rules: legibility; **clear association** of the name with its feature;
    avoid overlapping other map content; show the extent of the object; use type style to
    show hierarchy; avoid both dense clustering and uniform spread of names.
  * The AutoCarto paper notes these rules often conflict, so meeting one can break another.
* **Relevance to Label Anything:** this is where the "Imhof cartographic order" option
  comes from, and the root of the ambiguity term ("clear association"). The rule against
  dense clustering argues for a *density-aware* omission policy, not only a feasibility
  one (see the density finding in B1).

### A2. Yoeli 1972, The logic of automated map lettering
* **Citation:** Pinhas Yoeli (1972). The logic of automated map lettering. *The
  Cartographic Journal* 9(2):99–108. (The issue number is from memory, UNVERIFIED. The
  search result confirmed volume 9 and pages 99–108.)
* **DOI:** 10.1179/000870472787352505. It appears in a Spanish bibliography (riunet.upv.es)
  that the search returned. No publisher page was seen.
* **How found:** WebSearch `Yoeli 1972 "The logic of automated map lettering"
  Cartographic Journal` (2026-10-18).
* **What I read:** secondary sources only (riunet.upv.es bibliography, Wikipedia,
  the Rylov dissertation listing at the Heidelberg repository).
* **Status:** PARTIAL. Volume, pages and DOI come from one secondary bibliography.
* **Claims (secondary):** first to propose solving label placement by computer, and the
  first to codify Imhof's guidelines as logic. Started from a simplified version with
  horizontal labels only.
* **Relevance:** historical background. It supports the split the library already makes:
  hard rules are checked exactly, soft rules go into the cost.

### A3. van Dijk, van Kreveld, Strijk, Wolff 2002, Towards an evaluation of quality for names placement methods
* **Citation:** Steven van Dijk, Marc van Kreveld, Tycho Strijk, Alexander Wolff (2002).
  Towards an evaluation of quality for names placement methods. *International Journal of
  Geographical Information Science* 16(7):641–661.
* **DOI:** 10.1080/13658810210138742.
* **How found:** WebSearch `van Dijk van Kreveld Strijk Wolff "Towards an evaluation of
  quality for names placement methods" ...`, then
  `dblp van Dijk van Kreveld Strijk Wolff ... IJGIS 2002` restricted to dblp domains
  (2026-10-18).
* **What I read:** the abstract (via the search summary), plus the DBLP author-page entry.
* **Status:** VERIFIED-SEARCH. The DBLP author page (dblp.org/pid/05/5258.html) shows
  "Int. J. Geogr. Inf. Sci. 16(7): 641-661 (2002)". The DOI matches OpenAlex
  (api.openalex.org/works/doi:10.1080/13658810210138742) and the reference list of
  arXiv 1910.07799.
* **Earlier versions:** the conference paper "Towards an Evaluation of Quality for Label
  Placement Methods", Proc. 19th ICC (ICA'99), Ottawa, pp. 905–913. Utrecht technical
  report UU-CS-2001-43. (The search tool, not me, reported that UU-CS-2001-44 is a
  different report on line labeling.) A green open-access copy is reported at
  dspace.library.uu.nl.
* **Claims (abstract):**
  * Classifies most label placement rules, for example readability and **clear
    association**.
  * Turns them into a *function* that can serve as a quality measure for a labeling.
  * With such a function implemented, the output of different placement programs can be
    compared. A simple and a more refined example of the function are given.
  * I did **not** see the list of terms or the weights; the full text was not reachable.
* **Relevance to Label Anything:** the evaluator (weakness 2 and the benchmark docs) now
  reports mostly how many labels were placed. A van Dijk-style **decomposed quality
  function** could report one score per term per label: placed or omitted with priority,
  overlap with each obstacle class, position rank, association/ambiguity, leader
  length/bends/crossings, and distribution. It would be reported **separately from the
  solver's cost**, so improvements to the optimizer can be judged by a measure the
  optimizer did not tune itself against. That matches the stated aim: comparing
  placement programs.

### A4. Rylov & Reimer 2014, A comprehensive multi-criteria model for high cartographic quality point-feature label placement
* **Citation:** Maxim A. Rylov, Andreas W. Reimer (2014). A comprehensive multi-criteria
  model for high cartographic quality point-feature label placement. *Cartographica*
  49(1):52–68.
* **DOI:** 10.3138/carto.49.1.2137.
* **How found:** WebSearch `Rylov Reimer "comprehensive multi-criteria model for high
  cartographic quality point-feature label placement" Cartographica`, plus a follow-up
  with the DOI (2026-10-18).
* **What I read:** secondary sources only: the Heidelberg GIScience blog
  (giscienceblog.uni-heidelberg.de/?p=1405) and the listing of Rylov's dissertation
  "Models and methods for cartographic label placement" (backend.geog.uni-heidelberg.de).
* **Status:** PARTIAL. Volume, issue, pages and DOI agree across several citing
  bibliographies, but I saw no publisher or DBLP page. **The criteria and their weights
  were NOT retrieved**: the full text and the dissertation could not be opened, and the
  search budget ran out.
* **Claims (secondary):** a multi-criteria model that "complies with almost all
  well-defined cartographic placement principles" for point-feature labels. It is written
  as a quality-evaluation function that any combinatorial optimizer can use. Tested on
  OpenStreetMap data. The blog says it allows a markedly higher density of names without
  hurting legibility.
* **Relevance:** the closest published analogue of Label Anything's multi-term cost.
  **Action:** read the full text (or Rylov's dissertation, which is open) and map each of
  its criteria to an existing cost term, or mark it as missing. This is the best
  available check for the cost model; I could not do it here.

### A5. Rylov & Reimer 2015, Improving label placement quality by considering basemap detail with a raster-based approach
* **Citation:** Maxim A. Rylov, Andreas W. Reimer (2015; online 2014). Improving label
  placement quality by considering basemap detail with a raster-based approach.
  *GeoInformatica* 19(3):463–486.
* **DOI:** 10.1007/s10707-014-0214-6.
* **How found:** this came up during the WebSearch for the van Dijk technical report.
  Follow-up: `"Improving label placement quality by considering basemap detail with a
  raster-based approach" GeoInformatica authors` (2026-10-18).
* **What I read:** the abstract (search summary), the Heidelberg university library
  record (heibib.ub.uni-heidelberg.de/search/Record/1713952920) and a doi.org link in the
  results.
* **Status:** VERIFIED-SEARCH (library record plus doi.org result). One library record
  shows a different DOI, which the search tool judged to be an error.
* **Claims (abstract):** a generic quality-evaluation model that **fully automates
  refined techniques for map-feature overlap, visual contrast and layer hierarchy**.
  Mainly for point features; extendable to line and area features.
* **Relevance:** this is directly about the "soft coverage of obstacle classes" over
  **raster backgrounds**. Label Anything scores how much of an obstacle class a label
  covers. This paper also scores **visual contrast** between label and basemap, and
  **layer hierarchy**: covering a higher layer costs more. **Idea:** for raster
  backgrounds, add a contrast term (for example, the colour distance between the text
  colour and the local background, or the local edge/detail energy under the label from
  a summed-area table of gradient magnitude), alongside plain coverage.

### A6. Fan, Zhang, Du 2005, Quality evaluation model for map labeling
* **Citation:** Fan Hong, Zhang Zuxun, Du Daosheng (2005). Quality evaluation model for
  map labeling. *Geo-spatial Information Science* 8(1):72–78.
* **DOI:** 10.1007/BF02826996.
* **How found:** this came up during the van Dijk search. Follow-up:
  `"Quality evaluation model for map labeling" Geo-spatial Information Science`
  (2026-10-18).
* **What I read:** the abstract as indexed on the journal page
  (gsis.xml-journal.net/article/doi/10.1007/BF02826996).
* **Status:** VERIFIED-SEARCH (journal page).
* **Claims (abstract):** scores a labeling on four factors: **conflicts between labels,
  overlap of labels with map features, priority of label positions, and the association
  between a label and its feature**. Combined into one scoring system and tested on the
  MapLabel system.
* **Relevance:** a minimal set of four evaluator terms that also appears in A3 and in
  Rapid Labels (C4). It supports making **association/ambiguity a first-class evaluator
  metric**, not only a solver cost.

### A7. Christensen, Marks, Shieber 1995, An empirical study of algorithms for point-feature label placement
* **Citation:** Jon Christensen, Joe Marks, Stuart Shieber (1995). An empirical study of
  algorithms for point-feature label placement. *ACM Transactions on Graphics*
  14(3):203–232.
* **DOI:** 10.1145/212332.212334.
* **How found:** WebSearch `Christensen Marks Shieber 1995 "An empirical study of
  algorithms for point-feature label placement"`, then a search with the DOI
  (2026-10-18).
* **What I read:** the abstract and the ACM copyright line (both quoted by the search tool
  from the Harvard DASH full-text PDF and MERL TR94-12).
* **Status:** VERIFIED-SEARCH (ACM copyright line in the DASH PDF; MERL TR94-12 has the
  same title and abstract).
* **Claims (abstract):** the basic problem and most variants are NP-hard. Proposes
  discrete gradient descent and simulated annealing. The first empirical comparison of
  algorithms. **Names the best approach as a function of the computation time
  available.**
* **Relevance:** Label Anything has a hard time target (120 ms). The paper's framing
  ("which method wins depends on the budget") suggests **sharing the time between greedy
  and local search by expected gain**: weakness 2 reports local search adds only +0.7%. At
  a tight budget, saving greedy time (section C) is worth more than more annealing.

### A8. Hartmann, Götzelmann, Ali, Strothotte 2005, Metrics for functional and aesthetic label layouts
* **Citation:** Knut Hartmann, Timo Götzelmann, Kamran Ali, Thomas Strothotte (2005).
  Metrics for functional and aesthetic label layouts. In *Smart Graphics (SG 2005)*,
  LNCS 3638, Springer. Pages unknown. (LNCS volume 3638 is from memory, UNVERIFIED.)
* **DOI:** 10.1007/11536482_10. The DOI's record appeared via unpaywall, with the
  abstract.
* **How found:** WebSearch `Hartmann Götzelmann Ali Strothotte "Metrics for functional
  and aesthetic label layouts" Smart Graphics 2005` (2026-10-18).
* **What I read:** the abstract shown for DOI 10.1007/11536482_10. That record did *not*
  show the title or venue; the DOI prefix fits the SG 2005 proceedings.
* **Status:** PARTIAL. The DOI and abstract were seen; the title-to-DOI match, the venue
  and the pages are not confirmed.
* **Claims (abstract):** analysed a corpus of hand-drawn illustrations with complex label
  layouts. From it they extracted a classification of layout styles and **metrics for
  functional requirements and aesthetic attributes**, plus a real-time layout algorithm.
  Related: Götzelmann, Ali, Hartmann, Strothotte, "Form follows function: aesthetic
  interactive labels" (Computational Aesthetics 2005, Eurographics digital library),
  which balances unambiguity, readability, aesthetics and **frame coherence**. Ali,
  Hartmann, Strothotte, "Label layout for interactive 3D illustrations", *Journal of
  WSCG* 13(1):1–8, 2005, gives evaluation criteria for **static and dynamic** layouts.
* **Relevance:** evaluator metrics for **leader layouts** (weakness 3: many long leaders):
  leader length, bends, crossings, angle spread, and ordering consistency, which the
  external-labeling literature rates. The dynamic criteria (frame coherence) apply to
  weakness 4.

### A9. Wolff & Strijk, The Map-Labeling Bibliography (web resource)
* **Citation:** Alexander Wolff, Tycho Strijk. *The Map-Labeling Bibliography*. Web page.
* **URL:** https://i11www.iti.kit.edu/map-labeling/bibliography/ (also sorted by author:
  .../maplab_author.html). Mirror: Collection of Computer Science Bibliographies
  (for example ftp.fi.muni.cz/pub/bibliography/Theory/map.labeling.html).
* **How found:** WebSearch `Wolff Strijk "The Map-Labeling Bibliography" web`
  (2026-10-18).
* **What I read:** the search summary of the KIT page and the mirror.
* **Status:** PARTIAL (web resource; not opened). The KIT page lists Wolff as maintainer
  and Strijk as a major contributor, with a **last update note of June 2009**. The mirror
  record reports **360 references, last updated July 2008**. Treat it as **not maintained
  since about 2009**. For later work, the external-labeling survey (Bekos, Niedermann,
  Nöllenburg, CGF 2019, already cited) is the more current overview.
* **Relevance:** a reference for the classical literature only.

---

## B. Label–feature association, position preference, perception studies

### B1. Bobák, Čmolík, Čadík, From Top-Right to User-Right: Perceptual prioritization of point-feature label positions (the project's "CVM 2026" citation)
* **Citation:** Petr Bobák, Ladislav Čmolík, Martin Čadík. From Top-Right to User-Right:
  Perceptual Prioritization of Point-Feature Label Positions. arXiv:2407.11996 (2024; a v2
  exists). **Venue "CVM 2026" (Computational Visual Media) NOT confirmed**: a targeted
  search found no CVM record or DOI.
* **DOI:** unknown. arXiv: https://arxiv.org/abs/2407.11996
* **How found:** WebSearch `Bobák Čmolík Čadík perceptual prioritization label positions
  CVM 2026`, `"From Top-Right to User-Right" ... abstract`, `"From Top-Right to
  User-Right" Computational Visual Media 2026 DOI`, `PerceptPPO position priority order
  ...` (2026-10-18).
* **What I read:** the abstract (arXiv PDF and HTML v2, via the search summary).
* **Status:** PARTIAL. The arXiv record (title, three authors) was confirmed; the
  published venue, year and DOI were not.
* **Claims (abstract):**
  * There is no consensus on a Position Priority Order (PPO). Most techniques still use
    typographic/cartographic conventions from decades ago. Commercial maps (Google Maps,
    Mapbox) use non-traditional PPOs for reasons they do not report.
  * Proposes **PerceptPPO**, validated by a user study: nearly 800 participants from 48
    countries, more than 45,500 pairwise comparisons.
  * **Labels above the point are significantly preferred over the conventional top-right
    position.**
  * A supplementary study on **preferred label density**. A truncated snippet says users
    prefer on average about **17% of a generic map to be covered** by labels. The wording
    and exact figure are **not confirmed**.
  * I did not retrieve the full ranking of the 8 positions. The library's "perceptual
    order" (top, right, bottom, left, then corners) should be checked against the paper's
    table.
* **Relevance:** cross-check for the default position-rank term. **Ideas:**
  1. Use PerceptPPO's **pairwise preference strengths** (not just the ranks) as the
     position cost, so the gap between "top" and "right" is calibrated.
  2. If the density result holds, offer a **density target**: omit low-priority labels
     once coverage exceeds a target, even when they would fit. That also saves time
     (fewer ladder runs) and follows Imhof's "avoid dense clustering".

### B2. Scheuerman, Harman, Goldstein, Acklin, Michael 2023, Visual preferences in map label placement
* **Citation:** Scheuerman, Harman, Goldstein, Acklin, Michael (2023). Visual preferences
  in map label placement. *Discover Psychology* 3(1), article (pp. 1–11 per DOAJ). (Only
  surnames were in the search result; first names were not confirmed, so none are given.)
* **DOI:** 10.1007/s44202-023-00088-0.
* **How found:** WebSearch `user study label position preference point feature which point
  does label belong ambiguity scatterplot perception`, then `"Visual Preferences in Map
  Label Placement" alignment proximity Michigan Tech 2023` (2026-10-18).
* **What I read:** the abstract (via the search summary of link.springer.com, DOAJ and the
  Michigan Tech repository digitalcommons.mtu.edu/michigantech-p2/626). Dataset record:
  .../michigantech-p2/624 (956 binary choices between two maps).
* **Status:** VERIFIED-SEARCH (Springer article URL, DOAJ record with volume 3, issue 1).
* **Claims (abstract):** participants had consistent preferences for where a label sits
  relative to its point. **When alignment and distance conflicted, they more often chose
  alignment over proximity.** The authors argue that heuristic and rule-based placement
  often does not match what map users prefer.
* **Relevance:** the cost model has both a *gap distance* term and a *slider* model
  (positions along the mark). This study suggests **misalignment should cost more than
  extra distance**: a centred top/bottom or vertically centred left/right box a few pixels
  farther away beats a slid, off-centre box closer to the point. **Idea:** add an
  "alignment" term (offset of the label's centre line from the anchor's axis), weighted
  above `gap distance`, and lower the cost of the gap ring for aligned positions.

### B3. Ooms, Kellens, Fack 2009, Dynamic map labeling for users
* **Citation:** Kristien Ooms, Wim Kellens, Veerle Fack (2009). Dynamic map labeling for
  users. In *Proceedings of the 24th International Cartographic Conference*, Santiago,
  Chile, pp. 1–12. (The search tool reports the name is spelled "Keilens" in the PDF.)
* **DOI:** none known.
* **How found:** WebSearch `eye-tracking study label placement maps readability point
  labels position`, then `Ooms Kellens Fack "Dynamic map labeling for users" ICC 2009
  ...` (2026-10-18).
* **What I read:** the abstract (marineinfo.org/doc/publication/207944; VLIZ PDF
  vliz.be/imisdocs/publications/ocrd/226262.pdf, via the search summary).
* **Status:** PARTIAL (a repository record only; no publisher DOI exists for ICC
  proceedings).
* **Claims (abstract):** studies adaptations to a label placement method for dynamic,
  interactive maps. **Reducing the number of labels the method has to consider "will
  drastically improve its efficiency".** An eye-tracking user study (visual search) found
  that **users did not notice the adaptations**. Efficiency can therefore improve without
  distorting the user's cognitive map.
* **Relevance:** user-study evidence for the weakness-5 strategy of **pruning candidate
  labels early**: dropping labels that will not be placed anyway did not visibly hurt
  users. It supports aggressive early omission of low-priority, doomed labels (C-ideas
  below). Caveat: I did not see which reduction they used.

### B4. Bobák, Čmolík, Čadík 2024, Reinforced Labels: Multi-agent deep reinforcement learning for point-feature label placement
* **Citation:** Petr Bobák, Ladislav Čmolík, Martin Čadík (2024). Reinforced Labels:
  Multi-Agent Deep Reinforcement Learning for Point-Feature Label Placement. *IEEE
  Transactions on Visualization and Computer Graphics* 30(9):5908–5922.
* **DOI:** 10.1109/TVCG.2023.3313729. arXiv:2303.01388.
* **How found:** WebSearch `Bobák Čmolík Čadík "Reinforced Labels" ... IEEE TVCG 2024 DOI`
  (2026-10-18).
* **What I read:** the abstract (via the search summary of the CTU DCGI page
  dcgi.fel.cvut.cz/publications/2024/bobak-tvcg-reinforced/ and the BUT FIT record
  fit.vut.cz/research/result/c185209/).
* **Status:** VERIFIED-SEARCH (institutional publication records with volume, issue,
  pages and DOI).
* **Claims (abstract):** each label is an agent. Described as the first machine-learning
  labeling method. The trained policy **places more labels (completeness)** than
  hand-designed methods (compared against Particle-Based Labeling and Rapid Labels, per a
  citing summary), **but is slower**. A user study with **paired comparisons
  (two-alternative forced choice)** found it significantly preferred.
* **Relevance:** (a) the **2AFC paired-comparison protocol** is a ready template for a
  small in-house study to calibrate the ambiguity and position weights (see the gap
  below). (b) It shows that **completeness in dense scenes** (weakness 1) can still be
  improved over greedy+repair, though not cheaply.

### B5. Gap: label-to-point association (ambiguity) in scatterplots
* Searches: `user study label position preference point feature which point does label
  belong ambiguity scatterplot perception`; `crowdsourced user study scatterplot labels
  leader lines external labeling readability association experiment`; `eye-tracking study
  label placement maps readability point labels position` (2026-10-18).
* **Result:** I found **no peer-reviewed study that directly measures which point a
  label is perceived to belong to** in dense scatterplots or maps, between 2010 and 2026.
  The closest are B1 (position preference), B2 (alignment vs distance) and B3 (eye
  tracking, but about efficiency). A lead that came up only as a title: "Clarity and
  Computational Efficiency of Orbital Boundary Labeling" (arXiv:2603.08657). Its summary
  reports a user experiment where straight leaders gave **similar accuracy but faster
  responses** than the alternative leader type. Authors and venue are UNVERIFIED.
* **Implication for Label Anything:** the ambiguity term (a label closer to another item's
  shape than to its own) is a geometric proxy with no published perceptual calibration.
  **Idea:** run a small 2AFC or "which point does this label belong to?" crowdsourced
  study (B4 protocol) on scenes from the benchmark. Fit the ambiguity penalty as a
  function of the ratio d(label, own) / d(label, nearest other), and of alignment (B2).

---

## C. Fast and scalable placement

### C1. Wagner, Wolff, Kapoor, Strijk 2001, Three rules suffice for good label placement
* **Citation:** Frank Wagner, Alexander Wolff, Vikas Kapoor, Tycho Strijk (2001). Three
  rules suffice for good label placement. *Algorithmica* 30(2):334–349.
* **DOI:** 10.1007/s00453-001-0009-7.
* **How found:** WebSearch `Wagner Wolff Kapoor Strijk "Three rules suffice for good label
  placement" Algorithmica`; `dblp "Three Rules Suffice ..."` restricted to
  dblp.org/link.springer.com; `dblp Wagner Wolff Kapoor Strijk ...` restricted to dblp;
  `Wagner Wolff three rules label placement rule L1 L2 L3 ...` (2026-10-18).
* **What I read:** the abstract (via the search summary of research.tue.nl and the Springer
  page), the DBLP BibTeX record, and a secondary paraphrase of rule 1 (Mote thesis,
  arXiv 1209.5766). The authors' PDF is at i11www.iti.kit.edu/~awolff/pub/wwks-3rsgl-01.pdf
  (not opened).
* **Status:** VERIFIED-SEARCH (DBLP key `DBLP:journals/algorithmica/WagnerWKS01`, DOI
  10.1007/S00453-001-0009-7, vol 30(2), pp. 334–349; Springer article URL
  link.springer.com/article/10.1007/s00453-001-0009-7).
* **Claims (abstract plus secondary):**
  * Separates the geometric part (candidates and their conflicts) from the combinatorial
    part, which is a **conflict graph** of candidates.
  * Gives **rules that shrink the conflict graph without reducing the size of an optimal
    solution**. Applying them, then a simple heuristic, gives near-optimal results.
  * Rule L1 (secondary source): *if a point has a candidate with no conflicts, choose it
    and remove that point's other candidates.*
  * Rules L2 and L3 (from memory, UNVERIFIED; roughly consistent with a patent's
    paraphrase seen in search): L2 handles a pair of points p, q whose candidates p_i and
    q_j each conflict only with a candidate of the other: choose p_i and q_j. L3: if p has
    one candidate left and the candidates overlapping it form a clique, choose it and
    remove the overlapping candidates. Check the exact wording in the PDF.
* **Relevance to weakness 5 (my own interpretation):**
  * **Safe reduction before greedy.** Run L1 per band against the candidates of the band,
    the already-placed labels and the hard obstacles. Any item whose *cheapest* candidate
    conflicts with nothing is fixed at once, and its other candidates leave the pool
    (smaller lookahead sets). The original rules are for the unweighted "label as many
    points as possible" objective. With costs, L1 is safe when the conflict-free candidate
    is also the item's cheapest one, and the conflict check includes soft
    coverage-relevant obstacles only if their cost is already counted.
  * **The converse rule, "doomed" detection.** If every candidate of item i, *including a
    conservative bound on all ladder variants* (see C8), conflicts with hard obstacles or
    with labels of *higher* priority, i can be omitted at once in strict mode. Strict mode
    forbids omission only while a *lower*-priority label blocks it. That replaces running
    the ladder for many of the 1128 items that are omitted in the end.
  * **Dominance pruning** (my generalisation, in the same spirit): drop candidate B of an
    item if another candidate A of the same item has cost(A) ≤ cost(B) and
    conflicts(A) ⊆ conflicts(B). It shrinks both the greedy's lookahead work and the
    ladder output.

### C2. Luboschik, Schumann, Cords 2008, Particle-based labeling
* **Citation:** Martin Luboschik, Heidrun Schumann, Hilko Cords (2008). Particle-based
  labeling: Fast point-feature labeling without obscuring other visual features. *IEEE
  Transactions on Visualization and Computer Graphics* 14(6):1237–1244 (InfoVis 2008).
* **DOI:** 10.1109/TVCG.2008.152.
* **How found:** WebSearch `Luboschik Schumann Cords 2008 "Particle-based labeling" ...`;
  `dblp Luboschik 2008 TVCG ...` restricted to dblp/ieee; `Particle-based labeling
  Luboschik doi 10.1109/TVCG.2008.152` (2026-10-18).
* **What I read:** the abstract (via the doi.org landing page in the results) and a
  description of the method in a patent's prior-art section (US patent 10621757, via the
  search summary).
* **Status:** VERIFIED-SEARCH (DBLP volume page dblp.org/db/journals/tvcg/tvcg14.html,
  key journals/tvcg/LuboschikSC08; doi.org/10.1109/tvcg.2008.152 result).
* **Claims:**
  * (abstract) Fast, interactive point-feature labeling that **also avoids covering other
    visual elements** (icons, lines), takes the extent of labeled features into account,
    and labels **dense point clouds using non-occluding distant labels**. Reported as
    favourable against existing techniques in labels placed and processing time.
  * (patent paraphrase) The scene is rendered first. **Areas labels must not cover are
    filled with virtual "conflict particles".** Labels are then placed by several
    strategies in turn, starting with a free region near the point.
  * The exact strategy order and the particle data structure were **not retrieved** (the
    search budget was exhausted).
* **Relevance:** Label Anything's coverage grids are the same idea in spirit as conflict
  particles. The transferable part is the **sequence of increasingly expensive strategies
  driven by a free-space representation**: try near positions first, then search free
  space for distant positions. **Idea:** create distant candidates only at free-space
  locations that can actually hold the box (see C8), instead of the fixed 4 rings × 16
  directions grid followed by "keep 24 cheapest".

### C3. Mote 2007, Fast point-feature label placement for dynamic visualizations
* **Citation:** Kevin Mote (2007). Fast point-feature label placement for dynamic
  visualizations. *Information Visualization* 6(4):249–260. (The PNNL/OSTI records date it
  2008, report PNWD-SA-7962. The SAGE page shows 2007.) Preprint arXiv:1209.5765; M.S.
  thesis (Washington State University, Dec 2007) arXiv:1209.5766.
* **DOI:** 10.1057/palgrave.ivs.9500163.
* **How found:** WebSearch `Mote 2007 "Fast point-feature label placement for dynamic
  visualizations" Information Visualization trellis`; `... 10.1057/palgrave.ivs`;
  `Mote trellis strategy ...`; `dblp Kevin Mote ...` restricted to dblp/sagepub
  (2026-10-18).
* **What I read:** the abstract and parts of the trellis section of arXiv:1209.5765
  (via the search summary).
* **Status:** VERIFIED-SEARCH (SAGE page journals.sagepub.com/doi/10.1057/palgrave.ivs.9500163
  titled "...– Kevin Mote, 2007"). There is a year discrepancy (2007 SAGE vs 2008 PNNL).
* **Claims:**
  * Real-time point labeling with **no pre-processing**, using a geometric de-confliction
    method called the **"trellis strategy"** and a candidate cost analysis to choose the
    cheapest configuration. Multiple frames per second on maps with tens of thousands of
    nodes.
  * Trellis: a 2D array of equal cells over the screen, each holding a list of the
    features in it. **Each cell is a quarter of the label's area, with the label's aspect
    ratio**, so a label covers about four cells. Example: a 1500×1000 view with 150×20
    labels gives 2000 cells.
  * The thesis surveys Petzold's reactive conflict graph (see C6) as the pre-processing
    alternative.
* **Relevance:** Label Anything's static and dynamic indexes (`index.rs`) use one cell
  size. Mote sizes cells **from the label size**, so a box query touches a constant number
  of cells. With 100k points and 2000 labels this keeps queries O(1) and makes "count
  features near this anchor" a cheap **crowding estimate**. **Idea:** compute a per-item
  crowding score from a label-sized trellis before the greedy pass. Order items in a band
  by it ("most constrained first" already exists). Use it to **skip the ladder** for items
  whose surrounding trellis cells are saturated by higher-priority placed labels (see C8).

### C4. Pavlovec & Čmolík 2022, Rapid Labels: Point-feature labeling on GPU (already cited)
* **Citation:** Václav Pavlovec, Ladislav Čmolík (2022). Rapid Labels: Point-Feature
  Labeling on GPU. *IEEE Transactions on Visualization and Computer Graphics*
  28(1):604–613 (IEEE VIS 2021).
* **DOI:** 10.1109/TVCG.2021.3114854.
* **How found:** WebSearch `Pavlovec Čmolík "Rapid Labels: Point-Feature Labeling on GPU"
  IEEE TVCG 2022`; `Rapid Labels GPU ... mechanism ... milliseconds` (2026-10-18). A DBLP
  check was planned but blocked by the search budget.
* **What I read:** the abstract and the project page (dcgi.fel.cvut.cz/?p=61722;
  content.ieeevis.org/year/2021/paper_v-full-1310.html), via the search summary.
* **Status:** VERIFIED-SEARCH (CTU DCGI project page and IEEE VIS 2021 page; volume,
  pages and DOI as reported there). Not checked on DBLP.
* **Claims (abstract and project page):**
  * Greedy labeling **on the GPU that places several labels in parallel**, while
    guaranteeing no overlaps with each other or with important visual features.
  * Each candidate position is evaluated for **overlap with visual features, conflicts
    with other labels' candidates, and ambiguity**, in **constant time independent of the
    number of points, visual features and image resolution**.
  * Places more labels than greedy methods that ignore candidate-candidate conflicts, and
    is significantly faster. The speed comes mostly from parallelism and efficient
    candidate evaluation.
  * Project page: **3340 US airports labeled in 72 ms.** Full benchmark tables were not
    retrieved.
* **Relevance:** (a) evaluating every candidate in constant time with summed-area tables
  is the same approach as `Occupancy::blocked_in` with a SAT. Rapid Labels applies it to
  *all* cost terms, including ambiguity. (b) **Parallel commit of non-interfering labels:**
  in a band, items whose candidate regions are disjoint cannot affect each other. Their
  best candidates can be computed in parallel, with a deterministic, sequential commit
  order, which keeps output bit-identical. That gives native multi-core speed-up for the
  ladder-heavy part; the single-thread WASM build gains nothing.

### C5. Kittivorawong, Moritz, Wongsuphasawat, Heer 2020, Fast and flexible overlap detection for chart labeling with occupancy bitmap (already cited)
* **Citation:** Chanwut Kittivorawong, Dominik Moritz, Kanit Wongsuphasawat, Jeffrey Heer
  (2020). Fast and Flexible Overlap Detection for Chart Labeling with Occupancy Bitmap.
  In *IEEE Visualization Conference (VIS 2020), Short Papers*. Pages not confirmed.
  (The IEEE VIS page uses the plural "Bitmaps".) Extended in the arXiv paper "Legible
  Label Layout for Data Visualization, Algorithm and Integration into Vega-Lite"
  (arXiv:2405.10953, based on a 2021 UW thesis).
* **DOI:** 10.1109/VIS47514.2020.00027 (as listed by the UW Interactive Data Lab page).
* **How found:** WebSearch `Kittivorawong Moritz Wongsuphasawat Heer "Fast and Flexible
  Overlap Detection ..."`; `Kittivorawong occupancy bitmap ... bitwise ...` (2026-10-18).
  A DBLP check was planned but blocked by the search budget.
* **What I read:** the abstract and parts of the thesis paper (via the search summary of
  idl.uw.edu/papers/fast-labels, dig.cmu.edu/publications/2020-labeling.html,
  virtual.ieeevis.org/year/2020/paper_s-short-1028.html and arXiv:2405.10953).
* **Status:** PARTIAL. Authors, venue and DOI were seen on the UW IDL and IEEE VIS pages;
  pages are unknown; not checked on DBLP.
* **Claims:**
  * Prior work approximated mark shapes by point sets, which scales poorly with large or
    numerous marks. They instead **rasterize all marks into a bitmap at screen
    resolution, one bit per pixel**.
  * Two operations use bitwise operators: *lookup* (is any pixel of this area occupied?)
    and *update* (mark the area of a placed label). **Their cost depends only on the chart
    size and label size, not on the number or complexity of existing elements.**
  * Significantly faster than the state of the art with a similar number of labels; works
    for marks of any shape.
* **Relevance:** Label Anything already does this (`grid/occupancy.rs`: per-row u64
  bitsets plus a SAT once frozen). What it adds: the bitmap gives O(1) **rejection**,
  but the 1M boxes of weakness 5 are still *generated*. The bitmap can also support
  **feasibility queries before generation**: an erosion/SAT over free space (C8). Then the
  bitmap answers "can any box of size w×h fit near here?", not only "is this box free?".

### C6. Petzold, Gröger, Plümer 2003, Fast screen map labeling (and 2004, Modeling of conflicts for screen map labeling)
* **Citation (2003):** Ingo Petzold, Gerhard Gröger, Lutz Plümer (2003). Fast screen map
  labeling – data-structures and algorithms. In *Proceedings of the 21st International
  Cartographic Conference (ICC 2003)*, Durban, South Africa, pp. 288–298. (The author
  order varies between sources: Petzold, Plümer, Gröger in some.)
* **Citation (2004, companion):** I. Petzold, G. Gröger, L. Plümer (2004). Modeling of
  conflicts for screen map labeling. *International Archives of Photogrammetry, Remote
  Sensing and Spatial Information Sciences* XXXV (ISPRS Congress, Istanbul), Commission IV,
  paper 347 (www.isprs.org/proceedings/XXXV/congress/comm4/papers/347.pdf).
* **DOI:** none known for either. The pages of the ICC paper come from a reference list
  that Crossref holds for a citing ACM paper (DOI 10.1145/1377676.1377681).
* **How found:** WebSearch `Petzold Gröger Plümer "Fast screen map labeling" ...`; `"Fast
  screen map labeling" Petzold Gröger Plümer 2003 Durban ...`; `"reactive conflict graph"
  labeling zooming Petzold` (2026-10-18).
* **What I read:** the 2004 ISPRS paper's opening section (abstract and keywords, via the
  search summary) and secondary descriptions (Mote thesis arXiv:1209.5766). Nothing from
  the 2003 paper beyond its citation.
* **Status:** PARTIAL. 2003: title, venue and pages come from one reference list. 2004:
  seen in the ISPRS proceedings URL.
* **Claims (2004 abstract plus secondary):**
  * Standard automatic labeling does not suffice for screen maps because it does not
    support zooming and scrolling. **Determining conflicts between labels at a fixed scale
    is the most time-consuming part of labeling.**
  * **Reactive conflict graph:** nodes are the objects to label; edges are potential
    conflicts, **each annotated with the scale range in which the conflict occurs**.
    Stored in a 3D index (x, y, scale; for example a 3D R-tree). For a given extent and
    scale it is queried to give the static conflict graph of that view.
  * The expensive conflict detection moves into pre-processing, so zooming and panning
    relabel almost instantly (secondary: Mote thesis).
* **Relevance (weaknesses 4 and 5):** for labels of fixed screen size over data
  coordinates, the conflict between candidate slots of items p and q exists exactly when
  the zoom factor s satisfies s·|p−q| < (a threshold that depends on the slot offsets and
  box sizes). That is a **closed-form scale interval per candidate pair**. **Idea:** on
  warm starts, keep the previous frame's conflict pairs with their validity intervals and
  re-detect conflicts only where the interval is crossed or items moved. Combined with
  Been's active ranges (C7), the decision to show or omit a label is also kept consistent
  across zoom steps. That reduces both recomputation and the >10% side flips per zoom step.

### C7. Been, Daiches, Yap 2006, Dynamic map labeling
* **Citation:** Ken Been, Eli Daiches, Chee Yap (2006). Dynamic Map Labeling. *IEEE
  Transactions on Visualization and Computer Graphics* 12(5):773–780 (InfoVis 2006).
* **DOI:** not confirmed (I believe 10.1109/TVCG.2006.136, from memory, UNVERIFIED).
* **How found:** WebSearch `Been Daiches Yap 2006 "Dynamic map labeling" IEEE TVCG active
  ranges precomputation`; `Been Daiches Yap "Dynamic map labeling" IEEE Transactions ...
  12(5) 773-780 2006` (2026-10-18). A DBLP check was blocked by the search budget.
* **What I read:** the abstract (author PDF cs.nyu.edu/visual/home/pub/infovis06.pdf, via
  the search summary) and secondary descriptions (arXiv 1609.06327 "Temporal map
  labeling"; Been, Nöllenburg, Poon, Wolff "Optimizing active ranges for consistent
  dynamic map labeling").
* **Status:** PARTIAL. Volume, issue and pages come from a GIScience 2018 reference list
  (drops.dagstuhl.de, LIPIcs.GISCIENCE.2018.8). The author PDF was seen. The DOI was not.
* **Claims (abstract plus secondary):** the first formal model of dynamic maps and
  dynamic labels. Desiderata: **no popping or flickering during monotone zooming, no
  jumping, and labeling depends only on the current view, not on history**. Selection and
  placement decisions are moved into **pre-processing** so display is fast. Each label
  gets an **active range** (one scale interval where it is shown). "Invariant point
  placements" are a simple solvable case. Follow-up work shows that optimizing active
  ranges is NP-complete in general (Been et al., the "Optimizing active ranges" paper),
  but some 1D variants can be solved by dynamic programming.
* **Relevance (weakness 4 mainly, and weakness 5 for interactive use):** **Idea:** for
  zoomable scatterplots and maps, compute per label a zoom interval in which it is shown,
  using the scale intervals of its conflicts (C6). Then (a) at frame time most items need
  no ladder at all, (b) omission is monotone in zoom (no flicker), and (c) the warm start
  becomes "look up the active set", not "re-solve". This conflicts with the library's
  "depends on the previous frame" stability model. Been et al. argue for history
  independence, which is worth discussing in an ADR.

### C8. Free-space and empty-rectangle queries for early infeasibility detection

#### C8a. Naamad, Lee, Hsu 1984, On the maximum empty rectangle problem
* **Citation:** A. Naamad, D. T. Lee, W.-L. Hsu (1984). On the maximum empty rectangle
  problem. *Discrete Applied Mathematics* 8(3):267–277.
* **DOI:** not confirmed (no publisher page seen).
* **How found:** WebSearch `Naamad Lee Hsu 1984 "On the maximum empty rectangle problem"
  Discrete Applied Mathematics` (2026-10-18).
* **What I read:** secondary sources only: the Academia Sinica repository record
  (ir.sinica.edu.tw/handle/201000000A/39625), the typeset.io author summary, and SoCG 2016
  and arXiv 2103.08043 papers citing it.
* **Status:** PARTIAL (volume, issue and pages from a repository record; DOI unknown).
* **Claims (secondary):** among n points in a rectangle, find the largest empty
  axis-parallel rectangle. O(n²) worst case. **O(n log² n) expected time** for random
  points. The number of maximal empty rectangles is O(n²) in the worst case.

#### C8b. Chazelle, Drysdale, Lee 1986, Computing the largest empty rectangle
* **Citation:** Bernard Chazelle, Robert L. (Scot) Drysdale, D. T. Lee (1986). Computing
  the largest empty rectangle. *SIAM Journal on Computing* 15(1):300–315.
* **DOI:** not confirmed.
* **How found:** WebSearch `Chazelle Drysdale Lee 1986 "Computing the largest empty
  rectangle" SIAM Journal on Computing` (2026-10-18).
* **What I read:** the abstract (scan at cs.princeton.edu/~chazelle/pubs/ComputLargestEmptyRectangle.pdf
  and the Princeton portal record, via the search summary).
* **Status:** VERIFIED-SEARCH for volume, issue and pages (Princeton portal plus
  scan). DOI unknown. **The running time is reported inconsistently** (O(n log³ n) in the
  portal and arXiv 2103.08043, versus O(n log n) in the summary of the scan). Check before
  citing a bound.
* **Claims:** divide and conquer with a new kind of Voronoi diagram; subquadratic
  largest-empty-rectangle computation among n points.

#### C8c. Applicability to Label Anything (my own analysis; the most promising speed idea)
* The exact algorithms above answer "the *largest-area* empty rectangle among *points*".
  Label Anything needs a different question, "**does a box of a given size w×h fit
  anywhere in region R around anchor a, avoiding hard obstacles and placed labels?**",
  over arbitrary obstacle shapes. In computational-geometry terms, that is a question
  about the free configuration space (the region minus the union of obstacles expanded by
  the box). The vector algorithms are therefore **not directly applicable**. The
  **raster version is cheap**, and the repository already has the pieces:
  * `Occupancy` keeps occupied cells as bitsets and, when frozen, a summed-area table, so
    `blocked_in(window)` is O(1).
  * **Fit-centre map:** for a box size class (w, h) (quantized; use the *smallest* box any
    ladder step can produce, i.e. after shrink 0.85 and maximum wrap), the cell c is a
    feasible centre iff the occupied count in the w×h window around c is 0. That is a
    single O(1) SAT query per cell, so a whole-canvas **erosion** costs O(cells), at most
    about 1M with the current grid. An equivalent alternative is an L∞ (box) distance
    transform on an anisotropically scaled grid. The existing `grid/dt.rs` is Euclidean,
    so this would need a separable min-filter variant.
  * **Reach query:** build a SAT over the fit-centre map. Then "is there any feasible
    centre within item i's reachable region" (the anchor's bounding box grown by gap plus
    box size for adjacent and slider candidates, and by max leader length plus box size
    for distant ones) is **one O(1) query per item**.
  * **Soundness:** to avoid wrongly omitting a placeable label, rasterize obstacles
    *conservatively* (mark a cell occupied only if it is fully covered), and include only
    obstacles that every ladder step must respect: hard obstacles, plus placed labels of
    **higher** priority when `evict_lower` is in the ladder (lower-priority labels may be
    evicted, so they count as free). `soft_overlap` relaxes hard obstacles, so items for
    which that step applies must still run it. A positive answer means "maybe", and the
    item runs the normal ladder. A negative answer means **"no ladder step except
    evict_lower/soft_overlap can succeed"**, so those steps (alternatives, wrap, distant,
    shrink) are skipped without generating any box.
  * **Dynamic updates:** placed labels change free space during the greedy pass. Either
    (a) rebuild the fit map per priority band (bands are processed in order, so a band's
    ladder pass sees the labels committed so far), or (b) keep a 2D Fenwick tree of
    "killed" centres: placing a W×H label kills the centres in a (W+w)×(H+h) rectangle,
    which is a rectangle update; queries then cost O(log²).
  * **Expected effect on weakness 5:** 1509 of 2000 items run the ladder, and 1128 of
    them end up omitted. For every doomed item whose reachable region has no fit for the
    smallest variant, the ladder (about 1M boxes across all items) is replaced by one
    query. The real fraction can only be measured in the bench. The 300 ms profile
    suggests most of the 2/3 greedy share could go.
  * Supporting sources: the bitmap as a constant-time oracle (C5), constant-time
    candidate evaluation (C4), conflict particles as a free-space model (C2), and
    "reducing the labels that need to be considered drastically improves efficiency" with
    no user-visible harm (B3). The largest-empty-rectangle literature (C8a, C8b) gives the
    formal background, but its algorithms are not the ones to implement here.

### C9. Mapbox GL / MapLibre GL collision index (industry practice; NOT peer-reviewed)
* **Sources:**
  * Mapbox GL Native wiki, "Collision Detection" (GitHub wiki),
    https://github.com/mapbox/mapbox-gl-native/wiki/Collision-Detection. Per the search
    summary, it was written at the end of 2017 and covers the move to viewport-wide
    collision detection.
  * MapLibre GL JS source `src/symbol/collision_index.ts` (seen only through third-party
    unpkg mirrors in the results, e.g. app.unpkg.com/maplibre-gl@6.12.0/files/src/symbol/collision_index.ts;
    versions not verified).
  * Mapbox blog "Map Label Placement in Mapbox GL",
    https://blog.mapbox.com/map-label-placement-in-mapbox-gl-c6f843a7caaa (older design
    with an R-tree).
  * Mapbox docs "Optimize map label placement",
    https://docs.mapbox.com/help/dive-deeper/optimize-map-label-placement/
* **How found:** WebSearch `Mapbox GL symbol placement collision index grid "GridIndex"
  label collision detection blog`; `MapLibre GL JS collision index symbol placement
  documentation grid index` (2026-10-18).
* **What I read:** search summaries of these pages. I could not open the code: the GitHub
  tool is limited to this repository, and WebFetch is blocked.
* **Status:** industry documentation, not peer-reviewed. URLs were seen in results; the
  content comes from search summaries only.
* **Claims (from the summaries):**
  * A **GridIndex**, a 2D grid tuned for fast insertion and querying of symbol bounding
    geometries. Labels are processed **in priority order**. If the box fits, it is
    inserted; otherwise the label is marked "collided" and **the engine moves on** (no
    repair, no degradation).
  * **Two-phase API:** `placeCollisionBox/Circles` tests for room, `insertCollisionBox`
    commits. That lets paired symbols (icon plus text) be committed together.
  * A separate `ignoredGrid` holds symbols that ignore collisions. **The viewport is
    padded by 100 px** so most label changes happen off-screen.
  * Performance constraint: collision work must fit a 60 fps loop, so synchronous work of
    more than a few milliseconds is unacceptable.
  * Variable placement via `text-variable-anchor` (a list of anchors tried in order) and
    `text-radial-offset`.
* **Relevance:** industry sets the speed baseline with **one test per anchor and
  immediate omission**. Label Anything's ladder makes the opposite trade-off. A **"fast"
  profile** that runs only `alternatives` and omits on failure for items below some
  priority tier would hit the 120 ms target in the scatterplot case at once. With C8c it
  could be the default for low tiers. The 100 px off-screen padding is also a cheap trick
  for weakness 4 (flips happen outside the view).

### C10. Theophil & Schödl 2006, An efficient algorithm for scatter chart labeling
* **Citation:** Sebastian Theophil, Arno Schödl (2006). An efficient algorithm for scatter
  chart labeling. In *Proceedings of the 21st National Conference on Artificial
  Intelligence (AAAI 2006)*, pp. 1064–1069.
* **DOI:** none known. Full text: https://www.think-cell.com/assets/en/career/talks/pdf/think-cell_article_aaai2006.pdf
* **How found:** this came up during the scatterplot crowdsourcing search. Follow-up:
  `Theophil Schödl "An efficient algorithm for scatter chart labeling" AAAI 2006`
  (2026-10-18).
* **What I read:** the abstract (via the search summary of mlanthology.org/aaai/2006/theophil2006aaai-efficient,
  aaai.org/?p=44358 and the DBLP author page dblp.dagstuhl.de/pid/75/6583.html).
* **Status:** VERIFIED-SEARCH (DBLP author page and AAAI/MLAnthology records; pages
  1064–1069).
* **Claims (abstract):** place as many point labels as possible without overlapping each
  other or the points. **Greedy with limited lookahead, then iteratively regroup labels to
  find a near-optimal labeling order.** Used in a commercial charting product (think-cell
  chart 4.2); performs well against other algorithms.
* **Relevance (weakness 2):** the library's local search moves labels. This paper instead
  optimizes the **order** in which greedy processes items. **Idea:** with a cheap greedy
  (after C8c and C1), spend the remaining budget on a few greedy *re-runs* with perturbed
  orders inside a priority band, keeping the best. That may beat simulated annealing,
  which adds only +0.7%. Determinism is preserved if the PCG32 stream picks the
  perturbations.

---

## D. Learning-based evaluation or placement (2020–2026)

### D1. Qu, Zhang, Che, Chen, Ling 2024, Graph Transformer for Label Placement (LPGT)
* **Citation:** Jingwei Qu, Pingshun Zhang, Enyu Che, Yinan Chen, Haibin Ling (2024).
  Graph Transformer for Label Placement. *IEEE Transactions on Visualization and Computer
  Graphics* (IEEE VIS 2024). Volume, issue and pages not confirmed.
* **DOI:** 10.1109/TVCG.2024.3456141, from the authors' GitHub citation block
  (github.com/JingweiQu/LPGT). **Not confirmed on IEEE Xplore.**
* **How found:** WebSearch `deep learning predict label placement quality neural network
  evaluation label layout 2023 2024 2025`; `"Graph Transformer for Label Placement" Qu
  Ling IEEE TVCG 2025 LPGT DOI` (2026-10-18).
* **What I read:** the abstract (via the search summary of the IEEE VIS 2024 program page
  aa.ieeevis.org/year/2024/program/paper_v-full-1218.html, the author PDF and the GitHub
  page).
* **Status:** PARTIAL (venue from the VIS program; DOI only from the authors' repository).
* **Claims:** labels are graph nodes; label placement is cast as node-position
  prediction. Edge-level attention conditioned on node representations models relations
  between labels. New dataset: AMIL (appliance-manual illustration labels).
* **Relevance:** low for the core engine (deterministic, bit-identical across Rust and TS;
  a neural model does not fit). Possible use **offline**: learn a quality predictor (or
  fit cost weights) from human-made layouts such as AMIL, then use it in the evaluator.
  Related, from the same group, details UNVERIFIED: "Mixture of Cluster-guided Experts
  for Retrieval-Augmented Label Placement" (IEEE VIS 2025 program page).

### D2. Shomer & Xu 2025, Automated label placement on maps via large language models
* **Citation:** Harry Shomer, Jiejun Xu (2025). Automated Label Placement on Maps via Large
  Language Models. arXiv:2507.22952 (v1 29 Jul 2025, v2 1 Aug 2025).
* **DOI:** none (arXiv).
* **How found:** this came up during the deep-learning search. Follow-up: `"Automated Label
  Placement on Maps via Large Language Models" arXiv 2507.22952 authors` (2026-10-18).
* **What I read:** the arXiv listing metadata (via the search summary). The content was
  not retrieved.
* **Status:** PARTIAL (arXiv metadata only).
* **Relevance:** a pointer only. I cannot say anything about its method or results.

### D3. Learning-based evaluation: gap
* I found **no published neural model that predicts the perceived quality of a given
  label layout** (as opposed to producing a layout). The closest perceptual data are
  B1's 45,500 pairwise comparisons and B2's 956 binary choices. A Bradley–Terry model
  fitted to such data would give calibrated cost weights. Only the B2 dataset was seen
  to be public.

---

## E. Leads not followed (search budget exhausted)
* Noyes (1980), "The positioning of type on maps: the effect of surrounding material on
  word recognition time", *Human Factors*. The search did not confirm it. It is a classic
  empirical study on how background clutter affects label reading time, relevant to the
  buffer and background terms.
* Wood (2000), "A descriptive and illustrated guide for type placement on small scale
  maps", *The Cartographic Journal*. Only the Wikipedia mention ("extended Imhof's
  guidelines") was seen.
* Brychtová et al. (Palacký University eye-tracking lab, eyetracking.upol.cz): colour
  distance between labels and map background (CIEDE2000 ΔE 30–100) and font size versus
  reading performance. This would back a raster contrast term (A5). The citation was not
  retrieved.
* Liao et al. (2018), label density and perceived map complexity with eye tracking.
  Only the citation, from a summary.
* arXiv:1712.05936, "A fast and practical grid based algorithm for point-feature label
  placement problem". Authors not confirmed.
* arXiv:2609.19848, "Constraint-Safe Graph-Context Scoring for Stable Point-Feature Labels
  Under Text-Width and Accessibility-Inspired Profiles" (2026). Seen as a title only.
* Felzenszwalb & Huttenlocher, distance transforms of sampled functions (already cited in
  `rust/crates/la-core/src/grid/dt.rs`; not re-verified here).

---

## Improvement ideas, ranked (my synthesis)

1. **Sound "can it fit at all?" test before the ladder** (C8c). Erode the conservative
   free-space raster by the smallest ladder box and query reachability with a SAT, in O(1)
   per item. Skip alternatives/wrap/distant/shrink for doomed items. Lower-priority labels
   count as free when evict_lower is enabled. This targets the ~1M wasted boxes directly.
   *Support:* Kittivorawong 2020 (bitmap O(1) queries), Pavlovec & Čmolík 2022
   (constant-time candidate evaluation), Luboschik 2008 (free-space model), Ooms 2009
   (pruning considered labels is efficient and goes unnoticed by users); Naamad 1984 and
   Chazelle 1986 as formal background only.
2. **Wagner–Wolff-style safe reductions plus a converse "doomed" rule and dominance
   pruning** before and inside each band's greedy pass (C1). Fix items whose cheapest
   candidate is conflict-free. Omit at once, in strict mode, items whose every
   candidate/variant bound is blocked by hard obstacles or higher-priority labels. Drop
   dominated candidates. *Support:* Wagner, Wolff, Kapoor, Strijk 2001.
3. **Lazy, staged candidate generation driven by free space** (C2, C3, C9). Create
   distant candidates only at free-space maxima where the box fits (the repo already has
   `dt_maxima` seeds), not 64 ring positions followed by "keep 24". Use label-sized
   trellis cells for crowding estimates. Offer a Mapbox-like "fast tier" (alternatives
   only, then omit) for low-priority tiers. *Support:* Luboschik 2008, Mote 2007, Mapbox
   GL Native wiki / MapLibre (non-peer-reviewed).
4. **Reuse conflict structure across frames with scale-interval conflicts and active
   ranges** (C6, C7). Speeds up interactive re-solves and reduces side flips and popping
   (weakness 4). *Support:* Petzold, Gröger, Plümer 2003/2004; Been, Daiches, Yap 2006.
5. **Deterministic parallel evaluation** of items with disjoint candidate regions inside a
   band, committing in a fixed order. *Support:* Pavlovec & Čmolík 2022.
6. **Decomposed evaluator quality function**, separate from the solver cost: label–label
   conflicts, overlap by obstacle class, position priority, association/ambiguity,
   leader metrics, and raster contrast/hierarchy. Report it per term so placement methods
   and versions can be compared. *Support:* van Dijk et al. 2002; Fan, Zhang, Du 2005;
   Rylov & Reimer 2014 (Cartographica) and 2015 (GeoInformatica); Hartmann et al. 2005
   (leader/aesthetic metrics).
7. **Cost terms calibrated by user studies:** position costs from PerceptPPO
   preference strengths (top above top-right); an **alignment** term weighted above gap
   distance (alignment preferred over proximity); a possible **density target** (about 17%
   coverage, unconfirmed); and an in-house 2AFC study to calibrate the ambiguity term,
   since no published association study was found. *Support:* Bobák et al. arXiv
   2407.11996; Scheuerman et al. 2023; Bobák et al. 2024 (2AFC protocol).
8. **Budget-aware split between greedy and optimization:** spend the time saved on greedy
   re-runs with perturbed order rather than more annealing. *Support:* Christensen, Marks,
   Shieber 1995 (the best method depends on available time); Theophil & Schödl 2006
   (optimize the labeling order).
