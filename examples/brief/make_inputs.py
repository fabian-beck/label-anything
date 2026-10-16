"""Sample inputs for cli_6_5.sh: pts.csv (anchors with names and traffic) and bg.png."""
import random
import struct
import sys
import zlib
from pathlib import Path

out = Path(sys.argv[1])
random.seed(3)
with open(out / "pts.csv", "w") as f:
    f.write("x,y,name,traffic\n")
    for i in range(60):
        f.write(f"{random.uniform(20, 780):.1f},{random.uniform(20, 580):.1f},Airport {i},{random.randint(1, 1000)}\n")

# an 800 x 600 RGBA PNG with a pattern of dark blocks (no imaging library needed)
w, h = 800, 600
rows = []
for y in range(h):
    row = bytearray([0])
    for x in range(w):
        v = 240 if (x // 40 + y // 40) % 5 else 120
        row += bytes((v, v, v, 255))
    rows.append(bytes(row))


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(b"".join(rows), 6)) + chunk(b"IEND", b"")
(out / "bg.png").write_bytes(png)
