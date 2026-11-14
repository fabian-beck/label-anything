"""The examples of the documentation's home page, labeled by the CLI.

    bench/.venv/bin/python examples/showcase/make_showcase.py --cli rust/target/release/label-anything [--only NAME ...]

Each example is a picture as a host would draw it, from open data, with a problem that
labels it (``<name>.json``, next to its picture ``<name>-*.svg``), and a figure: the picture
with the labels and leaders of the result, the text set in an embedded subset of Noto Sans
(``docs/assets/figures/<name>.svg``). It needs the benchmark's Python environment for the
fonts (fontTools). Solves are deterministic, so unchanged inputs give unchanged figures.

On the home page the examples are live (``ts/packages/playground/src/showcase``): the
chart and the map are built there again from the same data (ports of ``economies.py`` and
``europe.py``; a browser test compares their problems with the ones written here), the
graph and the photograph start from ``modules.json`` and ``retina.json``. Change a script
and its port together.

* ``economies.py``: a chart, the world's economies as a bubble chart;
* ``europe.py``: a map, the countries and capitals of Europe;
* ``retina.py``: a photograph, the parts of the eye's fundus, labeled in the margins;
* ``modules.py``: a diagram, the module graph of this repository's TypeScript packages.
"""

from __future__ import annotations

import argparse
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

EXAMPLES = ["economies", "europe", "retina", "modules"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cli", required=True, help="the label-anything executable")
    ap.add_argument("--only", nargs="*", choices=EXAMPLES, help="examples to (re)make")
    args = ap.parse_args()
    cli = str(Path(args.cli).resolve())
    for name in args.only or EXAMPLES:
        print(importlib.import_module(name).make(cli))
    return 0


if __name__ == "__main__":
    sys.exit(main())
