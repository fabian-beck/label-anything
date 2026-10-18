# B — Dynamic, interactive and temporally coherent labeling (weakness 4)

Agent notes, 2026-10-18. Topic: consistency of labels across frames, zoom, rotation, moving
points; real-time labeling in graphics/AR; zoomless/multi-page maps; selection by scale;
practice in web map engines.

## How this search was done (read first)

* **Access limits.** WebFetch could not resolve dblp.org, doi.org, arxiv.org, ieeexplore,
  docs.mapbox.com, wikipedia, KIT/NYU/TUM hosts (ENOTFOUND). curl from the shell is blocked
  by the egress proxy (403). Only **WebSearch** worked, plus WebFetch on **github.com /
  raw.githubusercontent.com**. So no paper PDF or publisher page was opened directly.
* **Search budget.** The shared WebSearch budget (200 calls per turn, all agents) ran out
  after about 45 of my queries. Some planned checks were not done. They are listed under
  "Unverified leads" at the end.
* **Status legend used here** (the brief's VERIFIED level could not be reached for papers):
  * **VERIFIED-SEARCH**: bibliographic data (authors, title, venue, vol/pages, DOI) shown by
    search results whose URL is a DBLP, publisher, DOI, Dagstuhl, ACM/IEEE (via Unpaywall),
    OpenAlex/Crossref or institutional repository record, where the result content
    states those data. The page itself was not opened. Any field confirmed only by a
    secondary source is flagged.
  * **PARTIAL**: some fields (named) are unconfirmed or come from secondary sources only.
  * **UNVERIFIED**: from memory. Used only in the clearly marked leads section and in
    sentences marked "(my recollection, unverified)".
  * **READ-FULL (code/wiki)**: web-engine source code and wiki pages fetched in full from
    GitHub.
* "What I read" is almost always **"search-result summary/abstract excerpt"**. Bullets on
  content report only what those summaries said. My own interpretation is marked
  *[interpretation]*.

## What the engine already does (from the repo, read-only, so the ideas below are new)

* ADR 0016/0025: warm start from the previous result, with boxes moved by their anchor's
  movement. A stability cost `w·(min(1,d/em) + min(1,max(0,d/em−1)/4))` (ADR 0027) uses
  distance only and has no notion of *side*. Degraded labels keep their box.
* ADR 0027: nudges of a blocked warm box along the slider path (0.05–0.8 em); kept leaders.
* ADR 0026: `LabelMotion` in `@label-anything/extras` uses a critically damped spring plus
  linear fades (T = 300 ms). **Engine-side hysteresis was rejected** because it "either
  breaks strict priority or overlaps labels".
* Scenario 11 (`bench/scenarios/11-stability/build.py`) has zoom 1 → 8 in 19 geometric steps
  (≈ ×1.116 per step), then pan. It has no zoom-out steps and no round trips.
  `bench/eval/stability.py` measures displacement, flips, added/removed, and nesting on
  zoom-in steps.
* ADR 0025 table: zoom-pan-1000 warm start gives 3.01 px, 11.6 % flips. zoom-pan-3000 gives
  3.81 px, 15.5 % flips.

---

## Sources

### S1. Been, Daiches, Yap 2006: Dynamic Map Labeling
* **Citation:** Ken Been, Eli Daiches, Chee-Keng Yap. Dynamic Map Labeling. *IEEE Trans.
  Vis. Comput. Graph.* 12(5):773–780, 2006 (InfoVis 2006).
* **DOI:** 10.1109/TVCG.2006.136. The DOI comes from a citing paper's reference list
  (arXiv 2202.11562) in a search summary and was not seen on IEEE/DBLP. DBLP key
  journals/tvcg/BeenDY06, https://dblp.org/rec/journals/tvcg/BeenDY06.
* **How found:** WebSearch "Been Daiches Yap 2006 "Dynamic map labeling" IEEE TVCG" and
  "dblp Been Daiches Yap Dynamic Map Labeling IEEE Trans. Vis. Comput. Graph. 12(5) 2006"
  (restricted to dblp.org), 2026-10-18.
* **Read:** search-result summaries (abstract-level). The author PDF at
  cs.nyu.edu/visual/home/pub/infovis06.pdf was found but could not be opened.
* **Status:** VERIFIED-SEARCH for authors/venue/vol/pages (DBLP record in the result). DOI
  PARTIAL (secondary source only).
* **Claims (from summaries):**
  * Dynamic labeling has two goals: avoid label popping and other artifacts that confuse
    and interrupt navigation, and label at interactive speed.
  * It introduces a set of desiderata for "consistent" dynamic map labeling. The Mapbox
    blog (S25) paraphrases them as: labels do not pop in/out while zooming or panning, do
    not jump, and are placed deterministically whatever path the user took to the view.
    That paraphrase is secondary. That labels vanish only when zooming out and appear
    only when zooming in (monotonicity) is my recollection, unverified.
  * It moves all selection and placement decisions into preprocessing, so display only
    filters. The model gives each label an "active range" of scales (as used by S2).
  * It defines a class of "invariant point placements" as the simple solvable case and
    proves NP-completeness of the simple problem version. The method is implemented in
    G-Vis (a full-detail dynamic map of the continental USA).
* **Relevance:** weakness 4 (flips at zoom, nesting) and indirectly 5 (per-frame time).
  Label Anything's warm start makes results **path-dependent**: the same view reached by
  two camera paths gives two labelings, which breaks the determinism desideratum. A
  precomputed scale-space selection (Idea 1) is history-independent by construction and
  makes each frame a filter.

### S2. Been, Nöllenburg, Poon, Wolff 2010: Optimizing active ranges for consistent dynamic map labeling
* **Citation:** Ken Been, Martin Nöllenburg, Sheung-Hung Poon, Alexander Wolff. Optimizing
  active ranges for consistent dynamic map labeling. *Computational Geometry: Theory and
  Applications* 43(3):312–328, 2010. Earlier versions: SoCG 2008, pp. 10–19. EuroCG 2008
  (Nancy), pp. 55–58.
* **DOI:** not seen in any result, so unknown here.
* **How found:** WebSearch "Been Nöllenburg Poon Wolff "Optimizing active ranges for
  consistent dynamic map labeling" Computational Geometry", 2026-10-18.
* **Read:** search summaries of the TU/e research portal, Nottingham repository, KIT library
  and the KIT-hosted PDF (i11www.iti.kit.edu/extra/publications/bnpw-oarcd-08.pdf, not
  opened).
* **Status:** PARTIAL. Vol/issue/pages come from the TU/e portal record. The DOI is
  unconfirmed.
* **Claims:**
  * Each label is modeled as a 3D solid with scale as the third dimension. The task is to
    choose non-overlapping active scale intervals that maximize the total "height" (the
    sum of active range lengths).
  * 2D active-range optimization (ARO) and general 1D ARO are NP-complete.
  * The simple 1D variant has an optimal dynamic program. Several variants have
    constant-factor approximations.
* **Relevance:** weakness 4 (nesting, flips). This is the formal objective for Idea 1:
  maximize Σ (length of zoom interval in which item i is labeled) over consistent
  intervals. *[interpretation]* For screen-size labels with fixed screen offsets, two
  candidate boxes overlap on a single interval of zoom. Anchor separation is linear in
  zoom, so each axis condition gives one interval and their intersection is one interval.
  The conflict graph of (candidate, zoom-interval) pairs can therefore be built once,
  exactly, with the existing vector geometry.

### S3. Liao, Liang, Poon 2016: Approximation algorithms on consistent dynamic map labeling
* **Citation:** Chung-Shou Liao, Chih-Wei Liang, Sheung-Hung Poon. Approximation algorithms
  on consistent dynamic map labeling. *Theoretical Computer Science* 640:84–93, 2016.
  Conference version: FAW 2014, LNCS 8497, pp. 170–181.
* **DOI:** not seen, unknown.
* **How found:** WebSearch "Liao Liang Poon "Approximation algorithms on consistent dynamic
  map labeling" Theoretical Computer Science", 2026-10-18.
* **Read:** search summary of the University of Nottingham Ningbo research portal record.
* **Status:** PARTIAL (vol/pages from an institutional record; no DOI).
* **Claims:**
  * Studies active range optimization, where labels stay consistent across map scales.
  * For unit-width rectangular labels: a 3c·log n approximation, given a c-approximation
    for static unit-width placement. For arbitrary rectangles: a randomized
    O(log n log log n) approximation.
  * The general version is NP-complete even for congruent squares. It gives
    12-approximations (arbitrary squares, unit-width rectangles) and a 6-approximation
    for congruent squares, with tight bounds.
* **Relevance:** shows that ARO approximations can sit on top of a good *static* placer,
  which Label Anything is. *[interpretation]* A practical scheme: run the static solver at
  discrete zoom levels and combine the results into consistent active ranges (Idea 1).

### S4. Gemsa, Nöllenburg, Rutter 2016: Consistent labeling of rotating maps
* **Citation:** Andreas Gemsa, Martin Nöllenburg, Ignaz Rutter. Consistent Labeling of
  Rotating Maps. *Journal of Computational Geometry* 7(1):308–331, 2016. arXiv:1104.5634.
  Earlier version: EuroCG 2011.
* **DOI:** 10.20382/jocg.v7i1a15. DOAJ, the TU Wien repository and the KIT library agree,
  per the search summary.
* **How found:** WebSearch "Gemsa Nöllenburg Rutter "Consistent labeling of rotating maps"
  Journal of Computational Geometry 2016 doi", 2026-10-18.
* **Read:** search summaries (abstract-level).
* **Status:** VERIFIED-SEARCH.
* **Claims:**
  * The map rotates and labels stay horizontal. Choose **one active interval of rotation
    angles per label** so that visible labels never overlap each other or cover points.
  * NP-hard. 1/4-approximation; EPTAS for unit-height labels.
* **Relevance:** weakness 4. "One active interval per label" is the same kind of
  consistency as nesting across zoom: a label appears and disappears at most once along
  the view parameter. It fits hosts that rotate (MapLibre bearing). Idea 1 generalizes to
  a rotation parameter.

### S5. Gemsa, Nöllenburg, Rutter 2016: Evaluation of labeling strategies for rotating maps
* **Citation:** Andreas Gemsa, Martin Nöllenburg, Ignaz Rutter. Evaluation of Labeling
  Strategies for Rotating Maps. *ACM Journal of Experimental Algorithmics* 21(1), Article
  1.4, pp. 1–21, 2016. arXiv:1404.1849. Conference version SEA 2014, LNCS (Springer chapter
  10.1007/978-3-319-07959-2_20, seen as a link.springer.com result URL with this title).
  **Correction to the brief:** the author list in the search results is Gemsa, Nöllenburg,
  Rutter, not "Gemsa, Haunert, Nöllenburg".
* **DOI:** 10.1145/2851493 (OpenAlex and Crossref result URLs).
* **How found:** WebSearch "Gemsa Haunert Nöllenburg "Evaluation of labeling strategies for
  rotating maps" ACM Journal of Experimental Algorithmics doi", 2026-10-18.
* **Read:** search summary of the abstract.
* **Status:** VERIFIED-SEARCH (DOI, vol, article number). The SEA DOI was seen as a URL
  only.
* **Claims:**
  * Three new heuristics are compared with an existing approximation algorithm and exact
    ILP solutions.
  * **Consistency constraints greatly reduce flickering at only a small drop in the
    objective.**
  * The heuristics reach high quality much faster than the other methods.
* **Relevance:** the main empirical argument for making consistency a constraint rather
  than a weak cost (Ideas 1, 2). *[interpretation]* Benchmark: count "flicker" (label
  on→off→on within a window) per label, as these evaluations do. Today's
  `added`/`removed` counts don't separate a single change from flicker. ADR 0026 notes
  that half the appearances last one or two solves.

### S6. Gemsa, Niedermann, Nöllenburg 2013: Trajectory-based dynamic map labeling
* **Citation:** Andreas Gemsa, Benjamin Niedermann, Martin Nöllenburg. Trajectory-Based
  Dynamic Map Labeling. In *Proc. 24th ISAAC 2013*, LNCS 8283, pp. 413–423. Springer, 2013.
  Extended version arXiv:1309.3963 (19 pp.).
* **DOI:** the Springer DOI was not found. arXiv DOI 10.48550/arXiv.1309.3963.
* **How found:** WebSearch "Gemsa Niedermann Nöllenburg "Trajectory-based dynamic map
  labeling" ISAAC 2013 LNCS doi", 2026-10-18.
* **Read:** search summary (DBLP person page and KIT project page cited for venue/pages)
  and the abstract.
* **Status:** PARTIAL (venue/pages from DBLP and project-page snippets; Springer DOI
  unknown).
* **Claims:**
  * The viewport follows a known movement path (trajectory). The task is to maximize the
    active ranges of labels along it.
  * Active-range maximization is NP-complete and W[1]-hard. It is polynomial when at most
    k labels may be active at once.
  * Gives a practical ILP formulation and approximation algorithms.
* **Relevance:** Idea 6 (offline sequence mode). When the camera path or the animation is
  known in advance (exported animations, scripted tours, Gapminder play-through), solving
  the whole sequence jointly beats frame-by-frame warm start.

### S7. de Berg, Gerrits 2013: Labeling moving points with a trade-off between label speed and label overlap
* **Citation:** Mark de Berg, Dirk H. P. Gerrits. Labeling moving points with a trade-off
  between label speed and label overlap. In *Proc. 21st ESA 2013* (H. Bodlaender,
  G. Italiano, eds.), LNCS 8125, pp. 373–384. Springer, 2013.
* **DOI:** unknown (not in any result).
* **How found:** WebSearch "de Berg Gerrits "Labeling moving points with a trade-off between
  label speed and label overlap" ESA 2013", plus a follow-up on dblp/springer domains,
  2026-10-18.
* **Read:** secondary only: reference lists in search results (a 2014 chapter, Gerrits's
  publications page), a LinkedIn abstract excerpt, and the related-work summary in
  Barth et al.'s Algorithmica paper (S10).
* **Status:** PARTIAL (bibliographic data from reference lists only; no DBLP/publisher page
  seen; DOI unknown).
* **Claims (secondary):**
  * Motivated by air-traffic control: controllers watch screens with airplanes as moving
    points, and labels must stay readable without distracting motion.
  * Presents an efficient heuristic that trades label speed against label overlap. Per
    Barth et al., it is "a sophisticated heuristic for finding a reasonable trade-off
    between label speed and label overlap".
  * Gerrits's TU/e PhD thesis (2013, "Pushing and Pulling: … dynamic labelings for moving
    points", ipa.win.tue.nl/?p=716) covers this line of work (title only seen).
* **Relevance:** Idea 4. Make **label speed** an explicit quantity, e.g. offset change ≤
  v_max em per solve, hard or soft. Today the stability term penalizes distance but
  allows any jump when the warm box is blocked. ADR 0026's spring smooths only the drawing,
  and it can show 33 px glides.

### S8. de Berg, Gerrits 2012: Approximation algorithms for free-label maximization
* **Citation:** Mark de Berg, Dirk Gerrits. Approximation algorithms for free-label
  maximization. *Computational Geometry: Theory and Applications* 45(4):153–168, 2012.
  Conference version SWAT 2010.
* **DOI:** 10.1016/j.comgeo.2011.10.004 (from a Scipedia record only).
* **How found:** WebSearch "de Berg Gerrits "Approximation algorithms for free-label
  maximization" Computational Geometry 2012 doi", 2026-10-18.
* **Read:** search summary (abstract sentence).
* **Status:** PARTIAL (DOI and pages from Scipedia; not confirmed on Elsevier/DBLP).
* **Claims:**
  * Static problem: every point gets a unit-square label, and the number of **free**
    (non-overlapped) labels is maximized.
  * Constant-factor approximations and PTASs for several label models.
* **Relevance:** the objective behind S7's dynamic heuristic. *[interpretation]* It offers a
  principled "soft" mode for transitions in Label Anything. During a short transient, a
  label may overlap (not be free) instead of jumping or vanishing. The engine's existing
  `soft_overlap` ladder rung is a static cousin.

### S9. Buchin, Gerrits 2013: Dynamic point labeling is strongly PSPACE-complete
* **Citation:** Kevin Buchin, Dirk H. P. Gerrits. Dynamic Point Labeling is Strongly
  PSPACE-Complete. In *Proc. 24th ISAAC 2013*, LNCS 8283, pp. 262–272. Springer. Also
  EuroCG 2013, pp. 241–244. A journal version in IJCGA is listed as "to appear" on
  Gerrits's page; no volume/year found.
* **DOI:** unknown.
* **How found:** WebSearch "Buchin Gerrits "Dynamic point labeling is strongly
  PSPACE-complete" ISAAC 2013 International Journal of Computational Geometry", 2026-10-18.
* **Read:** search summary of the Springer chapter listing (springerprofessional.de) with
  the abstract, plus Gerrits's publication page.
* **Status:** PARTIAL (pages from the author's page; DOI and journal version unconfirmed).
* **Claims:**
  * Deciding whether a **smooth** dynamic labeling (a function from time to static
    labelings) exists is strongly PSPACE-complete when points move, when points are added
    and removed, or when the user pans, rotates and/or zooms.
* **Relevance:** a theory limit for Ideas 1, 4 and 6. A guarantee of "never jump, never
  pop" for arbitrary interaction is intractable. Keep temporal coherence as soft costs,
  bounded heuristics, or precomputation for restricted settings (screen-size labels under
  zoom, Idea 1). Don't promise it as a hard guarantee.

### S10. Barth, Niedermann, Nöllenburg, Strash 2016: Temporal map labeling: a new unified framework with experiments
* **Citation:** Lukas Barth, Benjamin Niedermann, Martin Nöllenburg, Darren Strash.
  Temporal Map Labeling: A New Unified Framework with Experiments. In *Proc. 24th ACM
  SIGSPATIAL GIS 2016*, Article 23. arXiv:1609.06327. Journal follow-up seen as a result
  URL: "A Unified Model and Algorithms for Temporal Map Labeling", *Algorithmica*,
  https://link.springer.com/article/10.1007/s00453-020-00694-7. Its authors, volume and
  pages were not confirmed.
* **DOI:** 10.1145/2996913.2996957 (KIT library record and ACM landing page via Unpaywall
  agree). Algorithmica: 10.1007/s00453-020-00694-7 (URL only).
* **How found:** WebSearch "Barth Niedermann Nöllenburg Strash "Temporal map labeling: a new
  unified framework with experiments" SIGSPATIAL 2016 doi", 2026-10-18.
* **Read:** search summaries only. They gave bibliographic data and the related-work
  statements quoted in S2/S7.
* **Status:** VERIFIED-SEARCH for the SIGSPATIAL paper. PARTIAL for the Algorithmica
  version.
* **Claims (very limited, from summaries):** a unified model for temporal (time-dependent)
  map labeling covering earlier zooming, rotating and trajectory models, with experiments.
  It credits Been et al. with the active-range model and summarizes de Berg & Gerrits (S7).
  *(My recollection, unverified: ILP and heuristic solutions, with labels limited in how
  often they may appear.)*
* **Relevance:** Idea 6 (sequence mode) and the benchmark: a common model in which
  "label visible over a time interval" is the decision variable.

### S11. Depian, Li, Nöllenburg, Wulms 2023: Transitions in Dynamic Point Labeling
* **Citation:** Thomas Depian, Guangping Li, Martin Nöllenburg, Jules Wulms. Transitions in
  Dynamic Point Labeling. In *Proc. 12th GIScience 2023*, LIPIcs 277, pp. 2:1–2:19. Schloss
  Dagstuhl, 2023. arXiv:2202.11562 (v1 Feb 2022, v3 2026). Per the v3 note in the search
  summary, a journal version appeared in *Cartography and Geographic Information Science*,
  DOI 10.1080/15230406.2025.2555426 (not confirmed independently).
* **DOI:** 10.4230/LIPIcs.GIScience.2023.2.
* **How found:** WebSearch "Depian Li Nöllenburg Wulms "Transitions in Dynamic Point
  Labeling" GIScience 2022 LIPIcs doi". It first surfaced in the Been et al. DBLP query.
  2026-10-18.
* **Read:** search summary of the Dagstuhl/arXiv records (abstract-level).
* **Status:** VERIFIED-SEARCH (LIPIcs). Journal version PARTIAL.
* **Claims:**
  * Studies **transitions (morphs)** that show how a point labeling changes between two
    states over time.
  * Gives bounds on the overlaps that occur during transitions.
  * A weighted penalty variant is NP-complete. A prototype was evaluated.
* **Relevance:** Idea 5. ADR 0026's `LabelMotion` glides and fades without checking
  overlap during the glide, and admits that "a label fading out may overlap the label that
  took its place for up to T". The engine could plan transitions: choose slide vs.
  fade-out/fade-in per label so that interpolated boxes don't collide, and report the
  plan in the result.

### S12. Bhore, Li, Nöllenburg 2020/2022: An algorithmic study of fully dynamic independent sets for map labeling
* **Citation:** Sujoy Bhore, Guangping Li, Martin Nöllenburg. An Algorithmic Study of Fully
  Dynamic Independent Sets for Map Labeling. In *Proc. 28th ESA 2020*, LIPIcs 173,
  pp. 19:1–19:24. Journal version: *ACM Journal of Experimental Algorithmics* 27, Article
  1.8, pp. 1–36, 2022. arXiv:2002.07611.
* **DOI:** 10.4230/LIPIcs.ESA.2020.19 and 10.1145/3514240.
* **How found:** WebSearch "Bhore Li Nöllenburg "An algorithmic study of fully dynamic
  independent sets for map labeling" ESA 2020 Journal of Experimental Algorithmics doi".
  It first surfaced in the Liao et al. query. 2026-10-18.
* **Read:** search summary of the Dagstuhl BibTeX record and the TU Wien repositum record
  (abstract-level).
* **Status:** VERIFIED-SEARCH.
* **Claims:**
  * Maximal and maximum independent set for dynamic sets of axis-parallel rectangles
    (uniform squares; uniform height with arbitrary width), under insertions and
    deletions.
  * A deterministic algorithm maintains a maximal independent set of uniform rectangles
    with polylogarithmic update time (claimed first of its kind). Experiments are in the
    JEA version.
* **Relevance:** Idea 3 (incremental repair). Each new frame need not be re-solved from
  scratch with warm-start bias. Keep the previous independent set and repair only around
  changed items. Untouched labels then have zero displacement by construction, and
  per-frame work scales with the change (weakness 5).

### S13. Krumpe 2018: Labeling points of interest in dynamic maps using disk labels
* **Citation:** Filip Krumpe. Labeling Points of Interest in Dynamic Maps using Disk Labels.
  In *Proc. 10th GIScience 2018*, LIPIcs 114, pp. 8:1–8:14. Schloss Dagstuhl, 2018.
  **Correction to the brief:** the Dagstuhl record lists a single author (Filip Krumpe,
  Univ. Stuttgart), not Gedicke et al.
* **DOI:** 10.4230/LIPIcs.GISCIENCE.2018.8.
* **How found:** WebSearch "Gedicke Niedermann Haunert "Labeling points of interest in
  dynamic maps using disk labels" GIScience 2018 LIPIcs", 2026-10-18.
* **Read:** search summary of the Dagstuhl record (abstract).
* **Status:** VERIFIED-SEARCH.
* **Claims:**
  * Labels maps at interactive speed. For any possible map rotation the labeling is free of
    label–label intersections (disk-shaped labels make rotation irrelevant).
  * Computes, for each label, **the map scale at which it is removed**. At presentation
    time the precomputed set is only filtered, which is very fast.
  * About 11 million labels are labeled in under 20 minutes.
* **Relevance:** Idea 1. It shows the "elimination scale per label, filter per frame"
  architecture scales to millions of labels. For Label Anything, a per-item
  `min_zoom`/`max_zoom` (plus a fixed candidate) computed once would make zoom frames
  nested and flip-free, and nearly free in time.

### S14. Gedicke, Bonerath, Niedermann, Haunert 2021: Zoomless Maps
* **Citation:** Sven Gedicke, Annika Bonerath, Benjamin Niedermann, Jan-Henrik Haunert.
  Zoomless Maps: External Labeling Methods for the Interactive Exploration of Dense Point
  Sets at a Fixed Map Scale. *IEEE Trans. Vis. Comput. Graph.* 27(2):1247–1256, 2021
  (VIS 2020). arXiv:2008.13556.
* **DOI:** 10.1109/TVCG.2020.3030399 (OpenAlex record URL in the results).
* **How found:** WebSearch "Gedicke Bonerath Niedermann Haunert "Zoomless maps: …" TVCG 2021
  doi", ""Zoomless Maps" Gedicke Jabrayilov … 1247-1256", "dblp Sven Gedicke Zoomless Maps
  multi-page maps" (dblp domains), 2026-10-18.
* **Read:** search summaries (abstract; DFG GEPRIS final report).
* **Status:** VERIFIED-SEARCH for venue/vol/pages/DOI. **Author list caveat:** the
  DBLP-based result and the arXiv preprint give Gedicke, Bonerath, Niedermann, Haunert. One
  GEPRIS summary attributed the TVCG paper to Gedicke, Jabrayilov, Niedermann, Mutzel,
  Haunert. I take DBLP/arXiv as correct; it matches the brief.
* **Claims:**
  * The map extent and scale stay fixed. Labels sit at the map boundary, joined to their
    features by leaders, and at any time only a subset is labeled.
  * Three interaction methods: **multi-page**, **sliding** (slide labels along the bottom
    side) and **stacking** boundary labeling.
  * DFG report: most problems are NP-hard; ILP and heuristic approaches.
* **Relevance:** weaknesses 1 and 4. Instead of zooming, which causes churn, Label Anything's
  boundary columns could offer *pages/stacks* of labels for omitted items at a fixed view
  (Idea 8).

### S15. Gedicke, Jabrayilov, Niedermann, Mutzel, Haunert 2021: Point feature label placement for multi-page maps on small-screen devices
* **Citation:** Sven Gedicke, Adalat Jabrayilov, Benjamin Niedermann, Petra Mutzel,
  Jan-Henrik Haunert. Point feature label placement for multi-page maps on small-screen
  devices. *Computers & Graphics* 100:66–80, 2021. Earlier: Gedicke, Niedermann, Haunert,
  "Multi-page Labeling of Small-screen Maps with a Graph-coloring Approach", *Advances in
  Cartography and GIScience of the ICA* 2:4, 2019.
* **DOI:** 10.1016/j.cag.2021.07.019 (www.doi.org result URL).
* **How found:** WebSearch "Gedicke Jabrayilov Niedermann Mutzel Haunert "Point feature label
  placement for multi-page maps on small-screen devices" Computers & Graphics doi" and the
  dblp-domain query in S14, 2026-10-18.
* **Read:** search summaries (journal highlights/abstract).
* **Status:** VERIFIED-SEARCH for venue/vol/pages/DOI. The author list comes from the
  DBLP-based result; one GEPRIS summary gave only Gedicke, Niedermann, Haunert.
* **Claims:**
  * Two phases: labels are assigned to **pages offline by mathematical programming**;
    labels for the current extent and page are retrieved interactively.
  * The user navigates page to page and retrieves many labels without zooming.
  * **The labeling stays temporally consistent when the user pans.**
* **Relevance:** Idea 8 and weakness 1. Also Idea 1: offline assignment plus interactive
  retrieval is the same precompute-then-filter pattern as active ranges.

### S16. Vaaraniemi, Treib, Westermann 2012: Temporally coherent real-time labeling of dynamic scenes
* **Citation:** Mikael Vaaraniemi, Marc Treib, Rüdiger Westermann. Temporally Coherent
  Real-Time Labeling of Dynamic Scenes. In *Proc. 3rd Int. Conf. on Computing for
  Geospatial Research and Applications (COM.Geo 2012)*. Pages not seen.
* **DOI:** unknown (not shown; probably ACM ICPS, unconfirmed).
* **How found:** WebSearch "Vaaraniemi Treib Westermann "Temporally coherent real-time
  labeling of dynamic scenes" COM.Geo 2012 doi", 2026-10-18.
* **Read:** search summary of the TUM CG publication page and PDF abstract
  (cs.cit.tum.de/…/2012_Vaaraniemi_Temporally_Coherent_Real-Time_Labeling_of_Dynamic_Scenes.pdf).
* **Status:** PARTIAL (authors/venue from the TUM group page; DOI and pages unknown).
* **Claims:**
  * A **force-based** labeling algorithm for 2D and 3D scenes, run in parallel on the GPU,
    aimed at temporal coherence.
* **Relevance:** continuous (force) relaxation moves labels smoothly by design, unlike
  discrete candidate switching. *[interpretation]* For Label Anything, use a short
  force/relaxation step on the *continuous slider parameter* between solves (labels slide
  along their mark instead of switching candidate). It would plug into the existing nudge
  mechanism (ADR 0027) as a first stage.

### S17. Mote 2007/2008: Fast point-feature label placement for dynamic visualizations
* **Citation:** Kevin D. Mote. Fast point-feature label placement for dynamic
  visualizations. *Information Visualization* 6(4):249–260. The year is given as 2007 or
  2008: PNNL lists 21 Jan 2008. Also the WSU MS thesis (2007), arXiv:1209.5765 and
  1209.5766.
* **DOI:** 10.1057/palgrave.ivs.9500163.
* **How found:** WebSearch "Mote 2007 "Fast point-feature label placement for dynamic
  visualizations" Information Visualization doi 10.1057", 2026-10-18.
* **Read:** search summary of the PNNL/OSTI records (abstract).
* **Status:** PARTIAL (DOI, vol/issue/pages via PNNL/OSTI records; year ambiguous).
* **Claims:**
  * Real-time labeling of point features on dynamic maps **without preprocessing**.
  * Core technique: a **"trellis" strategy** (spatial partitioning) plus a candidate cost
    analysis to find the least expensive configuration.
* **Relevance:** mostly weakness 5 (per-frame speed). It is the "no precompute" opposite of
  S1/S13 and a useful baseline for an interactive benchmark.

### S18. Maass, Döllner 2006: Efficient view management for dynamic annotation placement in virtual landscapes
* **Citation:** Stefan Maass, Jürgen Döllner. Efficient View Management for Dynamic
  Annotation Placement in Virtual Landscapes. In *Smart Graphics (SG 2006)*, LNCS 4073,
  pp. 1–12. Springer, 2006. Related: Maass & Döllner, "Dynamic Annotation of Interactive
  Environments using Object-Integrated Billboards", WSCG 2006 Full Papers, pp. 327–334.
* **DOI:** 10.1007/11795018_1. A Crossref API URL for this DOI appeared among the results,
  and the summary said Springer/Crossref entries confirm the metadata. The record was not
  opened.
* **How found:** WebSearch "Maass Döllner "Efficient view management for dynamic annotation
  placement in virtual landscapes" Smart Graphics 2006", 2026-10-18.
* **Read:** search summary (abstract).
* **Status:** VERIFIED-SEARCH (with the DOI caveat above).
* **Claims:**
  * Real-time placement for annotations in 3D landscapes, based on view management.
    External annotations are handled as 2.5D objects shifted in the view plane to
    available space.
  * Places labels without occlusion where possible; otherwise favors annotations close to
    the observer.
  * A single parameter trades placement quality against processing time.
* **Relevance:** an explicit quality/time knob per frame (the engine already uses
  iteration budgets). Priority by distance to the viewer is the 3D analogue of a
  zoom-dependent priority.

### S19. Čmolík, Bittner 2010: Layout-aware optimization for interactive labeling of 3D models
* **Citation:** Ladislav Čmolík, Jiří Bittner. Layout-aware optimization for interactive
  labeling of 3D models. *Computers & Graphics* 34(4):378–387, 2010.
* **DOI:** 10.1016/j.cag.2010.05.002. It was rebuilt from a truncated fragment
  ("016/j.cag.2010.05.002") in the search result. Treat it as PARTIAL.
* **How found:** WebSearch "Čmolík Bittner "Layout-aware optimization for interactive
  labeling of 3D models" Computers & Graphics 2010 doi", 2026-10-18.
* **Read:** search summary of the CTU DCGI page and PDF front matter.
* **Status:** PARTIAL (DOI).
* **Claims:**
  * Real-time labeling of 3D illustrations combining **fuzzy logic with greedy
    optimization**, running on the GPU.
  * Interactive rates on medium-sized models, comparing favorably with interactive
    state-of-the-art techniques.
* **Relevance:** the same group as the project's cited Čmolík/Pavlovec/Bobák work, and the
  lineage of the interactive external-labeling methods in S23.

### S20. Tatzgern, Kalkofen, Grasset, Schmalstieg 2014: Hedgehog labeling
* **Citation:** Markus Tatzgern, Denis Kalkofen, Raphael Grasset, Dieter Schmalstieg.
  Hedgehog labeling: View management techniques for external labels in 3D space. In *Proc.
  IEEE Virtual Reality (VR) 2014*, Minneapolis, pp. 27–32. **Correction to the brief:**
  venue is IEEE VR 2014, not 3DUI.
* **DOI:** 10.1109/VR.2014.6802046 (Unpaywall link to the IEEE Xplore record).
* **How found:** WebSearch "Tatzgern Kalkofen Grasset Schmalstieg "Hedgehog labeling: View
  management techniques for external labels in 3D space" IEEE Virtual Reality 2014 doi",
  2026-10-18.
* **Read:** search summary (abstract; FH Salzburg and Flinders records).
* **Status:** VERIFIED-SEARCH.
* **Claims:**
  * External labels are placed in **3D object space instead of 2D image space**, giving
    consistent label behavior when the viewpoint changes.
  * Two constraints: labels slide along a **3D pole**, or move within a **plane fixed in
    the world**.
* **Relevance:** *[interpretation]* Coherence comes from restricting label motion to a
  low-dimensional manifold attached to the object. Label Anything already moves warm boxes
  with their anchors (ADR 0025). The next step is to store and reason about the warm state
  as (side, slider t, leader direction) in item-relative coordinates, and to restrict
  near-term moves to that 1D path (Ideas 2 and 4).

### S21. Tatzgern, Orso, Kalkofen, Jacucci, Gamberini, Schmalstieg 2016: Adaptive information density for augmented reality displays
* **Citation:** Markus Tatzgern, Valeria Orso, Denis Kalkofen, Giulio Jacucci, Luciano
  Gamberini, Dieter Schmalstieg. Adaptive information density for augmented reality
  displays. In *Proc. IEEE VR 2016*, Greenville SC, pp. 83–92.
* **DOI:** 10.1109/VR.2016.7504691.
* **How found:** WebSearch "Tatzgern Orso Kalkofen Jacucci Gamberini Schmalstieg "Adaptive
  information density for augmented reality displays" IEEE VR 2016 doi", 2026-10-18.
* **Read:** search summary (abstract; Research.fi and Unpaywall/IEEE records).
* **Status:** VERIFIED-SEARCH.
* **Claims:**
  * Adapts how much information an AR browser shows, to avoid clutter.
  * A **hierarchical clustering** gives a level-of-detail structure. The number of visible
    items adapts during interaction.
  * In a user study, participants preferred it over a conventional AR browser interface.
* **Relevance:** Idea 7. Cluster labels ("12 airports") that split into members when zooming
  in yield nesting by design. Together with S24, a density budget per view.

### S22. Kouřil et al. 2019: Labels on Levels
* **Citation:** David Kouřil et al. Labels on Levels: Labeling of Multi-Scale Multi-Instance
  and Crowded 3D Biological Environments. *IEEE Trans. Vis. Comput. Graph.* 25(1):977–986,
  2019 (VIS 2018; SciVis Best Paper Honorable Mention). Full co-author list not seen.
* **DOI:** 10.1109/TVCG.2018.2864491 (TU Wien, MUNI, CTU, PMC records agree per the
  summary).
* **How found:** WebSearch "Kouřil "Labels on levels: labeling of multi-scale multi-instance
  and crowded 3D biological environments" IEEE TVCG doi", 2026-10-18.
* **Read:** search summary (abstract).
* **Status:** PARTIAL (co-authors not confirmed).
* **Claims:**
  * Interactive labeling of dense, multi-scale, multi-instance 3D scenes.
  * Chooses the **hierarchy level** for each label from depth-buffer analysis and the scene's
    object hierarchy, and labels only representative instances.
* **Relevance:** Idea 7. Scale-dependent choice of *which level of a hierarchy* gets the
  label, instead of all-or-nothing selection per item.

### S23. Bobák, Čmolík, Čadík 2020: Temporally stable boundary labeling for interactive and non-interactive dynamic scenes
* **Citation:** Petr Bobák, Ladislav Čmolík, Martin Čadík. Temporally Stable Boundary
  Labeling for Interactive and Non-Interactive Dynamic Scenes. *Computers & Graphics*
  91:265–278, 2020.
* **DOI:** 10.1016/j.cag.2020.08.005 (several university records and the project page
  cphoto.fit.vutbr.cz/interactive-labeling/ agree per the summary).
* **How found:** surfaced in the Vaaraniemi query. Then WebSearch ""Temporally Stable Boundary
  Labeling for Interactive and Non-Interactive Dynamic Scenes" Čmolík doi", 2026-10-18.
* **Read:** search summary (abstract).
* **Status:** VERIFIED-SEARCH.
* **Claims:**
  * Two screen-space boundary-labeling methods: one **offline for a whole video** and one
    for **interactive** use.
  * Goal: limit label drift under camera zoom and pan.
  * Labels move less than in the prior state of the art. A user study found them easier to
    follow.
* **Relevance:** directly on weakness 4, and for the boundary columns (ADR 0030). The same
  authors as the project's cited CVM 2026 paper. Its offline/interactive split supports
  Idea 6 (sequence mode when frames are known) next to the interactive warm start. Their
  drift measures are worth comparing with `displacement_mean_px`.

### S24. Töpfer, Pillewizer 1966: The principles of selection
* **Citation:** F. Töpfer, W. Pillewizer. The Principles of Selection: A Means of
  Cartographic Generalisation. *The Cartographic Journal* 3(1):10–16, 1966.
* **DOI:** not confirmed (no publisher record surfaced).
* **How found:** WebSearch "Töpfer Pillewizer 1966 "The principles of selection"
  Cartographic Journal 3(1) doi 10.1179" and a Taylor & Francis–restricted variant,
  2026-10-18.
* **Read:** secondary only (citing articles in search results, a Typeset author profile).
* **Status:** PARTIAL (vol/pages agree across several citing sources; DOI unknown).
* **Claims (secondary):**
  * The "radical law" of selection: N_d = N_s · √(M_s / M_d), where N counts objects
    retained and M are the scale denominators of the source and derived map. It also
    introduces constants for symbolic exaggeration and form.
* **Relevance:** Idea 7. *[interpretation]* Scenario 11 zooms ×1.116 per step. With the law,
  the number of labels per *map area* should grow by √1.116 ≈ 1.056 per step, while the
  visible map area shrinks by 1/1.116² ≈ 0.80. So the label count in the viewport should
  fall slightly, about ×0.85 per step, instead of refilling every freed pixel. The engine
  today maximizes placement in each frame, so newly freed space is filled at once. Those
  fill-ins are the labels most likely to be evicted or flipped next frame. A per-view
  budget from the radical law (option `density_budget`), filled in priority order and
  monotone across zoom, gives headroom and less churn.

### S25. Web map engine practice (non-peer-reviewed): MapLibre GL JS source, Mapbox GL wiki and blog
* **(a) MapLibre GL JS source code**, main branch, read 2026-10-18 via
  raw.githubusercontent.com: `src/symbol/placement.ts`, `src/symbol/cross_tile_symbol_index.ts`,
  `src/symbol/collision_index.ts`, `src/style/style.ts`, `src/ui/map.ts`, and the style
  spec `maplibre-style-spec/src/reference/v8.json`. URLs:
  https://github.com/maplibre/maplibre-gl-js/blob/main/src/symbol/placement.ts (and
  siblings). **Read:** full code (via WebFetch summarization with verbatim excerpts).
  **Status:** READ-FULL (code), non-peer-reviewed.
  * **Prefer the previous anchor:** with `text-variable-anchor`, an extra placement pass
    first tries only the anchor used in the previous placement (comment: "prefer placement
    using same anchor, if it's still available"). Later passes try all anchors in style
    order. The previous anchor is looked up per `crossTileID` in
    `prevPlacement.variableOffsets`.
  * **Fades:** `fadeDuration` defaults to **300 ms** (MapOptions doc: "duration of the
    fade-in/fade-out animation for label collisions"). Opacity per symbol moves toward 0/1
    by `(now − commitTime)/fadeDuration` per commit. When zooming out fast,
    `zoomAdjustment = max(0, Δzoom/1.5)` shortens fades. Placement is recomputed only after
    the last one is "settled" (`stillRecent`: commitTime + fadeDuration·adj > now), and it
    runs incrementally across frames (`PauseablePlacement`).
  * **Stable identity across zoom levels:** `CrossTileSymbolIndex` gives the "same
    conceptual label" (text + anchor point within a grid tolerance; feature id with
    `promoteId`) one `crossTileID` across tiles and zoom levels. Opacity and anchor state
    hang on that ID, so a label keeps its fade/anchor when the tile zoom changes.
  * **Viewport padding:** `viewportPadding = 100` px, with the comment "pad the edge of the
    viewport for collision detection so that the bulk of the changes occur offscreen.
    Making this constant greater increases label stability, but it's expensive."
    Collision uses a `GridIndex` over the padded viewport (constructor argument 25,
    presumably cell size, unconfirmed).
  * **Priority:** `symbol-sort-key`, where lower keys are placed first and get priority
    when overlap is disallowed. `symbol-z-order` controls draw order.
* **(b) Mapbox GL Native wiki, "Collision Detection"**,
  https://github.com/mapbox/mapbox-gl-native/wiki/Collision-Detection (last edited by Chris
  Loer, 17 Dec 2018; describes the late-2017 architecture; repo archived 2023). **Read:**
  full page. **Status:** READ-FULL (wiki), non-peer-reviewed.
  * Desiderata: Correct (no overlaps), Prioritized, **Deterministic**, **Stable** ("labels
    should not disappear unless there's no longer space for them on the screen"), Global,
    **Smooth** (animated fades for collided labels), Fast (60 fps; a collision-detection
    latency of "a couple hundred milliseconds" is perceptually acceptable).
  * Greedy in importance order against a viewport `GridIndex`. The GPU interpolates opacity
    between current and target. Cross-tile index shares opacity state per `crossTileID`, so
    a label keeps its animation across zoom levels.
* **(c) Mapbox blog, "Map Label Placement in Mapbox GL"**,
  https://blog.mapbox.com/map-label-placement-in-mapbox-gl-c6f843a7caaa (author/date not
  seen). **Read:** search snippet only. **Status:** PARTIAL, non-peer-reviewed.
  * The approach builds on Been et al.'s requirements for continuous labeling (no popping
    while zooming/panning, no jumping, deterministic regardless of how the view was
    reached), extended to rotation and curved labels.
* **How found:** WebSearch "Mapbox blog label placement collision detection fade cross-tile
  symbol index GL JS" and ""Map Label Placement in Mapbox GL" blog Brammanis Been Yap
  continuous labelling", 2026-10-18. Then direct GitHub fetches.
* **Relevance:** Ideas 2, 3, 5. The "same anchor first" pass is **hysteresis on side that
  does not touch selection or priority**. It answers ADR 0026's objection, which was about
  keeping a label *shown*, not about its *side*. Viewport padding is a cheap anti-pop
  measure for pans.

---

## Improvement ideas for Label Anything (ranked by expected effect on weakness 4)

**1. Zoom-consistent active ranges: a precomputed scale-space selection with candidate
lock-in** (S1, S2, S3, S4, S13; theory limit S9).
* *What:* an optional pre-solve over zoom for hosts with screen-size labels (maps,
  zoomable scatterplots). Two variants:
  * (a) **Discrete ladder:** solve at zoom levels z_0 < z_1 < … (e.g. ×2^(1/4)), coarse to
    fine. A label placed at level k enters level k+1 as *required at its level-k
    candidate*, with the side fixed and slider/nudge allowed. Only new items compete for
    the remaining space.
  * (b) **Continuous:** for fixed-offset candidates, a pair conflict is one zoom interval.
    It can be computed exactly from the existing box geometry (anchor separation scales
    linearly with zoom). Process items in priority order and give each the candidate with
    the earliest free zoom, i.e. the longest active range [z_min, ∞). This is Krumpe's
    "removal scale + filter" pattern, and it respects strict priority because higher
    priority is committed first. *[interpretation]*
* *Effect:* nesting becomes ≈ 100 % by construction, flips across zoom ≈ 0 for kept labels,
  and frames reduce to filtering (weakness 5). Results become history-independent (Been's
  determinism desideratum), which warm start is not. Expected cost: fewer labels at fine
  zoom than an unconstrained per-frame solve. S5 reports a "small drop" in the objective
  for consistency constraints.
* *Caveats:* the **"facing pair"** case. Two labels placed toward each other (i's label
  right, j's label left, j right of i) do not overlap at low zoom, overlap at mid zoom, and
  separate again. So a lock-in can become infeasible; then the side switches once or the
  lower priority loses. Obstacle and background coverage change with zoom; evaluate cost
  per discrete level. Panning matters only at the canvas edge.

**2. Side hysteresis: a same-side pass and an explicit flip term** (S25a "prefer placement
using same anchor"; S5 consistency vs. flicker; S20 1D motion constraint).
* *What:* when the warm box and its nudges fail, try **all candidates of the previous side
  first**: slider positions on that side, then the same side with a leader direction in the
  same half-plane. Only then fall back to the full candidate set, with an added cost
  `w_flip` on candidates whose `anchor_side` differs from the warm side. A "switch only
  if gain > τ" rule is the same as giving the warm side a bonus τ.
* *Why it is compatible with ADR 0026:* it changes only *which candidate* an already-selected
  label takes, never *whether* it is shown, so strict priority is untouched. Today the
  stability term is distance-based, capped at 2. A side flip of a wide label (d ≈ w + 2·gap)
  costs about as much as any 5-em move, so the engine has no specific aversion to flips.
* *Effect:* targets the 11.6–15.5 % flip rate directly. Measure flips per step and
  placement count (the expected trade-off is small).

**3. Incremental repair plus a padded solve region** (S12 dynamic MIS; S25a
`viewportPadding` 100 px "so that the bulk of the changes occur offscreen"; S25b "Stable"
desideratum).
* *What:* in interactive mode, keep the previous placement *as fixed* and re-solve only a
  dirty set: items whose warm box became infeasible, items entering the view, and their
  1–2-hop conflict neighbours (existing obstacle/label indexes). Include anchors within a
  padding band outside the canvas as "invisible but placed", so labels entering on a pan
  are already decided and don't pop or flip when they arrive.
* *Effect:* zero displacement and flips for untouched labels by construction (not just
  low cost). Per-frame time scales with change (weakness 5). Cascades (ADR 0027: ~40 % of
  moves were labels displaced by moved labels) are cut off at the dirty-set boundary.

**4. Bounded label speed** (S7, S8; S9 for why it must stay soft; S16 continuous force
relaxation).
* *What:* treat the label's offset (relative to its anchor) as a continuous state with a
  per-solve speed limit v_max (e.g. 0.25–0.5 em per solve), as a **soft** constraint.
  Candidates beyond v_max from the warm offset are allowed only via "fade-out here,
  fade-in there", with a higher cost. Opt-in: allow a short **transient overlap** (≤ k
  solves, counted and reported) instead of an instantaneous jump, as in de Berg &
  Gerrits's speed/overlap trade-off.
* *Effect:* replaces large jumps (ADR 0026's 33 px glides and 186 px raw jumps) with slides
  or fades. The opt-in overlap must be off by default to keep the hard-constraint
  guarantee.

**5. Overlap-aware transition plans from the engine** (S11; S25a/b fades 300 ms; extends
ADR 0026).
* *What:* the engine returns, per changed label, `transition: slide | fade` (and the path).
  It slides only when the straight-line interpolation of the box, including the leader,
  stays clear of other labels' interpolated boxes over the transition; otherwise it fades
  out/in. `LabelMotion` follows that plan instead of always gliding.
* *Effect:* removes the "fading label overlaps its replacement for up to T" artifact and
  long glides across other labels. It matches the morph model whose overlap bounds Depian
  et al. study.

**6. Offline sequence mode for known frame sequences** (S6, S10, S23 offline-video
method; S5 heuristics).
* *What:* an API taking N frames (animation, recorded camera path, force-layout replay).
  Compute feasible candidates per frame. Then choose per label maximal intervals with one
  candidate each and at most m switches, maximizing Σ visible duration − switch penalty −
  cost. Practical heuristic: the existing static solver on key frames every K frames;
  labels keep their key-frame candidate between key frames when feasible; interval
  scheduling in priority order otherwise.
* *Effect:* for exported animations (Gapminder play-through) both flicker and flips drop
  well below the frame-by-frame warm start. It also gives a reference ("best achievable
  coherence") for the interactive mode in the benchmark.

**7. Density budget and level-of-detail labels across zoom** (S24 radical law; S21
hierarchical-clustering LOD; S22 hierarchy levels).
* *What:* a `density_budget` derived from N_d = N_s·√(M_s/M_d) caps labels per view and is
  filled in priority order, monotone across zoom. Optional cluster labels at coarse zoom
  that split into member labels on zoom-in.
* *Effect:* leaves headroom, so fewer last-moment fill-in labels get evicted or flipped
  when zooming. Cluster labels raise "information placed" in dense data (weakness 1).

**8. Fixed-scale exploration: pages/stacks for omitted labels** (S14, S15).
* *What:* repeated solves with already-paged items excluded produce label pages 1..k for a
  view, or for boundary columns a "sliding/stacking" mode. The host flips pages instead of
  zooming. S15 assigns pages offline and stays temporally consistent while panning.
* *Effect:* addresses weakness 1 (501/1000 airports) in interactive settings without zoom
  churn.

**Benchmark additions suggested by the literature**
* Zoom-out steps and **round trips** (zoom in, then out to the same view): check Been's
  monotonicity (no label appears on zoom-out) and **history independence** (same view, same
  labels; S1, S25b "Deterministic").
* **Flicker count** per label (on→off→on within w frames; S5) next to added/removed.
* **Label speed distribution** (max and 99th percentile offset change per frame, in em; S7),
  and the share of changes realized as fades vs. slides (S11, S25).
* **Active-range coverage**: Σ over items of the fraction of zoom steps labeled (S2's
  objective).

---

## Unverified leads (not searched: shared search budget exhausted)

All UNVERIFIED (from memory). Check before citing.
* Madsen, Tatzgern, Madsen, Schmalstieg, Kalkofen: "Temporal coherence strategies for
  augmented reality labeling", IEEE TVCG (IEEE VR 2016). Compares temporal-coherence
  strategies for AR labels (2D vs 3D placement, update frequency). Likely highly relevant
  to Idea 2/5. DOI not known.
* Schwartges, Wolff, Haunert (and/or Allerkamp): interactive street labeling with embedded
  labels (ACM SIGSPATIAL 2014), and work on active ranges for point selection in dynamic
  maps. Details not checked.
* Petzold, Gröger, Plümer (2003): "reactive conflict graph" for fast screen-map labeling
  with zoom-dependent conflicts. A precomputed scale-dependent conflict structure, i.e.
  Idea 1. Not checked.
* Grasset, Langlotz, Kalkofen, Tatzgern, Schmalstieg: "Image-driven view management for
  augmented reality browsers" (ISMAR 2012). Not checked.
* Titles seen in results but not examined: "Algorithms for Consistent Dynamic Labeling of
  Maps With a Time-Slider Interface" (Univ. Bonn dissertation, bonndoc
  hdl 20.500.11811/13584, author not seen); "Beyond Zooming: Models and Algorithms for
  Mobile Maps with Extended Interaction Techniques" (Univ. Bonn, hdl 20.500.11811/12599,
  likely Gedicke's thesis, unconfirmed); Seike & Imai (2011), slider-model labeling of
  moving points with local search (GISA Japan proceedings).
* One result, "Constraint-Safe Graph-Context Scoring for Stable Point-Feature Labels …"
  (arXiv 2609.19848), was not examined. Its provenance is unknown, so it is not used.
