"""Static types: the installed package type-checks with ``mypy --strict``, and so does
typical user code."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

import label_anything as la

USER_CODE = '''
import threading
import label_anything as la

def measure(text: str, font: la.FontSpec) -> la.TextMetrics:
    return la.TextMetrics(len(text) * font.size * 0.6, font.size * 0.8, font.size * 0.2)

def cost(c: la.Candidate) -> float:
    return 0.0 if c.box.x > 100 else 1.0

res: la.Result = la.place(
    [(10.0, 20.0), (30.0, 40.0)],
    ["a", la.Text("b", wrap=la.Wrap(max_width=40))],
    canvas=(200, 100),
    priority=la.Priority.outlierness(k=5) - 0.2 * la.Priority.label_size(),
    leaders=la.Leaders(style="angles", angles=range(0, 360, 45)),
    measure=measure,
    cost=cost,
    progress=lambda phase, f: None,
    cancelled=threading.Event(),
)
for p in res.placements:
    if p.box is not None:
        x: float = p.box.x + p.box.w
    if p.leader is not None:
        n: int = len(p.leader.points)
order: list[str] = res.omission_order
svg: str = res.to_svg()
report: la.Report = la.validate(la.Problem(canvas=(10, 10)).item((1, 1), "x").build())
ok: bool = report.valid
'''


def _mypy(tmp_path: Path, *targets: str) -> None:
    config = tmp_path / "mypy.ini"
    # the plotting libraries behind the optional helpers ship no type information
    config.write_text("[mypy]\nstrict = True\n\n[mypy-plotly.*,seaborn.*,pandas.*]\nignore_missing_imports = True\n")
    cmd = [
        sys.executable, "-m", "mypy", "--config-file", str(config), "--no-incremental",
        "--cache-dir", str(tmp_path / ".mypy_cache"), *targets,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, cwd=tmp_path)
    assert out.returncode == 0, out.stdout + out.stderr


def test_package_type_checks_strictly(tmp_path: Path) -> None:
    pytest.importorskip("mypy")
    assert (Path(la.__file__).parent / "py.typed").exists()
    # the installed package (module mode: site-packages is not a source root)
    _mypy(tmp_path, "-p", "label_anything")


def test_user_code_type_checks_strictly(tmp_path: Path) -> None:
    pytest.importorskip("mypy")
    user = tmp_path / "user_code.py"
    user.write_text(USER_CODE)
    _mypy(tmp_path, str(user))
