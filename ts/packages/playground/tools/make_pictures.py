"""Derive data/pictures/ (the picture scene) from the benchmark's illustrations.

    bench/.venv/bin/python ts/packages/playground/tools/make_pictures.py

The photographs are scikit-image's sample images (astronaut: NASA, public domain; retina:
M. Häggström, CC0; rocket: SpaceX, public domain), read from the pinned and checksummed
scikit-image sdist of the benchmark (bench/common/sources.py). The annotated parts are the
hand-drawn CC0 polygons of bench/scenarios/08-illustration/polygons.json, scaled with the
image. Images are re-encoded as JPEG at most 560 px wide.
"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT))

from bench.common import fetch  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "data" / "pictures"
POLYGONS = ROOT / "bench" / "scenarios" / "08-illustration" / "polygons.json"
PREFIX = "scikit_image-0.26.0/src/"
MAX_SIDE = 560
CREDITS = {
    "astronaut": "Eileen Collins, STS-93 (NASA, public domain)",
    "retina": "Fundus photograph (M. Häggström, CC0)",
    "rocket": "Falcon 9 on the launch pad (SpaceX, public domain)",
}
TITLES = {"astronaut": "Astronaut", "retina": "Retina", "rocket": "Launch pad"}


def main() -> None:
    images = json.loads(POLYGONS.read_text(encoding="utf-8"))["images"]
    tgz = fetch.ensure("scikit-image-0.26.0-sdist", verbose=False)
    OUT.mkdir(parents=True, exist_ok=True)
    out = []
    for key, spec in images.items():
        data = fetch.read_tar_member(tgz, PREFIX + spec["file"])
        with Image.open(io.BytesIO(data)) as im:
            img = im.convert("RGB")
        scale = min(1.0, MAX_SIDE / max(img.size))
        size = (round(img.width * scale), round(img.height * scale))
        img = img.resize(size, Image.LANCZOS)
        name = f"{key}.jpg"
        img.save(OUT / name, format="JPEG", quality=84, optimize=True, progressive=True)

        def s(p):
            return [round(p[0] * scale, 1), round(p[1] * scale, 1)]

        parts = []
        for part in spec["parts"]:
            q = {"id": part["id"], "label": part["label"], "polygon": [s(p) for p in part["polygon"]]}
            if part.get("holes"):
                q["holes"] = [[s(p) for p in h] for h in part["holes"]]
            parts.append(q)
        out.append({"id": key, "title": TITLES[key], "file": name, "size": list(size), "credit": CREDITS[key], "parts": parts})
        print(f"{name}: {size[0]}x{size[1]}, {(OUT / name).stat().st_size / 1024:.0f} KB, {len(parts)} parts")
    meta = {
        "note": "Images: scikit-image sample data (public domain / CC0). Polygons: Label Anything contributors, CC0 1.0 (bench/scenarios/08-illustration/polygons.json).",
        "pictures": out,
    }
    (OUT / "pictures.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
