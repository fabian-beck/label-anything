# Label Anything — real-world benchmark

Twelve scenarios built from real, openly licensed data (one of them synthetic-from-real,
one a synthetic camera path over real data), an implementation-independent evaluator, one
renderer for every implementation, and a
runner that produces `bench-report/`. Everything here depends only on the JSON formats
(`spec/schema/problem.v1.json`, `spec/schema/result.v1.json`) and on `spec/` itself, never
on an engine implementation.

```
bench/
  common/          shared library: sources + fetch, spec options, text measurement, geometry,
                   problem model, raster modes, scene/SVG builder, deterministic JSON
  scenarios/NN-*/  fetch.py, build.py, README.md, LICENSE.md (+ data helpers, polygons.json)
  eval/            evaluator package + CLI (python -m bench.eval) + tests/
  solvers/         built-in baselines: naive, greedy
  baselines/       third-party baselines: textalloc, adjustText, vega-label, ggrepel (adapters,
                   pinned toolchains, README.md with methods and emulations, tests/)
  perf/            performance targets: problem generator + timing (python -m bench.perf)
  render.py        problem + result (+ background) -> SVG / PNG
  run.py           runner -> bench-report/results.json + index.html
  report.py        the report: tables, images, runtime plots, diff, parity, perf, gates
  gates.py         release gates (python -m bench.gates); gates-allow.json = ADR-backed exceptions
  milestones.py    acceptance checks of the brief's milestones M3 and M4 (python -m bench.milestones)
  tests/           tests of the report, gates, perf generator and runner
  Dockerfile       one image with every toolchain (docker-run.sh is its entrypoint)
  validate_problems.py
  requirements.txt
  data/            fetched third-party data (gitignored, never committed)
  out/problems/    generated problems, truths, backgrounds (gitignored, reproducible)
  out/perf/        generated performance-target problems (gitignored, reproducible)
```

## Quick start

```sh
python3 -m venv bench/.venv && bench/.venv/bin/pip install -r bench/requirements.txt
bench/.venv/bin/python -m bench.scenarios fetch          # download + verify SHA-256 (≈ 85 MB)
bench/.venv/bin/python -m bench.scenarios build          # write bench/out/problems/ (~12 min, see below)
bench/.venv/bin/python bench/validate_problems.py       # JSON Schema 2020-12 + size budgets
bench/.venv/bin/python bench/run.py --suite quick       # naive + greedy baselines -> bench-report/
bench/.venv/bin/python -m pytest bench/eval/tests bench/baselines/tests bench/tests   # tests
# third-party baselines (optional): bench/baselines/README.md
bench/.venv/bin/pip install -r bench/baselines/requirements.txt && npm ci --prefix bench/baselines
sudo bench/baselines/install-r.sh                        # R + ggrepel (Ubuntu 24.04; --cran elsewhere)
```

Run from the repository root. Single scenarios: `python -m bench.scenarios build 05` (or
`python bench/scenarios/05-airports/build.py`). Requirements: Python 3.13 and the pinned
packages; scenario 01 also needs a JDK ≥ 11 (`java` on PATH) to run `CkLite.java`.
Building takes ≈ 12 minutes the first time, ≈ 10 of them for the t-SNE of scenario 04,
which is cached (later builds: ≈ 2 minutes, dominated by the Cora force layout).

**Engine runs.** Build the Rust CLI (`cargo build --release --manifest-path
rust/Cargo.toml -p label-anything-cli`) and the TypeScript packages (`npm run build`,
which includes the `label-anything-ts` CLI) and pass them as solvers; `--engine` adds the
Rust CLI as `rust` together with its debug overlay, `--ts` and `--wasm` add the TypeScript
engine and the WebAssembly build (`npm run build:wasm -w @label-anything/wasm`) through the
TypeScript CLI. All three are timed in steady state, as a host application that solves
repeatedly sees them: `--warmup` solves (default 3) in the same process precede every timed
solve (a fresh process would also time loading fonts, first-touch memory and, for
JavaScript, compiling the engine); `--baselines` adds every baseline (see *Baselines*):

```sh
bench/.venv/bin/python bench/run.py --suite quick --engine rust/target/release/label-anything \
    --baselines --perf                                  # Rust + all baselines + performance targets
bench/.venv/bin/python bench/run.py --suite quick --engine rust/target/release/label-anything \
    --ts --wasm --perf                                  # all three implementations
bench/.venv/bin/python bench/run.py --suite full \
    --solver naive --solver greedy \
    --solver 'rust=rust/target/release/label-anything place {problem} -o {result}' \
    --solver 'ts=node ts/packages/cli/dist/main.js place {problem} -o {result}'
rust/target/release/label-anything bench --baselines --perf -o bench-report   # the same via the CLI
```

`label-anything bench [--suite quick|full] [--baselines] [--perf] [--gate] [--previous P]
[--runs N] [-o DIR] [-- ARGS]` runs `bench/run.py` with the binary itself as the `rust` solver,
using `bench/.venv`'s interpreter when present (or `$LA_BENCH_PYTHON`); arguments after `--` are
passed on unchanged.

**Evaluate one result.** `python -m bench.eval problem.json result.json [--truth t.json]
[--summary] [-o metrics.json]` (the truth defaults to `<problem>.truth.json`).
Sequences: `python -m bench.eval sequence <sequence.json> --results <dir-with-frame-results>`.

**Render one result.** `python bench/render.py problem.json result.json -o out.svg --png out.png`
(the PNG uses `<problem>.bg.png` as background when present; `--font-href` embeds an
`@font-face` URL for Noto Sans in the SVG; `--standalone` makes `-o` a self-contained SVG as in
the gallery, with `<problem>.bg.svg` inlined when the problem has no background of its own).

## Output layout

```
bench/out/problems/<scenario>/<config>.json          problem (validates against problem.v1.json)
bench/out/problems/<scenario>/<config>.truth.json    exact geometry of every obstacle class
bench/out/problems/<scenario>/<config>.bg.svg|.png   background for rendering
bench/out/problems/<scenario>/scenario.json          manifest: configs (quick flag, size, files), sources
bench/out/problems/11-stability/<seq>/f000….json + sequence.json
bench/out/perf/scatter-200.json, scatter-2000.json, raster-2048.json   performance-target problems
bench-report/results.json, index.html, results/<solver>/…, metrics/<solver>/…, img/<solver>/…,
             overlay/<solver>/… (engine debug overlays), plots/runtime-{engine,wall}.svg
bench-report/gallery/index.html, img/*.svg, fonts/…, gallery.json    the gallery (python -m bench.gallery)
```

**truth.json** (every config; `bench/common/truth.py`) — `{"version": 1, "canvas": [W, H],
"classes": {<class>: {"circles": [[x, y, r]], "rects": [[x, y, w, h]],
"polylines": [{"points": [[x, y], …], "width": w}], "polygons": [{"rings": [[[x, y], …], …],
"fill_rule": "evenodd"}]}}, "rasters": [{"index", "mode", "class", "scale", "offset"}],
"includes_problem_vectors": true}` in canvas px. Background geometry is emitted by the same
drawing list that produced the SVG (`bench/common/scene.py`): fills → polygons/circles/rects,
strokes → polylines with the stroke width, text → its bounding box measured with the bundled
font. The problem's `obstacles.vector` layers are added mapped through `transform`/`y_axis`
(positioned shapes as polygons). Raster classes cannot be listed as geometry: `rasters` says
which raster source yields which class, and the evaluator derives the mask per pixel with
the definitions of spec §4.6. Item marks are defined by the problem's anchors (spec §3.2).

## Scenarios

| # | scenario | configs (quick first) | data | synthetic? |
|---|---|---|---|---|
| 01 | software metrics outliers | `cbo-rfc-10-none`, `cbo-rfc-30-vector`, `cbo-rfc-100-svg`, `wmc-loc-30-raster` | React Native 0.63.5 Android Java sources (1,206 classes), CK-style metrics | no |
| 02 | volcano plot | `top20-vector`, `top50-svg`, `top30-transform`, `nfcore-top20-vector` | Galaxy volcanoplot table (16,406 genes); nf-core DESeq2 results | no |
| 03 | Gapminder bubbles | `y2005-vector`, `y2005-svg`, `y1955-all-vector` | vega-datasets gapminder.json | no |
| 04 | embedding map | `k40-ink`, `k40-saliency`, `k120-areas` | 50,000 WordNet 3.0 noun glosses, t-SNE computed here | no (computed embedding) |
| 05 | airports on an SVG world map | `world-iata-300-none`, `world-iata-1000-vector`, `world-iata-1000-lower-vector`, `world-iata-3000-svg`, `europe-names-400-svg`, `europe-hubs-svg`, `world-hubs-100-svg` | OpenFlights airports/routes, Natural Earth countries | no |
| 06 | city POIs on raster tiles | `monaco-ink`, `monaco-saliency`, `monaco-pins-ink` | OpenStreetMap extract of Monaco, map rendered here | no (rendered tiles) |
| 07 | node-link | `lesmis-circles`, `lesmis-shapes`, `lesmis-force`, `flare-imports`, `cora-circles` | Les Misérables and Flare's imports (vega-datasets), Cora citation network | no |
| 08 | technical / anatomical illustration | `astronaut-boundary`, `retina-boundary`, `rocket-distant` | scikit-image sample photos + hand-made CC0 polygons | no |
| 09 | line chart end labels | `unemployment-14-vector`, `stocks-5-svg`, `life-62-boundary` | vega-datasets unemployment, stocks, gapminder | no |
| 10 | stress / scale | `n00200` … `n20000` (7 sizes) | scenario 05 at 10× density (jittered copies) | **yes** |
| 11 | interactive stability | sequences `zoom-pan-1000` (quick), `zoom-pan-3000` (30 frames each), `force-lesmis` (quick, 61 frames), `drag-lesmis` (quick, 41 frames) | scenarios 05 and 07 | camera path and force simulation only |
| 12 | priority showcase | `metrics-attr-strict` (quick) + 17 more `<dataset>-<type>-<mode>` (types attr, outlier, coverage; modes strict, prefix, weighted), `europe-attr-strict`, `europe-attr-prefix` | scenarios 01 and 05 | no |

217 problems in the full suite (incl. 162 sequence frames), all valid against the schema,
each ≤ 3.5 MB; the quick suite (11 configs + the three quick sequences, 132 frames) is ≈ 7.5 MB.
Every scenario directory documents what and why, the configs and the rendering recipe
(`README.md`) and the data licenses (`LICENSE.md`).

### Substitutions, emulations and synthetic data

* **01 — CK.** CK's jar-with-dependencies is not published on Maven Central and its
  Eclipse-JDT dependency closure cannot be fetched reliably (Central is rate-limited from
  the build environment). `CkLite.java` implements CK's definitions of CBO, RFC, WMC, LOC,
  NOM and NOF on the JDK's own javac syntax tree (no type attribution; documented in the
  file). Java sources come from the `react-native` npm tarball.
* **02 — DE table.** Two MIT-licensed tables on raw GitHub (Galaxy tools-iuc test data;
  nf-core test-datasets).
* **04 — embedding.** No precomputed embedding of an open corpus was reachable; the
  embedding is computed deterministically (TF-IDF → SVD → t-SNE, fixed seeds, one thread).
* **06 — tiles.** Tile servers are blocked, so the raster map is rendered locally from an
  OSM extract (planetiler's Monaco test resource) with our own PBF reader and style.
* **07 — citation network.** Cora (LINQS selection, distributed in the MIT-licensed
  `tkipf/pygcn` repository); paper titles are not part of that copy, so labels are the
  paper ids (with the last four digits as an `alternatives` fallback).
* **10, 11 — synthetic.** Scenario 10 jitters copies of real airports (σ = 0.6°, seed 10)
  to reach 10× density and 20,000 anchors; scenario 11 is a synthetic camera path over
  real data and a force simulation of a real graph (`bench/common/forcesim.py`).
* **Everywhere — SVG `ignore`.** Elements that must not interact with labels are mapped
  to the class `background` with `avoid.label/leader.background = "ignore"` because the
  literal class `"ignore"` does not validate in v1 (see *Spec findings*).

## Data sources and licenses

All downloads are pinned (commit-hash raw GitHub URLs, exact package versions) and
verified by SHA-256 (`bench/common/sources.py`); nothing is committed. Status: all 13
checksums verified on 2026-10-16 (the scikit-image sdist also matches PyPI's published
digest).

| source id | pinned location | SHA-256 | license | attribution |
|---|---|---|---|---|
| `react-native-0.63.5` | npm `react-native-0.63.5.tgz` | `4100debc…fd631eee` | MIT | React Native, © Facebook, Inc. and its affiliates |
| `galaxy-volcano-input` | `galaxyproject/tools-iuc@3b052d86` `tools/volcanoplot/test-data/input.tab` | `d80359b0…a16156a7` | MIT | Galaxy IUC; "Getting Genetics Done" (S. Turner) |
| `nfcore-srp254919-deseq2`, `-genemeta` | `nf-core/test-datasets@618f1541` `data/genomics/mus_musculus/rnaseq_expression/` | `4e62f213…76d8beae`, `adc433f0…b58a06b3` | MIT (SRA data unrestricted) | nf-core; SRA study SRP254919 |
| `vega-datasets-3.2.1` | npm `vega-datasets-3.2.1.tgz` | `6f72fda4…881cc5a3` | BSD-3-Clause package; gapminder CC BY 4.0, BLS data public domain | vega-datasets; Gapminder Foundation; U.S. BLS; D. E. Knuth (SGB) |
| `nltk-wordnet` | `nltk/nltk_data@550b6625` `packages/corpora/wordnet.zip` | `cbda5ea6…2646ab59` | WordNet 3.0 license | Princeton University, WordNet (2010) |
| `openflights-airports`, `-routes` | `jpatokal/openflights@56a3cce4` `data/` | `9387cdb3…d9ff59f9`, `bd373706…735f2390` | ODbL 1.0 / DbCL 1.0 | "Contains information from OpenFlights.org (ODbL)" |
| `ne-50m-countries` | `nvkelso/natural-earth-vector@ca96624a` `geojson/ne_50m_admin_0_countries.geojson` | `3e458fc0…a2b7fdeb` | public domain | "Made with Natural Earth" |
| `osm-monaco` | `onthegomap/planetiler@7a5e0c59` `planetiler-core/src/test/resources/monaco-latest.osm.pbf` | `a3fa87c1…7e88c9be` | ODbL 1.0 | "© OpenStreetMap contributors" |
| `cora-cites`, `cora-content` | `tkipf/pygcn@1600b5b7` `data/cora/` | `ec1a3723…42d5945e`, `b8ebed0f…46e9c8ee` | repository MIT; data: research use, no explicit license (not redistributed) | McCallum et al. 2000; Sen et al. 2008 |
| `scikit-image-0.26.0-sdist` | PyPI `scikit_image-0.26.0.tar.gz` | `f5f970ab…e59199fa` | BSD-3-Clause; images: NASA/SpaceX public domain, retina CC0 | NASA; SpaceX; M. Häggström |

Benchmark tooling dependencies (`requirements.txt`) are BSD-3-Clause, MIT or MIT-CMU.

## Evaluator metrics

`bench/eval/` (`evaluate(problem, result, truth)`, CLI `python -m bench.eval`). All
geometry is canvas px; tolerance **t = 0.5 px**: a box violates something only if the box
shrunk by t on every side still intersects it (label–label: overlap > t in both axes).
Hard/soft/ignore come from the effective options (defaults.md ← preset ← problem).

| group | metric | definition |
|---|---|---|
| placement | `placed_rate` | placed / items |
| | `placed_weighted` | Σ_placed g(rank) / Σ_all g(rank), g(r) = 1/log2(r + 2); rank = the result's `priority.rank`, else the reference priority order (input order without priorities) |
| | `required_placed` | every `required` item is placed |
| hard | `hard.total` and breakdown | `label_label` (pairs), `label_item` (label vs another item's true mark, `items` hard; the marks of items of lower key follow `avoid.label.lower_items` where given), `label_lower` (a placed item whose mark a label of higher key covers, with `avoid.label.lower_items` given and not hard, spec §4.4), `own_mark` (external label vs own mark: `hard` = intersects, `partial:f` = covers > f + 0.01 of the mark), `internal_outside` (internal label not inside its shape), `class:<k>` (hard vector classes from the problem and truth.json; raster classes: integral of the §4.6 pixel mask over the shrunk box > 0), `canvas_edge` (outside the canvas/region minus padding, unless `allow_outside`), `leader_leader` (proper crossings, contacts within t of an endpoint ignored), `leader_near` (leaders of two labels closer than the larger `leaders.clearance` − t without crossing, the start-start approach of neighbouring marks exempt, spec §7), `leader_angle` (distant leaders starting within 1 em that diverge by less than `leaders.min_angle_between`), `leader_label` (leader or underline through another label), `leader_own_label` (leader enters its own label; last segment exempt for `port: baseline`), `leader_item` (a leader within `leaders.clearance` − t of another item's mark, marks of its group and marks covering its anchor exempt) / `leader_class:<k>` (when hard for leaders), `leader_canvas` |
| | `hard.conflicts`, `hard.spacing` | the hard violations split into **conflicts** — geometric overlaps every labeler must avoid: labels over labels, marks, hard classes or the canvas edge, crossing leaders, leaders through labels or marks — and **spacing** rules of the engine: `leader_near`, `leader_angle` and `leader_item` pairs whose leader passes within the clearance of a mark without touching it |
| usable labels | `usable.{count,rate,weighted,in_conflict}` | the labels a host keeps by dropping conflicts in priority order: a label in a conflict of its own (over a mark, a hard class or the canvas edge; its leader through a mark or its own label) is dropped, and of two conflicting labels (overlap, crossing leaders, a leader through a label, a label over the mark of a placed item) the more important one stays; `weighted` as `placed_weighted`; equals placed for a result without conflicts. Compares tools that never omit a label (adjustText, D3-Labeler) with tools that do |
| spread | `spread.{regions,labeled,region_coverage}` | of the populated regions (cells of 8 em of the default font holding an item's reference point), the share with at least one label: whether labels spread over the data or crowd where it is sparse (even distribution; Imhof 1975) |
| soft coverage | `coverage.<class>.{mean,max,touching}` | covered px² / label px² per placed label (union area: exact clipping for one primitive, 1/8 px point sampling otherwise, ≤ 6 thin strokes: clipped length × width; raster classes: integral of the value map), averaged; also `items` (other marks) and `labels` (other labels); classes ignored for labels are skipped |
| leaders | `crossings`, `label_intersections`, `length_mean_em`, `length_max_em`, `bends_mean`, `rate` | pairs of crossing leaders (always counted), leader–other-label pairs, polyline length / label font size, points − 2 |
| visual (`bench/eval/visual.py`) | `leader_length.{p50_em,p90_em,max_em,max_diag,long,far}` | leader length / font size; `far` = longer than 25 % of the canvas diagonal (with `far_boundary`: those of boundary labels); `long` = longer than 10 em |
| | `near_crossings.{count,min_px,parallel}` | label pairs whose leaders come closer than 4 px without crossing (the start-start approach of neighbouring marks exempt): they read as crossing; `parallel` = distant leaders starting within 1 em that diverge by less than 10° |
| | `leader_marks.{touches,leaders_touching}`, `.classes.<k>.{points,lines,areas,leaders}` | leader–mark pairs passing within 1.5 px (half stroke + 1 px) of another item's mark (exemptions as `leader_item`); per vector class the primitives leaders pass that close (the first 3 px of a leader skipped: lines ending at the own mark) |
| | `labels_over.<k>.{points_hidden,lines_hidden,areas_hidden,lines_em}` | soft vector classes under placed labels: primitives touched (circles = points, polylines = lines, the rest = areas) and polyline length inside labels / font size |
| | `contrast.{labels,border,rate}` | with raster sources: labels across a contrast border, whose backdrop luma (Rec. 709 of the rasters in order over `canvas.background`, at each canvas pixel centre in the box) spreads by ≥ 0.5 between its 10th and 90th percentile, e.g. half on black and half on white; internal labels of point items skipped; `null` without rasters |
| ambiguity | `ambiguity.rate` | fraction of placed labels whose nearest item shape is not their own: signed distance from the label box (min over box points; ≤ 0 when overlapping); leadered labels: distance from the leader's first point to the outlines (a leader ending at a mark that lies on a larger one ends at the smaller one's outline) |
| shape fidelity | `adjacent_gap_mean`, `_abs_mean`, `_max_abs`, `adjacent_touch_rate` | gap = signed distance(box, own shape) − `placement.offset` for adjacent/slider labels without leader (target 0; touch = \|gap\| ≤ t) |
| | `own_mark_violations`, `internal_outside` | as above |
| | `internal_eligible`, `internal_rate` | placed items whose shape can contain the placed box grown by `placement.inner_padding` (circles exactly, rects/ellipses at the center, polygons at the pole of inaccessibility); rate = fraction of them placed internally |
| position | `position.rank_mean`, `hist` | PerceptPPO rank (top 0, right 1, bottom 2, left 3, top-right 4, bottom-right 5, top-left 6, bottom-left 7) of adjacent labels by `anchor_side` |
| priority | `inversions` | **removal test**: an omitted h counts if any of its fixed adjacent positions (support-function placement around the true shape ⊕ offset, spec §6.1: the 8 positions, or only those of an explicit `position_order` list, when the `adjacent` model is enabled; area anchors also their pole unless `internal: never`) is free given only the placed labels/leaders of key ≥ key(h), the marks of all other items (those of lower key per `lower_items`) and the hard classes; with `avoid.label.lower_items` soft, h whose mark a placed label of higher key covers is not counted; conservative: the candidate box is *grown* by t; key = (required, tier, reserved, band(score)); items without such candidates (e.g. `models: ["distant"]`) are counted in `removal_untestable` |
| | `prefix_length`, `prefix_rate` | items at the start of the priority order that are all placed |
| | `ndcg_at_k` | k = placed; DCG = Σ_j g(rank of the j-th placed in rank order)/log2(j + 2), normalized by the ideal (the top-k); 1 iff the placed set is a prefix |
| | `coverage.satisfaction` | groups of `priority.coverage.by` (canonical JSON of the value) with ≥ min(min_per_group, group size) placed labels / groups |
| | `rank_source`, `reported_inversions` | where ranks came from; the result's own stat for comparison |
| text | `wrapped`, `alternative`, `truncated`, `shrunk` | fractions of placed text labels (incl. composite text parts): > 1 line without wrap settings, `used` = `alternative:i`, `used` = `truncated`, `scale` < 1 or smaller font |
| runtime | `runtime_ms`, `wall_ms` (runner: median, p95, runs), `iterations`, `time_guard_hit` | from `stats` and the runner |
| memory | `peak_rss_mb` (runner: median, max) | peak resident memory of the solver process (external commands: the engines' CLIs, `os.wait4`), steady state after `--warmup` solves |
| checks | `result_check` | result schema errors, unknown/missing/duplicate ids, placed without box |
| stability | `displacement_mean_px`/`_median_px`/`_mean_em`, `flip_rate`, `added_total`, `removed_total`, `nesting_rate`, `nesting_fraction_mean` | consecutive frames: change of (box center − anchor) for labels placed in both; side flips; labels appearing/disappearing among items visible in both; zoom-in steps with P_t ∩ V_{t+1} ⊆ P_{t+1} |

The **reference priority** (used when a result does not report `priority` for every
placement) implements `item.priority/tier/required`, `priority.terms` (`attr`, `expr` via
a Python implementation of `spec/expr.peg`, transforms, `rank`/`minmax`/`none`
normalization), `priority.tiers`, `priority.coverage` reservations and the tie rules. The
built-in terms are approximated (their exact definitions live in the engine):
outlierness = mean distance to the k nearest anchors, isolation = nearest-anchor distance,
crowding = −anchors within 4 em, label_size, mark_size, centrality = −distance to
`priority.focus`, degree = `attrs.degree`, input_order = −index.

Text measurement for omitted items (removal test) re-implements spec §5.2 simple shaping
(cmap, hmtx, GPOS kern pair adjustment with IgnoreMarks, typo metrics) and §5.3 line
breaking with fontTools on the bundled Noto Sans; the label box is the first normal
variant (`balanced(L_min)` under wrap settings).

## Renderer

`bench/render.py` draws, identically for every solver: background (embedded raster, SVG
embedded as image in SVG output, `<config>.bg.png` for PNG output), vector obstacles
(only without a background image), item marks with their true shapes (area anchors
dashed), label boxes, text at the reported `baseline_offsets` and `x_offset` with Noto Sans
from `fonts/` (PNG: glyphs positioned with the same GPOS kerning as the measurement),
composite icon parts, leaders and underlines, and unplaced items as red ×. PNG output uses
Pillow (2× supersampling); no LGPL rasterizer is involved.

## Runner

`bench/run.py` discovers problems from the scenario manifests, runs every solver
`--runs` times (default 7; baselines `--baseline-runs` times, default 1; runtime median and
p95 by nearest rank, wall time and `stats.runtime_ms`), checks determinism (identical
placements across runs), evaluates the last result (with the truth), renders PNGs (`--svg`:
also SVGs; `--no-render`: none) and writes `bench-report/results.json` and the static report
`bench-report/index.html` (see *Report*). Solvers: the built-in baselines `naive`, `greedy`,
`textalloc`, `adjusttext`, `vega-label`, `ggrepel` (`--baselines` = all of them), or
`NAME=COMMAND` with `{problem}` and `{result}` placeholders (`--timeout` seconds per run,
default 600); `--engine PATH` adds `rust=PATH place {problem} -o {result}`. Solvers named
`rust`, `wasm` or `ts` (optionally `-suffix`) are the Label Anything implementations: they
get the performance targets, the parity table and the release gates. `--overlay
NAME=COMMAND` (`{problem}`, `{result}`, `{svg}`) renders the engine's debug overlay (cost
grids, candidates) from one extra untimed run; `--engine` sets it up for `rust` with `place
--debug-svg`. Sequences are solved frame by frame; frame t+1 gets `warm_start.placements` =
frame t's placements with each box (and leader) shifted by its anchor's movement.
Third-party baselines solve a problem with soft classes twice — avoided like hard ones and
left out — and keep the better result by their own usable labels (`--baseline-soft best`, the
default; see `bench/baselines/README.md`). The peak resident memory of every external solver
run is recorded (`peak_rss_mb`).
`--suite quick` = configs marked `quick` (one small config per scenario) + the quick
sequences; `--suite full` = everything; `--scenario` restricts to scenario ids. Further
flags: `--perf` (performance targets), `--previous OLD/results.json` (changes), `--gate`
(release gates, implies `--perf`; the exit code reflects them), `--require-baselines` (a
missing toolchain is an error instead of a skip). Without `--gate` the exit code is 1 when
any solver failed on any problem ("n/a" is not a failure).

## Baselines

`naive` and `greedy` exist so the pipeline is testable without the engine and as reference
rows: `naive` puts every label top-right of its true shape (area anchors: internal at the
pole) without collision handling; `greedy` processes items in the reference priority order
and takes the first position of the item's position order (area anchors: their pole
first) that stays in the label area and is free of placed labels, other marks and hard
vector/raster classes. It always uses the adjacent model (no leaders, no degradation, it
ignores `models`) and does not parse SVG backgrounds.

The third-party baselines of brief §8.3 — **textalloc**, **adjustText**, **vega-label** (Vega's
label transform, headless in Node) and **ggrepel** (R; final positions read from the drawn grob
tree after `grid.force()`) — and the label layouts of two widely used chart libraries,
**d3fc** (`d3fc-label-layout`, greedy + removeOverlaps) and **ECharts** (`labelLayout.hideOverlap`,
rendered server-side), plus the classic simulated annealing of **D3-Labeler**, live in
`bench/baselines/` with pinned toolchains (`requirements.txt`, `package.json` +
`package-lock.json`, `install-r.sh`, `vendor/`). Each adapter
translates a problem into the tool's native input in canvas pixel coordinates, hands the tool
the problem's own label boxes (spec §5 measurement, padding included) and the items in priority
order, and converts the tool's output back into a result; features a tool cannot express are
emulated (raster masks as cells or pixel runs, SVG backgrounds as their truth geometry, lines
as sampled points, soft costs as hard obstacles or left out, whichever serves the tool better)
or reported "n/a", and every emulation is
listed in the result's `warnings` and marked ≈ in the report. Methods, parameters, the
emulation table and the ggrepel extraction: `bench/baselines/README.md`. A baseline whose
toolchain is missing is skipped with a message.

## Performance targets

`bench/perf/` turns the targets of brief §5.8 into deterministic problems and measurements:

| problem | what | Rust | WASM | TS |
|---|---|---|---|---|
| `scatter-200` | 200 labels + 10k obstacle points, 800×600, preset scatter, greedy | ≤ 15 ms | ≤ 30 ms | ≤ 60 ms |
| `scatter-2000` | 2,000 labels + 100k obstacle points, 1920×1080, greedy | ≤ 120 ms | ≤ 250 ms | ≤ 600 ms |
| `raster-2048` | 2048² synthetic raster background, ink mode: `stats.phases_ms.prepare` | ≤ 25 ms | ≤ 60 ms | ≤ 150 ms |

Items are `{"id": "i<k>", "anchor": {"type": "point", "x", "y"}, "label": {"type": "text", "text":
"Label <k>"}}` with anchors (and obstacle points, one vector layer `{"class": "points", "r":
1.5}`) uniform in [10, w − 10] × [10, h − 10] from SplitMix64 with fixed seeds, rounded to 0.01 px,
so any implementation can regenerate byte-identical files; the raster is drawn without randomness
(grid lines, stripes, discs, a gradient band) and passed as raw RGBA, so no image codec is timed.
The measured value is the median over the runs of the engine's own timing (`stats.runtime_ms`,
or `stats.phases_ms.prepare`), not the process wall time, which process start-up dominates. The
targets hold for one thread: the native engine runs with `RAYON_NUM_THREADS=1` (`--threads N`,
`bench/run.py --perf-threads N`; 0 = all cores).

```sh
bench/.venv/bin/python -m bench.perf --engine rust/target/release/label-anything --runs 7
bench/.venv/bin/python -m bench.perf --solver 'ts=node ts/packages/cli/dist/main.js place {problem} -o {result}'
bench/.venv/bin/python -m bench.perf generate bench/out/perf      # the problems only
```

## Report

`bench-report/index.html` (static, no external scripts) and `results.json` contain:

* a **summary** per solver (problems run / n/a / failed, mean placed and usable rate, hard
  violations and conflicts, ambiguity, inversions, summed runtimes, peak memory, and the
  empirical scaling exponent k of runtime ∝ nᵏ over the stress scenario's sizes);
* the **performance-target table** (median, target, ratio, every run) and the **release-gate**
  summary when evaluated;
* **runtime vs. problem size**: log–log small multiples — one panel for the Label Anything
  implementations and one per baseline against the reference implementation — for the
  engine-reported and the wall-clock runtime, inline and as `plots/runtime-*.svg`, with a
  table view;
* **implementation parity**: per problem the deltas of every metric between `rust` and `ts` /
  `wasm`, and whether the placements are identical;
* **changes vs. the previous release** (`--previous`): every changed metric, regressions beyond
  2 % (relative; any change away from 0 counts; direction per metric) highlighted, runtimes
  excluded;
* per scenario: the metric table (Label Anything rows bold, baseline emulations marked ≈ with the
  details in the tooltip, n/a rows with the reason) and the renderings side by side — every
  solver drawn by `bench/render.py`, plus the engine's debug overlay;
* the stability sequences and the baseline methods with the versions that ran.

`python -m bench.report bench-report/results.json [--previous OLD/results.json] [--gate]` rebuilds
the analyses and `index.html` of an existing run without solving anything again. Comparisons
happen at the precision `results.json` stores (6 decimals), so a stored run and a fresh one
with identical results show no change.

## Gallery

`python -m bench.gallery --engine rust/target/release/label-anything --run bench-report` writes
`bench-report/gallery/` (`index.html`, `img/*.svg`, `fonts/`, `gallery.json`): selected problems
of the full suite — hub-first airport maps, charts, photos, embeddings, networks, priority —
each solved once with the engine (`--warmup 3`, as by the runner) and drawn by the renderer as
one self-contained vector image (`render.standalone_svg`: SVG backgrounds inlined, raster
backgrounds embedded, the label text in an embedded subset of Noto Sans with every glyph at the
measured pen position), under it the evaluator's numbers (placed, leaders and the longest one,
hard violations, the omitted labels by reason), the engine's runtime and the settings the
problem gives; from the run, its results of three problems by every baseline and three frames
of its stability sequence, drawn the same way; and, last, what the engine still does badly, with
figures. Selecting an image opens a viewer for inspecting it: pinch, double-tap or scroll to
zoom (once a zoom settles, the vector image is drawn again at that size, so it stays sharp),
drag to pan, swipe or use the arrow keys for the next image; between the labelers' renderings
of one problem the view stays where it is, for comparing the same spot. The problems must be
built (`python -m bench.scenarios build` builds every config); a figure whose problem is
missing is left out. The page uses one font weight and loads nothing from other servers (Noto
Sans is copied next to it). A gallery written into its run directory is linked from the run's
report; the CI `baselines` job builds both, so the Pages workflow publishes the gallery at
`<site>/benchmark-report/gallery/`. `bench/gallery.py` lists the figures and their captions.

**Data colors.** An item whose `attrs.color` is a `#rrggbb` string is drawn in that color by the
renderer (PNG, SVG and standalone SVG) — the region of a bubble, the series of a line end, the
community of a node, the significance of a gene — so that labeled marks keep the color the
chart gives the data; other items are blue. The engine ignores the attribute.

## Release gates

`--gate` (or `python -m bench.gates results.json [--previous OLD/results.json]` on an existing run)
fails unless, for the Label Anything solvers, every problem was solved with **0 hard violations**,
**no metric regressed by more than 2 %** against `--previous` (skipped, not failed, without it),
and the **performance targets** were measured and met. Accepted regressions are listed in
`bench/gates-allow.json` (`metric`, `scenario`, optional `config` / `solver` patterns, `adr`,
`reason`); an entry counts only if `docs/adr/<adr>-*.md` exists. The summary is printed and
stored in `results.json` (`gate`). Release procedure: `docs/benchmark.md`.

## Milestone acceptance (M3, M4)

`python -m bench.milestones results.json` checks two acceptance criteria of the design brief
on a run: **M3**, 0 leader crossings on every problem and every sequence frame of every
Label Anything solver; **M4**, on the dense problems (where the greedy pass omits labels)
the full solve improves `placed_weighted` by at least 5 % over the greedy pass alone at the
same budget, with no new priority inversions (in the sense of each problem's omission mode).
Greedy is a twin solver `<name>-greedy` run with `--strategy greedy --degrade omit`: the
degradation ladder belongs to M4 like the local search. `--baseline ladder` compares with a
twin `<name>-ladder` (`--strategy greedy`, the ladder on) instead: the local search's own share.

```sh
E=rust/target/release/label-anything
python bench/run.py --suite full --engine $E --runs 1 --warmup 0 --no-render --out /tmp/milestones \
    --solver "rust-greedy=$E place {problem} -o {result} --strategy greedy --degrade omit" \
    --solver "rust-ladder=$E place {problem} -o {result} --strategy greedy"
python -m bench.milestones /tmp/milestones/results.json
python -m bench.milestones /tmp/milestones/results.json --baseline ladder
```

## Docker and CI

`bench/Dockerfile` builds one image with every toolchain — Python 3.13 with the bench and
baseline requirements, Node 22 with the vega-label lockfile, R 4.3.3 with ggrepel 0.9.5 /
ggplot2 3.4.4 (Ubuntu 24.04 packages), a JDK for scenario 01 and Rust for the engine CLI:

```sh
docker build -f bench/Dockerfile -t label-anything-bench .
docker run --rm -v la-bench-data:/la/bench/data -v la-bench-out:/la/bench/out \
    -v "$PWD/bench-report:/la/bench-report" label-anything-bench                    # quick suite
docker run --rm -v la-bench-data:/la/bench/data -v la-bench-out:/la/bench/out \
    -v "$PWD/bench-report:/la/bench-report" label-anything-bench --suite full --runs 7 --gate
```

The entrypoint (`bench/docker-run.sh`) fetches the data, builds the scenarios once per volume and
runs `bench/run.py --suite quick --engine … --baselines --require-baselines --perf` plus the
given arguments. In CI, the `bench` job runs the quick suite with the engine on pull requests
(full suite on tags); the `baselines` job (tags, manual dispatch, weekly) runs the quick suite
with the engine and every baseline plus the performance targets, builds the gallery into the
report, uploads it and, on tags, checks the release gates. When the CI run of a release tag succeeds, the Pages workflow
(`.github/workflows/pages.yml`) publishes that report with the documentation site, under
`benchmark-report/`.

## Determinism and reproducibility

Fixed seeds everywhere (jitter, permutations, layouts, k-means, SVD, t-SNE); JSON is
written with sorted keys and floats rounded to 3 decimals; PNGs are encoded without
metadata. Rebuilding every scenario with the same inputs gives byte-identical problem,
truth and background files (checked for all scenarios). The t-SNE of scenario 04 runs with
single-threaded BLAS/OpenMP so its float reductions do not depend on the thread count;
results can still differ across numpy/scikit-learn versions or CPU architectures, which
is why the embedding is cached and the versions are pinned.

## Spec findings (reported, not changed here)

* `svgClassRule.class`, `svgSource.default_class` and `rasterSource.classmap` values are
  `oneOf [className, const "ignore"]`, but `"ignore"` also matches the `className`
  pattern, so the documented value `"ignore"` never validates (oneOf requires exactly one
  match). Fix: `anyOf`, or exclude `ignore` from `className`.
* Composite labels: the defaults of `gap` and of the parts' `padding` are not specified
  (the benchmark always sets both explicitly; the evaluator assumes 0 when absent).
* The built-in priority terms (`outlierness`, `isolation`, `crowding`, …) have no normative
  definition in spec.md; the evaluator's fallbacks are listed above.
