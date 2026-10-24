# Benchmark: release procedure and how to read the report

The real-world benchmark (`bench/`, details in `bench/README.md`) compares every Label Anything
implementation with each other and with nine baselines on twelve scenarios built from real data,
and enforces the release gates. This page is the maintainer's view: what to run before a release,
what the gates check and how to read the report.

## Before tagging a release

```sh
cargo build --release --manifest-path rust/Cargo.toml -p label-anything-cli
npm ci && npm run build && npm run build:wasm -w @label-anything/wasm
bench/.venv/bin/python bench/run.py --suite full --runs 7 \
    --engine rust/target/release/label-anything --ts --wasm \
    --baselines --gate --previous path/to/previous-release/results.json
```

`--ts` and `--wasm` run the TypeScript engine and the WebAssembly build through the TypeScript
CLI (`label-anything-ts place [--engine wasm]`). All three implementations are timed in steady
state: `--warmup 3` solves in the same process precede every timed solve, as in a host
application that solves repeatedly (a fresh process also times font loading, first-touch memory
and, for JavaScript, compiling the engine).

or, equivalently for the Rust engine alone,
`label-anything bench --suite full --baselines --gate --previous path/to/results.json`.
Keep the run's `bench-report/results.json` with the release (it is the `--previous` of the next
one). The `baselines` CI job runs the quick suite with every baseline on each tag (and weekly),
builds the gallery into the report (`python -m bench.gallery`, see `bench/README.md`) and checks
the gates on tags; the full suite with `--previous` is the release run. When the CI run of a tag
succeeds, the Pages workflow deploys the documentation site of the tag with that run's report
under `benchmark-report/` and the gallery under `benchmark-report/gallery/`; after a weekly or
dispatched CI run of `main`, the site of `main` with that run's report. Dispatched by hand, it
publishes the report of the CI run given as `report_run_id`, else the latest one.

## Release gates

The run fails (exit code 1, summary printed and stored as `gate` in `results.json`) unless, for
the Label Anything solvers (`rust`, `wasm`, `ts`):

1. every problem and sequence is solved and the evaluator finds **0 hard violations**;
2. **no metric regresses by more than 2 %** relative to `--previous` — placement rates, NDCG,
   priority inversions, hard violations, crossings, ambiguity, clarity, covered points, label
   spacing, gap, position rank, soft coverage and the stability metrics, each in its own
   direction; a change away from 0 always counts;
   runtimes are excluded (target 3 covers them). Without `--previous` the check is skipped;
3. the **performance targets** of brief §5.8 are measured and met for every implementation in the
   run: 200 labels + 10k points (800×600) ≤ 15 / 30 / 60 ms, 2,000 labels + 100k points
   (1920×1080, greedy) ≤ 120 / 250 / 600 ms, 2048² raster preparation ≤ 25 / 60 / 150 ms for
   Rust / WASM / TS, as the engine's own median timing (`stats.runtime_ms`,
   `stats.phases_ms.prepare`) in steady state, on one thread.

A deliberate regression (a trade-off accepted for a better result elsewhere) needs an ADR in
`docs/adr/` and an entry in `bench/gates-allow.json`:

```json
{"allow": [{"metric": "placed_rate", "scenario": "05-airports", "config": "*", "solver": "rust",
            "adr": "00NN", "reason": "labels near the antimeridian now omitted instead of clipped"}]}
```

Entries naming an ADR that does not exist are ignored and reported.

## Where the performance targets stand

The targets of brief §5.8 hold for one thread, so `bench.perf` runs the native engine with
`RAYON_NUM_THREADS=1` (`--threads`; the WebAssembly and TypeScript engines are single-threaded
anyway). `python -m bench.perf --engine rust/target/release/label-anything --ts --wasm --runs 7`
at commit a0a4eab (2026-10-17) on a 4-core cloud VM (Intel Xeon @ 2.1 GHz, Linux, Node 22),
median engine time in ms (target in parentheses):

| problem | Rust | WASM | TS |
|---|---:|---:|---:|
| 200 labels + 10k points | 23.3 (15) | **26.2** (30) | **59.1** (60) |
| 2,000 labels + 100k points, greedy | 313.5 (120) | 385.0 (250) | 825.4 (600) |
| 2048² raster preparation | 27.9 (25) | **36.8** (60) | **113.3** (150) |

Four of the nine targets are met on this VM, the TypeScript one for 200 labels only just;
runs vary by about ±10 %. The same native engine on the GitHub-hosted runner of the CI
benchmark (weekly or dispatched, `ubuntu-24.04`) took 18.1, 272.4 and 20.8 ms: there the
raster target is met. The brief sets the targets for a 2023 laptop, whose cores are faster
than either machine's, but the gate checks them as measured, on whatever machine runs the
benchmark. The 2,000-label problem misses in every implementation, natively by a factor of
2.3 to 2.6.

Where its time goes (native engine, instruction counts of one solve, which do not depend on
the machine): two thirds in the greedy pass. Of the 2,000 labels, 1,509 find no room at
level 0 and run the degradation ladder; 1,128 of them are omitted in the end. Their wrapped
and shrunk variants get adjacent, slider and distant candidates, about a hundred boxes per
variant and a million in all, and each box is tested against the marks of the other items
and against the placed labels: 57 % of the greedy pass. The on-demand distant candidates at
level 0 take 18 %, explaining why a label was omitted (the `reason` and `blocked_by` of the
result) 13 %. Preparing the 100k obstacle points takes 13 % of the solve, building the
model from the problem and the result about 10 %. On a map the explanations weigh more: 17 %
of the 1,000-airport solve, where most of the 474 omitted airports have no candidate their
neighbours' marks leave free, so that the search for one evaluates every candidate of
every variant again; stopping each evaluation at the first hard conflict, the result the
same, would save 5.5 % there and 0.6 % on the stress problem. No function takes more than 5 %: removing
allocations, filtering boxes before their candidates are built, other inlining and link-time
optimization changed the time by less than the noise. What would help is less work per
omitted label — fewer ladder variants, no distant candidates for shrunk ones — and each such
change places fewer labels. The label margin of [ADR 0028](adr/0028-label-margin.md) costs time here too:
without it (`defaults.margin: 0`, `placement.offset: 2`) the problem places 972 labels instead
of 872, and solves about 10 % faster, as fewer labels go through the ladder.

The same profile at commit fad9db0 (after the lookahead bound of ADR 0047, which made the greedy
pass about 10 % faster): 1.38 G instructions in the solve; the CLI spends another 0.5 G outside the
timed solve, parsing the 1.8 MB problem, validating it against the schema and writing the
result, which a fresh process's wall time includes. The TypeScript engine has one cost of its own:
garbage collection, 11 % of its time. A solve allocates about 355 MB of short-lived objects — a
candidate object, its leader, rectangle and points for each of the hundred thousand candidates,
a fifth of it in the distant candidates — and the ladder's candidates stay alive for the
explanations, so they reach the old generation and cost full collections (46 ms each). Storing
the candidates as arrays of numbers instead of objects would remove most of it.

## Milestone acceptance

`python -m bench.milestones` checks two acceptance criteria of the design brief on a run of
the full suite (`bench/README.md` has the command). At commit d80414b (2026-10-16), same
machine:

* **M3, leaders: passed.** 0 leader crossings on all 345 solves — every problem and every
  frame of the two scenario-11 sequences, for the full solver and the two greedy variants
  below.
* **M4, optimization: passed against the greedy pass alone.** On the 36 dense problems
  (where the greedy pass omits labels), the full solve's `placed_weighted` is 57.6 % above
  that of the greedy pass alone on average (median 28.2 %; needs 5 %), with no new priority
  inversions. Greedy is the greedy pass of brief §5.6 without the degradation ladder
  (`--strategy greedy --degrade omit`), since the brief runs the ladder "at the end of
  greedy" and lists it under M4.
* **Read with the ladder as part of greedy, M4 is not met:** the local search alone adds
  +0.7 % on average (median +0.1 %) over the greedy pass *with* the ladder
  (`--baseline ladder`), and even 20 times the iterations add at most 1.7 % (six
  airport, POI and stress problems tried). With strict priorities the greedy pass and the
  ladder already secure the high-priority labels that dominate `placed_weighted`; the local
  search mostly lowers costs and adds a few low-priority labels.
* Eight problems were not compared because a solve hit the time guard: the three stress
  problems with 5,000 to 20,000 labels and five priority problems (four with 3,221 airports,
  one with 1,206 classes), where preparation, the candidates and the greedy pass take longer
  than the 100 ms default budget allows (the greedy pass stops at 10 times the budget, the
  local search starts only before 3 times). Their results depend on the machine; give such
  problems a larger `solver.time_budget_ms`.

## Visual quality

Hard constraints do not catch everything a reader perceives as clutter. The evaluator
also measures leader length (relative to the canvas diagonal), near crossings (two
leaders closer than 4 px without crossing), parallel leaders of neighbouring marks,
leaders passing other marks and data primitives, and the points and line length hidden
by labels (`bench/README.md`, *Evaluator metrics*; columns *near cross.*, *leader–mark*,
*far leaders*, *leader p90 em*, *points hidden* and *lines hidden em* of the report).
They motivated the leader spacing rules, the default ladder without margin labels and the
coverage costs per em² of [ADR 0019](adr/0019-visual-quality-defaults.md). Full suite,
deterministic solves (`--no-clock`, default budgets), before → after that change:

| | before | after |
|---|---|---|
| labels placed | 13,307 | 13,000 (−2.3 %) |
| leaders longer than ¼ of the canvas diagonal | 169 | 0 |
| near crossings | 1,424 | 1 |
| leader–mark touches | 25,505 | 0 |
| points hidden by labels | 1,862 | 1,524 (−18 %) |
| line length hidden by labels | 3,506 em | 2,855 em (−19 %) |

The labels that are lost are those whose only positions needed a leader through a dense
cluster of marks or across the picture.

## Whose label is it

A reader takes a label for the label of the point nearest to it, and a label about as near
to another point could be either's. The evaluator measures this for every solver
([ADR 0056](adr/0056-benchmark-measures-whose-a-label-is.md); `bench/README.md`,
*association*; columns *unclear*, *points covered* and *labels close* of the report):

* **Clarity** — by how much a label's own point is nearer than any other data point: the
  marks of all point items, labeled or not, and the circles of the obstacle classes labels
  do not ignore (the unlabeled points of a scatterplot or map). Below 0 a label is
  *misattributed*, below 0.2 em *unclear*, below 0.5 em *weak*; points closer together
  than the threshold need only the distance between them. A point hidden entirely under
  the label does not compete; a labeled leader counts when another point comes within
  0.2 em of its box.
* **Points covered** — data points under a label other than their own, whatever the
  avoidance settings, and those hidden entirely.
* **Labels close** — labels nearer than 0.4 em to another label: neighbouring labels that
  close read as one.

Quick suite, the 9 problems every solver runs, 2026-10-24:

| solver | placed | unclear | of which by background points | labels close |
|---|---:|---:|---:|---:|
| Label Anything | 631 | 24.1 % | 104 of 152 | 0 |
| — main branch before ADR 0050 | 617 | 29.5 % | 110 of 182 | 22.0 % |
| textalloc | 627 | 34.3 % | 94 of 215 | 14.8 % |
| adjustText | 719 | 24.9 % | 75 of 179 | 37.4 % |
| ggrepel | 666 | 35.7 % | 92 of 238 | 18.9 % |
| vega-label | 554 | 40.4 % | 116 of 224 | 11.9 % |

The 300-airport world map, with 2,917 unlabeled airports, holds 144 of the engine's 152
unclear labels; on the other 8 problems the engine has 2.0 % unclear labels, the other tools
9–20 %. What remains is what the engine's rule does not see: background points, and the
marks of less important items that the `map` preset lets labels cover.

## Reading the report

* **Summary** — one row per solver. Label Anything rows must show 0 hard violations; baselines
  usually do not (adjustText and D3-Labeler never omit labels, ggrepel's repulsion is not
  guaranteed to separate everything, d3fc and ECharts compare labels only, the naive baseline
  ignores collisions). *Usable* counts the labels left when conflicts are dropped in priority
  order — the fair number to compare across tools; *conflicts* are the hard violations
  without the engine's own spacing rules (leader clearance and angles). *Unclear*, *points
  covered* and *labels close* say whose a label is, what it hides and how close labels
  stand (see *Whose label is it*). *Peak MB* is the
  largest resident memory of a solver process, *runtime ∝ n^k* the slope of log runtime over
  log size on the stress scenario (full suite).
* **Performance targets** — median engine time per target and implementation, with every run.
  Machine details are printed; compare numbers from the same machine only.
* **Runtime vs. size** — log–log small multiples; the engine-reported chart compares the solve
  itself, the wall-clock chart includes process start-up (Node, R, Python imports).
* **Implementation parity** — the TypeScript and WASM implementations are meant to reproduce the
  Rust results; any non-zero delta or "identical: no" is a parity bug or an ADR-documented
  difference.
* **Changes vs. previous** — regressions are red (▲), improvements green (▼).
* **Scenarios** — metric tables and the renderings side by side. ≈ marks a baseline result that
  relies on an emulation (hover for the list); "n/a" means the tool cannot run the problem at all.
  The engine's debug overlay shows the cost grids and the candidates it considered.

Baselines are configured from the problem (canvas, label area, offsets, priority order, obstacle
classes) with tool defaults elsewhere; they cannot express leader styles or boundary labels, and
receive raster and SVG backgrounds as emulations. They have no soft costs either: a problem with
soft classes is solved both with them avoided like hard obstacles and with them left out, and
the report keeps whichever gives the tool more usable labels (`--baseline-soft`). Avoiding them
always — as the benchmark did until 2026-10 — left vega-label 2 of 375 labels on the Monaco
tiles where it places 154 now. Their rows are reference points, not tuned competitors:
`bench/baselines/README.md` lists every choice.
