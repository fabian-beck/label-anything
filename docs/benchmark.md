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
one). The `baselines` CI job runs the quick suite with every baseline on each tag (and weekly)
and checks the gates on tags; the full suite with `--previous` is the release run.

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
   `stats.phases_ms.prepare`) in steady state.

A deliberate regression (a trade-off accepted for a better result elsewhere) needs an ADR in
`docs/adr/` and an entry in `bench/gates-allow.json`:

```json
{"allow": [{"metric": "placed_rate", "scenario": "05-airports", "config": "*", "solver": "rust",
            "adr": "00NN", "reason": "labels near the antimeridian now omitted instead of clipped"}]}
```

Entries naming an ADR that does not exist are ignored and reported.

## Where the performance targets stand

`python -m bench.perf --engine rust/target/release/label-anything --ts --wasm --runs 7` at
commit 6f4ed69 (2026-10-16) on a 4-core cloud VM (Intel Xeon @ 2.1 GHz, Linux, Node 22),
median engine time in ms (target in parentheses):

| problem | Rust | WASM | TS |
|---|---:|---:|---:|
| 200 labels + 10k points | **14.1** (15) | **21.6** (30) | **46.8** (60) |
| 2,000 labels + 100k points, greedy | 244 (120) | 323 (250) | 665 (600) |
| 2048² raster preparation | **21.7** (25) | **39.4** (60) | **101.6** (150) |

Six of the nine targets are met on this machine; the 2,000-label problem is not, in any
implementation. About half of its time goes to the degradation ladder of the ≈ 1,400 labels
that find no room at level 0 (most of them, ≈ 1,050, are omitted in the end): every ladder step
generates and tests the candidates of new label variants against the placed labels, one item
after the other. The Rust engine runs the order-independent phases on all cores (feature
`parallel`: obstacle rasterization, level-0 candidates, the distance transform), which the
WebAssembly and TypeScript engines cannot. Numbers from a faster machine are lower; compare
numbers from the same machine only.

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
