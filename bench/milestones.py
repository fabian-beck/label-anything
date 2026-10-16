"""Acceptance checks of the brief's milestones M3 and M4 on a benchmark run.

* **M3 (leaders):** 0 leader crossings on every problem and every sequence frame (these
  evaluated here from the frame results next to ``results.json``), for every Label
  Anything solver of the run.
* **M4 (optimization and robustness):** "placed_weighted improves ≥ 5 % over greedy on
  dense scenarios at the same budget, with no new priority inversions". Greedy is the
  greedy pass of brief §5.6 alone: the degradation ladder runs "at the end of greedy"
  (§5.7) and belongs to M4 like the local search and the ejection chains. The baseline is
  therefore a twin solver ``<name>-greedy`` run with ``--strategy greedy --degrade omit``;
  the full solve is ``<name>``, with the problem's own settings and the same time budget.
  Dense problems are those where the greedy pass omits labels. The check passes when
  ``placed_weighted`` improves by at least 5 % (relative, mean over the dense problems)
  and no problem gains priority inversions in the sense of its omission mode (strict and
  weighted: the evaluator's removal test; prefix: placed items after the first omitted
  one). Problems where either solve hit the time guard (the greedy pass cut at 10 × the
  time budget, or no time left for the local search) are listed but not compared: their
  results depend on the machine's speed.

``--baseline ladder`` compares ``<name>`` with a twin ``<name>-ladder`` run with
``--strategy greedy`` (the greedy pass with the ladder): the share of the local search
alone, reported for information::

    E=rust/target/release/label-anything
    python bench/run.py --suite full --engine $E --runs 1 --warmup 0 --no-render --out /tmp/m \\
        --solver "rust-greedy=$E place {problem} -o {result} --strategy greedy --degrade omit" \\
        --solver "rust-ladder=$E place {problem} -o {result} --strategy greedy"
    python -m bench.milestones /tmp/m/results.json
    python -m bench.milestones /tmp/m/results.json --baseline ladder

Exit code 0 when both checks pass, 1 otherwise.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .common import paths
from .common.jsonio import read_json
from .eval import evaluate
from .perf import implementation

M4_MIN_GAIN = 0.05


def frame_crossings(out: Path, seq: dict) -> list[tuple[str, int | None]]:
    """(frame, leader crossings) of a solved sequence; None when the frame result is missing."""
    src = paths.BENCH / "out" / "problems" / seq["scenario"] / seq["sequence"]
    res_dir = out / "results" / seq["solver"] / seq["scenario"] / seq["sequence"]
    rows = []
    for f in seq.get("frames", []):
        rp = res_dir / f["file"]
        if not rp.exists():
            rows.append((f["file"], None))
            continue
        truth = src / (Path(f["file"]).stem + ".truth.json")
        m = evaluate(read_json(src / f["file"]), read_json(rp), read_json(truth) if truth.exists() else None)
        rows.append((f["file"], m["leaders"]["crossings"]))
    return rows


def m3(report: dict, out: Path | None = None) -> tuple[bool, list[str]]:
    """Leader crossings of every Label Anything solver, problems and sequence frames."""
    lines, ok, n = [], True, 0
    for r in report.get("results", []):
        if not implementation(r["solver"]):
            continue
        n += 1
        x = (r.get("summary") or {}).get("leader_crossings")
        if x is None:
            ok = False
            lines.append(f"  {r['solver']} {r['scenario']}/{r['config']}: not evaluated")
        elif x:
            ok = False
            lines.append(f"  {r['solver']} {r['scenario']}/{r['config']}: {x} crossings")
    for s in report.get("sequences", []):
        if not implementation(s.get("solver", "")) or out is None:
            continue
        for file, x in frame_crossings(out, s):
            n += 1
            if x is None:
                ok = False
                lines.append(f"  {s['solver']} {s['sequence']}/{file}: result missing")
            elif x:
                ok = False
                lines.append(f"  {s['solver']} {s['sequence']}/{file}: {x} crossings")
    head = f"M3 pass: 0 leader crossings on all {n} solves" if ok else f"M3 FAIL: leader crossings (of {n} solves)"
    return ok, [head, *lines]


def time_guard_hit(out: Path | None, row: dict) -> bool:
    """Whether the solve of a result row hit the time guard (from its metrics file)."""
    if out is None or not row.get("metrics"):
        return False
    m = out / row["metrics"]
    return bool(m.exists() and (read_json(m).get("runtime") or {}).get("time_guard_hit"))


def omission(row: dict) -> str:
    """The omission mode of a result row's problem (``strict`` when unknown)."""
    p = paths.REPO / row.get("problem", "")
    if not row.get("problem") or not p.exists():
        return "strict"
    return ((read_json(p).get("priority") or {}).get("omission")) or "strict"


def inversions(summary: dict, mode: str) -> int:
    """Priority inversions in the sense of the omission mode (spec §9.2)."""
    if mode == "prefix":
        n = summary.get("total") or 0
        return (summary.get("placed") or 0) - round((summary.get("prefix_rate") or 0) * n)
    return summary.get("priority_inversions") or 0


def m4(report: dict, min_gain: float = M4_MIN_GAIN, out: Path | None = None,
       baseline: str = "greedy") -> tuple[bool, list[str]]:
    """placed_weighted of each full solver against its ``-<baseline>`` twin on dense problems."""
    suffix = f"-{baseline}"
    rows = {(r["solver"], r["scenario"], r["config"]): r for r in report.get("results", [])}
    by = {k: r.get("summary") or {} for k, r in rows.items()}
    twins = sorted({s for s, _, _ in by if implementation(s) and s.endswith(suffix)})
    if not twins:
        return False, [f"M4 FAIL: no Label Anything solver named *{suffix} in the run"]
    ok, lines = True, []
    for g in twins:
        full = g[: -len(suffix)]
        gains, lines_g, new_inv, guarded = [], [], [], []
        for (s, sc, cfg), gs in sorted(by.items()):
            if s != g or (full, sc, cfg) not in by:
                continue
            fs = by[(full, sc, cfg)]
            if gs.get("placed_rate") is None or gs["placed_rate"] >= 1:
                continue
            if time_guard_hit(out, rows[(s, sc, cfg)]) or time_guard_hit(out, rows[(full, sc, cfg)]):
                guarded.append(f"{sc}/{cfg}")
                continue
            if not gs.get("placed_weighted"):
                # nothing placed by the baseline: a gain without a ratio
                gain = 1.0 if fs.get("placed_weighted") else 0.0
            else:
                gain = fs["placed_weighted"] / gs["placed_weighted"] - 1
            gains.append(gain)
            mode = omission(rows[(full, sc, cfg)])
            gi, fi = inversions(gs, mode), inversions(fs, mode)
            if fi > gi:
                new_inv.append(f"{sc}/{cfg}: {gi} -> {fi}")
            lines_g.append(f"  {sc}/{cfg}: placed_weighted {gs['placed_weighted']:.3f} -> "
                           f"{fs['placed_weighted']:.3f} ({gain:+.1%}), placed {gs.get('placed')} -> "
                           f"{fs.get('placed')}, inversions ({mode}) {gi} -> {fi}")
        if not gains:
            ok = False
            lines.append(f"M4 FAIL: {full} vs {g}: no dense problem (baseline placing < 100 %)")
            continue
        mean = sum(gains) / len(gains)
        srt = sorted(gains)
        median = (srt[(len(srt) - 1) // 2] + srt[len(srt) // 2]) / 2
        passed = mean >= min_gain and not new_inv
        ok &= passed
        lines.append(f"M4 {'pass' if passed else 'FAIL'}: {full} vs {g} on {len(gains)} dense problems: "
                     f"placed_weighted {mean:+.1%} on average (needs {min_gain:+.0%}; median {median:+.1%}), "
                     f"{len(new_inv)} with new priority inversions")
        lines += lines_g
        if guarded:
            lines.append(f"  not compared (time guard hit): {', '.join(guarded)}")
    return ok, lines


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("results", help="results.json of bench/run.py")
    ap.add_argument("--min-gain", type=float, default=M4_MIN_GAIN, help="M4: required mean relative gain")
    ap.add_argument("--baseline", default="greedy",
                    help="M4: suffix of the baseline twins (greedy: the greedy pass alone; ladder: with the ladder)")
    a = ap.parse_args(argv)
    report = read_json(a.results)
    out = Path(a.results).parent
    ok3, l3 = m3(report, out)
    ok4, l4 = m4(report, a.min_gain, out, a.baseline)
    print("\n".join(l3 + l4))
    return 0 if ok3 and ok4 else 1


if __name__ == "__main__":
    sys.exit(main())
