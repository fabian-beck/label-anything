"""Shared fixtures of the label_anything tests.

The tests import the *installed* package (wheel or ``maturin develop``); the source tree
``python/`` is not put on ``sys.path``. ``LA_REPO_ROOT`` overrides the repository root
used to find ``conformance/`` and ``spec/``.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

import pytest

import label_anything as la

REPO = Path(os.environ.get("LA_REPO_ROOT", Path(__file__).resolve().parents[4]))
CONFORMANCE = REPO / "conformance"
SPEC = REPO / "spec"


def pytest_report_header(config: Any) -> str:
    return f"label_anything {la.__version__} from {Path(la.__file__).parent} (repo: {REPO})"


@pytest.fixture
def repo() -> Path:
    return REPO


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture
def problem_schema() -> Dict[str, Any]:
    data: Dict[str, Any] = load_json(SPEC / "schema" / "problem.v1.json")
    return data


def boxes_overlap(a: la.BBox, b: la.BBox, tol: float = 1e-6) -> bool:
    return a.intersects(b, tol)
