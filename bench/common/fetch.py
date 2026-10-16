"""Download helpers: pinned URLs, SHA-256 verification, safe member extraction.

Every fetched file is verified against a SHA-256 checksum pinned in
``bench/common/sources.py``. Archives are never extracted wholesale: only the
named members are copied out (no path traversal, no symlinks), because
downloaded archives are untrusted input.
"""
from __future__ import annotations

import hashlib
import io
import os
import shutil
import sys
import tarfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from . import paths
from .sources import SOURCES, Source

USER_AGENT = "label-anything-bench/0.1 (+https://github.com/fabian-beck/label-anything)"


def sha256_file(path: str | Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _download(url: str, dest: Path, retries: int = 6) -> None:
    tmp = dest.with_name(dest.name + ".part")
    delay = 5.0
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            os.replace(tmp, dest)
            return
        except urllib.error.HTTPError as e:  # rate limits / transient server errors: retry
            if e.code in (429, 500, 502, 503, 504) and attempt + 1 < retries:
                print(f"  HTTP {e.code} for {url}; retrying in {delay:.0f}s", file=sys.stderr)
                time.sleep(delay)
                delay *= 2
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt + 1 < retries:
                print(f"  {type(e).__name__} for {url}; retrying in {delay:.0f}s", file=sys.stderr)
                time.sleep(delay)
                delay *= 2
                continue
            raise
        finally:
            if tmp.exists():
                tmp.unlink()


def source_path(source_id: str) -> Path:
    src = SOURCES[source_id]
    return paths.DATA / src.group / src.filename


def ensure(source_id: str, verbose: bool = True) -> Path:
    """Download ``source_id`` if missing and verify its checksum. Returns the local path."""
    src: Source = SOURCES[source_id]
    dest = source_path(source_id)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        got = sha256_file(dest)
        if got == src.sha256:
            if verbose:
                print(f"  ok      {source_id} ({dest.relative_to(paths.REPO)})")
            return dest
        print(f"  checksum mismatch for existing {dest}; re-downloading", file=sys.stderr)
        dest.unlink()
    if verbose:
        print(f"  fetch   {source_id} <- {src.url}")
    _download(src.url, dest)
    got = sha256_file(dest)
    if got != src.sha256:
        bad = dest.with_name(dest.name + ".bad")
        os.replace(dest, bad)
        raise RuntimeError(
            f"SHA-256 mismatch for {source_id}: expected {src.sha256}, got {got} (kept as {bad})"
        )
    return dest


def fetch_all(source_ids: list[str]) -> dict[str, Path]:
    return {s: ensure(s) for s in source_ids}


def _safe_name(name: str) -> str:
    n = name.replace("\\", "/")
    if n.startswith("/") or ".." in n.split("/"):
        raise ValueError(f"unsafe archive member name: {name!r}")
    return n


def read_tar_member(archive: str | Path, member: str) -> bytes:
    """Read one regular-file member of a (gzip) tar archive into memory."""
    with tarfile.open(archive, "r:*") as t:
        info = t.getmember(_safe_name(member))
        if not info.isfile():
            raise ValueError(f"{member} is not a regular file in {archive}")
        f = t.extractfile(info)
        assert f is not None
        return f.read()


def list_tar(archive: str | Path) -> list[str]:
    with tarfile.open(archive, "r:*") as t:
        return [m.name for m in t.getmembers() if m.isfile()]


def extract_tar_members(archive: str | Path, members: list[str], dest_dir: str | Path,
                        strip: str = "") -> list[Path]:
    """Copy the listed regular-file members to ``dest_dir`` (optionally stripping a prefix)."""
    dest_dir = Path(dest_dir)
    out = []
    with tarfile.open(archive, "r:*") as t:
        for m in members:
            info = t.getmember(_safe_name(m))
            if not info.isfile():
                continue
            rel = m[len(strip):] if strip and m.startswith(strip) else m
            target = dest_dir / _safe_name(rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            f = t.extractfile(info)
            assert f is not None
            target.write_bytes(f.read())
            out.append(target)
    return out


def read_zip_member(archive: str | Path, member: str) -> bytes:
    with zipfile.ZipFile(archive) as z:
        return z.read(_safe_name(member))


def list_zip(archive: str | Path) -> list[str]:
    with zipfile.ZipFile(archive) as z:
        return [i.filename for i in z.infolist() if not i.is_dir()]


def text_of(data: bytes) -> io.StringIO:
    return io.StringIO(data.decode("utf-8"))
