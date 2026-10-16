# 02 — Volcano plot

**What.** Volcano plots (x = log2 fold change, y = −log10 p) of public
differential-expression tables; the top-N genes by significance are labeled with their
gene symbols over the dense background of all other genes.

**Why.** The archetypal "label the significant few among thousands" chart: very dense
near the origin, sparse at the top, short labels, threshold lines that should stay
visible.

**Data.** A genome-scale table (16,406 human genes; test data of the Galaxy
`volcanoplot` tool, MIT) and a small real DESeq2 output (977 genes with p values; nf-core
SRP254919, MIT). Substitution note: the brief asked for "a public DE table on
raw.githubusercontent.com with a clear license"; these two satisfy it (both repositories
are MIT-licensed).

**Configs** (canvas 900 × 680 px, preset `scatter`, font 10 px, priority = −log10 p):

| config | labels | background |
|---|---|---|
| `top20-vector` (quick) | 20 | other genes (`points`, r 1.8), dashed thresholds (`lines`), axes (`axes`, hard), ticks (`text`) as vector layers |
| `top50-svg` | 50 | SVG chart; significant genes colored (|log2FC| ≥ 1, p < 0.05) |
| `top30-transform` | 30 | none; anchors and points in **data units** with `transform` + `y_axis: "up"` |
| `nfcore-top20-vector` | 20 | small DESeq2 table, vector layers |

**Rendering recipe.** Symmetric x domain ±1.08·max|log2FC|, y domain [0, 1.08·max];
plot area (70, 34)–(876, 620) px; thresholds |log2FC| = 1 and p = 0.05 dashed `#999`;
labeled genes have circle marks r 3; ids are gene symbols (suffix `#k` for repeats).
