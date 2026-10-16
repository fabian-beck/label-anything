"""Minimal OpenStreetMap PBF reader (pure Python: protobuf wire format + zlib).

Supports what the benchmark needs: dense and plain nodes, ways, relations with
tags (OSMHeader blocks are skipped; only zlib or raw blobs). Reference:
https://wiki.openstreetmap.org/wiki/PBF_Format
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = 0
    out = 0
    while True:
        b = buf[i]
        i += 1
        out |= (b & 0x7F) << shift
        if b < 0x80:
            return out, i
        shift += 7


def _zigzag(v: int) -> int:
    return (v >> 1) ^ -(v & 1)


def _fields(buf: bytes):
    """Yield (field number, wire type, value) of a protobuf message."""
    i, n = 0, len(buf)
    while i < n:
        key, i = _varint(buf, i)
        fn, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(buf, i)
        elif wt == 2:
            ln, i = _varint(buf, i)
            v = buf[i:i + ln]
            i += ln
        elif wt == 1:
            v = buf[i:i + 8]
            i += 8
        elif wt == 5:
            v = buf[i:i + 4]
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wt}")
        yield fn, wt, v


def _packed(buf: bytes, signed: bool = False) -> list[int]:
    out = []
    i, n = 0, len(buf)
    while i < n:
        v, i = _varint(buf, i)
        out.append(_zigzag(v) if signed else v)
    return out


def _delta(vals: list[int]) -> list[int]:
    acc = 0
    out = []
    for v in vals:
        acc += v
        out.append(acc)
    return out


@dataclass
class OSMData:
    nodes: dict[int, tuple[float, float]] = field(default_factory=dict)      # id -> (lon, lat)
    node_tags: dict[int, dict[str, str]] = field(default_factory=dict)       # tagged nodes only
    ways: dict[int, tuple[list[int], dict[str, str]]] = field(default_factory=dict)
    relations: dict[int, tuple[list[tuple[str, int, str]], dict[str, str]]] = field(default_factory=dict)


def read(path: str) -> OSMData:
    with open(path, "rb") as f:
        data = f.read()
    out = OSMData()
    i = 0
    while i < len(data):
        (hlen,) = struct.unpack(">I", data[i:i + 4])
        i += 4
        btype, dsize = "", 0
        for fn, _wt, v in _fields(data[i:i + hlen]):
            if fn == 1:
                btype = v.decode()
            elif fn == 3:
                dsize = v
        i += hlen
        blob = data[i:i + dsize]
        i += dsize
        raw = None
        for fn, _wt, v in _fields(blob):
            if fn == 1:
                raw = bytes(v)
            elif fn == 3:
                raw = zlib.decompress(v)
            elif fn in (4, 6, 7):
                raise ValueError("only zlib-compressed PBF blobs are supported")
        if btype == "OSMData" and raw is not None:
            _primitive_block(raw, out)
    return out


def _primitive_block(buf: bytes, out: OSMData) -> None:
    strings: list[str] = []
    groups = []
    gran, lat_off, lon_off = 100, 0, 0
    for fn, _wt, v in _fields(buf):
        if fn == 1:
            strings = [s.decode("utf-8") for f2, _w, s in _fields(v) if f2 == 1]
        elif fn == 2:
            groups.append(v)
        elif fn == 17:
            gran = v
        elif fn == 19:
            lat_off = v
        elif fn == 20:
            lon_off = v

    def coord(off, v):
        return 1e-9 * (off + gran * v)

    for g in groups:
        for fn, _wt, v in _fields(g):
            if fn == 1:  # plain node
                nid = lat = lon = 0
                keys, vals = [], []
                for f2, _w, x in _fields(v):
                    if f2 == 1:
                        nid = _zigzag(x)
                    elif f2 == 2:
                        keys = _packed(x)
                    elif f2 == 3:
                        vals = _packed(x)
                    elif f2 == 8:
                        lat = _zigzag(x)
                    elif f2 == 9:
                        lon = _zigzag(x)
                out.nodes[nid] = (coord(lon_off, lon), coord(lat_off, lat))
                if keys:
                    out.node_tags[nid] = {strings[k]: strings[val] for k, val in zip(keys, vals)}
            elif fn == 2:  # dense nodes
                ids, lats, lons, kv = [], [], [], []
                for f2, _w, x in _fields(v):
                    if f2 == 1:
                        ids = _delta(_packed(x, signed=True))
                    elif f2 == 8:
                        lats = _delta(_packed(x, signed=True))
                    elif f2 == 9:
                        lons = _delta(_packed(x, signed=True))
                    elif f2 == 10:
                        kv = _packed(x)
                j = 0
                for k, nid in enumerate(ids):
                    out.nodes[nid] = (coord(lon_off, lons[k]), coord(lat_off, lats[k]))
                    if kv:
                        tags = {}
                        while j < len(kv) and kv[j] != 0:
                            tags[strings[kv[j]]] = strings[kv[j + 1]]
                            j += 2
                        j += 1
                        if tags:
                            out.node_tags[nid] = tags
            elif fn == 3:  # way
                wid = 0
                keys, vals, refs = [], [], []
                for f2, _w, x in _fields(v):
                    if f2 == 1:
                        wid = x
                    elif f2 == 2:
                        keys = _packed(x)
                    elif f2 == 3:
                        vals = _packed(x)
                    elif f2 == 8:
                        refs = _delta(_packed(x, signed=True))
                out.ways[wid] = (refs, {strings[k]: strings[val] for k, val in zip(keys, vals)})
            elif fn == 4:  # relation
                rid = 0
                keys, vals, roles, mids, types = [], [], [], [], []
                for f2, _w, x in _fields(v):
                    if f2 == 1:
                        rid = x
                    elif f2 == 2:
                        keys = _packed(x)
                    elif f2 == 3:
                        vals = _packed(x)
                    elif f2 == 8:
                        roles = _packed(x)
                    elif f2 == 9:
                        mids = _delta(_packed(x, signed=True))
                    elif f2 == 10:
                        types = _packed(x)
                members = [(("node", "way", "relation")[t], m, strings[r]) for t, m, r in zip(types, mids, roles)]
                out.relations[rid] = (members, {strings[k]: strings[val] for k, val in zip(keys, vals)})
