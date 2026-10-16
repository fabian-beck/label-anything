# 09 — Line chart end labels

**What.** Multi-series line charts labeled at the series ends (direct labeling instead
of a legend).

**Why.** End values crowd — several series end at almost the same value — so labels need
slider positions, leaders or stacking in the margin, while the lines themselves are
costly obstacles (`lines`, soft 2.0) that labels should not cover.

**Configs** (preset `scatter`; item = last data point, circle r 2.5; series polylines 1.5 px):

| config | series | background | placement |
|---|---|---|---|
| `unemployment-14-vector` (quick) | 14 industries (unemployment rate %) | vector layers (lines, axes, grid, ticks) | positions restricted to `right`, `top-right`, `bottom-right`; models adjacent + slider + distant |
| `stocks-5-svg` | 5 stocks, label "SYMBOL $last price" | SVG chart | right-side positions first |
| `life-62-boundary` | 62 countries (life expectancy) | vector layers | `boundary` model on the right (stack, gap 1 px), straight leaders into the label side |

**Rendering recipe.** Plot areas: (60, 20)–(740, 500) on 960 × 560 (unemployment),
(60, 20)–(760, 460) on 900 × 520 (stocks), (60, 20)–(640, 940) on 900 × 1000 (life
expectancy); x ticks every two years; 14-color categorical palette.
