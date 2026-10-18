#!/usr/bin/env bash
# The CLI (docs/getting-started/cli.md): validate, place, render, stdin/stdout and the CSV
# mode. Run in a copy of examples/tutorials/data with `label-anything` on the PATH.
set -euo pipefail

# --8<-- [start:place]
label-anything validate ../problems/shapes.json            # "valid", or the errors and exit code 1
label-anything place ../problems/shapes.json -o shapes.result.json \
    --debug-svg shapes.debug.svg --time 200 --seed 1 --pretty
label-anything render ../problems/shapes.json shapes.result.json -o shapes.png
# --8<-- [end:place]

# --8<-- [start:pipes]
label-anything place - < ../problems/graph.json > graph.result.json   # `-` = stdin / stdout
# --8<-- [end:pipes]

# --8<-- [start:csv]
# anchors from a CSV (columns x, y and a label column; the other columns become attrs)
label-anything place --anchors outliers.csv --labels-col name --id-col id \
    --background scatter.png --preset scatter --max-labels 12 -o csv.result.json
# --8<-- [end:csv]

# --8<-- [start:invalid]
echo '{"items": [{"anchor": {"type": "point", "x": 1}}]}' > invalid.json
label-anything validate invalid.json || echo "exit code $?"            # errors on stderr, exit code 1
label-anything validate --json invalid.json > report.json || true      # the report as JSON
# --8<-- [end:invalid]
grep -q '"pointer": "/items/0/anchor/y"' report.json
grep -q '"placed": true' shapes.result.json
test -s shapes.png && test -s shapes.debug.svg
