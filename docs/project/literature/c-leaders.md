# C — External labeling with leaders (weaknesses 1, 3, 6)

Agent C, 2026-10-18. Topic: boundary labeling theory, leader readability, contour/radial and
focus-region labeling, scatterplot leader layouts, mixed internal/external labeling, line-end
labeling, leader routing.

## How this was searched, and what "verified" means here

* **Network limits in this session.** WebFetch could only reach `github.com` and
  `raw.githubusercontent.com`. Every other host (dblp.org, doi.org, api.crossref.org, arxiv.org,
  link.springer.com, KIT and university repositories, cran.r-project.org, *.github.io) failed
  with `getaddrinfo ENOTFOUND`. `curl` from the shell was refused by the egress proxy (403). So
  the only way to check bibliographic data was **WebSearch**. Its results list URLs plus a
  summary that the search engine wrote from those pages.
* **Status labels used below** (following the coordinator's instruction):
  * **VERIFIED-SEARCH**: authors, venue, volume/pages and DOI were confirmed by search results
    whose source is a DBLP, publisher (ScienceDirect, Springer, SAGE, ACM DL, JGAA, EG Digital
    Library, JOSIS) or arXiv page. I did **not** open the page myself.
  * **PARTIAL**: some fields come only from a secondary source (a citing paper's reference list,
    an institutional repository or a publication list), or were not confirmed at all. The
    fields affected are named.
  * **VERIFIED (GitHub)**: software whose source code I read directly on GitHub.
  * **UNVERIFIED**: from memory and clearly marked as such.
* **What I read.** For every paper I saw only the **abstract or metadata, as quoted or
  summarized by the search engine**. I read no full texts. Statements about a paper's content
  are limited to what its abstract says. My own interpretations are marked *(interpretation)*.
* **The search stopped early.** The WebSearch budget for this turn (200 calls, shared by all
  agents) ran out partway through. The ggrepel examples page, a directlabels paper or talk,
  and full-text checks of several DOIs could not be searched any more. Those items are marked.
* **Repository context** comes from reading the code (not modified): `rust/crates/la-core/src/solver/repair.rs`
  (`stack`: bounded isotonic stacking by pool-adjacent-violators, PAV; `hungarian`: minimum
  total-length assignment), `solver/fan.rs` (the fan column, which keeps the anchors' order
  unless a Hungarian matching is shorter), `docs/adr/placement/columns.md` and spec §6.6,
  §6.8, §7. Boundary labels with the
  `orthogonal` style use `opo` leaders (spec §7). The default leader style is `straight`
  (spec/defaults.md).

---

## 1. Boundary labeling theory

### C1. Bekos, Kaufmann, Symvonis, Wolff 2007 — Boundary labeling: models and efficient algorithms for rectangular maps
* **Citation:** Michael A. Bekos, Michael Kaufmann, Antonios Symvonis, Alexander Wolff. Boundary
  labeling: Models and efficient algorithms for rectangular maps. *Computational Geometry:
  Theory and Applications* 36(3):215–236, 2007. Preliminary version: Graph Drawing (GD 2004),
  LNCS 3383, pp. 49–59.
* **DOI/URL:** 10.1016/j.comgeo.2006.05.003 —
  https://www.sciencedirect.com/science/article/pii/S0925772106000447 ;
  DBLP https://dblp.org/rec/journals/comgeo/BekosKSW07.html
* **How found:** WebSearch "Bekos Kaufmann Symvonis Wolff Boundary labeling: Models and efficient
  algorithms for rectangular maps" and "Boundary labeling: Models and efficient algorithms for
  rectangular maps Computational Geometry 36(3)" (limited to dblp.org, sciencedirect.com,
  doi.org), 2026-10-18.
* **Read:** abstract and metadata (search summary of the ScienceDirect and DBLP pages).
* **Status:** VERIFIED-SEARCH (ScienceDirect and DBLP result pages). The GD'04 page range comes
  from a citing reference list.
* **Claims (abstract):**
  * Introduces *boundary labeling*: labels around a rectangle enclosing the sites, each
    connected to its site by a leader, with no two leaders crossing. The authors note it is
    common in technical drawings and medical atlases but had not been studied before.
  * Variants: labels of identical or different size, straight or rectilinear leaders, fixed or
    sliding ports, labels on one, two or four sides.
  * Simple, efficient algorithms that minimize total leader length or, for rectilinear leaders,
    the total number of bends.
* **Relevance:** This is the model behind LA's boundary columns (spec §6.6, ADR placement/columns) and fan
  columns (§6.8). LA already uses the two standard tools from this line of work: order-keeping
  stacking and a minimum-total-length assignment (`hungarian` in `repair.rs`). The paper
  separates *fixed* from *sliding* ports. LA's slots are fixed after the PAV stacking.
  *(Interpretation)* Sliding ports, meaning a leader may end anywhere on the label's near side,
  would give extra vertical slack before a fan leader exceeds `max_length` (weakness 6).

### C2. Benkert, Haverkort, Kroll, Nöllenburg 2009 — Algorithms for multi-criteria boundary labeling
* **Citation:** Marc Benkert, Herman Haverkort, Moritz Kroll, Martin Nöllenburg. Algorithms for
  Multi-Criteria Boundary Labeling. *Journal of Graph Algorithms and Applications* 13(3):289–317,
  2009. Special issue of GD 2007. Preliminary version: "Algorithms for multi-criteria one-sided
  boundary labeling", GD 2007, LNCS 4875, pp. 243–254.
* **DOI/URL:** 10.7155/jgaa.00189 — https://www.jgaa.info/index.php/jgaa/article/view/paper189
  (open access, CC BY 4.0).
* **How found:** WebSearch "Benkert Haverkort Kroll Nöllenburg Algorithms for multi-criteria
  boundary labeling Journal of Graph Algorithms and Applications", 2026-10-18.
* **Read:** abstract and metadata (search summary of the JGAA page).
* **Status:** VERIFIED-SEARCH (JGAA article page).
* **Claims (abstract):**
  * Labels n points with labels aligned on one side of the bounding box. Each leader is a
    horizontal segment plus a second segment at a fixed angle (this covers po leaders at 90°
    and do leaders at diagonal angles).
  * Computes crossing-free leaders that minimize the number of bends, the total length, or a
    general "badness" function.
  * Generalizes to labels on two opposite sides. Includes an experimental evaluation.
* **Relevance (weaknesses 6, 1):** *(interpretation)* LA builds a fan column greedily: stack by
  PAV, test each label, then "the lowest-priority failing member leaves" and repeat (spec
  §6.8, Repair). A DP over a general badness function suggests building the column directly as
  an optimization instead. Set the badness to infinity for a leader longer than `max_length`
  or one hitting a mark, give omission a cost equal to the item's priority weight, and let the
  DP choose the members and the slots together. Benkert et al.'s DP is for crossing-free leader
  sets with given label slots. Whether omission can be folded in without losing its
  complexity has to be checked against the full text, which I did not read.

### C3. Kindermann, Niedermann, Rutter, Schaefer, Schulz, Wolff 2016 — Multi-sided boundary labeling
* **Citation:** Philipp Kindermann, Benjamin Niedermann, Ignaz Rutter, Marcus Schaefer, André
  Schulz, Alexander Wolff. Multi-Sided Boundary Labeling. *Algorithmica* 76(1):225–258, 2016.
  Preliminary version: WADS 2013, LNCS 8037, pp. 463–474. arXiv:1305.0750.
* **DOI/URL:** 10.1007/s00453-015-0028-4 — https://link.springer.com/article/10.1007/s00453-015-0028-4 ;
  DBLP https://dblp.org/rec/journals/algorithmica/KindermannNRS0W16.html
* **How found:** WebSearch "Kindermann Niedermann Rutter Schulz Wolff Multi-sided boundary
  labeling Algorithmica 2016", then "dblp Multi-Sided Boundary Labeling Algorithmica 76
  Kindermann" (limited to dblp.org, link.springer.com, doi.org), 2026-10-18. The brief's author
  list leaves out Marcus Schaefer.
* **Read:** abstract and metadata (search summaries of the DBLP and arXiv pages).
* **Status:** VERIFIED-SEARCH (DBLP record and Springer page).
* **Claims (abstract):**
  * Studies po leaders with labels on two or more sides of the rectangle.
  * Main result: a polynomial-time algorithm that finds a crossing-free leader layout whenever
    one exists.
  * For two adjacent sides it also minimizes the total leader length.
  * A later paper (Bose, Mehrabi, Mondal, arXiv:2002.09740) cites its running times as O(n⁴)
    for three sides and O(n⁹) for four. This is a secondary statement from the search
    summary, not checked.
* **Relevance (weakness 6):** LA's fan tries each allowed side separately: it lays out the
  better side, then lays out the other side again for the members left (§6.8 "Sides"). The
  paper decides jointly which side each label goes to. *(interpretation)* For crowded line ends
  (right column) one could allow a second column above or below the plot area (an adjacent
  side), or on the left at the line *starts* (see C22). The side assignment would be chosen
  jointly by length, which avoids a greedy split.

### C4. Bekos, Kaufmann, Nöllenburg, Symvonis 2010 — Boundary labeling with octilinear leaders
* **Citation:** Michael A. Bekos, Michael Kaufmann, Martin Nöllenburg, Antonios Symvonis.
  Boundary Labeling with Octilinear Leaders. *Algorithmica* 57(3):436–461, 2010. Special issue of
  SWAT 2008.
* **DOI/URL:** 10.1007/s00453-009-9283-6 — https://link.springer.com/doi/10.1007/s00453-009-9283-6
* **How found:** WebSearch "Bekos Kaufmann Nöllenburg Symvonis Boundary labeling with octilinear
  leaders Algorithmica", 2026-10-18.
* **Read:** abstract and metadata (search summaries of the Springer link and the NTUA repository
  record, which gives the DOI).
* **Status:** VERIFIED-SEARCH (Springer DOI link in the results; volume and pages from the NTUA
  repository and the KIT preprint listing).
* **Claims (abstract):**
  * Leaders made of horizontal, vertical and diagonal (45°) segments.
  * Combining pairs of octilinear leader types overcomes the infeasibility that can arise when
    only one leader type is allowed.
  * A total-length minimization algorithm for uniform label sizes. NP-completeness for labels
    of arbitrary sizes.
* **Relevance (weaknesses 3, 6):** LA's fan and boundary leaders all have one shape per run
  (`leaders.style`). ADR placement/columns records that `angles` and `elbow` fans failed at line ends
  because parallel diagonals from close ends come nearer to each other than the clearance.
  *(interpretation)* The paper's main point is that **mixing** leader types per label restores
  feasibility. A fan column could give the labels near the crowd's vertical centre straight or
  horizontal leaders and the outer ones diagonal-then-horizontal leaders. Diagonals would then
  only appear where they spread apart. The NP-completeness for non-uniform labels is a
  warning: fan labels of different heights do not have an exact polynomial algorithm.

### C5. Lin, Kao, Yen 2008 — Many-to-one boundary labeling
* **Citation:** Chun-Cheng Lin, Hao-Jen Kao, Hsu-Chun Yen. Many-to-One Boundary Labeling.
  *Journal of Graph Algorithms and Applications* 12(3):319–356, 2008. Conference version: APVIS
  2007, pp. 65–72.
* **DOI/URL:** 10.7155/jgaa.00169 — https://jgaa.info/index.php/jgaa/article/view/paper169
* **How found:** WebSearch "Many-to-one boundary labeling Lin Kao Yen Journal of Graph Algorithms
  and Applications 2008", 2026-10-18.
* **Read:** abstract and metadata (search summaries of the JGAA page and the NTU repository).
* **Status:** VERIFIED-SEARCH (JGAA page). The DOI string is from the NTU repository record,
  but it matches the JGAA DOI scheme.
* **Claims (abstract):**
  * Several sites share one label (multi-site-to-one-label). The goal is placing labels and
    leaders so that the number of crossings between leaders is minimal.
  * NP-complete for certain one-sided and two-sided schemes. The authors give approximation
    algorithms and heuristics.
* **Relevance (weaknesses 1, 3):** see C6.

### C6. Bekos, Cornelsen, Fink, Hong, Kaufmann, Nöllenburg, Rutter, Symvonis 2015 — Many-to-one boundary labeling with backbones
* **Citation:** Michael A. Bekos, Sabine Cornelsen, Martin Fink, Seok-Hee Hong, Michael Kaufmann,
  Martin Nöllenburg, Ignaz Rutter, Antonios Symvonis. Many-to-One Boundary Labeling with
  Backbones. *Journal of Graph Algorithms and Applications* 19(3):779–816, 2015. Conference
  version: GD 2013, LNCS 8242, pp. 244–255. arXiv:1308.6801.
* **DOI/URL:** 10.7155/jgaa.00379 — https://jgaa.info/index.php/jgaa/article/view/paper379
* **How found:** WebSearch "Bekos Cornelsen Fink Hong Kaufmann Nöllenburg Rutter Symvonis
  Many-to-one boundary labeling with backbones", 2026-10-18.
* **Read:** abstract and metadata (search summaries of the JGAA page and the KOPS repository).
* **Status:** VERIFIED-SEARCH (JGAA page).
* **Claims (abstract):**
  * A horizontal *backbone* runs from each label into the rectangle. The sites attach to it by
    vertical segments.
  * Dynamic programs minimize the number of label occurrences and the leader length in
    crossing-free labelings.
  * Minimizing leader crossings is NP-hard when the label order is flexible.
* **Relevance (weaknesses 1, 3):** *(interpretation)* When crowded items share a label (same
  category or name, or items of a `group` in LA), one label with a backbone or hyperleader
  replaces k labels and k leaders. LA has group labels with leaders to members, but no
  backbone. A backbone leader at a crowded scatter cluster or a bundle of line ends of one
  category would cut the leader count in Gapminder-like scenes. This is an opt-in model, not a
  default.

### C7. Nöllenburg, Polishchuk, Sysikaski 2010 — Dynamic one-sided boundary labeling
* **Citation:** Martin Nöllenburg, Valentin Polishchuk, Mikko Sysikaski. Dynamic one-sided
  boundary labeling. *Proc. 18th ACM SIGSPATIAL International Conference on Advances in
  Geographic Information Systems (GIS '10)*, pp. 310–319, 2010.
* **DOI/URL:** 10.1145/1869790.1869834 — http://dl.acm.org/citation.cfm?id=1869834 ; DBLP
  conference listing https://dblp.org/db/conf/gis/gis2010.html
* **How found:** WebSearch "Nöllenburg Polishchuk Sysikaski Dynamic one-sided boundary
  labeling", then "\"Dynamic one-sided boundary labeling\" GIS 2010 doi 10.1145" (limited to
  dblp.org, dl.acm.org, doi.org), 2026-10-18.
* **Read:** abstract and front matter (search summary of the ACM DL record and the KIT preprint).
* **Status:** VERIFIED-SEARCH (ACM DL record).
* **Claims (abstract and summary):**
  * One-sided boundary labeling with one-bend rectilinear (po) leaders, minimizing total
    leader length.
  * A *dynamic* setting with continuous zoom and scale changes, building on the consistency
    criteria of Been et al. (no popping or jumping).
  * A *clustered* setting with several label stacks, and a combined dynamic-clustered setting.
  * Algorithms track the "combinatorially different" labelings that occur while zooming.
* **Relevance (weaknesses 6, 4):** Two ideas. (a) *Multiple stacks*: one column per crowd is LA's
  current model. Several stacks (clusters) per side are explicitly modelled here, and they are
  the natural remedy when one fan column saturates. (b) *Dynamic consistency*: ADR placement/columns reports
  fans raise flip rate +4–5 % because "columns are built anew in each frame".
  *(interpretation)* Keeping a column's membership and order from the previous frame, and
  changing it only at combinatorial events, is the paper's model. It would remove most of
  that instability.

---

## 2. Readability of leaders

### C8. Barth, Gemsa, Niedermann, Nöllenburg 2019 — On the readability of leaders in boundary labeling
* **Citation:** Lukas Barth, Andreas Gemsa, Benjamin Niedermann, Martin Nöllenburg. On the
  readability of leaders in boundary labeling. *Information Visualization* 18(1):110–132, 2019.
  Conference version: "On the Readability of Boundary Labeling", GD 2015, LNCS 9411, pp. 515–527,
  DOI 10.1007/978-3-319-27261-0_42, arXiv:1509.00379.
* **DOI/URL:** 10.1177/1473871618799500 — https://journals.sagepub.com/doi/abs/10.1177/1473871618799500 ;
  study data: https://algo.iti.kit.edu/projects/bl-userstudy
* **How found:** WebSearch "Barth Gemsa Niedermann Nöllenburg On the readability of leaders in
  boundary labeling Information Visualization 2019", then "\"On the readability of leaders in
  boundary labeling\" abstract" (limited to journals.sagepub.com, semanticscholar.org,
  repositum.tuwien.at, dblp.org), 2026-10-18.
* **Read:** abstract (search summary of the SAGE page and the TU Wien repository). I did not read
  the full text, so I cannot report per-leader error rates or times.
* **Status:** VERIFIED-SEARCH (SAGE page: volume 18, issue 1, pages 110–132, DOI). One institute
  page gives the year as 2018, probably the online-first date.
* **What they actually found (abstract only):**
  * The first formal user study of boundary-labeling readability. It compares the four
    most-studied leader types: straight (s), L-shaped (po), diagonal (do) and S-shaped (opo).
  * Tasks: whether and how fast a viewer assigns a feature to its label and a label to its
    feature. Aesthetics come from preference judgments and interviews.
  * **L-shaped (po) leaders are recommended as the best compromise** between measured task
    performance and subjective preference.
  * **Straight and diagonal leaders got mixed ratings** across the two measures.
  * **S-shaped (opo) leaders are generally not recommended** from a practical point of view.
  * Secondary source: the radial contour labeling paper (C9, arXiv abstract page) summarizes
    the study as "straight-line leaders and L-shaped leaders outperform the other mentioned
    leader types concerning readability".
* **Relevance (weakness 3):** LA's boundary labels with the `orthogonal` style use **opo**
  leaders (spec §7: "`opo` (two bends) for boundary labels"), which is the type this study
  advises against. *(interpretation)* Make **po** the boundary/fan leader for the orthogonal
  style. Columns would then run with the leader entering the label horizontally at the
  anchor's own height where possible (slot = anchor height) and otherwise one vertical-then-
  horizontal bend. C1 and C2 give algorithms for po. Keep `straight` (the default) for fans.
  The study covers boundary labels only. It says nothing about the 8–11 em distant leaders of
  weakness 3, so it cannot be used to justify their length.

---

## 3. Contour, radial and focus-region labeling

### C9. Niedermann, Nöllenburg, Rutter 2017 — Radial contour labeling with straight leaders
* **Citation:** Benjamin Niedermann, Martin Nöllenburg, Ignaz Rutter. Radial Contour Labeling
  with Straight Leaders. *Proc. 10th IEEE Pacific Visualization Symposium (PacificVis 2017)*,
  pp. 295–304, 2017. Extended version arXiv:1702.01799.
* **DOI/URL:** 10.1109/PACIFICVIS.2017.8031608 (from a citing reference) — arXiv
  https://arxiv.org/abs/1702.01799
* **How found:** WebSearch "Niedermann Nöllenburg Rutter Radial contour labeling with straight
  leaders PacificVis 2017", then "\"Radial contour labeling with straight leaders\" PacificVis
  2017 pages doi 10.1109/PACIFICVIS" (limited to dblp.org, ieeexplore.ieee.org, doi.org,
  arxiv.org), 2026-10-18.
* **Read:** abstract (search summary of the arXiv page).
* **Status:** PARTIAL. Authors, title, venue and arXiv ID were confirmed on the arXiv page. The
  **pages (295–304) and the DOI come only from a citing paper's reference list**. No IEEE Xplore
  or DBLP page was seen.
* **Claims (abstract):**
  * External labels are placed around a given **contour** of the figure, which prescribes the
    possible label positions, and are connected to features by straight leaders. The
    approach is flexible and general.
  * The algorithm is based on **18 layout quality criteria** derived from interviews and an
    analysis of **202 handmade anatomical drawings**.
  * Aimed at highest-quality illustrations, not fast interactive use. The authors argue that
    rectangular boundary-labeling results are hardly applicable when labels are not uniform
    and the figure's boundary is not a rectangle.
* **Relevance (weaknesses 1, 3):** ADR placement/columns says two-dimensional scatter crowds (Gapminder,
  software metrics, citations, cities) "get few or no columns: their leaders would cross the
  marks and labels around the crowd". *(interpretation)* A **contour labeling pass** for 2D
  crowds is the natural counterpart of the fan column. Take the crowd's hull, offset it by the
  leader clearance plus a gap to get the contour, and order the labels around it by the
  angles of their anchors from the crowd centre. Straight radial leaders in angular order do
  not cross each other. Every leader is about as long as the crowd's radius plus the offset,
  so no leader is 8–11 em unless the crowd itself is that large. The 18 criteria can be
  checked against LA's cost terms; I did not read them.

### C10. Fink, Haunert, Schulz, Spoerhase, Wolff 2012 — Algorithms for labeling focus regions
* **Citation:** Martin Fink, Jan-Henrik Haunert, André Schulz, Joachim Spoerhase, Alexander Wolff.
  Algorithms for Labeling Focus Regions. *IEEE Transactions on Visualization and Computer
  Graphics* 18(12):2583–2592, 2012.
* **DOI/URL:** 10.1109/TVCG.2012.193 — https://doi.org/10.1109/tvcg.2012.193 ; PubMed
  https://pubmed.ncbi.nlm.nih.gov/26357167/
* **How found:** WebSearch "Fink Haunert Schulz Spoerhase Wolff Algorithms for labeling focus
  regions IEEE TVCG 2012", then "\"Algorithms for Labeling Focus Regions\" abstract circular
  focus region leaders labels placed around" (limited to ieeexplore.ieee.org, doi.org, dblp.org,
  pubmed.ncbi.nlm.nih.gov, semanticscholar.org), 2026-10-18.
* **Read:** abstract and introduction (search summary of the PubMed, doi.org and Semantic
  Scholar PDF results).
* **Status:** VERIFIED-SEARCH. The DOI resolves in the results (doi.org link). Volume, issue and
  pages come from the Würzburg publication list and several reference lists.
* **Claims (abstract and introduction):**
  * Point sites inside a **focus region** (for example a crowded downtown in a map) are labeled
    on the **boundary of the region**, each by a leader. The labels move out of the focus into
    the context.
  * Leaders are **straight segments or Bézier curves**, not polylines. The algorithms exclude
    leader crossings and optimize total leader length and the spacing between labels.
  * Also algorithms that choose the focus region's position optimizing these criteria.
  * When there are more sites than label slots, the user prioritizes the sites, or a
    facility-location model clusters them.
* **Relevance (weaknesses 1, 3):** *(interpretation)* This is the same contour idea as C9,
  aimed at crowds. A crowd is a focus region; its boundary circle holds the label slots. The
  "more sites than slots" case is exactly weakness 1 (crowds keep few labels). The paper's
  answer is to select by priority or to cluster (one label per cluster), which fits LA's
  priority model and would label "N items" clusters. Bézier leaders are an existing LA style
  (`curved`). They could route around large marks at the crowd edge instead of the candidate
  being rejected.

### C11. Heinsohn, Gerasch, Kaufmann 2014 — Boundary labeling methods for dynamic focus regions
* **Citation:** Niklas Heinsohn, Andreas Gerasch, Michael Kaufmann. Boundary Labeling Methods for
  Dynamic Focus Regions. *Proc. IEEE Pacific Visualization Symposium (PacificVis 2014)*,
  pp. 243–247, 2014.
* **DOI/URL:** 10.1109/PacificVis.2014.20 — repository record
  https://publikationen.uni-tuebingen.de/xmlui/handle/10900/76454
* **How found:** WebSearch "Heinsohn Gerasch Kaufmann boundary labeling dynamic focus regions
  2014", 2026-10-18.
* **Read:** metadata only. The repository lists it as closed access, and no abstract was found.
* **Status:** PARTIAL. All bibliographic data, including the DOI, come from the University of
  Tübingen repository record. No IEEE or DBLP page was seen. **Content not verified.**
* **Claims:** none that I can report. Only the title is known: boundary labeling for a *dynamic*
  focus region.
* **Relevance:** *(interpretation, from the title only)* Supports C7 and C10 for interactive use
  (weakness 4): fan/contour labels around a moving focus or lens.

### C12. Fekete, Plaisant 1999 — Excentric labeling
* **Citation:** Jean-Daniel Fekete, Catherine Plaisant. Excentric labeling: Dynamic neighborhood
  labeling for data visualization. *Proc. ACM SIGCHI Conference on Human Factors in Computing
  Systems (CHI '99)*, pp. 512–519, 1999. Also a University of Maryland technical report, 1998
  (DRUM handle 1903/973).
* **DOI/URL:** 10.1145/302979.303148 (from the UMIACS index only) — https://drum.lib.umd.edu/handle/1903/973
* **How found:** WebSearch "Fekete Plaisant Excentric labeling: dynamic neighborhood labeling for
  data visualization CHI 1999", then "\"Excentric labeling\" Fekete Plaisant CHI '99 pages
  512-519 10.1145/302979.303148" (limited to dl.acm.org, dblp.org, doi.org), 2026-10-18.
* **Read:** abstract (search summary of the UMD DRUM record and the UMIACS index).
* **Status:** PARTIAL. Authors, title, venue and year were confirmed by repository records. **The
  pages (512–519) come only from citing reference lists. The DOI comes only from the UMIACS
  index**; no ACM DL page confirmed it.
* **Claims (abstract):**
  * A dynamic technique that labels the neighborhood of objects around the cursor. The
    neighborhood is a circle centred on the cursor (summary from a Cytoscape RFC, a secondary
    source).
  * Non-intrusive, not computationally intensive, easily applied to several visualizations.
  * A pilot study with 8 subjects showed a strong speed benefit over a zoom interface for
    exploring large numbers of objects.
  * UNVERIFIED (from memory): labels are stacked in columns left and right of the focus
    circle, ordered by the objects' y to avoid leader crossings.
* **Relevance:** ADR placement/columns already names excentric labeling as the model for fan labels.
  *(interpretation)* The interactive form, labels for the crowd under a lens on demand,
  answers weakness 1 for interactive hosts. Crowd members that stay unlabeled statically could
  be reported in the result as "lens-able" crowds, so the host can show an excentric lens.

### C13. Bertini, Rigamonti, Lalanne 2009 — Extended excentric labeling
* **Citation:** Enrico Bertini, Maurizio Rigamonti, Denis Lalanne. Extended Excentric Labeling.
  *Computer Graphics Forum* 28(3):927–934, 2009 (EuroVis 2009).
* **DOI/URL:** 10.1111/j.1467-8659.2009.01456.x — EG Digital Library
  https://diglib.eg.org/handle/10.1111/v28i3pp0927-0934
* **How found:** WebSearch "Bertini Rigamonti Santucci Extended excentric labeling Computer
  Graphics Forum 2009", 2026-10-18. The third author is **Lalanne**, not Santucci as the brief
  says.
* **Read:** abstract (search summary of the EG Digital Library page).
* **Status:** VERIFIED-SEARCH (EG Digital Library page).
* **Claims (abstract):**
  * Extends excentric labeling (labels around a movable lens) for high-density areas, uneven
    density distributions and summary statistics.
  * A think-aloud user study found that users understand and operate most functions easily,
    except **label scrolling**, which needs more research.
* **Relevance (weakness 1):** *(interpretation)* The non-uniform-density case is LA's crowd case.
  Where a crowd has more members than a column or contour can hold, show a summary label
  instead of silently omitting the rest. For example: "+12 more" as one label with a
  many-to-one leader, see C5 and C6.

---

## 4. Scatterplot- and visualization-specific leader layouts

### C14. Lhuillier, van Garderen, Weiskopf 2019 — Density-based label placement
* **Citation:** Antoine Lhuillier, Mereke van Garderen, Daniel Weiskopf. Density-based label
  placement. *The Visual Computer* 35(6–8):1041–1052, 2019.
* **DOI/URL:** 10.1007/s00371-019-01686-7 — https://link.springer.com/doi/10.1007/s00371-019-01686-7 ;
  ACM DL https://dl.acm.org/doi/10.1007/s00371-019-01686-7
* **How found:** WebSearch "Lhuillier van Garderen Weiskopf Density-based label placement The
  Visual Computer 2019", 2026-10-18.
* **Read:** abstract (search summary of the KOPS repository and the Springer page).
* **Status:** VERIFIED-SEARCH (Springer DOI page, with volume, issue and pages from the KOPS
  record).
* **Claims (abstract):**
  * An image-space algorithm builds a **kernel-density map** of the features to be labeled.
  * Labels move along the **gradient descent** of the map until they no longer overlap
    features or other labels. They end up pushed into low-density areas around dense
    clusters.
  * The descent path can be drawn as a **curved leader**.
  * Supports priorities, label-to-label and label-to-feature margins, obstacles and
    arbitrarily shaped labels. It can be implemented with OpenCV-like image processing.
* **Relevance (weaknesses 1, 3, 5):** LA's distant candidates are 4 rings × 16 directions plus
  free-space seeds, of which the 24 cheapest are kept. *(interpretation)* LA already has
  coverage grids and summed-area tables (SATs). A blurred density of those grids gives a
  gradient field almost for free. **Distant candidates generated by descending from the anchor
  to the first free spot** would (i) find a free spot with far fewer box evaluations than the
  64 ring positions plus the ladder (weakness 5: about 1M boxes for labels that end up
  omitted), (ii) by construction not take leaders across dense or large marks, since the path
  runs downhill in density (weakness 3), and (iii) supply a natural curved leader route. Keep
  the exact hard checks on the result.

### C15. Meng, Zhang, Liu, Liu 2015 — Clutter-aware label layout
* **Citation:** Y. Meng, H. Zhang, M. Liu, S. Liu (initials only, as in the citing reference). Clutter-aware label layout. *Proc. IEEE
  Pacific Visualization Symposium (PacificVis 2015)*, Hangzhou, pp. 207–214, 2015.
* **DOI/URL:** **unknown, not confirmed.** The infona.pl mirror URL contains the IEEE article
  number 7156379 (https://www.infona.pl/resource/bwmeta1.element.ieee-art-000007156379), which
  suggests 10.1109/PACIFICVIS.2015.7156379, but no result showed that DOI. AMiner:
  https://www.aminer.org/pub/5736977f6e3b12023e665608/clutter-aware-label-layout
* **How found:** WebSearch "Meng Zhang Chen Clutter-aware label layout PacificVis 2015", then two
  follow-up queries with author lists and pages, 2026-10-18.
* **Read:** abstract (search summary of the AMiner and infona pages).
* **Status:** PARTIAL. Title, venue and year were confirmed by the AMiner and infona IEEE
  mirror. **The authors (Meng, Zhang, Liu, Liu, initials only) and pages 207–214 come from one
  citing reference list. The DOI is unconfirmed.** The brief's "Meng, Zhang, Chen et al." does
  not match.
* **Claims (abstract):**
  * Measures and reduces visual clutter during label layout. The clutter model has four
    factors: **confusion, visual connection, distance, intersection**.
  * Motivation: when there are many labels, existing methods do not give a quick overview, and
    clutter blocks real-world use. Applied to several visualization types.
* **Relevance (weakness 3):** *(interpretation)* LA prices each leader on its own (fixed + length +
  bends + covered classes). It has no **global** term for how many leaders a scene has or how
  they visually connect. A scene-level leader budget would decide when a long leader is worse
  than omitting the label or keeping it adjacent: for example, a soft cost growing with the
  number of leaders crossing one region, or an option `leaders.max_count` / `max_fraction`.
  That is the trade-off in Gapminder's 14 of 32. This also gives a metric for the benchmark.

---

## 5. Mixed internal/external labeling and illustrations

### C16. Löffler, Nöllenburg, Staals 2016 — Mixed map labeling
* **Citation:** Maarten Löffler, Martin Nöllenburg, Frank Staals. Mixed Map Labeling. *Journal of
  Spatial Information Science* 13:3–32, 2016. Conference version: CIAC 2015, LNCS 9079,
  pp. 339–351. arXiv:1501.06813.
* **DOI/URL:** 10.5311/JOSIS.2016.13.264 — https://josis.org/index.php/josis/article/view/71
* **How found:** WebSearch "Löffler Nöllenburg Staals Mixed map labeling Journal of Spatial
  Information Science 2016", 2026-10-18.
* **Read:** abstract (search summaries of the JOSIS, Digital Commons and Utrecht pages).
* **Status:** VERIFIED-SEARCH (JOSIS page and DOI). One listing puts Staals first, so check the
  author order on the journal page.
* **Claims (abstract):**
  * Polynomial-time algorithms that **maximize the number of internal labels** in a model where
    the labels left over become external with leaders.
  * All leaders share a fixed orientation, and the orientation affects the running times.
* **Relevance (weaknesses 1, 3):** *(interpretation)* This is LA's ladder (adjacent → distant →
  boundary) stated as one optimization: maximize the labels next to their anchors and route the
  rest to the boundary. LA decides per item and greedily. Treat "which items go to the
  column" as a set decision after the search. Move adjacent labels into a column when that
  frees room for two others. LA's `fan: always` does this partly; a principled variant
  maximizes the total number of labels.

### C17. Ali, Hartmann, Strothotte 2005 — Label layout for interactive 3D illustrations
* **Citation:** Kamran Ali, Knut Hartmann, Thomas Strothotte. Label Layout for Interactive 3D
  Illustrations. *Journal of WSCG* 13(1):1–8, 2005.
* **DOI/URL:** no DOI known. Repository: https://dspace5.zcu.cz/handle/11025/1441 (University of
  West Bohemia, WSCG's host; PDF https://dspace5old.zcu.cz/bitstream/11025/1441/1/Ali.pdf).
* **How found:** WebSearch "Ali Hartmann Strothotte Label layout for interactive 3D illustrations
  Journal of WSCG 2005", 2026-10-18.
* **Read:** abstract (search summary of the ZCU DSpace record).
* **Status:** VERIFIED-SEARCH (publisher repository record: volume, issue, pages; no DOI exists
  in the record shown).
* **Claims (abstract):**
  * Analyzes complex hand-made examples and extracts and classifies several **label layout
    styles** (internal and external).
  * Real-time layout algorithms that **use the previous frame's layout decisions** to stay
    consistent during interaction.
  * Evaluation criteria for static and dynamic label layouts.
* **Relevance (weakness 4, the fan instability noted in ADR placement/columns):** *(interpretation)* LA warm-
  starts its candidates but rebuilds fan and boundary columns from scratch in each frame. Reuse
  the previous frame's column membership, order and side as a strong prior: the same column if
  still feasible, otherwise the minimal change.

### C18. Hartmann, Götzelmann, Ali, Strothotte 2005 — Metrics for functional and aesthetic label layouts
* **Citation:** Knut Hartmann, Timo Götzelmann, Kamran Ali, Thomas Strothotte. Metrics for
  Functional and Aesthetic Label Layouts. In: *Smart Graphics (SG 2005)*, LNCS 3638, Springer,
  pp. 115–126 (pages from one bibliography), 2005.
* **DOI/URL:** 10.1007/11536482_10
* **How found:** WebSearch "Hartmann Götzelmann Ali Strothotte Metrics for functional and
  aesthetic label layouts Smart Graphics 2005 LNCS 3638", 2026-10-18.
* **Read:** abstract (search summary of the Unpaywall record for the DOI).
* **Status:** PARTIAL. Title, authors, LNCS volume and DOI come from the Unpaywall DOI record.
  **The pages come from one citing bibliography.**
* **Claims (abstract):**
  * From a corpus of complex hand-drawn label layouts: a classification of layout styles and
    **metrics for functional requirements and aesthetic attributes**.
  * A real-time layout algorithm for internal and external labels that balances user
    requirements against these attributes.
  * Related open-access paper: Götzelmann, Ali, Hartmann, Strothotte, "Form Follows Function:
    Aesthetic Interactive Labels", Computational Aesthetics 2005, pp. 193–200, which balances
    unambiguity, readability, aesthetics and frame coherency. That paper was seen only as a
    search result.
* **Relevance (weakness 3):** *(interpretation)* Use this together with C15 to define leader
  metrics for LA's benchmark: leader length relative to font size, number of leaders, leader
  over marks, leader angle variety. The benchmark currently reports mostly counts and
  longest-leader percentiles (ADR placement/columns). Metrics are a precondition for tuning the trade-off
  of "more labels versus more long leaders".

### C19. Čmolík, Bittner 2010 — Layout-aware optimization for interactive labeling of 3D models
* **Citation:** Ladislav Čmolík, Jiří Bittner. Layout-aware optimization for interactive labeling
  of 3D models. *Computers & Graphics* 34(4):378–387, 2010.
* **DOI/URL:** **DOI not seen.** ScienceDirect PII S0097849310000695 —
  https://www.sciencedirect.com/science/article/abs/pii/S0097849310000695 ; author PDF
  https://dcgi.fel.cvut.cz/wp-content/wpallimport-dist/publications/pdf/publications-2010-cmolik-cag-label-paper.pdf
* **How found:** WebSearch "Čmolík Bittner Layout-aware optimization for interactive labeling of 3D
  models Computers & Graphics 2010", then "\"Layout-aware optimization for interactive labeling
  of 3D models\" doi 10.1016/j.cag.2010" (limited to sciencedirect.com, dblp.org, doi.org),
  2026-10-18.
* **Read:** abstract (search summary of the ScienceDirect page and the CTU page).
* **Status:** PARTIAL. Volume, issue, pages and the ScienceDirect PII were confirmed. **The DOI
  string was not shown in any result.** I do not give one.
* **Claims (abstract):**
  * Labeling 3D illustrations treated as **multi-criteria optimization** that takes the desired
    layout into account already **while searching for salient points** (anchor positions) of
    the labeled areas.
  * Fuzzy logic combined with greedy optimization. Runs on the GPU at interactive rates on
    medium-sized models. Reported as better than the interactive labeling techniques of the
    time.
* **Relevance (weakness 3):** *(interpretation)* The **leader start** is a decision variable. LA
  starts a leader on the item's true boundary toward the port. For **large marks** (weakness 3:
  leaders across large marks), choosing where the leader leaves the shape is part of the
  candidate. Allowing several start points per large shape, at any point of the boundary
  facing the label, before declaring a leader blocked, avoids the leader crossing its own or a
  neighbouring large mark.

### C20. Niedermann, Haunert 2019 — Focus+context map labeling with optimized clutter reduction
* **Citation:** Benjamin Niedermann, Jan-Henrik Haunert. Focus+context map labeling with optimized
  clutter reduction. *International Journal of Cartography* 5(2–3):158–177, 2019. Special issue
  of ICC 2019.
* **DOI/URL:** 10.1080/23729333.2019.1613072 (from the Bonn publication list) —
  https://www2.geoinfo.uni-bonn.de/html/publikationen/years/2019
* **How found:** WebSearch "Niedermann Haunert Focus+context map labeling with optimized clutter
  reduction International Journal of Cartography 2019", 2026-10-18.
* **Read:** abstract (search summary of the University of Bonn publication page).
* **Status:** PARTIAL. **All bibliographic data, including the DOI, come from the authors'
  institutional publication list.** No Taylor & Francis or DBLP page was seen.
* **Claims (abstract):**
  * On small screens, zooming reveals what labels hide but loses context.
  * The user can **displace the labels of a circular focus region**, implemented by
    **fish-eye projection** (focus+context map techniques).
  * Claimed to substantially improve the legibility of both the focus region and the displaced
    labels.
* **Relevance (weakness 1):** *(interpretation)* This is the interactive alternative for crowds,
  like C10 and C12. Given a focus circle from the host, LA could place labels of the crowd
  inside it at a displaced (fish-eye) layout. An API-level feature, not a change to the static
  solver.

---

## 6. Line charts and line features

### C21. Wolff, Knipping, van Kreveld, Strijk, Agarwal 2000/2001 — A simple and efficient algorithm for high-quality line labeling
* **Citation:** Alexander Wolff, Lars Knipping, Marc van Kreveld, Tycho Strijk, Pankaj K. Agarwal.
  A simple and efficient algorithm for high-quality line labeling. In: *Innovations in GIS VII:
  GeoComputation*, chapter 11, Taylor & Francis, pp. 147–159, 2000. Earlier version: GISRUK'99,
  pp. 146–150. Technical report UU-CS-2001-44, Utrecht University.
* **DOI/URL:** no DOI known. Report PDF https://dspace.library.uu.nl/bitstream/handle/1874/2561/2001-44.pdf ;
  Utrecht research portal https://research-portal.uu.nl/en/publications/a-simple-and-efficient-algorithm-for-high-quality-line-labeling-3/
* **How found:** WebSearch "Wolff Knipping van Kreveld Strijk Agarwal A simple and efficient
  algorithm for high-quality line labeling", 2026-10-18.
* **Read:** abstract (search summaries of the Utrecht portal and the chapter text).
* **Status:** PARTIAL. Authors and title were confirmed by the Utrecht repository. **The year
  differs between sources (book 2000, report 2001). The chapter pages come from the search
  summary only.** Two different complexity statements appeared (O(n²) in the repository
  abstract; O(nk + k log k) in the chapter text). I could not reconcile them and do not
  rely on either.
* **Claims (abstract):**
  * Labels polygonal chains (rivers, streets) with labels that may **curve along the line**,
    evaluated by curvature, number of inflections and distance between label and line.
  * Input: minimum label–line distance, maximum curvature, label height. A Java applet exists
    on the KIT site.
* **Relevance (weakness 6, minor):** *(interpretation)* For line charts, the *line itself* offers
  label positions besides its end: a horizontal or curved label on a flat stretch of the series,
  away from other series. LA's slider positions run along a mark's box, not along a polyline.
  Line-following candidates for series that miss the end column would label them in place,
  with no leader at all. directlabels has a related method: `angled.boxes`, which places a label
  at the curve point farthest from the borders and other curves (C22).

### C22. directlabels (R package, T. D. Hocking) — line-end label stacking
* **Citation:** Toby Dylan Hocking. *directlabels: Direct Labels for Multicolor Plots.* R package,
  version 2026.8.28, GPL-3. https://github.com/tdhock/directlabels
* **DOI/URL:** no DOI. GitHub repository (source read directly).
* **How found:** WebSearch "direct labeling line chart series labels at line ends algorithm paper
  label placement time series" (extended), 2026-10-18; then direct WebFetch of
  `raw.githubusercontent.com/tdhock/directlabels/master/{DESCRIPTION,R/utility.function.R,R/isoreg_dp.R,R/lineplot.R}`
  and `github.com/tdhock/directlabels/blob/master/NEWS`.
* **Read:** source code and NEWS file (GitHub).
* **Status:** VERIFIED (GitHub). No accompanying paper was found; the search budget ran out before
  a dedicated search for one.
* **What it does (from the code):**
  * `last.qp` / `first.qp` = `vertical.qp("last.points")` / `vertical.qp("first.points")`: labels
    at each series' last or first point, made non-overlapping vertically. `maxvar.qp`: "Label
    first or last points, whichever are more spread out", with the same non-overlap step.
    The `default.picker` comments name `maxvar.qp` as the default for line plots.
  * `qp.labels` (comment: "Use a QP solver to find the best places to put the points on a line,
    subject to the constraint that they should not overlap") now calls
    `aligned_labels_dp(target, half.size, lo, hi)`. That function subtracts the cumulative
    minimum spacing and runs **isotonic regression by dynamic programming** (`isoreg_dp`), then
    clips to the plot bounds. It is the same reduction that LA's `stack` uses (PAV). NEWS
    2026.8.27: "qp.labels positioning method now uses aligned_labels_dp() and isoreg_dp(),
    which is faster than previous quadprog::solve.QP()."
  * When the labels do not fit (`h.available < h.occupied`) `qp.labels` **shrinks the text**
    (`cex <- h.available / h.occupied * 0.9`) instead of dropping labels.
  * Other methods: `bumpup` (greedy sequential shift), `far.from.others.borders` and
    `angled.boxes` (label at the curve point maximizing the distance to borders and other
    curves), `empty.grid` (greedy grid search for scatterplots).
* **Relevance (weakness 6):** This confirms that LA's isotonic stacking of the fan and boundary
  columns is the established technique. It also points at two choices LA lacks:
  (a) **choose the end**: label the first points when the last points are more crowded
  (`maxvar.qp`), or split crowded series between both ends, a two-sided fan (see C3);
  (b) **shrink the column** before dropping members. LA's ladder shrinks single labels to
  0.85, but the fan column does not shrink as a whole. A column at 0.9–0.85 scale fits about 11–18 %
  more labels within the same `max_length` *(arithmetic: 1/0.9, 1/0.85)*.

### C23. ggrepel (R package, K. Slowikowski) — repulsion-based labels with segments
* **Citation:** Kamil Slowikowski. *ggrepel: Automatically Position Non-Overlapping Text Labels
  with 'ggplot2'.* R package. https://github.com/slowkow/ggrepel (already used as a benchmark
  baseline by LA, `docs/project/benchmark.md`).
* **DOI/URL:** no DOI. GitHub (source read directly).
* **How found:** WebFetch of `raw.githubusercontent.com/slowkow/ggrepel/master/R/geom-text-repel.R`
  and `.../vignettes/ggrepel.Rmd`, 2026-10-18. The examples page (ggrepel.slowkow.com) was not
  reachable, and the search budget had run out.
* **Read:** roxygen documentation in the source.
* **Status:** VERIFIED (GitHub) for the parameters quoted. The line-end example usage
  (`direction = "y"`, `xlim` to a strip beyond the data, `hjust = 0`) is **UNVERIFIED**: it is
  from memory of the examples page, which I could not open.
* **What it does (documentation):** "Text labels repel away from each other and away from the data
  points"; `direction` "both", "x" or "y"; `xlim`/`ylim` constrain labels to a strip;
  `max.overlaps` excludes a label that "overlap[s] too many other things" (default 10);
  `max.time` 0.5 s, `max.iter` 10000; `force` / `force_pull`; `hjust`/`vjust` "only control the
  initial positioning, so repulsive forces may disrupt alignment".
* **Relevance (weakness 6, minor):** *(interpretation)* The common recipe for line ends in
  ggplot2 is a *y-only* repulsion within an x-strip right of the data. That is a 1-D column like
  LA's, without hard guarantees. LA's exact column is already stronger. ggrepel's
  `max.overlaps` omission rule (count of overlaps) is a cheap early-omission test that LA's
  ladder could borrow to avoid generating ~1M boxes for labels that end up omitted (weakness 5).

---

## 7. Crossing-free leaders via minimum-length matching

### C24. The classical "uncrossing" argument (min-total-length matching is crossing-free)
* **Status:** **UNVERIFIED** (from memory; no source located before the search budget ran out).
* **Statement (from memory):** for straight leaders from points to fixed ports, any two crossing
  leaders can be swapped (each point takes the other's port), which strictly reduces the total
  length by the triangle inequality. Therefore a minimum-total-length assignment (a
  minimum-weight bipartite matching between sites and ports) has no crossings. I believe C1
  (Bekos et al. 2007) uses this argument for s-leaders, and that the general fact goes back to
  work on non-crossing Euclidean matchings. I did not verify either attribution. **Cite C1
  only after checking its full text.**
* **Relevance:** LA already relies on this: `hungarian` over the anchor-to-port distances for
  straight and `angles` leaders (`repair.rs` boundary columns; `fan.rs` keeps the anchors'
  order unless the matching is shorter). The argument only holds for straight leaders to
  collinear ports with nothing else in the way. It does **not** cover clearance from other
  marks, or po/opo leaders. *(interpretation)* That is why C2's DP over a general badness is
  the right tool when obstacles and `max_length` matter.

---

## Leads seen only as search-result titles (UNVERIFIED, not read)

These came up in search results while verifying the sources above. I did not see their
abstracts unless noted. Worth a follow-up once the search budget allows:

* Gedicke, Bonerath, Niedermann, Haunert (authors from memory): "Zoomless Maps: External Labeling
  Methods for the Interactive Exploration of Dense Point Sets at a Fixed Map Scale",
  arXiv:2008.13556 (I believe TVCG 2021 / VIS 2020). **Highly relevant to weakness 1.**
* "Multi-stack boundary labeling problems" (Bekos, Kaufmann, Potika, Symvonis — authors from
  memory), FSTTCS 2006, DOI shown in an ACM DL listing as 10.1007/11944836_10. **Relevant to
  multi-column fans.**
* Depian et al., "Constrained Boundary Labeling", arXiv:2402.12245; ScienceDirect pii
  S092577212500029X (CGTA 2025). A search summary says it cites Barth et al. for po leaders.
* "Temporally stable boundary labeling for interactive and non-interactive dynamic scenes",
  *Computers & Graphics*, pii S0097849320301230 (2020). **Relevant to weakness 4.**
* "(Faster) Multi-Sided Boundary Labelling" (Bose, Mehrabi, Mondal), arXiv:2002.09740.
* "Boundary Labeling in a Circular Orbit", arXiv:2403.19052; "Clarity and Computational Efficiency
  of Orbital Boundary Labeling", arXiv:2603.08657 (2026). Circular boundary, as in C9 and C10.
* "Boundary Labeling for Rectangular Diagrams", arXiv:1803.10812.
* "Label placement for outliers in scatterplots" (Univ. Duisburg-Essen vis group page).
* "Mixture of Cluster-guided Experts for Retrieval-Augmented Label Placement", IEEE VIS 2025.
* "Labels on Levels: Labeling of Multi-Scale Multi-Instance and Crowded 3D Biological
  Environments", TVCG, DOI 10.1109/TVCG.2018.2864491 (DOI from a result link).
* "Legible Label Layout for Data Visualization, Algorithm and Integration into Vega-Lite",
  arXiv:2405.10953. A search summary says it labels line ends with candidates top-right, right
  and bottom-right of each line's rightmost point, greedily over an occupancy bitmap. It
  extends the Kittivorawong et al. work that LA already cites.
* "On the selection of 2D objects using external labeling", CHI 2014, DOI 10.1145/2556288.2557288
  (DOI from an ACM DL result link).
* The brief's "Heinsohn? 'Labels in scatterplots'": not found.

---

## Synthesis: improvement ideas for Label Anything (ranked)

1. **Build each column as one optimization, not stack-then-evict (weaknesses 6, 1). Sources: C2,
   C1, C22, C24.** Today: PAV stacking, then labels whose leader exceeds `max_length` fail, and
   members leave one at a time. Instead, give each member a hard vertical window
   `|y_i − d_i| ≤ sqrt(L_max² − run²)` and a priority weight. Choose the subset and the slots
   in one pass:
   * Isotonic regression with per-item box constraints is still a small convex QP. *(My
     belief, to be checked:)* after making the bounds monotone (running maximum of the lower
     bounds, running minimum of the upper bounds), clamping the PAV result gives the optimum.
   * Selecting a subset is a 1-D DP over the anchors in order, with state = top of the last
     slot. This is in the spirit of the badness DP of C2.
   * Also scan a few `run` values (column distance). A longer run increases the window but
     uses up length.

   This removes the iterative repair, and it is exact for the 1-D problem.
2. **Multi-column and two-sided fans for line ends (weakness 6). Sources: C7 (multiple stacks),
   C3 and C2 (two or more sides), C22 (`first.qp` / `maxvar.qp`), lead "multi-stack boundary
   labeling".** When one column is full within `max_length`:
   * open a second column further out (leaders pass between the first column's labels, or the
     first column narrows); or
   * label the series' **first** points on the left (directlabels picks the end that is more
     spread out); or
   * split the crowd between both ends by a joint assignment.
3. **Contour/radial labeling for 2D crowds (weaknesses 1, 3). Sources: C9, C10, C12, C13.** Fans
   fail for 2D scatter crowds (ADR placement/columns). Put labels on an offset contour around the crowd's
   hull, ordered by angle. Straight radial leaders in angular order are crossing-free, and
   their lengths are bounded by the crowd's size. When there are more members than slots,
   select by priority, or emit one cluster label ("+N"; C10, C13).
4. **Density-gradient distant candidates with curved leaders (weaknesses 3, 1, 5). Source:
   C14.** Use the existing coverage grids and SATs as a density field. Descend from each anchor
   to the first free spot and use the path as a `curved` leader. This finds low-density room
   with few evaluations, does not cross large or dense marks by construction, and replaces part
   of the 4×16 ring sampling and the ladder's box flood.
5. **Route around large marks before rejecting (weakness 3). Sources: C4 (mixing leader types
   restores feasibility), C10 (Bézier leaders), C19 (leader start as a variable), C14.** For a
   good candidate whose straight leader hits a large mark: try other start points on the
   shape's boundary, then a po or do leader, then a Bézier detour. Do this per label, even when
   `leaders.style` is `straight`, if a "mixed" option is set. Only then reject or penalize.
6. **Global leader budget and clutter metrics (weakness 3). Sources: C15, C18 (and C8 for the
   leader shape).** Add a scene-level cost or limit on the number and total length of leaders,
   so that an 8–11 em leader competes with omission or an adjacent label. Report leader
   metrics such as confusion, visual connection and intersection in the benchmark.
7. **Leader shape defaults by readability evidence (weakness 3). Source: C8.** L-shaped (po)
   leaders are the recommended compromise. S-shaped (opo) leaders are not recommended, but
   they are LA's boundary-leader shape under the `orthogonal` style. Switch boundary and fan
   columns to po for that style; C1 and C2 have algorithms for po.
8. **Stable columns across frames and many-to-one labels (weaknesses 4, 1). Sources: C7, C17,
   C11 (stability); C5, C6 (many-to-one).**
   * Keep the previous frame's column membership, order and side unless infeasible. This
     targets the +4–5 % flips that fans caused.
   * Offer backbone or hyperleaders for crowded items that share a label (groups or
     categories): one label and one leader instead of k.
