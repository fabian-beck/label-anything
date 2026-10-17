# 03 — Gapminder bubble chart

**What.** Fertility (x) vs life expectancy (y) with bubble area ∝ population, the 40
most populous countries plus 6 outliers of a linear fit labeled with country names.

**Why.** Item shapes matter: radii vary ≈ 30× (2 … 60 px), so adjacent positions must
touch the true circles, small bubbles hide behind big ones, and big bubbles should get
**internal** labels (shape fidelity / internal-label rate metrics).

**Configs** (canvas 960 × 640 px, preset `scatter`, font 11 px, priority = log population, font classes: the top 5 % bold at 1.25 ×, the rest at 0.9 ×):

| config | labels | background | internal policy |
|---|---|---|---|
| `y2005-vector` (quick) | 46 | other bubbles (`bubbles`, 0.5), axes, grid, ticks as vector layers | `prefer` (models internal + adjacent + slider + distant) |
| `y2005-svg` | 46 | SVG chart with a 170 px year watermark (`watermark`, 0.05) and region legend (`legend`, hard) | `prefer` |
| `y1955-all-vector` | 62 (all) | vector layers | default (`auto`) |

**Rendering recipe.** Domains x [0.8, 8.4], y [30, 86] in plot area (70, 30)–(940, 580);
radius = max(2, 60·sqrt(pop / max pop of the year)); unlabeled bubbles drawn largest
first with region colors (opacity 0.55, white 0.5 px stroke).
