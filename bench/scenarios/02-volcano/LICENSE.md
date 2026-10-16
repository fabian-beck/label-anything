# Scenario 02 — data licenses

| Data | Source (pinned) | License | Attribution |
|---|---|---|---|
| Genome-scale DE table (16,406 genes: `Gene`, `log2FoldChange`, `pvalue`, `padj`) | `galaxyproject/tools-iuc@3b052d86…` `tools/volcanoplot/test-data/input.tab` | MIT (repository) | Galaxy IUC (© 2014 galaxy-iuc); example data of the "Getting Genetics Done" volcano plot tutorial by Stephen Turner. |
| DESeq2 results, study SRP254919 (1,000 genes) + gene symbols | `nf-core/test-datasets@618f1541…` `data/genomics/mus_musculus/rnaseq_expression/` | MIT (repository); underlying reads from NCBI SRA (no use restrictions) | nf-core/test-datasets (© 2018 nf-core); SRA study SRP254919. |

Both files are downloaded by `fetch.py` (SHA-256 verified) and never committed.
Generated problems contain gene symbols, fold changes and p values derived from them.
