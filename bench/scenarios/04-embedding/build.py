"""Build scenario 04: embedding map of WordNet noun glosses.

50,000 synsets are embedded in 2-D (embedding.py: TF-IDF → SVD → t-SNE, fixed
seeds) and drawn as a raster background (one 1.3 px dot per synset, colored by
WordNet lexicographer category). Clusters are k-means groups of the 2-D
positions (seed 0); each cluster is labeled at its centroid with a long topic
name: the dominant category's description (WordNet lexnames) plus the three
most frequent gloss terms.

Configs:
* ``k40-ink`` (quick)  40 clusters, point anchors at the centroids, raster mode ``ink``, wrapped names,
* ``k40-saliency``     same items, raster mode ``saliency``,
* ``k120-areas``       120 clusters as ``area`` anchors (convex hull of each cluster's 75 % core),
                       raster mode ``ink``.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.geom import convex_hull  # noqa: E402
from bench.common.scenario import FONT_CLASSES_SPARSE, Writer, base_problem, data_url, png_bytes  # noqa: E402
from bench.scenarios import load_module  # noqa: E402

E = load_module("04", "embedding")
SCENARIO = "04-embedding"
W, H = 1600.0, 1200.0
PALETTE = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f",
           "#8cd17d", "#86bcb6", "#d37295", "#a0cbe8", "#ffbe7d", "#79706e", "#d4a6c8"]


def to_canvas(xy: np.ndarray, margin: float = 30.0) -> np.ndarray:
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    s = min((W - 2 * margin) / (hi[0] - lo[0]), (H - 2 * margin) / (hi[1] - lo[1]))
    off = np.array([(W - s * (hi[0] - lo[0])) / 2, (H - s * (hi[1] - lo[1])) / 2])
    return np.round((xy - lo) * s + off, 3)


def raster(pts: np.ndarray, lex: list[int]) -> Image.Image:
    ss = 2
    img = Image.new("RGBA", (int(W * ss), int(H * ss)), (255, 255, 255, 255))
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dr = ImageDraw.Draw(layer)
    r = 1.3 * ss
    for (x, y), lx in zip(pts, lex):
        c = PALETTE[lx % len(PALETTE)]
        col = (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 150)
        dr.ellipse([x * ss - r, y * ss - r, x * ss + r, y * ss + r], fill=col)
    img.alpha_composite(layer)
    return img.resize((int(W), int(H)), Image.LANCZOS).convert("RGB")


def clusters(pts: np.ndarray, k: int) -> np.ndarray:
    from sklearn.cluster import KMeans
    from threadpoolctl import threadpool_limits

    with threadpool_limits(limits=1):
        km = KMeans(n_clusters=k, n_init=4, random_state=0)
        return km.fit_predict(pts)


def topic_items(syn, pts, labels, k, areas: bool) -> list[dict]:
    items = []
    all_docs = [" ".join(m["words"]) + " " + m["definition"] for m in syn]
    df = E.document_frequencies(all_docs)
    for c in range(k):
        idx = np.nonzero(labels == c)[0]
        if len(idx) == 0:
            continue
        members = [syn[i] for i in idx]
        lex_counts: dict[int, int] = {}
        for m in members:
            lex_counts[m["lex"]] = lex_counts.get(m["lex"], 0) + 1
        lex = min(lex_counts, key=lambda L: (-lex_counts[L], L))
        terms = E.top_terms([all_docs[i] for i in idx], 3, df, len(all_docs))
        name = f"{E.LEXNAMES.get(lex, 'nouns').capitalize()}: {', '.join(terms)}"
        cen = pts[idx].mean(axis=0)
        it = {"id": f"c{c:03d}", "label": {"type": "text", "text": name, "wrap": {"max_width": "11em", "max_lines": 3}},
              "attrs": {"size": int(len(idx)), "category": E.LEXNAMES.get(lex, ""), "terms": terms}}
        if areas:
            d = np.sqrt(((pts[idx] - cen) ** 2).sum(axis=1))
            core = pts[idx][d <= np.quantile(d, 0.75)]
            hull = convex_hull([tuple(p) for p in core.tolist()])
            if len(hull) < 3:
                continue
            it["anchor"] = {"type": "area", "polygon": [[round(x, 2), round(y, 2)] for x, y in hull]}
        else:
            # anchor at the member closest to the centroid (centroids of curved clusters can fall outside them)
            j = idx[int(np.argmin(((pts[idx] - cen) ** 2).sum(axis=1)))]
            it["anchor"] = {"type": "point", "x": float(pts[j][0]), "y": float(pts[j][1]),
                            "mark": {"shape": "circle", "r": 3.0}}
        items.append(it)
    items.sort(key=lambda it: (-it["attrs"]["size"], it["id"]))
    return items


def problem(items, png: bytes, mode: str) -> dict:
    p = base_problem(W, H, "scatter", font_size=11.0)
    p["items"] = items
    p["priority"] = {"terms": [{"attr": "size", "transform": "log1p", "normalize": "minmax"}],
                     "font_classes": FONT_CLASSES_SPARSE}
    p["obstacles"] = {"raster": {"source": data_url(png), "mode": mode, "class": "ink"}}
    return p


def main() -> None:
    emb = E.compute()
    syn = emb["synsets"]
    pts = to_canvas(np.asarray(emb["xy"], dtype=np.float64))
    lex = [s["lex"] for s in syn]
    png = png_bytes(raster(pts, lex), palette=True)
    wr = Writer(SCENARIO, "Embedding map of WordNet glosses", E.SOURCES,
                notes=f"{len(syn)} WordNet 3.0 noun synsets, TF-IDF + SVD + t-SNE (fixed seeds).")
    lab40 = clusters(pts, 40)
    items40 = topic_items(syn, pts, lab40, 40, areas=False)
    wr.config("k40-ink", problem(items40, png, "ink"), png=png, quick=True,
              description="40 cluster labels (long topic names, wrapped) over a raster of 50,000 points (ink mode).")
    wr.config("k40-saliency", problem(items40, png, "saliency"), png=png,
              description="Same items, raster saliency mode.")
    lab120 = clusters(pts, 120)
    wr.config("k120-areas", problem(topic_items(syn, pts, lab120, 120, areas=True), png, "ink"), png=png,
              description="120 clusters as area anchors (convex hulls of the 75 % cores) over the raster (ink mode).")
    wr.finish()


if __name__ == "__main__":
    main()
