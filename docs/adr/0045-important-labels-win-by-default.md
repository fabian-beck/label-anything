# 0045 — Important labels win by default on maps and in the helpers

* Status: accepted (amends ADR 0040's opt-in; `spec/presets/map.json`, the Python and
  JavaScript helpers)
* Date: 2026-10-18

## Context
ADR 0040 added `lower_items`: a label may cover the marks of less important items, which
then go unlabeled. It was opt-in. Exploring the library as an outside developer, the same
inversion of the priority showed up in every priority-driven use case tried, with default
settings: on a Leaflet map of Germany's 81 largest cities (priority: population) Essen,
Duisburg and Düsseldorf went unlabeled while Moers and Bottrop at the edge of the Ruhr
cluster kept their labels; in a seaborn chart of countries (top 15 by population) China,
India, Indonesia, Brazil, Pakistan and Bangladesh were missing while Chile (rank 56) and
Angola (rank 63) were labeled. Setting `lower_items` fixed each of them, but a user has to
know about the option to find it.

## Decision
* The `map` preset sets `avoid.label.lower_items` 10 and `avoid.leader.lower_items` 2.5,
  the values of the benchmark's airport maps (ADR 0040).
* The plotting and map helpers — Python `label_points` for matplotlib, seaborn and
  Plotly, and every helper of `@label-anything/extras` — set the same values when a
  priority is given (`priority` or `tiers` in Python; a `priority` option or items with an
  explicit priority or tier in JavaScript). Without a priority the order is only the
  input order, and no label should claim another point's mark for that.
* The caller's own `avoid` wins key by key: `"lower_items": "hard"` restores the old
  behaviour.
* The engine default stays as it was (`lower_items` follows `items`), so problems written
  as JSON keep their results unless they use the `map` preset.

## Consequences
The Leaflet map labels Essen, Duisburg, Düsseldorf, Bochum, Wuppertal, Cologne and
Dortmund, and the small towns around them make way. The seaborn chart (gapminder 2007,
`max_labels` 15 by population) labels ranks 0–9, 12, 14, 16, 18 and 19; with
`"lower_items": "hard"` rank 5 is missing and ranks 21, 25 and 33 take its place. A less important point whose dot a more important label covers goes unlabeled even
where it would have had room — the price ADR 0040 describes. The parity fixture of the
`presets-map` sample counts 15 more candidates; its placements are unchanged.
