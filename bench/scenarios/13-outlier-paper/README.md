# 13 — Outlier labeling, after Mumtaz et al. (2019)

**What.** The four labeled scatterplots of H. Mumtaz, M. van Garderen, F. Beck,
D. Weiskopf: *Label Placement for Outliers in Scatterplots*, EuroVis 2019 short paper
([doi:10.2312/evs.20191161](https://doi.org/10.2312/evs.20191161)), reconstructed from the
paper's figures: the outliers of two software-metrics scatterplots of the *redactor* project
(classes by coupling, response and weighted methods; Figures 1, 3 and 4) and of U.S. states
by median income and the rate of mental disorders (Figure 8), each named by its label, among
the other, unlabeled points.

**Why.** The paper's problem in its own examples: few labels, all on sparse outliers, next to
a cloud of unlabeled points that the labels should neither cover nor seem to name. The paper's
cost-based greedy method is a baseline of the benchmark (`mumtaz2019`,
`bench/baselines/mumtaz2019_baseline.py`), and its published layouts can be scored as they
are (below).

**Data.** `figures.json`, digitized by `digitize.py` from the figures as embedded in the PDF
(image px): dots by colour (red outliers, blue other points; dots drawn on top of each other
are one), data values through the axes' tick marks (integers for the metrics), names by an
optimal assignment of the printed names to the red dots, the published label boxes from the
printed text (and which labels have leaders). Nothing is fetched; see `LICENSE.md`.

**Configs** (preset `scatter`, 12 px labels, priority = outlierness: mean distance to the 5
nearest points in canvas px):

| config | labels | other points | canvas | notes |
|---|---:|---:|---|---|
| `fig1-cbo-rfc` (quick) | 19 | 125 | 512.5 × 503 | Figure 1: coupling between objects (cbo) vs response for a class (rfc) |
| `fig3-cbo-wmc` | 27 | 91 | 516 × 498.5 | Figure 3: cbo vs weighted methods per class (wmc) |
| `fig4-cbo-wmc-more` | 33 | 84 | 534.5 × 500 | Figure 4: Figure 3 with a lower outlier threshold (*Util*'s dot is drawn blue in the paper) |
| `fig8-income-disorders` | 17 | 34 | 543.2 × 371.2 | Figure 8: the 50 states and D.C. by median income and mental disorders |

**Rendering recipe.** The canvas is the figure scaled by 0.5 (Figure 8: 0.4), so that labels
in the bundled Noto Sans at 12 px are as wide as the paper's; dots r 3.5 (2.8) px. The axes
run along the top and the right as in the paper; labels stay inside them (`canvas.region`),
the other points are the soft class `points`.

**Published layouts.** `build.py` also writes `<config>.published.json`, the paper's own
layout as a result: each label's box (the problem's box, padding included) centred on the
printed text, with a straight leader where the figure draws one. Score it like any result:

```sh
python -m bench.eval bench/out/problems/13-outlier-paper/fig1-cbo-rfc.json \
    bench/out/problems/13-outlier-paper/fig1-cbo-rfc.published.json --summary
```

The paper sets its text closer to the dots than the 0.15 em padding of the problems' boxes
allows, so most published labels count as touching their own mark (`own_mark`); positions
are as exact as the digitization (about 1 px).
