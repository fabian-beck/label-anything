#!/usr/bin/env bash
# Label your outliers in five lines (docs/tutorials/outliers.md), with the CLI. Run in a
# copy of examples/tutorials/data with `label-anything` on the PATH.
set -euo pipefail

# --8<-- [start:five]
label-anything validate outliers.json                                     # problem.v1 JSON
label-anything place outliers.json -o result.json --debug-svg debug.svg   # result.v1 JSON
label-anything render outliers.json result.json -o overlay.png            # debug overlay as PNG
# --8<-- [end:five]

# --8<-- [start:csv]
label-anything place --anchors outliers.csv --labels-col name --background scatter.png \
                     --preset scatter -o from-csv.json
# --8<-- [end:csv]
