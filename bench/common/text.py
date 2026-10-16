"""Text measurement for the benchmark tools: spec §5.2 "simple shaping" and the
line breaking / wrapping of §5.3, implemented independently of the engine.

* advances from ``hmtx`` through ``cmap`` (unmapped code points → glyph 0),
* GPOS pair kerning: every lookup referenced by a ``kern`` feature of any
  script's default or language system (union, ascending); type 2 or type 9
  extension to type 2; glyphs walked pairwise, skipping marks (GDEF class 3)
  when the lookup flag has IgnoreMarks; the first matching subtable applies;
  ``XAdvance`` of value record 1 (and 2, which also advances past the pair),
* width = (Σ advances + Σ adjustments) · size / unitsPerEm,
* vertical metrics from hhea (or OS/2 typo metrics when USE_TYPO_METRICS).

The bundled Noto Sans subset in ``fonts/`` is used for the family ``default``.
"""
from __future__ import annotations

import functools
import unicodedata
from dataclasses import dataclass, field

from fontTools.ttLib import TTFont

from . import paths

ELLIPSIS = "…"


class Font:
    def __init__(self, path: str):
        f = TTFont(path, lazy=False)
        self.path = path
        self.upem = f["head"].unitsPerEm
        order = f.getGlyphOrder()
        self.gid = {name: i for i, name in enumerate(order)}
        self.cmap = {cp: self.gid[name] for cp, name in f.getBestCmap().items()}
        hmtx = f["hmtx"]
        self.adv = [hmtx[name][0] for name in order]
        os2 = f["OS/2"]
        hhea = f["hhea"]
        if os2.fsSelection & (1 << 7):
            self.ascent_u, self.descent_u = os2.sTypoAscender, -os2.sTypoDescender
        else:
            self.ascent_u, self.descent_u = hhea.ascent, -hhea.descent
        self.marks: set[int] = set()
        if "GDEF" in f and f["GDEF"].table.GlyphClassDef is not None:
            for name, cls in f["GDEF"].table.GlyphClassDef.classDefs.items():
                if cls == 3:
                    self.marks.add(self.gid[name])
        self.lookups = self._kern_lookups(f)

    # -- GPOS ---------------------------------------------------------------
    def _kern_lookups(self, f: TTFont):
        if "GPOS" not in f:
            return self._legacy_kern(f)
        g = f["GPOS"].table
        feats = g.FeatureList.FeatureRecord
        idx: set[int] = set()
        for sr in g.ScriptList.ScriptRecord:
            systems = []
            if sr.Script.DefaultLangSys is not None:
                systems.append(sr.Script.DefaultLangSys)
            systems += [lr.LangSys for lr in sr.Script.LangSysRecord]
            for ls in systems:
                for fi in ls.FeatureIndex:
                    if feats[fi].FeatureTag == "kern":
                        idx.update(feats[fi].Feature.LookupListIndex)
        out = []
        for li in sorted(idx):
            lk = g.LookupList.Lookup[li]
            subs = []
            for st in lk.SubTable:
                typ = lk.LookupType
                if typ == 9:
                    typ = st.ExtensionLookupType
                    st = st.ExtSubTable
                if typ != 2:
                    continue
                subs.append(self._pair_subtable(st))
            if subs:
                out.append((bool(lk.LookupFlag & 0x0008), subs))
        return out

    def _pair_subtable(self, st):
        def xa(v):
            return 0 if v is None else int(getattr(v, "XAdvance", 0) or 0)

        vf2 = st.ValueFormat2 != 0
        cov = [self.gid[n] for n in st.Coverage.glyphs]
        if st.Format == 1:
            table: dict[int, dict[int, tuple[int, int]]] = {}
            for g1, ps in zip(cov, st.PairSet):
                row = {}
                for rec in ps.PairValueRecord:
                    g2 = self.gid[rec.SecondGlyph]
                    if g2 not in row:  # first record wins
                        row[g2] = (xa(rec.Value1), xa(rec.Value2))
                table[g1] = row
            return ("f1", vf2, table)
        cd1 = {self.gid[n]: c for n, c in st.ClassDef1.classDefs.items()}
        cd2 = {self.gid[n]: c for n, c in st.ClassDef2.classDefs.items()}
        mat = [[(xa(c2.Value1), xa(c2.Value2)) for c2 in c1.Class2Record] for c1 in st.Class1Record]
        return ("f2", vf2, set(cov), cd1, cd2, mat, st.Class1Count, st.Class2Count)

    def _legacy_kern(self, f: TTFont):
        if "kern" not in f:
            return []
        table: dict[int, dict[int, tuple[int, int]]] = {}
        for sub in f["kern"].kernTables:
            if getattr(sub, "format", 0) != 0:
                continue
            for (a, b), v in sub.kernTable.items():
                table.setdefault(self.gid[a], {})[self.gid[b]] = (int(v), 0)
        return [(False, [("f1", False, table)])] if table else []

    @staticmethod
    def _match(st, g1: int, g2: int):
        if st[0] == "f1":
            row = st[2].get(g1)
            if row is None:
                return None
            v = row.get(g2)
            return None if v is None else (v[0], v[1], st[1])
        _, vf2, cov, cd1, cd2, mat, n1, n2 = st
        if g1 not in cov:
            return None
        c1, c2 = cd1.get(g1, 0), cd2.get(g2, 0)
        if c1 >= n1 or c2 >= n2:
            return None
        v = mat[c1][c2]
        return (v[0], v[1], vf2)

    def glyphs(self, text: str) -> list[int]:
        return [self.cmap.get(ord(ch), 0) for ch in text]

    @functools.lru_cache(maxsize=200000)
    def units(self, text: str) -> int:
        g = self.glyphs(text)
        total = sum(self.adv[x] for x in g)
        n = len(g)
        for ignore_marks, subs in self.lookups:
            i = 0
            while i < n:
                if ignore_marks and g[i] in self.marks:
                    i += 1
                    continue
                j = i + 1
                while j < n and ignore_marks and g[j] in self.marks:
                    j += 1
                if j >= n:
                    break
                for st in subs:
                    r = self._match(st, g[i], g[j])
                    if r is not None:
                        total += r[0] + r[1]
                        i = j + 1 if r[2] else j
                        break
                else:
                    i += 1
        return total

    def width(self, text: str, size: float) -> float:
        return self.units(text) * size / self.upem

    def pen_positions(self, text: str, size: float) -> list[float]:
        """x offset (px) of every character's pen position, kerning included (for drawing)."""
        g = self.glyphs(text)
        n = len(g)
        adj = [0] * n
        for ignore_marks, subs in self.lookups:
            i = 0
            while i < n:
                if ignore_marks and g[i] in self.marks:
                    i += 1
                    continue
                j = i + 1
                while j < n and ignore_marks and g[j] in self.marks:
                    j += 1
                if j >= n:
                    break
                for st in subs:
                    r = self._match(st, g[i], g[j])
                    if r is not None:
                        adj[i] += r[0]
                        adj[j] += r[1]
                        i = j + 1 if r[2] else j
                        break
                else:
                    i += 1
        out, x = [], 0
        for k in range(n):
            out.append(x * size / self.upem)
            x += self.adv[g[k]] + adj[k]
        return out

    def ascent(self, size: float) -> float:
        return self.ascent_u * size / self.upem

    def descent(self, size: float) -> float:
        return self.descent_u * size / self.upem


@functools.lru_cache(maxsize=None)
def font(weight: int = 400, family: str = "default") -> Font:
    """Bundled Noto Sans (nearest of 400/700). Other families fall back to it."""
    w = 700 if resolve_weight(weight) >= 550 else 400
    name = "NotoSans-Bold.ttf" if w == 700 else "NotoSans-Regular.ttf"
    return Font(str(paths.FONTS / name))


def resolve_weight(w) -> int:
    if w in (None, "normal"):
        return 400
    if w == "bold":
        return 700
    return int(w)


def font_file(weight: int = 400) -> str:
    return str(paths.FONTS / ("NotoSans-Bold.ttf" if resolve_weight(weight) >= 550 else "NotoSans-Regular.ttf"))


# ---------------------------------------------------------------------------
# Line breaking (spec §5.3)
# ---------------------------------------------------------------------------
def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return (0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF or 0x20000 <= cp <= 0x2A6DF
            or 0xF900 <= cp <= 0xFAFF)


def break_opportunities(text: str) -> list[int]:
    """Sorted end positions e (a line may end after text[e-1])."""
    out = []
    n = len(text)
    for k in range(n - 1):
        c, d = text[k], text[k + 1]
        ok = False
        if c == " ":
            ok = True
        elif c in "/._-,;":
            ok = True
        elif c == ":":
            ok = d != ":"
        elif c.isalpha() and unicodedata.category(c) == "Ll" and unicodedata.category(d) == "Lu":
            ok = True
        elif c.isalpha() and d.isdigit():
            ok = True
        elif _is_cjk(c) and _is_cjk(d):
            ok = True
        if ok:
            out.append(k + 1)
    return out


def _trim(s: str) -> str:
    return s.strip(" ")


def greedy(text: str, max_width: float, measure) -> list[str]:
    opps = break_opportunities(text)
    n = len(text)
    lines: list[str] = []
    start = 0
    while start < n:
        while start < n and text[start] == " ":
            start += 1
        if start >= n:
            break
        cands = [e for e in opps if e > start] + [n]
        best = None
        for e in cands:
            if measure(_trim(text[start:e])) <= max_width + 1e-9:
                best = e
            else:
                break
        if best is None:  # emergency break inside the first token
            e = cands[0]
            k = start + 1
            while k < e and measure(text[start:k + 1]) <= max_width + 1e-9:
                k += 1
            best = max(start + 1, k)
        line = _trim(text[start:best])
        if line:
            lines.append(line)
        start = best
    return lines or [""]


def candidate_widths(text: str, measure) -> list[float]:
    opps = break_opportunities(text)
    starts = [0] + opps
    ends = opps + [len(text)]
    ws = set()
    for a in starts:
        for e in ends:
            if e > a:
                s = _trim(text[a:e])
                if s:
                    ws.add(measure(s))
    return sorted(ws)


def balanced(text: str, n: int, measure) -> list[str]:
    for w in candidate_widths(text, measure):
        lines = greedy(text, w, measure)
        if len(lines) <= n:
            return lines
    return [_trim(text)]


def truncate_end(text: str, max_width: float, max_lines: int, measure) -> list[str]:
    lines = greedy(text, max_width, measure)
    if len(lines) <= max_lines:
        return lines
    keep = lines[:max_lines]
    last = keep[-1]
    while last and measure(last + ELLIPSIS) > max_width + 1e-9:
        last = last[:-1].rstrip(" ")
    keep[-1] = last + ELLIPSIS
    return keep


def truncate_middle(text: str, max_width: float, max_lines: int, measure) -> list[str]:
    n = len(text)
    for remove in range(1, n):
        left = (n - remove + 1) // 2
        right = n - remove - left
        cand = text[:left] + ELLIPSIS + (text[n - right:] if right > 0 else "")
        lines = greedy(cand, max_width, measure)
        if len(lines) <= max_lines:
            return lines
    return [ELLIPSIS]


@dataclass
class TextLayout:
    lines: list[str]
    line_widths: list[float]
    width: float          # content width (max line width)
    height: float         # content height
    ascent: float
    descent: float
    line_pitch: float
    font_size: float
    font_weight: int
    used: str = "original"
    truncated: bool = False
    baselines: list[float] = field(default_factory=list)  # relative to the content top


def layout_lines(lines: list[str], size: float, weight: int, line_height: float) -> TextLayout:
    f = font(weight)
    widths = [f.width(s, size) for s in lines]
    asc, desc = f.ascent(size), f.descent(size)
    pitch = line_height * size
    h = asc + desc + (len(lines) - 1) * pitch
    return TextLayout(lines=list(lines), line_widths=widths, width=max(widths) if widths else 0.0, height=h,
                      ascent=asc, descent=desc, line_pitch=pitch, font_size=size, font_weight=weight,
                      baselines=[asc + i * pitch for i in range(len(lines))])


def measure_fn(size: float, weight: int):
    f = font(weight)
    return lambda s: f.width(s, size)


def normal_variant(text: str, size: float, weight: int, line_height: float, wrap: dict | None,
                   truncate: str = "none", em: float | None = None) -> TextLayout:
    """The first normal variant of a text label (spec §5.3): balanced(L_min) with wrap
    settings, else the single line; truncated per ``truncate`` when L_min > max_lines."""
    from .spec import length  # local import to avoid a cycle

    meas = measure_fn(size, weight)
    if "\n" in text:
        return layout_lines(text.split("\n"), size, weight, line_height)
    if not wrap:
        return layout_lines([text], size, weight, line_height)
    mw = wrap.get("max_width")
    max_w = length(mw, em if em is not None else size) if mw is not None else None
    max_lines = wrap.get("max_lines")
    if max_w is None:
        return layout_lines([text], size, weight, line_height)
    g = greedy(text, max_w, meas)
    l_min = len(g)
    if max_lines is not None and l_min > max_lines:
        if truncate == "end":
            lay = layout_lines(truncate_end(text, max_w, max_lines, meas), size, weight, line_height)
            lay.used, lay.truncated = "truncated", True
            return lay
        if truncate == "middle":
            lay = layout_lines(truncate_middle(text, max_w, max_lines, meas), size, weight, line_height)
            lay.used, lay.truncated = "truncated", True
            return lay
        return layout_lines(balanced(text, max_lines, meas), size, weight, line_height)
    if wrap.get("balance", True) is False:
        return layout_lines(g, size, weight, line_height)
    return layout_lines(balanced(text, l_min, meas), size, weight, line_height)
