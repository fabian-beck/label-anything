#!/usr/bin/env bash
# The CLI examples of the design brief (§6.5), run against sample inputs.
#   examples/brief/cli_6_5.sh [path/to/label-anything]
set -euo pipefail
BIN="$(realpath "${1:-rust/target/release/label-anything}")"
HERE="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'kill "${serve_pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
cp "$HERE/../../conformance/problems/scatter-basic.json" "$work/problem.json"
python3 "$HERE/make_inputs.py" "$work"
cd "$work"
label-anything() { "$BIN" "$@"; }

label-anything place problem.json -o result.json --debug-svg out.svg --time 200 --seed 1
label-anything place --anchors pts.csv --labels-col name --priority-col traffic --omission prefix --background bg.png --preset map -o out.json
label-anything render problem.json result.json -o overlay.svg
label-anything render problem.json result.json -o overlay.png
label-anything validate problem.json
label-anything bench --help >/dev/null    # the full benchmark runs in its own CI job

# JSON on stdin and stdout
label-anything place - -o - < problem.json > piped.json

# HTTP: POST /place and /validate
"$BIN" serve --port 7077 > serve.log 2>&1 & serve_pid=$!   # label-anything serve --port 7077
for _ in $(seq 50); do curl -sf -o /dev/null -X POST --data-binary @problem.json http://127.0.0.1:7077/validate && break; sleep 0.1; done
curl -sf -X POST --data-binary @problem.json http://127.0.0.1:7077/place -o served.json

python3 - <<'PY'
import json
for f in ["result.json", "out.json", "piped.json", "served.json"]:
    r = json.load(open(f))
    st = r["stats"]
    assert st["placed"] > 0 and st["hard_violations"] == 0, (f, st)
    print(f"{f}: placed {st['placed']}/{st['total']}")
assert open("overlay.png", "rb").read(8) == b"\x89PNG\r\n\x1a\n"
assert "<svg" in open("overlay.svg").read() and "<svg" in open("out.svg").read()
print("ok")
PY
