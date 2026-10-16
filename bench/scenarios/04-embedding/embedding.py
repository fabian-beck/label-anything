"""Deterministic 2-D embedding of WordNet 3.0 noun glosses (scenario 04).

* corpus: 50,000 noun synsets of WordNet 3.0 (NLTK distribution), sampled with a
  fixed seed; text = lemma names + gloss definition (examples stripped),
* TF-IDF (sublinear, English stop words, min_df 3) → TruncatedSVD (64 dims,
  randomized, seed 0) → L2 normalization → t-SNE (2 dims, perplexity 40,
  PCA init, seed 0, single thread),
* the embedding is cached in ``bench/data/nltk-wordnet/embedding-<n>.npz``.

Lexicographer-file descriptions (WordNet's lexnames(5WN)) give each synset a
long, human-readable category name.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common import fetch, paths  # noqa: E402

SOURCES = ["nltk-wordnet"]
N_POINTS = 50_000
SEED = 0

# lexnames(5WN): descriptions of the noun lexicographer files (WordNet 3.0 documentation)
LEXNAMES = {
    3: "unique beginners for nouns", 4: "acts or actions", 5: "animals", 6: "man-made objects",
    7: "attributes of people and objects", 8: "body parts", 9: "cognitive processes and contents",
    10: "communicative processes and contents", 11: "natural events", 12: "feelings and emotions",
    13: "foods and drinks", 14: "groupings of people or objects", 15: "spatial position", 16: "goals",
    17: "natural objects (not man-made)", 18: "people", 19: "natural phenomena", 20: "plants",
    21: "possession and transfer of possession", 22: "natural processes",
    23: "quantities and units of measure", 24: "relations between people or things or ideas",
    25: "two and three dimensional shapes", 26: "stable states of affairs", 27: "substances",
    28: "time and temporal relations",
}


def load_synsets() -> list[dict]:
    z = fetch.ensure("nltk-wordnet", verbose=False)
    data = fetch.read_zip_member(z, "wordnet/data.noun").decode("utf-8", "replace")
    out = []
    for line in data.split("\n"):
        if not line or line.startswith("  "):
            continue
        head, _, gloss = line.partition(" | ")
        f = head.split()
        offset, lex, w_cnt = f[0], int(f[1]), int(f[3], 16)
        words = [f[4 + 2 * i].replace("_", " ") for i in range(w_cnt)]
        definition = gloss.split(";")[0].strip().strip('"').strip()
        out.append({"offset": offset, "lex": lex, "words": words, "definition": definition})
    return out


def compute(n: int = N_POINTS) -> dict:
    cache = paths.data_dir("nltk-wordnet") / f"embedding-{n}.npz"
    syn = load_synsets()
    rng = np.random.default_rng(SEED)
    idx = np.sort(rng.permutation(len(syn))[:n])
    sel = [syn[i] for i in idx]
    if cache.exists():
        z = np.load(cache, allow_pickle=False)
        if z["offsets"].tolist() == [s["offset"] for s in sel]:
            return {"synsets": sel, "xy": z["xy"], "svd": z["svd"]}
    from sklearn.decomposition import TruncatedSVD
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.manifold import TSNE
    from sklearn.preprocessing import normalize
    from threadpoolctl import threadpool_limits

    docs = [" ".join(s["words"]) + " " + s["definition"] for s in sel]
    with threadpool_limits(limits=1):  # single-threaded BLAS/OpenMP: reproducible float reductions
        tf = TfidfVectorizer(sublinear_tf=True, stop_words="english", min_df=3, max_features=40000,
                             token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z]+\b")
        X = tf.fit_transform(docs)
        svd = TruncatedSVD(n_components=64, algorithm="randomized", n_iter=7, random_state=SEED)
        Y = normalize(svd.fit_transform(X)).astype(np.float64)
        ts = TSNE(n_components=2, perplexity=40.0, init="pca", random_state=SEED, n_jobs=1, learning_rate="auto",
                  method="barnes_hut", angle=0.5)
        xy = ts.fit_transform(Y)
    np.savez_compressed(cache, xy=xy, svd=Y.astype(np.float32),
                        offsets=np.array([s["offset"] for s in sel]))
    return {"synsets": sel, "xy": xy, "svd": Y.astype(np.float32)}


STOP = set("""a an the of or and to in on for with by from as at that which who is are be used
especially any one various genus family order type kind group member small large usually having
part form something someone person people make made other its it their often""".split())


def tokens(doc: str) -> set[str]:
    return {w for w in re.findall(r"[a-z][a-z]+", doc.lower()) if w not in STOP and len(w) > 2}


def document_frequencies(docs: list[str]) -> dict[str, int]:
    df: dict[str, int] = {}
    for d in docs:
        for w in tokens(d):
            df[w] = df.get(w, 0) + 1
    return df


def top_terms(docs: list[str], k: int = 3, df: dict[str, int] | None = None, n_docs: int = 1) -> list[str]:
    """Distinctive terms of a cluster: in-cluster document frequency × global IDF (class-based TF-IDF)."""
    counts: dict[str, int] = {}
    for d in docs:
        for w in tokens(d):
            counts[w] = counts.get(w, 0) + 1
    import math

    def score(w):
        c = counts[w]
        if df is None:
            return float(c)
        return (c / len(docs)) * math.log(n_docs / df.get(w, 1)) if c >= 3 else 0.0

    return [w for w in sorted(counts, key=lambda w: (-score(w), w))[:k]]
