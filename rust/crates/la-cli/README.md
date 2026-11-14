# label-anything-cli

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

The command line of [Label Anything](https://fabian-beck.github.io/label-anything/), a label placement engine for charts, maps
and diagrams. The binary is `label-anything`:

```sh
cargo install label-anything-cli

label-anything place problem.json -o result.json --debug-svg overlay.svg
label-anything place --anchors points.csv --canvas 800x600 -o result.json
label-anything validate problem.json
label-anything render problem.json result.json -o overlay.png
label-anything serve --port 7077      # POST /place, POST /validate, GET /health
```

`place` solves a problem (`problem.v1`, JSON) or builds one from a CSV file of anchors;
`validate` reports errors by JSON pointer and code; `render` draws the debug overlay as
SVG or PNG; `serve` answers HTTP requests; `bench` runs the benchmark of the repository.
`-` reads stdin or writes stdout. Exit codes: 0 success, 1 invalid problem or input,
2 any other error.

Features (both default): `png` (PNG output of `render`, with resvg) and `mimalloc` (the
allocator). The guide:
[CLI and HTTP server](https://fabian-beck.github.io/label-anything/getting-started/cli/).

MIT License. The binary embeds a subset of Noto Sans, Copyright 2022 The Noto Project
Authors, under the SIL Open Font License 1.1 (`assets/OFL.txt`).
