# 0031 — Keep the name "Label Anything"; say "label placement" first

* Status: accepted (README, documentation home, site and package descriptions,
  `CITATION.cff`; no engine change; keeps the names of ADR 0002)
* Date: 2026-10-18

## Context
ADR 0002 chose "Label Anything" after a registry check and noted that an unrelated
computer-vision work has the same name. Before the first publish, we checked how the name
reads (2026-10-18).

What the name does well:
* A verb and an object in plain English: it says what the engine does, it is easy to
  remember, and it gives the short alias `la`.
* "Anything" stands for the real difference to the closest tools, each of which serves one
  host: adjustText (matplotlib), ggrepel (ggplot2), textalloc (matplotlib), vega-label
  (Vega), d3fc-label-layout (D3), labella.js (labels along one axis), Maplex (ArcGIS), PAL
  (QGIS). This engine serves scatterplots, maps, node-link diagrams and illustrations;
  text, icon and box labels; no background, vector, SVG or raster backgrounds; and every
  language, from one JSON problem format.

Where it misleads:

| Name | What it is | Why it matters |
|---|---|---|
| Label Anything (De Marinis et al., ECAI 2025; arXiv 2407.02075; `pasqualedem/LabelAnything`, MIT) | few-shot semantic segmentation with visual prompts | the same name on open-source research software with a paper; Google Scholar and reviewers are likely to mix the two up |
| `label_anything` in `open-mmlab/playground` | Segment Anything plus Label Studio for semi-automatic annotation | the same words for annotating training data |
| Segment Anything (2023) and the names that followed it: Track, Caption, Inpaint, Count, Relate, Place Anything, Depth Anything | vision foundation models and pipelines built on them | "*Verb* Anything" reads as "promptable vision model" |
| Label Studio, Labelbox, labelme, LabelImg, AnyLabeling, X-AnyLabeling | data-labeling tools | in machine learning, "labeling" means annotating data |

Besides:
* "Anything" promises more than the engine does: point and area features (spec §3, §6.5)
  with text, icon and box labels. Lines are obstacles, not features: there are no labels
  along roads or rivers, which cartographers look for first.
* The name names an action, not the category people search for ("label placement",
  "avoid overlapping labels"). The front pages led with "a host-independent label
  placement engine", which names the category but in jargon; two package descriptions
  (the TypeScript CLI, the JavaScript helpers) did not name it.

## Decision
Keep "Label Anything" and every package name of ADR 0002. Position it as label placement:

* **Category first.** The README, the documentation home and the site description open
  with "Label placement for charts, maps and diagrams, from any language"; the package
  descriptions, `CITATION.cff` and the API doc comments call it "a label placement engine
  for charts, maps and diagrams". "Host-independent" is no longer used: the front pages
  say what it means instead. The home page's browser title is "Label placement for
  charts, maps and diagrams - Label Anything".
* **What "anything" means.** One paragraph on the front pages: the *anything* is the host
  and the label (any chart, map or diagram, any label with a size, every language), where
  adjustText, ggrepel or vega-label each serve one plotting library.
* **Scope.** The same paragraph says that labels go to points and areas, and that lines
  are obstacles, not labeled features.
* **Disambiguation.** The same paragraph says that Label Anything places labels in
  graphics, is not a tool for labeling data, and is unrelated to the segmentation model
  of the same name.
* **Every package description says "label placement"**, now including the TypeScript CLI
  and the JavaScript helpers. `CITATION.cff` gets the keyword "map labeling".
* **Repository description and topics** (set on GitHub, not in the repository):
  "Label placement for charts, maps and diagrams: labels and leaders that avoid what must
  stay visible, from Rust, TypeScript, Python, Java and C"; topics `label-placement`,
  `map-labeling`, `point-feature-labeling`, `external-labeling`, `leader-lines`,
  `data-visualization`, `cartography`, not the bare `labeling` (data annotation).

Considered and rejected:
* Renaming before the first publish (to "Label Etiquette", "Label Anywhere", "Overpost",
  "Cartellino" or "Wide Berth", all free on PyPI, npm and crates.io on 2026-10-18): the
  name is memorable and says what the engine does, and "anything" carries its main
  difference; the collisions are with other fields, which the category and the
  disambiguation line separate. A rename would touch 394 files, every package name and
  the address of the documentation site, which GitHub does not redirect.
* A second alias for the Python examples (`la` is also a common alias of `numpy.linalg`
  and `scipy.linalg`): the examples rarely import both, and `la` matches the name.

## Consequences
New front pages, package descriptions and papers name the category on first mention:
"Label Anything, a label placement engine for …". Paper titles name the contribution
rather than only the tool, since "Label Anything: …" is already a paper title. The name
stays tied to the segmentation work in search results; the disambiguation line is the
answer, and the registry names are reserved by publishing 0.1.0 (ADR 0002).
