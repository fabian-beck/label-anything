#!/usr/bin/env bash
# Entry point of bench/Dockerfile: fetch the data (verified by SHA-256; kept in the bench/data
# volume), build the scenarios into the bench/out volume (the slow derived data is cached in
# bench/data, so a rebuild takes under a minute), then run the benchmark with the Rust engine,
# every baseline and the performance targets. Arguments are appended to bench/run.py's.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

py=bench/.venv/bin/python
"$py" -m bench.scenarios fetch
"$py" -m bench.scenarios build
exec "$py" bench/run.py --suite quick --engine rust/target/release/label-anything --baselines \
  --require-baselines --perf --out bench-report "$@"
