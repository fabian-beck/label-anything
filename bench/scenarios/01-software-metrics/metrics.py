"""Data access for scenario 01 (also used by scenario 12).

Extracts ``ReactAndroid/src/main/java`` of the react-native 0.63.5 npm tarball
(MIT) and computes CK-style class metrics with ``CkLite.java`` (JDK 11+).
The metrics CSV is cached in ``bench/data/react-native/ck-lite.csv``.
"""
from __future__ import annotations

import csv
import hashlib
import math
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common import fetch, paths  # noqa: E402

SOURCES = ["react-native-0.63.5"]
PREFIX = "package/ReactAndroid/src/main/java/"
HERE = Path(__file__).resolve().parent


@dataclass(frozen=True)
class ClassMetrics:
    name: str      # FQCN (nested: Outer$Inner, anonymous: Outer$AnonymousN)
    type: str
    file: str
    cbo: int
    rfc: int
    wmc: int
    loc: int
    nom: int
    nof: int

    @property
    def package(self) -> str:
        return self.name.rsplit(".", 1)[0] if "." in self.name else ""

    @property
    def area(self) -> str:
        """Second-level area below com.facebook (e.g. 'react.uimanager', 'yoga')."""
        parts = self.package.split(".")
        if parts[:2] == ["com", "facebook"]:
            rest = parts[2:]
            if rest[:1] == ["react"] and len(rest) >= 2:
                return "react." + rest[1]
            return ".".join(rest[:1]) or "facebook"
        return ".".join(parts[:2])


def extract_sources() -> Path:
    tgz = fetch.ensure("react-native-0.63.5", verbose=False)
    dest = paths.data_dir("react-native") / "src"
    marker = dest / ".complete"
    if marker.exists():
        return dest
    if dest.exists():
        shutil.rmtree(dest)
    members = [m for m in fetch.list_tar(tgz) if m.startswith(PREFIX) and m.endswith(".java")]
    fetch.extract_tar_members(tgz, members, dest, strip=PREFIX)
    marker.write_text(f"{len(members)} files\n")
    return dest


def ck_csv() -> Path:
    src = extract_sources()
    out = paths.data_dir("react-native") / "ck-lite.csv"
    tool = HERE / "CkLite.java"
    stamp = out.with_suffix(".tool-sha256")
    tool_hash = hashlib.sha256(tool.read_bytes()).hexdigest()
    if out.exists() and stamp.exists() and stamp.read_text().strip() == tool_hash:
        return out
    java = shutil.which("java")
    if not java:
        raise SystemExit("scenario 01 needs a JDK (java >= 11) on PATH to run CkLite.java")
    subprocess.run([java, str(tool), str(src), str(out)], check=True)
    stamp.write_text(tool_hash + "\n")
    return out


def load_metrics() -> list[ClassMetrics]:
    out = []
    with open(ck_csv(), encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            out.append(ClassMetrics(row["class"], row["type"], row["file"], int(row["cbo"]), int(row["rfc"]),
                                    int(row["wmc"]), int(row["loc"]), int(row["nom"]), int(row["nof"])))
    return out


def jitter(name: str, salt: str, amp: float) -> float:
    """Deterministic jitter in [-amp, amp] from a hash of the class name."""
    h = hashlib.sha256((salt + name).encode()).digest()
    return (int.from_bytes(h[:4], "big") / 2 ** 32 * 2 - 1) * amp


def knn_outlierness(pts: list[tuple[float, float]], k: int = 5) -> list[float]:
    import numpy as np

    P = np.asarray(pts, dtype=np.float64)
    n = len(P)
    out = np.zeros(n)
    for i in range(n):
        d = np.sqrt(((P - P[i]) ** 2).sum(axis=1))
        d[i] = np.inf
        out[i] = np.sort(d)[:k].mean()
    return [float(v) for v in out]


def log1p_axis(v: float) -> float:
    return math.log10(1.0 + v)
