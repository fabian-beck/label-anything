# @label-anything/cli

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

`label-anything-ts`: the command line of the [Label Anything](https://fabian-beck.github.io/label-anything/) label placement
engine on its pure TypeScript implementation (`@label-anything/core`), for Node ≥ 18.

```sh
npm install -g @label-anything/cli

label-anything-ts place problem.json -o result.json --debug-svg overlay.svg
label-anything-ts validate problem.json
label-anything-ts render problem.json result.json -o overlay.svg
```

`place` solves a problem (`problem.v1`, JSON), `validate` reports errors by JSON pointer
and code, `render` draws the debug overlay as SVG. `-` reads stdin or writes stdout. Exit
codes: 0 success, 1 invalid problem or input, 2 any other error. The options are those of
the Rust command line `label-anything`, which also reads CSV files, writes PNG and serves
HTTP; `--engine wasm` solves with `@label-anything/wasm` when that package is installed.

The guide: [CLI and HTTP server](https://fabian-beck.github.io/label-anything/getting-started/cli/#the-typescript-cli).

MIT License.
