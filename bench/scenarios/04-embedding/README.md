# 04 — Embedding map

**What.** A 2-D "data map" of an open text corpus — 50,000 WordNet 3.0 noun synsets
(lemma names + gloss) — drawn as a raster of 50k dots, with cluster labels at the
cluster centers carrying long topic names, e.g. *"Communicative processes and contents:
music, work, instrument"*.

**Why.** Labels of regions rather than points, long multi-line labels, and a raster-only
background (no vector geometry to avoid) — the setting of tools like datamapplot.

**Embedding (deterministic, computed once, ~10 min, cached in `bench/data/nltk-wordnet/`).**
Sample of 50,000 noun synsets (seeded permutation) → TF-IDF (sublinear, English stop
words, min_df 3) → TruncatedSVD 64 (randomized, seed 0) → L2 normalize → t-SNE 2-D
(perplexity 40, PCA init, seed 0, Barnes–Hut, single-threaded BLAS/OpenMP via
threadpoolctl). No precomputed embedding was reachable, hence this computation.

**Clusters and names.** k-means (seed 0, 4 inits) on the 2-D canvas positions. Topic name
= description of the cluster's dominant WordNet category (lexnames) + the three most
distinctive gloss terms (in-cluster document frequency × global IDF; English stop words and gloss
phrasing such as "whereby" or "consisting" are not terms). Point anchors use
the cluster member closest to the centroid.

**Configs** (canvas 1600 × 1200 px, preset `scatter`, font 11 px, wrap 11 em / 3 lines,
priority = log cluster size, font classes: the top 5 % at 1.3 ×, the next 20 % at 1.1 ×):

| config | clusters | anchors | raster mode |
|---|---|---|---|
| `k40-ink` (quick) | 40 | points (circle r 3) | `ink` (soft 0.5) |
| `k40-saliency` | 40 | points | `saliency` (soft) |
| `k120-areas` | 120 | `area` anchors: convex hull of each cluster's 75 % core | `ink` |

**Rendering recipe.** Dots r 1.3 px, color by WordNet category (16-color palette,
alpha 150/255), 2× supersampled, palette PNG.
