#!/usr/bin/env bash
# The HTTP server (docs/getting-started/cli.md): POST a problem, get the result. Run in a
# copy of examples/tutorials/data with `label-anything` on the PATH.
set -euo pipefail
label-anything serve --port 7177 > serve.log 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
for _ in $(seq 100); do curl -sf http://127.0.0.1:7177/health > /dev/null && break; sleep 0.1; done

# --8<-- [start:serve]
# label-anything serve --port 7177 --host 127.0.0.1      (in another terminal)
curl -s http://127.0.0.1:7177/health                     # {"name":"label-anything","version":"0.1.0"}
curl -s -X POST --data-binary @../problems/shapes.json http://127.0.0.1:7177/validate
curl -s -X POST --data-binary @../problems/shapes.json http://127.0.0.1:7177/place -o served.result.json
curl -s -X POST --data-binary '{"items": [{}]}' http://127.0.0.1:7177/place   # HTTP 422 {"errors": [...]}
# --8<-- [end:serve]
echo
grep -q '"placements"' served.result.json
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST --data-binary '{"items": [{}]}' http://127.0.0.1:7177/place)"
test "$code" = 422
