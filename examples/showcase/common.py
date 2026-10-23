"""What the showcase figures share: solving with the CLI and setting the text in Noto Sans.

A figure is the picture a host draws (an SVG, also the problem's background) with the
labels and leaders of the result on top, the text set in a subset of the bundled Noto Sans
embedded in the file, every glyph at the pen position the engine measured.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
FIGURES = ROOT / "docs" / "assets" / "figures"
PLAYGROUND_DATA = ROOT / "ts" / "packages" / "playground" / "data"

sys.path.insert(0, str(ROOT))
from bench.common import text as textmod  # noqa: E402
from bench.render import _font_face, _glyph_text  # noqa: E402

_TEXT = re.compile(r"<text\b([^>]*)>([^<]*)</text>")


def f(v: float) -> str:
    """A coordinate, without trailing zeros."""
    return f"{v:.2f}".rstrip("0").rstrip(".")


def solve(cli: str, problem: Path) -> dict:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "result.json"
        subprocess.run([cli, "place", str(problem), "-o", str(out)], check=True)
        return json.loads(out.read_text(encoding="utf-8"))


def write_problem(name: str, problem: dict) -> Path:
    path = HERE / f"{name}.json"
    path.write_text(json.dumps(problem, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def body(svg: str) -> str:
    """The content of an SVG document, without its root element."""
    return svg.split(">", 1)[1].rsplit("</svg>", 1)[0]


def _weight(t: dict) -> int:
    return 700 if textmod.resolve_weight(t.get("font_weight", 400)) >= 550 else 400


def compose(width: float, height: float, title: str, picture: str, result: dict, *,
            style: str = "", label_class: Callable[[dict], str] = lambda p: "",
            label_color: Callable[[dict], str] = lambda p: "#1f2328", leaders: str = "",
            leaders_under: str = "", stubs: str | None = None, extra: str = "") -> str:
    """The picture (SVG markup, drawn first), the result's leaders (``leaders``: their
    attributes; ``leaders_under``: those of a casing drawn below them; ``stubs``: those of
    the stubs of labels near other marks, else as the leaders) and labels, and ``extra``
    (markup drawn last), with the fonts the text needs."""
    placed = [p for p in result["placements"] if p.get("placed")]
    chars: dict[int, set[str]] = {}
    for p in placed:
        texts = [p["text"]] if p.get("text") else []
        texts += [q["text"] for q in p.get("parts") or [] if q.get("text")]
        for t in texts:
            chars.setdefault(_weight(t), set()).update("".join(t["lines"]))
    for m in _TEXT.finditer(picture + extra):
        heavy = re.search(r'font-weight="(bold|[6-9]\d\d)"', m.group(1))
        chars.setdefault(700 if heavy else 400, set()).update(
            m.group(2).replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">"))
    faces = "".join(_font_face(w, "".join(sorted(cs))) for w, cs in sorted(chars.items()) if cs)
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{f(width)}" height="{f(height)}" '
         f'viewBox="0 0 {f(width)} {f(height)}">',
         f"<title>{title}</title>",
         f"<style>{faces}text{{font-family:'LA Noto Sans',sans-serif;white-space:pre}}{style}</style>",
         picture]
    drawn = [L for p in placed for L in ([p["leader"]] if p.get("leader") else []) + list(p.get("leaders") or [])]
    line = lambda L: '<polyline points="' + " ".join(f"{f(x)},{f(y)}" for x, y in L["points"]) + '"/>'  # noqa: E731
    lines = [line(L) for L in drawn if stubs is None or not L.get("stub")]
    if leaders_under:
        o += [f'<g class="leaders-under" {leaders_under}>', *lines, "</g>"]
    o += [f'<g class="leaders" {leaders}>', *lines, "</g>"]
    short = [line(L) for L in drawn if stubs is not None and L.get("stub")]
    if short:
        o += [f'<g class="stubs" {stubs}>', *short, "</g>"]
    o.append('<g class="labels">')
    for p in placed:
        cls = label_class(p)
        o.append(f'<g class="{cls}">' if cls else "<g>")
        if p.get("text"):
            o += _glyph_text(p["box"]["x"], p["box"]["y"], p["text"], color=label_color(p))
        o.append("</g>")
    o.append("</g>")
    o.append(extra)
    o.append("</svg>")
    return "\n".join(x for x in o if x) + "\n"


def report(name: str, result: dict) -> str:
    s = result["stats"]
    omitted = [p["id"] for p in result["placements"] if not p.get("placed") and p.get("reason") != "grouped"]
    return (f"docs/assets/figures/{name}.svg: {s['placed']} of {s['total']} labels placed, "
            f"{s.get('hard_violations', 0)} hard violations, {s.get('leader_crossings', 0)} leader crossings, "
            f"{s['runtime_ms']:.0f} ms; omitted: {', '.join(omitted[:10])}{' …' if len(omitted) > 10 else ''}")
