"""Background inputs: NumPy rasters, bytes, files, SVG markup, PIL images."""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

import label_anything as la
from label_anything import _native

np = pytest.importorskip("numpy")

W, H = 240, 160
PTS = [(40.0 + 23.0 * (i % 8), 30.0 + 25.0 * (i // 8)) for i in range(24)]
NAMES = [f"n{i}" for i in range(24)]
BLOCK = (90, 50, 150, 110)  # x0, y0, x1, y1 of an ink block
HARD_INK: Dict[str, Any] = {"avoid": {"ink": "hard"}, "relaxable": []}


def image() -> Any:
    img = np.full((H, W, 4), 255, dtype=np.uint8)
    x0, y0, x1, y1 = BLOCK
    img[y0:y1, x0:x1, :3] = (20, 40, 60)
    img[5:15, 5:200, :3] = (200, 30, 30)
    return img


def placements(res: la.Result) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = res.raw["placements"]
    return out


def embedded(img: Any) -> Dict[str, Any]:
    rgba = np.ascontiguousarray(img, dtype=np.uint8)
    return {"rgba": {"width": int(rgba.shape[1]), "height": int(rgba.shape[0]), "data": base64.b64encode(rgba.tobytes()).decode()}}


def raw_problem(**extra: Any) -> Dict[str, Any]:
    p: Dict[str, Any] = {
        "canvas": {"width": W, "height": H},
        "items": [{"anchor": {"type": "point", "x": x, "y": y}, "label": {"type": "text", "text": t}} for (x, y), t in zip(PTS, NAMES)],
        # ink is hard and never relaxed by the soft_overlap ladder step
        "avoid": {"label": {"ink": "hard"}, "relaxable": []},
    }
    p.update(extra)
    return p


@pytest.fixture(scope="module")
def reference() -> List[Dict[str, Any]]:
    """Placements with the image embedded as base64 RGBA in the problem."""
    return placements(la.place_problem(raw_problem(obstacles={"raster": embedded(image())})))


def test_numpy_rgba_matches_embedded_pixels(reference: List[Dict[str, Any]]) -> None:
    res = la.place(PTS, NAMES, canvas=(W, H), background=image(), **HARD_INK)
    assert placements(res) == reference
    src = res.problem["obstacles"]["raster"]
    assert src == {"rgba": {"width": W, "height": H, "data": ""}}


def test_raster_is_avoided(reference: List[Dict[str, Any]]) -> None:
    x0, y0, x1, y1 = BLOCK
    block = la.BBox(x0, y0, x1 - x0, y1 - y0)
    res = la.place(PTS, NAMES, canvas=(W, H), background=image(), **HARD_INK)
    assert res.stats["hard_violations"] == 0
    for p in res.placed:
        assert p.box is not None and not p.box.intersects(block, 0.5)
    plain = la.place(PTS, NAMES, canvas=(W, H))
    assert plain.raw["placements"] != reference


def test_rgb_and_grey_layouts() -> None:
    img = image()
    rgba = la.place(PTS, NAMES, canvas=(W, H), background=img)
    rgb = la.place(PTS, NAMES, canvas=(W, H), background=np.ascontiguousarray(img[:, :, :3]))
    assert placements(rgb) == placements(rgba)
    grey = img[:, :, 0].copy()
    grey_rgba = np.dstack([grey, grey, grey, np.full_like(grey, 255)])
    assert placements(la.place(PTS, NAMES, canvas=(W, H), background=grey)) == placements(
        la.place(PTS, NAMES, canvas=(W, H), background=grey_rgba)
    )


def test_strided_arrays() -> None:
    img = image()
    contiguous = placements(la.place(PTS, NAMES, canvas=(W, H), background=img))
    big = np.zeros((H * 2, W * 2, 4), dtype=np.uint8)
    big[::2, ::2] = img
    view = big[::2, ::2]
    assert not view.flags["C_CONTIGUOUS"]
    assert placements(la.place(PTS, NAMES, canvas=(W, H), background=view)) == contiguous
    fortran = np.asfortranarray(img)
    assert placements(la.place(PTS, NAMES, canvas=(W, H), background=fortran)) == contiguous
    flipped = img[::-1][::-1]
    assert placements(la.place(PTS, NAMES, canvas=(W, H), background=flipped)) == contiguous


def test_float_and_bool_arrays_are_converted() -> None:
    img = image()
    as_float = img.astype(np.float32) / 255.0
    assert placements(la.place(PTS, NAMES, canvas=(W, H), background=as_float)) == placements(
        la.place(PTS, NAMES, canvas=(W, H), background=img)
    )
    mask = np.zeros((H, W), dtype=bool)
    mask[50:110, 90:150] = True
    res = la.place(PTS, NAMES, canvas=(W, H), background=~mask)
    assert res.stats["placed"] > 0


def test_native_buffer_inputs(reference: List[Dict[str, Any]]) -> None:
    img = np.ascontiguousarray(image())
    problem = json.dumps(raw_problem())
    flat = img.tobytes()
    for buf in (flat, bytearray(flat), memoryview(flat), memoryview(img)):
        out = json.loads(_native.place_json(problem, rgba=buf, width=W, height=H))
        assert out["placements"] == reference
    out = json.loads(_native.place_json(problem, rgba=img))
    assert out["placements"] == reference


@pytest.mark.parametrize(
    "rgba, kw, exc",
    [
        (b"\x00" * 10, {"width": 2, "height": 2}, ValueError),
        (b"\x00" * 16, {}, ValueError),
        ("not pixels", {}, TypeError),
    ],
)
def test_native_buffer_errors(rgba: Any, kw: Dict[str, int], exc: type) -> None:
    with pytest.raises(exc):
        _native.place_json(json.dumps(raw_problem()), rgba=rgba, **kw)


def test_native_array_errors() -> None:
    problem = json.dumps(raw_problem())
    with pytest.raises(TypeError, match="uint8"):
        _native.place_json(problem, rgba=np.zeros((4, 4, 4), dtype=np.float64))
    with pytest.raises(ValueError, match="shape"):
        _native.place_json(problem, rgba=np.zeros((4, 4, 5), dtype=np.uint8))
    with pytest.raises(ValueError, match="width"):
        _native.place_json(problem, rgba=np.zeros((4, 4, 4), dtype=np.uint8), width=5)
    with pytest.raises(TypeError):
        la.place(PTS, NAMES, background=np.zeros((4, 4, 4), dtype=np.uint16))
    with pytest.raises(ValueError):
        la.place(PTS, NAMES, background=np.zeros((4, 4, 4, 4), dtype=np.uint8))


def test_canvas_from_the_raster() -> None:
    res = la.place(PTS, NAMES, background=image(), background_scale=2.0)
    assert "canvas" not in res.problem
    assert res.problem["obstacles"]["raster"]["scale"] == 2.0
    for p in res.placed:
        assert p.box is not None and p.box.x1 <= W / 2 + 1e-6 and p.box.y1 <= H / 2 + 1e-6


def test_raster_options_reach_the_source() -> None:
    res = la.place(PTS, NAMES, canvas=(W, H), background=image(), background_mode="alpha", background_class="photo", background_offset=(1, 2), background_options={"alpha": {"threshold": 0.5}})
    src = res.problem["obstacles"]["raster"]
    assert src["mode"] == "alpha" and src["class"] == "photo" and src["offset"] == [1.0, 2.0]
    assert src["alpha"] == {"threshold": 0.5}


def png_bytes(img: Any) -> bytes:
    PIL = pytest.importorskip("PIL.Image")
    buf = io.BytesIO()
    PIL.fromarray(img, "RGBA").save(buf, format="PNG")
    return buf.getvalue()


def test_png_bytes_and_files(tmp_path: Path, reference: List[Dict[str, Any]]) -> None:
    data = png_bytes(image())
    res = la.place(PTS, NAMES, canvas=(W, H), background=data, **HARD_INK)
    assert placements(res) == reference
    assert res.problem["obstacles"]["raster"]["source"].startswith("data:image/png;base64,")
    path = tmp_path / "bg.png"
    path.write_bytes(data)
    for bg in (path, str(path)):
        r = la.place(PTS, NAMES, canvas=(W, H), background=bg, **HARD_INK)
        assert placements(r) == reference
        assert r.problem["obstacles"]["raster"]["source"] == str(path.resolve())
    # no extension: recognized by content
    odd = tmp_path / "background"
    odd.write_bytes(data)
    assert placements(la.place(PTS, NAMES, canvas=(W, H), background=odd, **HARD_INK)) == reference
    with pytest.raises(FileNotFoundError):
        la.place(PTS, NAMES, background=tmp_path / "missing.png")
    with pytest.raises(ValueError):
        la.place(PTS, NAMES, background=b"definitely not an image")


def test_pil_images(reference: List[Dict[str, Any]]) -> None:
    Image = pytest.importorskip("PIL.Image")
    img = Image.fromarray(image(), "RGBA")
    assert placements(la.place(PTS, NAMES, canvas=(W, H), background=img, **HARD_INK)) == reference
    rgb = img.convert("RGB")
    assert placements(la.place(PTS, NAMES, canvas=(W, H), background=rgb, **HARD_INK)) == reference


SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}">
  <rect width="{W}" height="{H}" fill="white"/>
  <rect id="block" x="{BLOCK[0]}" y="{BLOCK[1]}" width="{BLOCK[2] - BLOCK[0]}" height="{BLOCK[3] - BLOCK[1]}" fill="#123"/>
</svg>"""


def test_svg_markup_bytes_and_files(tmp_path: Path) -> None:
    rules = [{"selector": "#block", "class": "wall"}, {"selector": "*", "class": "ignore"}]
    x0, y0, x1, y1 = BLOCK
    block = la.BBox(x0, y0, x1 - x0, y1 - y0)
    by_markup = la.place(PTS, NAMES, canvas=(W, H), background=SVG, svg_classes=rules, avoid={"wall": "hard"})
    assert by_markup.problem["obstacles"]["svg"]["source"] == SVG
    assert by_markup.warnings == []
    for p in by_markup.placed:
        assert p.box is not None and not p.box.intersects(block, 1e-6)
    by_bytes = la.place(PTS, NAMES, canvas=(W, H), background=SVG.encode(), svg_classes=rules, avoid={"wall": "hard"})
    path = tmp_path / "bg.svg"
    path.write_text(SVG)
    by_file = la.place(PTS, NAMES, canvas=(W, H), background=path, svg_classes=[("#block", "wall"), ("*", "ignore")], avoid={"wall": "hard"})
    assert by_file.problem["obstacles"]["svg"] == {"path": str(path.resolve()), "classes": rules}
    assert placements(by_markup) == placements(by_bytes) == placements(by_file)
    # canvas from the SVG viewport
    no_canvas = la.place(PTS, NAMES, background=SVG, svg_classes={"#block": "wall", "*": "ignore"}, avoid={"wall": "hard"})
    assert placements(no_canvas) == placements(by_markup)


def test_embedded_background_is_self_contained() -> None:
    p = la.Problem(canvas=(W, H), **HARD_INK).items(PTS, NAMES).background(image())
    standalone = p.build(embed_background=True)
    assert standalone["obstacles"]["raster"]["rgba"]["data"]
    assert placements(la.place_problem(standalone)) == placements(p.solve())
    rgb = la.Problem(canvas=(W, H)).items(PTS, NAMES).background(image()[:, :, :3]).build(embed_background=True)
    assert base64.b64decode(rgb["obstacles"]["raster"]["rgba"]["data"]) == np.ascontiguousarray(image()).tobytes()


def test_several_backgrounds() -> None:
    res = la.place(PTS, NAMES, canvas=(W, H), background=[image(), image()[:, :, :3], SVG], svg_classes={"#block": "wall"})
    obs = res.problem["obstacles"]
    assert isinstance(obs["raster"], list) and len(obs["raster"]) == 2
    assert obs["raster"][0]["rgba"]["data"] == ""  # raw pixels for the first source
    assert obs["raster"][1]["rgba"]["data"]  # the second one is embedded
    assert obs["svg"]["classes"] == [{"selector": "#block", "class": "wall"}]
    assert res.stats["hard_violations"] == 0


def test_place_problem_raster_argument(reference: List[Dict[str, Any]]) -> None:
    problem = raw_problem(obstacles={"raster": {"rgba": {"width": W, "height": H, "data": ""}}})
    assert placements(la.place_problem(problem, raster=image())) == reference
    # without a raster source, the override adds one with default options
    assert placements(la.place_problem(raw_problem(), raster=image())) == reference


def test_to_svg_with_a_raw_raster(tmp_path: Path) -> None:
    res = la.place(PTS, NAMES, canvas=(W, H), background=image())
    out = tmp_path / "debug.svg"
    svg = res.to_svg(out)
    assert svg.startswith("<svg") and out.read_text() == svg
    assert f'viewBox="0 0 {W} {H}"' in svg
