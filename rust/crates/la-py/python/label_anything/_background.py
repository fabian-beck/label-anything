"""``background=``: raster and SVG backgrounds from paths, bytes, arrays or markup.

* ``str`` / ``Path``: a raster file (PNG, JPEG, WebP) or an SVG file, recognized by the
  extension or, failing that, by the content;
* ``bytes``: an encoded image (embedded as a ``data:`` URL) or SVG text;
* a NumPy ``uint8`` array ``H×W×4`` / ``H×W×3`` / ``H×W`` (floats in [0, 1] are
  converted) or a PIL image: handed to the engine directly (``raster_override``), and the
  problem gets a placeholder raster source ``{"rgba": {"width", "height", "data": ""}}``
  that carries the options;
* a string of SVG markup;
* a list of these, or ``None``.
"""

from __future__ import annotations

import base64
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ._types import JSONDict

_PNG = b"\x89PNG\r\n\x1a\n"
_BASE64_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_\r\n ")
RASTER_SUFFIXES = {".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp"}


@dataclass
class RawRaster:
    """Pixels passed to the engine without encoding (the ``rgba=`` argument)."""

    data: Any
    width: int
    height: int

    def rgba_bytes(self) -> bytes:
        """The pixels as RGBA8 bytes (for embedding into a standalone problem)."""
        d = self.data
        if isinstance(d, (bytes, bytearray, memoryview)):
            raw = bytes(d)
            n = self.width * self.height
            if len(raw) == 4 * n:
                return raw
            if len(raw) == 3 * n:
                out = bytearray(4 * n)
                out[0::4], out[1::4], out[2::4] = raw[0::3], raw[1::3], raw[2::3]
                out[3::4] = b"\xff" * n
                return bytes(out)
            if len(raw) == n:
                out = bytearray(4 * n)
                out[0::4] = out[1::4] = out[2::4] = raw
                out[3::4] = b"\xff" * n
                return bytes(out)
            raise ValueError("pixel buffer size does not match width and height")
        import numpy as np

        a = np.asarray(d)
        if a.ndim == 2:
            a = a[:, :, None]
        c = a.shape[2]
        if c == 4:
            rgba = a
        elif c == 3:
            rgba = np.concatenate([a, np.full(a.shape[:2] + (1,), 255, np.uint8)], axis=2)
        elif c == 2:
            rgba = np.concatenate([a[:, :, :1]] * 3 + [a[:, :, 1:2]], axis=2)
        else:
            rgba = np.concatenate([a] * 3 + [np.full(a.shape[:2] + (1,), 255, np.uint8)], axis=2)
        return bytes(np.ascontiguousarray(rgba, dtype=np.uint8).tobytes())


@dataclass
class Sources:
    """Background sources of a problem."""

    raster: List[JSONDict]
    svg: List[JSONDict]
    #: Pixels for the first raster source (its JSON entry is a placeholder).
    override: Optional[RawRaster]


def looks_like_svg(text: str) -> bool:
    s = text.lstrip("﻿ \t\r\n")
    if not s.startswith("<"):
        return False
    head = s[:4096].lower()
    return "<svg" in head


def _sniff(head: bytes) -> Optional[str]:
    if head.startswith(_PNG):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    try:
        text = head.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        text = head.decode("utf-8", errors="ignore")
    if looks_like_svg(text) or text.lstrip("﻿ \t\r\n").startswith("<?xml"):
        return "svg"
    return None


def _data_url(data: bytes, kind: str) -> str:
    return f"data:image/{kind};base64," + base64.b64encode(data).decode("ascii")


def _is_array(obj: Any) -> bool:
    return hasattr(obj, "__array_interface__") and hasattr(obj, "shape") and hasattr(obj, "dtype")


def _is_pil(obj: Any) -> bool:
    return all(hasattr(obj, a) for a in ("mode", "size", "convert", "tobytes", "getbands"))


def raw_raster(obj: Any) -> RawRaster:
    """Pixels from a NumPy array or a PIL image."""
    if isinstance(obj, RawRaster):
        return obj
    if _is_pil(obj):
        img = obj if obj.mode == "RGBA" else obj.convert("RGBA")
        w, h = img.size
        return RawRaster(img.tobytes(), int(w), int(h))
    if _is_array(obj):
        import numpy as np

        a = obj
        kind = a.dtype.kind
        if kind == "f":
            a = (np.clip(np.nan_to_num(a), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
        elif kind == "b":
            a = a.astype(np.uint8) * 255
        elif a.dtype != np.uint8:
            raise TypeError(
                f"background arrays must be uint8 (or floats in [0, 1]); got dtype {a.dtype}"
            )
        if a.ndim == 2 or (a.ndim == 3 and a.shape[2] in (1, 2, 3, 4)):
            return RawRaster(a, int(a.shape[1]), int(a.shape[0]))
        raise ValueError(
            f"background arrays must have shape H×W×4, H×W×3, H×W×2, H×W×1 or H×W (got {a.shape})"
        )
    raise TypeError(f"not a pixel image: {type(obj).__name__}")


def _path_source(path: Path) -> Tuple[str, JSONDict]:
    p = path.expanduser()
    if not p.is_file():
        raise FileNotFoundError(f"background file not found: {p}")
    kind: Optional[str] = RASTER_SUFFIXES.get(p.suffix.lower())
    if p.suffix.lower() == ".svg":
        kind = "svg"
    if kind is None:
        with p.open("rb") as f:
            kind = _sniff(f.read(4096))
    if kind is None:
        raise ValueError(f"{p}: not a PNG, JPEG, WebP or SVG file")
    if kind == "gif":
        raise ValueError(f"{p}: GIF backgrounds are not supported (use PNG)")
    full = str(p.resolve())
    if kind == "svg":
        return "svg", {"path": full}
    if len(full) >= 16 and set(full) <= _BASE64_CHARS:
        # the engine would read this path as bare base64: embed the file instead
        return "raster", {"source": _data_url(p.read_bytes(), kind)}
    return "raster", {"source": full}


def _one(bg: Any) -> Tuple[str, JSONDict, Optional[RawRaster]]:
    """(kind, source dict, raw pixels) of one background."""
    if isinstance(bg, str):
        if looks_like_svg(bg):
            return "svg", {"source": bg}, None
        if bg.startswith("data:"):
            head = bg[:64].lower()
            if head.startswith("data:image/svg+xml"):
                import urllib.parse

                meta, _, payload = bg.partition(",")
                text = (
                    base64.b64decode(payload).decode("utf-8")
                    if meta.lower().endswith(";base64")
                    else urllib.parse.unquote(payload)
                )
                return "svg", {"source": text}, None
            return "raster", {"source": bg}, None
        kind, src = _path_source(Path(bg))
        return kind, src, None
    if isinstance(bg, os.PathLike):
        kind, src = _path_source(Path(os.fspath(bg)))
        return kind, src, None
    if isinstance(bg, (bytes, bytearray, memoryview)) and not _is_array(bg):
        data = bytes(bg)
        fmt = _sniff(data[:4096])
        if fmt == "svg":
            return "svg", {"source": data.decode("utf-8-sig")}, None
        if fmt in ("png", "jpeg", "webp"):
            return "raster", {"source": _data_url(data, fmt)}, None
        if fmt == "gif":
            raise ValueError("GIF backgrounds are not supported (use PNG)")
        raise ValueError(
            "background bytes are not a PNG, JPEG, WebP or SVG image (pass raw pixels as a "
            "NumPy array)"
        )
    if _is_array(bg) or _is_pil(bg):
        raw = raw_raster(bg)
        src = {"rgba": {"width": raw.width, "height": raw.height, "data": ""}}
        return "raster", src, raw
    raise TypeError(
        "background must be a path, bytes, an SVG string, a NumPy array, a PIL image, a list "
        f"of these, or None (got {type(bg).__name__})"
    )


def svg_rules(classes: Any) -> List[JSONDict]:
    """Normalize SVG class rules: ``[{selector, class}]``, ``[(selector, class)]`` or a
    ``{selector: class}`` dict."""
    if isinstance(classes, Mapping):
        return [{"selector": str(k), "class": str(v)} for k, v in classes.items()]
    out: List[JSONDict] = []
    for r in classes:
        if isinstance(r, Mapping):
            out.append(dict(r))
        else:
            sel, cls = r
            out.append({"selector": str(sel), "class": str(cls)})
    return out


def _raster_options(src: JSONDict, o: Mapping[str, Any]) -> None:
    offset: Optional[Sequence[float]] = o.get("offset")
    for key, v in (
        ("mode", o.get("mode")),
        ("class", o.get("cls")),
        ("scale", o.get("scale")),
        ("offset", None if offset is None else [float(offset[0]), float(offset[1])]),
    ):
        if v is not None:
            src[key] = v
    if o.get("options"):
        src.update(dict(o["options"]))


def _svg_options(src: JSONDict, o: Mapping[str, Any]) -> None:
    if o.get("svg_classes") is not None:
        src["classes"] = svg_rules(o["svg_classes"])
    if o.get("svg_default_class") is not None:
        src["default_class"] = o["svg_default_class"]
    if o.get("auto_mark_items") is not None:
        src["auto_mark_items"] = bool(o["auto_mark_items"])
    if o.get("options"):
        src.update(dict(o["options"]))


def sources(entries: Sequence[Tuple[Any, Mapping[str, Any]]], *, embed: bool = False) -> Sources:
    """Build the obstacle sources of ``(background, options)`` entries; a background may
    be a list. Options: ``mode``, ``cls``, ``scale``, ``offset`` (rasters),
    ``svg_classes``, ``svg_default_class``, ``auto_mark_items`` (SVG) and ``options``
    (merged into every source object)."""
    out = Sources([], [], None)
    for background, opts in entries:
        if background is None:
            continue
        items = list(background) if isinstance(background, (list, tuple)) else [background]
        for bg in items:
            if bg is None:
                continue
            kind, src, raw = _one(bg)
            if kind == "svg":
                _svg_options(src, opts)
                out.svg.append(src)
                continue
            _raster_options(src, opts)
            if raw is not None:
                if embed or out.raster:
                    # only the first raster source can take raw pixels: embed the others
                    src["rgba"]["data"] = base64.b64encode(raw.rgba_bytes()).decode("ascii")
                else:
                    out.override = raw
            out.raster.append(src)
    return out


def merge_sources(obstacles: Dict[str, Any], srcs: Sources) -> None:
    """Prepend the background sources to ``obstacles.raster`` / ``obstacles.svg``."""
    for key, new in (("raster", srcs.raster), ("svg", srcs.svg)):
        if not new:
            continue
        old = obstacles.get(key)
        rest = [] if old is None else (list(old) if isinstance(old, list) else [old])
        both = new + rest
        obstacles[key] = both[0] if len(both) == 1 else both
