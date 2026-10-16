# Scenario 07 — data licenses

| Data | Source (pinned) | License | Attribution |
|---|---|---|---|
| Les Misérables co-occurrence network (`miserables.json`) | npm `vega-datasets@3.2.1` (package BSD-3-Clause) | no explicit data license; compiled by M. Newman from Knuth's Stanford GraphBase, widely used for research | D. E. Knuth, *The Stanford GraphBase: A Platform for Combinatorial Computing*, Addison-Wesley (1993). |
| Cora citation network (`cora.cites`, `cora.content`) | `tkipf/pygcn@1600b5b7…` `data/cora/` (repository MIT) | no explicit data license; distributed for research use | A. McCallum, K. Nigam, J. Rennie, K. Seymore, "Automating the construction of internet portals with machine learning", *Information Retrieval* 3(2), 2000; P. Sen et al., "Collective classification in network data", *AI Magazine* 29(3), 2008. |

Both datasets are downloaded by `fetch.py` (SHA-256 verified) and **never committed or
redistributed** (their data licenses are not explicit). The generated problems contain
node names / paper ids, a derived layout and citation counts; keep the citations above
when publishing results.
