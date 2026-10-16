# 12 — Priority and omission showcase

**What.** Far more labels than fit, so the priority function and the omission semantics
decide what is shown. Two datasets × three priority types × three omission modes =
18 problems named `<dataset>-<type>-<mode>`.

| dataset | items | canvas / preset | coverage groups |
|---|---|---|---|
| `metrics` | all 1,206 classes of scenario 01, FQCN labels 10 px, CBO vs RFC positions | 1000 × 720, `scatter` | `attrs.area` (second-level package area, e.g. `react.uimanager`) |
| `airports` | all served airports of scenario 05, city-name labels 9 px | 1800 × 710 world, `map` | `attrs.country` |

| type | `priority` |
|---|---|
| `attr` | `terms: [{attr: rfc / routes, transform: log1p}]` |
| `outlier` | `terms: [{builtin: "outlierness", k: 5}]` |
| `coverage` | the `attr` terms + `coverage: {by: …, min_per_group: 1}` |

Modes: `strict` (no omitted item may have a feasible position given the higher/equal-key
labels: `priority_inversions` must be 0), `prefix` (the placed set is a prefix of the
priority order) and `weighted` (maximize the priority-weighted count). The evaluator
reports inversions by its own removal test, prefix length, NDCG@k, placed_weighted and
coverage satisfaction. Quick suite: `metrics-attr-strict`.
