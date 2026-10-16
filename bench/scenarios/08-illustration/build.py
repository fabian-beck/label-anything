"""Build scenario 08: technical / anatomical illustrations with callouts.

Public-domain / CC0 photographs bundled with scikit-image are placed in the
middle of a wider canvas (margins for callouts) as ``obstacles.raster``
(re-encoded as JPEG to keep problems small). The labeled parts are ``area``
anchors whose polygons were drawn by hand (``polygons.json``, CC0, in image
pixel coordinates; mapped to canvas px by offset and scale here).

Configs (preset ``illustration``: boundary + distant models, ink is costly):
* ``astronaut-boundary`` (quick)  NASA portrait of Eileen Collins, 12 parts (one area with a hole),
                                  ``elbow`` leaders into the label side, boundary labels left/right,
* ``retina-boundary``             fundus photograph (CC0), 10 anatomical structures, raster scale 2,
* ``rocket-distant``              Falcon 9 on the launch pad (SpaceX, public domain), 12 parts,
                                  ``distant`` labels with straight leaders (no boundary model).
"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common import fetch  # noqa: E402
from bench.common.scenario import Writer, base_problem, data_url  # noqa: E402

SCENARIO = "08-illustration"
SOURCES = ["scikit-image-0.26.0-sdist"]
HERE = Path(__file__).resolve().parent
PREFIX = "scikit_image-0.26.0/src/"


def image(name: str) -> Image.Image:
    tgz = fetch.ensure("scikit-image-0.26.0-sdist", verbose=False)
    data = fetch.read_tar_member(tgz, PREFIX + name)
    with Image.open(io.BytesIO(data)) as im:
        return im.convert("RGB")


def jpeg(img: Image.Image, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True, subsampling=0)
    return buf.getvalue()


def config(spec: dict, canvas: tuple[float, float], offset: tuple[float, float], scale: float, *,
           models: list[str], leaders: dict, boundary: dict | None = None, font: float = 12.0):
    img = image(spec["file"])
    data = jpeg(img)
    W, H = canvas
    ox, oy = offset

    def C(p):
        return [round(ox + p[0] / scale, 2), round(oy + p[1] / scale, 2)]

    items = []
    for part in spec["parts"]:
        anchor = {"type": "area", "polygon": [C(p) for p in part["polygon"]]}
        if part.get("holes"):
            anchor["holes"] = [[C(p) for p in h] for h in part["holes"]]
        items.append({"id": part["id"], "anchor": anchor, "label": {"type": "text", "text": part["label"]}})
    p = base_problem(W, H, "illustration", font_size=font)
    p["items"] = items
    p["obstacles"] = {"raster": {"source": data_url(data, "image/jpeg"), "mode": "ink", "class": "ink",
                                 "scale": scale, "offset": [ox, oy]}}
    pl = {"models": models}
    if boundary:
        pl["boundary"] = boundary
    p["placement"] = pl
    p["leaders"] = leaders
    # background preview for the renderer: the photo on the canvas
    bg = Image.new("RGB", (int(W), int(H)), "#ffffff")
    shown = img.resize((round(img.width / scale), round(img.height / scale)), Image.LANCZOS)
    bg.paste(shown, (round(ox), round(oy)))
    return p, bg


def main() -> None:
    with open(HERE / "polygons.json", encoding="utf-8") as f:
        polys = json.load(f)["images"]
    wr = Writer(SCENARIO, "Technical and anatomical illustrations", SOURCES,
                notes="scikit-image sample images (public domain / CC0); hand-made CC0 polygons (polygons.json).")
    elbow = {"style": "elbow", "port": "side-center", "angles": [45, 135, 225, 315]}
    p, bg = config(polys["astronaut"], (1000.0, 600.0), (244.0, 44.0), 1.0, models=["boundary", "distant"],
                   leaders=elbow, boundary={"sides": ["left", "right"], "align": "stack"})
    wr.config("astronaut-boundary", p, png=_png(bg), quick=True,
              description="Astronaut portrait, 12 area anchors (incl. a ring with a hole), elbow leaders, boundary labels.")
    p, bg = config(polys["retina"], (1180.0, 746.0), (237.0, 20.0), 2.0, models=["boundary", "distant"],
                   leaders=elbow, boundary={"sides": ["left", "right"], "align": "stack"})
    wr.config("retina-boundary", p, png=_png(bg),
              description="Fundus photograph (raster scale 2), 10 anatomical structures, elbow leaders, boundary.")
    p, bg = config(polys["rocket"], (1000.0, 560.0), (180.0, 66.0), 1.0, models=["distant"],
                   leaders={"style": "straight", "port": "nearest"})
    wr.config("rocket-distant", p, png=_png(bg),
              description="Falcon 9 launch pad, 12 parts (duplicate label texts), distant labels with straight leaders.")
    wr.finish()


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


if __name__ == "__main__":
    main()
