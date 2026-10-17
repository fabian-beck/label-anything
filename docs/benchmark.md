# Benchmark: release procedure and how to read the report

The real-world benchmark (`bench/`, details in `bench/README.md`) compares every Label Anything
implementation with each other and with six baselines on twelve scenarios built from real data,
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
   priority inversions, hard violations, crossings, ambiguity, gap, position rank, soft coverage
   and the stability metrics, each in its own direction; a change away from 0 always counts;
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
model from the problem and the result about 10 %. No function takes more than 5 %: removing
allocations, filtering boxes before their candidates are built, other inlining and link-time
optimization changed the time by less than the noise. What would help is less work per
omitted label — fewer ladder variants, no distant candidates for shrunk ones — and each such
change places fewer labels. The label margin of [ADR 0028](adr/0028-label-margin.md) costs time here too:
without it (`defaults.margin: 0`, `placement.offset: 2`) the problem places 972 labels instead
of 872, and solves about 10 % faster, as fewer labels go through the ladder.

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

## Reading the report

* **Summary** — one row per solver. Label Anything rows must show 0 hard violations; baselines
  usually do not (adjustText never omits labels, ggrepel's repulsion is not guaranteed to
  separate everything, the naive baseline ignores collisions).
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
classes) with tool defaults elsewhere; they cannot express soft costs, leader styles, boundary or
internal labels, and receive raster and SVG backgrounds as emulations. Their rows are reference
points, not tuned competitors: `bench/baselines/README.md` lists every choice.
