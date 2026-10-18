# syntax=docker/dockerfile:1.7
#
# The Label Anything benchmark with every baseline, reproducible in one image:
#   Python 3.13 + bench/requirements.txt + bench/baselines/requirements.txt (textalloc, adjustText),
#   Node 22 + bench/baselines/package-lock.json (vega, vega-label, canvas, d3fc-label-layout, echarts;
#   D3-Labeler is vendored in bench/baselines/vendor),
#   R 4.3.3 + ggrepel 0.9.5 + ggplot2 3.4.4 + jsonlite 1.8.8 (Ubuntu 24.04 packages, pinned),
#   a JDK (scenario 01 builds its metrics with CkLite.java) and Rust (builds the engine CLI).
#
# Build from the repository root (the image contains this checkout; rebuild to benchmark another):
#
#   docker build -f bench/Dockerfile -t label-anything-bench .
#
# Run: fetched data and built problems live in volumes (the first run fetches ≈ 85 MB and builds
# the scenarios, ≈ 12 min); the report is written to the mounted bench-report directory.
#
#   docker run --rm -v la-bench-data:/la/bench/data -v la-bench-out:/la/bench/out \
#              -v "$PWD/bench-report:/la/bench-report" label-anything-bench               # quick suite
#   docker run ... label-anything-bench --suite full --runs 7 --gate --previous /la/bench-report/prev.json
#
# Arguments are passed to bench/run.py after the defaults
#   --suite quick --engine rust/target/release/label-anything --baselines --require-baselines --perf
FROM ubuntu:24.04

ARG NODE_VERSION=22.22.0
ARG RUST_VERSION=1.97.0
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    MPLBACKEND=Agg \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

# System toolchains: build tools, JDK (scenario 01), Python 3.13 (deadsnakes PPA), fontconfig.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git build-essential pkg-config gnupg software-properties-common \
      openjdk-21-jdk-headless fontconfig \
 && add-apt-repository -y ppa:deadsnakes/ppa \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3.13 python3.13-venv python3.13-dev \
 && rm -rf /var/lib/apt/lists/*

# R and the ggrepel baseline's packages at the pinned versions.
COPY bench/baselines/install-r.sh bench/baselines/install-r.R /tmp/install-r/
RUN bash /tmp/install-r/install-r.sh && rm -rf /var/lib/apt/lists/* /tmp/install-r

# Node.js from the official tarball, verified against the release's SHASUMS256.txt.
RUN set -eu; arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) n=x64 ;; arm64) n=arm64 ;; *) echo "unsupported architecture $arch" >&2; exit 1 ;; esac; \
    f="node-v${NODE_VERSION}-linux-${n}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${f}"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${f}\$" | sha256sum -c -; \
    tar -xJf "$f" -C /usr/local --strip-components=1 --no-same-owner; \
    rm "$f"; node --version; npm --version

# Rust toolchain (minimal profile, pinned).
RUN curl -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
 && sh /tmp/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
 && rm /tmp/rustup-init.sh && rustc --version

WORKDIR /la

# Python environment of the benchmark and the Python baselines (cached until the pins change).
COPY bench/requirements.txt bench/requirements.txt
COPY bench/baselines/requirements.txt bench/baselines/requirements.txt
RUN python3.13 -m venv bench/.venv \
 && bench/.venv/bin/pip install --no-cache-dir -r bench/requirements.txt -r bench/baselines/requirements.txt

# Node baselines: vega-label, d3fc, ECharts (exact versions from the lockfile; canvas ships prebuilt
# binaries).
COPY bench/baselines/package.json bench/baselines/package-lock.json bench/baselines/
RUN npm ci --prefix bench/baselines --no-audit --no-fund

# The engine CLI (rebuilt when rust/ changes).
COPY rust/ rust/
RUN cargo build --release --manifest-path rust/Cargo.toml -p label-anything-cli \
 && rm -rf rust/target/release/build rust/target/release/deps rust/target/release/incremental

# The rest of the repository (spec, fonts, bench, …); see Dockerfile.dockerignore.
COPY . .

RUN bench/.venv/bin/python -m bench.baselines --list
ENTRYPOINT ["bash", "bench/docker-run.sh"]
