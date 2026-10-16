"""label_anything.matplotlib / .plotly / .seaborn without the optional helpers."""

from __future__ import annotations

import importlib
import sys

import pytest


@pytest.mark.parametrize("name", ["matplotlib", "plotly", "seaborn"])
def test_helpful_import_error(name: str, monkeypatch: pytest.MonkeyPatch) -> None:
    # simulate a missing label-anything-extras distribution
    monkeypatch.setitem(sys.modules, "label_anything_extras", None)
    monkeypatch.setitem(sys.modules, f"label_anything_extras.{name}", None)
    monkeypatch.delitem(sys.modules, f"label_anything.{name}", raising=False)
    with pytest.raises(ImportError, match=rf'pip install "label-anything\[{name}\]"'):
        importlib.import_module(f"label_anything.{name}")


def test_unrelated_import_errors_are_not_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    from label_anything import _extras

    def broken(name: str) -> None:
        raise ImportError("something else", name="some_other_module")

    monkeypatch.setattr(_extras.importlib, "import_module", broken)
    with pytest.raises(ImportError, match="something else"):
        _extras.require("matplotlib")
