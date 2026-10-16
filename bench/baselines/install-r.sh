#!/usr/bin/env bash
# Install R and the R packages of the ggrepel baseline at the versions the benchmark pins.
#
#   sudo bench/baselines/install-r.sh          # Ubuntu 24.04 (noble): distribution packages, exact versions
#   bench/baselines/install-r.sh --cran        # any system with R >= 4.1: CRAN (archive) versions via remotes
#
# Pins (the versions the published results were produced with):
#   R 4.3.3 (Ubuntu 24.04), ggrepel 0.9.5, ggplot2 3.4.4, jsonlite 1.8.8.
# Licenses: R GPL-2|3, ggrepel GPL-3, ggplot2 MIT, jsonlite MIT (benchmark tooling only).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="${1:-auto}"

if [ "$mode" != "--cran" ] && command -v apt-get >/dev/null 2>&1 \
    && grep -q '^VERSION_CODENAME=noble$' /etc/os-release 2>/dev/null; then
  apt-get update
  # --allow-downgrades: a runner image may come with a newer R from another repository
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --allow-downgrades \
    r-base-core=4.3.3-2build2 \
    r-cran-ggrepel=0.9.5-1 \
    r-cran-ggplot2=3.4.4+dfsg-1 \
    r-cran-jsonlite=1.8.8+dfsg-1 \
    fontconfig
else
  if ! command -v Rscript >/dev/null 2>&1; then
    echo "install-r.sh: Rscript not found; install R (>= 4.1) first, then rerun with --cran" >&2
    exit 1
  fi
  Rscript "$here/install-r.R"
fi

Rscript -e 'for (p in c("ggrepel", "ggplot2", "jsonlite")) cat(p, as.character(packageVersion(p)), "\n")'
