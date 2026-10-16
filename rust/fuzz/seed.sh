#!/usr/bin/env bash
# Seed the corpora from the conformance inputs: rust/fuzz/seed.sh (from any directory).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
conf="$here/../../conformance"
mkdir -p "$here/corpus/place_json" "$here/corpus/svg_parse" "$here/corpus/raster_decode"
cp "$conf"/problems/*.json "$here/corpus/place_json/"
python3 - "$conf/svg" "$here/corpus/svg_parse" <<'PY'
import json, pathlib, sys
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
for f in sorted(src.glob("*.json")):
    svg = json.loads(f.read_text()).get("svg")
    if isinstance(svg, str):
        (out / (f.stem + ".svg")).write_text(svg)
PY
cp "$conf"/raster/images/* "$here/corpus/raster_decode/"
