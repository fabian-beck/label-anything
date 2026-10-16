#!/usr/bin/env bash
# The TypeScript CLI (docs/getting-started/cli.md): the same commands on the pure
# TypeScript engine (Node). Run in a copy of examples/tutorials/data with
# `label-anything-ts` on the PATH (npm install @label-anything/cli, or the workspace's
# node_modules/.bin after npm ci && npm run build).
set -euo pipefail

# --8<-- [start:ts]
label-anything-ts validate ../problems/shapes.json
label-anything-ts place ../problems/shapes.json -o shapes.ts.json --debug-svg shapes.ts.svg
label-anything-ts render ../problems/shapes.json shapes.ts.json -o shapes.ts.overlay.svg
# --8<-- [end:ts]
grep -q '"implementation":"ts/' shapes.ts.json
test -s shapes.ts.svg && test -s shapes.ts.overlay.svg
