"""Run the tutorial programs (the code shown in docs/) and check their results.

    python3 examples/tutorials/run.py data                        # data files are current
    python3 examples/tutorials/run.py cli --cli rust/target/release/label-anything
    python3 examples/tutorials/run.py python                      # label_anything installed
    python3 examples/tutorials/run.py c go --lib rust/target/release
    python3 examples/tutorials/run.py java --jar bindings/java/target/label-anything-0.1.0.jar
    python3 examples/tutorials/run.py js [--js-engine cli --cli ...]

Every program runs in a fresh copy of ``examples/tutorials/data`` (it reads ``scatter.png``,
``outliers.csv``, ... from its working directory, and ``../problems/*.json``). Programs check their own results where
the language makes that easy (Python, JavaScript, Java); for C, Go and the CLI this runner
checks the result JSON they print or write. ``cli`` also validates and solves every
problem in ``examples/tutorials/problems/`` and checks what its tutorial says about it.

``js`` runs the Node programs in ``js/`` (not ``js/browser/``, which need a page) against
``@label-anything/core``; ``--js-engine cli`` instead maps ``@label-anything/core`` and
``@label-anything/wasm`` to the Rust CLI (``js/harness/``), for use until the packages
export ``place``.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DATA = HERE / "data"
PROBLEMS = HERE / "problems"

failures: list[str] = []
only: list[str] = []
verbose = False


def selected(name: str) -> bool:
    return not only or any(o in name for o in only)


def log(msg: str) -> None:
    print(msg, flush=True)


def fail(name: str, msg: str) -> None:
    failures.append(f"{name}: {msg}")
    log(f"FAIL {name}: {msg}")


def workdir() -> Path:
    """A fresh copy of data/ (returned; programs run there) next to a copy of problems/."""
    d = Path(tempfile.mkdtemp(prefix="la-tutorial-"))
    shutil.copytree(DATA, d / "data")
    shutil.copytree(PROBLEMS, d / "problems")
    return d / "data"


def run(name: str, cmd: list[str], cwd: Path, env: dict[str, str] | None = None, timeout: float = 300) -> subprocess.CompletedProcess[str] | None:
    if not selected(name):
        return None
    log(f"--- {name}: {' '.join(cmd)}")
    try:
        p = subprocess.run(cmd, cwd=cwd, env={**os.environ, **(env or {})}, text=True, capture_output=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        fail(name, str(e))
        return None
    if p.returncode != 0:
        fail(name, f"exit code {p.returncode}\n{p.stdout[-3000:]}\n{p.stderr[-3000:]}")
        return None
    out = p.stdout.strip().splitlines()
    for line in (out if verbose else out[-3:]):
        log(f"    {line[:160]}")
    return p


def check_result(name: str, res: dict[str, Any], *, placed_min: int = 1, extra: Callable[[dict[str, Any]], str | None] | None = None) -> None:
    st = res.get("stats", {})
    problems = []
    if st.get("hard_violations") != 0:
        problems.append(f"hard_violations={st.get('hard_violations')}")
    if st.get("leader_crossings") != 0:
        problems.append(f"leader_crossings={st.get('leader_crossings')}")
    if st.get("placed", 0) < placed_min:
        problems.append(f"placed {st.get('placed')} < {placed_min}")
    if extra:
        msg = extra(res)
        if msg:
            problems.append(msg)
    if problems:
        fail(name, ", ".join(problems))
    else:
        log(f"    ok: placed {st.get('placed')}/{st.get('total')}")


def last_json(stdout: str) -> dict[str, Any]:
    """The JSON object a program printed (the last line that parses)."""
    for line in reversed(stdout.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    raise ValueError("no JSON object in the output")


# ---------------------------------------------------------------------------------------
# What the tutorials say about their problems (examples/tutorials/problems/*.json)
# ---------------------------------------------------------------------------------------


def placements(res: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {p["id"]: p for p in res["placements"]}


def leader_styles(style: str) -> Callable[[dict[str, Any]], str | None]:
    def check(res: dict[str, Any]) -> str | None:
        ls = [p["leader"] for p in res["placements"] if p.get("leader")]
        if not ls:
            return "no leaders"
        bad = [l["style"] for l in ls if l["style"] != style]
        return f"leader styles {bad}" if bad else None

    return check


def models(*wanted: str) -> Callable[[dict[str, Any]], str | None]:
    def check(res: dict[str, Any]) -> str | None:
        used = {p.get("model") for p in res["placements"] if p["placed"]}
        missing = [m for m in wanted if m not in used]
        return f"models {sorted(used)} lack {missing}" if missing else None

    return check


def all_checks(*checks: Callable[[dict[str, Any]], str | None]) -> Callable[[dict[str, Any]], str | None]:
    def check(res: dict[str, Any]) -> str | None:
        msgs = [m for m in (c(res) for c in checks) if m]
        return "; ".join(msgs) if msgs else None

    return check


def omitted_with(reason: str) -> Callable[[dict[str, Any]], str | None]:
    def check(res: dict[str, Any]) -> str | None:
        reasons = {p.get("reason") for p in res["placements"] if not p["placed"]}
        return None if reason in reasons else f"no item omitted with {reason} (reasons: {reasons})"

    return check


def model_of(**wanted: str) -> Callable[[dict[str, Any]], str | None]:
    """Items (by id) placed with the given model; ``"-"`` means omitted."""

    def check(res: dict[str, Any]) -> str | None:
        ps = placements(res)
        bad = {i: ps[i].get("model") if ps[i]["placed"] else "-" for i, m in wanted.items() if (ps[i].get("model") if ps[i]["placed"] else "-") != m}
        return f"models {bad}, expected {wanted}" if bad else None

    return check


def priority_cities(res: dict[str, Any]) -> str | None:
    problem = json.loads((PROBLEMS / "priority-cities.json").read_text())
    attrs = {it["id"]: it["attrs"] for it in problem["items"]}
    ps = placements(res)
    msgs = []
    capitals = [i for i, a in attrs.items() if a.get("capital")]
    if not all(ps[c]["placed"] for c in capitals):
        msgs.append(f"capitals {capitals} not all placed")
    for region in {a["region"] for a in attrs.values()}:
        n = sum(1 for i, a in attrs.items() if a["region"] == region and ps[i]["placed"])
        if n < 2:
            msgs.append(f"region {region}: {n} labels (coverage asks for 2)")
    if res["stats"]["priority_inversions"] != 0:
        msgs.append("priority inversions")
    order = res["stats"]["omission_order"]
    if sorted(order) != sorted(i for i, p in ps.items() if not p["placed"]):
        msgs.append("omission_order does not list the omitted items")
    return "; ".join(msgs) or None


PROBLEM_CHECKS: dict[str, tuple[int, Callable[[dict[str, Any]], str | None] | None]] = {
    "svg-classes.json": (18, None),
    "raster-ink.json": (18, None),
    "raster-alpha.json": (7, None),
    "raster-cost.json": (18, None),
    "raster-classmap.json": (10, None),
    "raster-saliency.json": (5, None),
    "leaders-straight.json": (10, leader_styles("straight")),
    "leaders-angles.json": (10, leader_styles("angles")),
    "leaders-orthogonal.json": (10, leader_styles("orthogonal")),
    "leaders-elbow.json": (10, leader_styles("elbow")),
    "leaders-curved.json": (10, leader_styles("curved")),
    "leaders-boundary.json": (11, models("boundary")),
    "priority-cities.json": (30, all_checks(omitted_with("omitted_by_priority"), priority_cities)),
    "shapes.json": (10, model_of(big="internal", ellipse="internal", card="internal", region="internal", islet="adjacent", medium="adjacent")),
    "graph.json": (14, model_of(core="internal", api="internal", db="internal", cache="internal", web="adjacent")),
}


# ---------------------------------------------------------------------------------------
# Languages
# ---------------------------------------------------------------------------------------


def lang_data(args: argparse.Namespace) -> None:
    run("data", [sys.executable, str(DATA / "make_data.py"), "--check"], HERE)


def lang_cli(args: argparse.Namespace) -> None:
    if not args.cli:
        fail("cli", "--cli PATH is required")
        return
    cli = str(Path(args.cli).resolve())
    path_env = {"PATH": f"{Path(cli).parent}{os.pathsep}{os.environ.get('PATH', '')}"}
    for script in sorted((HERE / "cli").glob("*.sh")):
        wd = workdir()
        if run(f"cli/{script.name}", ["bash", str(script)], wd, path_env) is None:
            continue
        for out in sorted(wd.glob("*.json")):
            if out.name in {p.name for p in DATA.glob("*.json")}:
                continue  # inputs
            res = json.loads(out.read_text())
            if "placements" in res:
                check_result(f"cli/{script.name} -> {out.name}", res)
    for problem in sorted(PROBLEMS.glob("*.json")):
        name = f"problems/{problem.name}"
        wd = workdir()
        if run(name + " (validate)", [cli, "validate", f"../problems/{problem.name}"], wd) is None:
            continue
        p = run(name, [cli, "place", f"../problems/{problem.name}", "-o", "-"], wd)
        if p is None:
            continue
        placed_min, check = PROBLEM_CHECKS.get(problem.name, (1, None))
        check_result(name, json.loads(p.stdout), placed_min=placed_min, extra=check)


def lang_python(args: argparse.Namespace) -> None:
    for prog in sorted((HERE / "python").glob("*.py")):
        run(f"python/{prog.name}", [args.python, str(prog)], workdir(), {"MPLBACKEND": "Agg"})


def native_env(lib: Path) -> dict[str, str]:
    var = "DYLD_LIBRARY_PATH" if sys.platform == "darwin" else "LD_LIBRARY_PATH"
    return {var: f"{lib}{os.pathsep}{os.environ.get(var, '')}"}


def lang_c(args: argparse.Namespace) -> None:
    if not args.lib:
        fail("c", "--lib DIR is required")
        return
    lib = Path(args.lib).resolve()
    for src in sorted((HERE / "c").glob("*.c")):
        wd = workdir()
        exe = wd / src.stem
        build = ["cc", "-std=c99", "-Wall", "-Werror", str(src), f"-I{ROOT / 'rust/crates/la-capi/include'}", f"-L{lib}", "-llabelanything", "-o", str(exe)]
        if run(f"c/{src.name} (build)", build, wd) is None:
            continue
        p = run(f"c/{src.name}", [str(exe)], wd, native_env(lib))
        if p is not None and src.stem == "outliers":
            check_result(f"c/{src.name}", last_json(p.stdout), placed_min=18)


def lang_go(args: argparse.Namespace) -> None:
    if not args.lib:
        fail("go", "--lib DIR is required")
        return
    lib = Path(args.lib).resolve()
    env = {"CGO_ENABLED": "1", "CGO_LDFLAGS": f"-L{lib}"}
    for pkg in sorted(p for p in (HERE / "go").iterdir() if p.is_dir()):
        wd = workdir()
        exe = wd / pkg.name
        if run(f"go/{pkg.name} (build)", ["go", "build", "-o", str(exe), f"./{pkg.name}"], HERE / "go", env) is None:
            continue
        p = run(f"go/{pkg.name}", [str(exe)], wd, native_env(lib))
        if p is not None and pkg.name == "outliers":
            check_result(f"go/{pkg.name}", last_json(p.stdout), placed_min=18)


def lang_java(args: argparse.Namespace) -> None:
    if not args.jar:
        fail("java", "--jar PATH is required")
        return
    jar = str(Path(args.jar).resolve())
    java = [args.java, "--enable-native-access=ALL-UNNAMED", *args.java_opt, "-cp", jar]
    for src in sorted((HERE / "java").glob("*.java")):
        run(f"java/{src.name}", [*java, str(src)], workdir())


def lang_js(args: argparse.Namespace) -> None:
    node = [args.node]
    env: dict[str, str] = {}
    if args.js_engine == "cli":
        if not args.cli:
            fail("js", "--js-engine cli needs --cli PATH")
            return
        node += ["--import", str(HERE / "js/harness/register.mjs")]
        env["LA_CLI"] = str(Path(args.cli).resolve())
    for prog in sorted((HERE / "js").glob("*.mjs")):
        run(f"js/{prog.name}", [*node, str(prog)], workdir(), env)


LANGS = {"data": lang_data, "cli": lang_cli, "python": lang_python, "c": lang_c, "go": lang_go, "java": lang_java, "js": lang_js}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("langs", nargs="+", choices=[*LANGS, "all"])
    ap.add_argument("--cli", help="the label-anything executable")
    ap.add_argument("--lib", help="directory with liblabelanything (C, Go)")
    ap.add_argument("--jar", help="label-anything-<version>.jar (Java)")
    ap.add_argument("--python", default=sys.executable, help="Python with label_anything installed")
    ap.add_argument("--java", default="java")
    ap.add_argument("--java-opt", action="append", default=[], help="extra JVM option (repeatable)")
    ap.add_argument("--node", default="node")
    ap.add_argument("--js-engine", choices=["core", "cli"], default="core")
    ap.add_argument("--only", nargs="*", default=[], help="run only programs whose name contains one of these")
    ap.add_argument("-v", "--verbose", action="store_true", help="print the whole output of every program")
    args = ap.parse_args()
    only.extend(args.only)
    global verbose
    verbose = args.verbose
    langs = list(LANGS) if "all" in args.langs else args.langs
    for lang in langs:
        log(f"=== {lang}")
        LANGS[lang](args)
    if failures:
        log(f"\n{len(failures)} failure(s):")
        for f in failures:
            log(f"  {f.splitlines()[0]}")
        return 1
    log("\nall tutorial programs passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
