# Scenario 13 — data licenses

| Data | Source | License | Attribution |
|---|---|---|---|
| `figures.json`: positions of the dots and labels of Figures 1, 3, 4 and 8, as digitized by `digitize.py` | H. Mumtaz, M. van Garderen, F. Beck, D. Weiskopf: *Label Placement for Outliers in Scatterplots*, EuroVis 2019 short paper, [doi:10.2312/evs.20191161](https://doi.org/10.2312/evs.20191161) (© 2019 the authors) | measurements read off the published figures (facts), with the paper cited | Mumtaz et al. (2019). |
| class names and metric values (cbo, rfc, wmc) of the *redactor* project, Figures 1, 3, 4 | the paper's footnote 1: [doi:10.5281/zenodo.322445](https://doi.org/10.5281/zenodo.322445) | metric values are facts; class names as printed in the figures | the redactor project, via Mumtaz et al. (2019). |
| state names, median income and the rate of mental disorders, Figure 8 | the paper's footnote 2: Urban Institute, *Geographic Patterns of Disability Insurance Receipt* | statistics (facts), as printed in the figure | Urban Institute, via Mumtaz et al. (2019). |

Committed (about 34 KB), since there is nothing to fetch: the values exist only as the
paper's figures. `digitize.py` documents how they were read; it needs the paper's PDF.
