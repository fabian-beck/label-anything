"""Minimal, fully controllable PNG encoder for test images (pure Python + zlib).

Supports every colour type (0, 2, 3, 4, 6) and bit depth (1, 2, 4, 8, 16), PLTE/tRNS,
Adam7 interlacing, a per-row filter schedule (all five filter types), the three deflate
block kinds (stored, fixed and dynamic Huffman, see `deflate`), IDAT splitting and extra
chunks. `encode_chunks` returns the chunk list so tests can corrupt it before
`serialize`.
"""
import struct
import zlib

SIGNATURE = b"\x89PNG\r\n\x1a\n"
CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
ADAM7 = [(0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2)]


def crc(kind: bytes, data: bytes) -> int:
    return zlib.crc32(kind + data) & 0xFFFFFFFF


def serialize(chunks, signature=SIGNATURE) -> bytes:
    """`chunks`: list of (kind, data) or (kind, data, crc_override)."""
    out = bytearray(signature)
    for c in chunks:
        kind, data = c[0], c[1]
        value = c[2] if len(c) > 2 else crc(kind, data)
        out += struct.pack(">I", len(data)) + kind + data + struct.pack(">I", value)
    return bytes(out)


def pack_row(samples, bit_depth: int) -> bytes:
    if bit_depth == 8:
        return bytes(samples)
    if bit_depth == 16:
        return b"".join(struct.pack(">H", s) for s in samples)
    out = bytearray()
    acc = n = 0
    for s in samples:
        assert 0 <= s < (1 << bit_depth)
        acc = (acc << bit_depth) | s
        n += bit_depth
        if n == 8:
            out.append(acc)
            acc = n = 0
    if n:
        out.append(acc << (8 - n))
    return bytes(out)


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def filter_row(ftype: int, row: bytes, prior: bytes, bpp: int) -> bytes:
    """Filters one row; a type above 4 (invalid, for corrupt test files) stores the raw bytes."""
    out = bytearray([ftype])
    for i, x in enumerate(row):
        a = row[i - bpp] if i >= bpp else 0
        b = prior[i]
        c = prior[i - bpp] if i >= bpp else 0
        pred = (0, a, b, (a + b) >> 1, _paeth(a, b, c))[ftype] if ftype <= 4 else 0
        out.append((x - pred) & 0xFF)
    return bytes(out)


def raw_scanlines(width, height, color_type, bit_depth, pixel, interlace=False, filters=(0, 1, 2, 3, 4)) -> bytes:
    """Filtered scanlines. `pixel(x, y)` returns the samples of one pixel (a tuple)."""
    ch = CHANNELS[color_type]
    bpp = max(1, ch * bit_depth // 8)
    raw = bytearray()
    k = 0
    for x0, y0, dx, dy in (ADAM7 if interlace else [(0, 0, 1, 1)]):
        pw = (width - x0 + dx - 1) // dx if width > x0 else 0
        ph = (height - y0 + dy - 1) // dy if height > y0 else 0
        if pw == 0 or ph == 0:
            continue
        prior = bytes(len(pack_row([0] * (pw * ch), bit_depth)))
        for j in range(ph):
            samples = []
            for i in range(pw):
                px = pixel(x0 + i * dx, y0 + j * dy)
                assert len(px) == ch, (px, ch)
                samples.extend(px)
            row = pack_row(samples, bit_depth)
            raw += filter_row(filters[k % len(filters)], row, prior, bpp)
            k += 1
            prior = row
    return bytes(raw)


def deflate(data: bytes, kind: str = "dynamic", parts: int = 1) -> bytes:
    """zlib stream of `data`: `dynamic` (default zlib), `fixed` (Z_FIXED), `stored`
    (level 0) or `mixed` (dynamic, with sync and full flushes between `parts` pieces,
    which add empty stored blocks and restart the Huffman tables)."""
    if kind == "stored":
        z = zlib.compressobj(0)
    elif kind == "fixed":
        z = zlib.compressobj(9, zlib.DEFLATED, 15, 9, zlib.Z_FIXED)
    else:
        z = zlib.compressobj(9)
    out = bytearray()
    n = max(1, parts)
    step = (len(data) + n - 1) // n
    for i in range(n):
        out += z.compress(data[i * step:(i + 1) * step])
        if i + 1 < n:
            out += z.flush(zlib.Z_SYNC_FLUSH if i % 2 == 0 else zlib.Z_FULL_FLUSH)
    out += z.flush()
    return bytes(out)


def encode_chunks(width, height, color_type, bit_depth, pixel, *, palette=None, trns=None,
                  interlace=False, filters=(0, 1, 2, 3, 4), deflate_kind="dynamic", parts=1,
                  idat_size=None, before_plte=(), before_idat=(), after_idat=()):
    """The chunk list of a PNG (IHDR, extra chunks, PLTE, tRNS, IDAT..., IEND)."""
    ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, 1 if interlace else 0)
    chunks = [(b"IHDR", ihdr)]
    chunks += list(before_plte)
    if palette is not None:
        chunks.append((b"PLTE", b"".join(bytes(c) for c in palette)))
    if trns is not None:
        chunks.append((b"tRNS", bytes(trns)))
    chunks += list(before_idat)
    z = deflate(raw_scanlines(width, height, color_type, bit_depth, pixel, interlace, filters), deflate_kind, parts)
    size = idat_size or len(z) or 1
    for i in range(0, max(len(z), 1), size):
        chunks.append((b"IDAT", z[i:i + size]))
    chunks += list(after_idat)
    chunks.append((b"IEND", b""))
    return chunks


def encode(width, height, color_type, bit_depth, pixel, **kw) -> bytes:
    return serialize(encode_chunks(width, height, color_type, bit_depth, pixel, **kw))


def trns_gray(value: int) -> bytes:
    return struct.pack(">H", value)


def trns_rgb(r: int, g: int, b: int) -> bytes:
    return struct.pack(">HHH", r, g, b)
