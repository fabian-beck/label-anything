# 0031 — Name and positioning: say "label placement" first; decide the name before the first publish

* Status: proposed (no engine change; revisits the name chosen in ADR 0002)
* Date: 2026-10-18

## Context
ADR 0002 chose "Label Anything" after a registry check and noted that an unrelated
computer-vision work has the same name. No package is on a registry yet, so changing the
name now is a search-and-replace (394 files, about 1,600 occurrences, nearly all
mechanical); after 0.1.0 is published and cited, it is a migration.

What the name does well:
* A verb and an object in plain English: it says what the engine does, it is easy to
  remember, and it gives the short alias `la`.
* "Anything" stands for the real difference to the closest tools, each of which serves one
  host: adjustText (matplotlib), ggrepel (ggplot2), textalloc (matplotlib), vega-label
  (Vega), d3fc-label-layout (D3), labella.js (labels along one axis), Maplex (ArcGIS), PAL
  (QGIS). This engine serves scatterplots, maps, node-link diagrams and illustrations;
  text, icon and box labels; no background, vector, SVG or raster backgrounds; and every
  language, from one JSON problem format.

Where it misleads (checked on 2026-10-18):

| Name | What it is | Why it matters |
|---|---|---|
| Label Anything (De Marinis et al., ECAI 2025; arXiv 2407.02075; `pasqualedem/LabelAnything`, MIT) | few-shot semantic segmentation with visual prompts | the same name on open-source research software with a paper; Google Scholar and reviewers are likely to mix the two up, and a paper titled "Label Anything: …" already exists |
| `label_anything` in `open-mmlab/playground` | Segment Anything plus Label Studio for semi-automatic annotation | the same words for annotating training data |
| Segment Anything (2023) and the names that followed it: Track, Caption, Inpaint, Count, Relate, Place Anything (arXiv 2402.14316), Depth Anything | vision foundation models and pipelines built on them | "*Verb* Anything" now reads as "promptable vision model"; Label Anything sounds like one of them, and one of them exists |
| Label Studio, Labelbox, labelme, LabelImg, AnyLabeling, X-AnyLabeling | data-labeling tools | in machine learning, the larger audience on GitHub, "labeling" means annotating data |
| label-maker apps (Zebra ZLabel: "make labels – anywhere, anytime") | printing physical labels | the everyday meaning of "label" |

Besides:
* "Anything" promises more than the engine does: point and area features (spec §3, §6.5)
  with text, icon and box labels. Lines are obstacles, not features: there are no labels
  along roads or rivers, which cartographers look for first.
* The name names an action, not a category. People search for "label placement" or "avoid
  overlapping labels"; the package descriptions say "label placement" (ADR 0002), but the
  name does not.
* A web search for "label anything" returns dictionary entries and the segmentation work.

## Decision (proposed)

### Positioning, whatever the name
* Name the category in the first words, everywhere (README, site, repository description,
  package summaries): "*Name* is a label placement engine for charts, maps and diagrams,
  from any language." "Host-independent" is accurate but jargon: say what it means first,
  use the term second. Two package descriptions still lack "label placement": the
  TypeScript CLI and the JavaScript helpers.
* Give integrators the analogy: what Yoga is to flexbox layout and ELK to graph layout, an
  embeddable engine with one problem format and bindings for every language, for labels.
* Lead with what the closest tools do not do (each serves one host and nudges labels until
  overlaps are rare): no overlaps and no crossing leaders as hard rules; a graded
  avoidance policy; priority-driven omission that explains every label left out;
  deterministic placements, the same in Rust and TypeScript.
* State the scope where "anything" is claimed: points and areas; text, icons and boxes;
  leaders. No labels along lines (yet).
* Repository topics: `label-placement`, `map-labeling`, `point-feature-labeling`,
  `external-labeling`, `leader-lines`, `data-visualization`, `cartography`, but not the
  bare `labeling` (machine-learning annotation).
* The Python examples write `import label_anything as la`; `la` is also the common alias
  of `numpy.linalg` and `scipy.linalg`, which the users of the matplotlib, Plotly and
  seaborn extras know. Pick a different alias when the name is settled.

### The name
Cheapest first:

1. **Keep "Label Anything"** with the positioning above, a disambiguation line on the home
   page and in the README ("not related to Label Anything, the few-shot segmentation
   model, ECAI 2025"), the descriptor after the name on first mention, and paper titles
   that name the contribution rather than the tool. Costs nothing; the exact collision and
   the "*Verb* Anything" reading stay.
2. **Rename to "Label Etiquette"** (proposed). *Étiquette* is French for label (German
   *Etikett*); *etiquette* is a code of conduct, and the engine is a configurable code of
   conduct for labels: hard rules (never cover an outlier, never cross a leader), costs
   for what is merely impolite (covering other points), personal space (the margin, ADR
   0028), who gives way (priority) and an excuse from everyone who leaves (the omission
   explanations). It keeps "Label" in front (search, continuity, a name of the same
   shape), drops the "Anything" family and its overpromise, and comes with a tagline:
   "label placement with good manners". `label-etiquette` was free on PyPI, npm and
   crates.io on 2026-10-18. The risk is a first reading as a style guide for labels; the
   category after the name answers it.
3. Other names, checked the same day (all free on PyPI, npm and crates.io):
   * **Label Anywhere** (`label-anywhere`): the smallest change; keeps `la` and the
     `la-*` crate directories; "where" is the engine's job. Keeps the annotation and
     label-maker readings.
   * **Overpost** (`overpost`): the cartographic term for a label printed over another
     symbol; ArcGIS calls its placement component an "overposter". Credible to GIS users,
     opaque to everyone else, and it names the problem, not the remedy.
   * **Cartellino** (`cartellino`): the painted paper label in Renaissance paintings.
     Distinctive and searchable; obscure and hard to spell.
   * **Wide Berth** (`wideberth`): a berth is an allotted place, and giving something a
     wide berth is keeping clear of it — both halves of the problem. Playful.

Considered and rejected:
* Place Anything: Place-Anything is a video object insertion paper (arXiv 2402.14316), the
  same family as above.
* Imhof, after Eduard Imhof, whose rules for positioning names on maps (1962, in English
  1975) still shape position preferences: npm `imhof` is a tool that renders map tiles to
  PDF, and to cartographers the name means relief shading.
* Labella (labella.js, Twitter's label layout along a timeline), AnyLabel (X-AnyLabeling),
  and Etiquette, Labeler, LabelKit, Callout, Signpost, Tether, Lanyard: taken on at least
  one of the registries or by a tool in the same field.

## Consequences
If the name changes, it changes before the first publish: the repository, every package
name of ADR 0002 (crates, npm scope, PyPI, Maven artifact and Java package, C library and
header), the CLI binary, the documentation site and `CITATION.cff`; ADR 0002's names are
then superseded. GitHub redirects git and web URLs after a rename, but not the Pages site:
`fabian-beck.github.io/label-anything/` stops working unless the site moves to a custom
domain first. Right before publishing, repeat the registry check and add what this one
did not cover: the npm scope, the Maven namespace, conda-forge, domain names and a
trademark search. If the name stays, the positioning bullets and the disambiguation line
apply.
