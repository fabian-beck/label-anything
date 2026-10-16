#!/usr/bin/env bash
# Entry point of bench/Dockerfile: fetch the data (verified by SHA-256; kept in the bench/data
# volume), build the scenarios once per volume (bench/out), then run the benchmark with the Rust
# engine, every baseline and the performance targets. Arguments are appended to bench/run.py's.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

py=bench/.venv/bin/python
"$py" -m bench.scenarios fetch
built=$(find bench/out/problems -mindepth 2 -maxdepth 2 -name scenario.json 2>/dev/null | wc -l)
if [ "$built" -lt 12 ]; then
  "$py" -m bench.scenarios build
fi
exec "$py" bench/run.py --suite quick --engine rust/target/release/label-anything --baselines \
  --require-baselines --perf --out bench-report "$@"
