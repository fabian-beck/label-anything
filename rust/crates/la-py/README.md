# label-anything (Python)

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

Python binding of **Label Anything**, a label placement engine for charts, maps and
diagrams: place text, icons or any sized label next to points, areas and shapes, avoid
what must not be covered (vector obstacles, SVG or raster backgrounds), draw leaders
without crossings, and omit labels in a user-defined priority order when space runs out.
The engine is written in Rust; this package is a PyO3 extension (abi3, CPython >= 3.9).

```python
import label_anything as la

res = la.place(
    anchors=[(120, 80), (124, 84), (300, 200)],
    labels=["Alpha", "Beta", "Gamma"],
    canvas=(400, 300),
    font_size=11,
    priority=la.Priority.outlierness(k=5),
)
for p in res.placed:
    print(p.id, p.box, p.anchor_side)
res.to_svg("debug.svg")
```

Three API styles: the one-call `la.place(...)`, the builder `la.Problem(...)`, and the
raw JSON API `la.place_problem(dict | str)`. Plotting helpers for matplotlib, Plotly and
seaborn are in the optional `label-anything-extras` package
(`pip install "label-anything[matplotlib]"`).

Build from source with [maturin](https://www.maturin.rs/): `maturin build --release`
in this directory. See `docs/bindings/python.md` in the repository for the guide.

MIT License.
