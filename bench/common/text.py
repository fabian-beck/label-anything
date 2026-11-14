"""Text measurement for the benchmark tools: spec §5.2 "simple shaping" and the
line breaking / wrapping of §5.3, implemented independently of the engine.

* advances from ``hmtx`` through ``cmap`` (unmapped code points → glyph 0),
* GPOS pair kerning: every lookup referenced by a ``kern`` feature of any
  script's default or language system (union, ascending); type 2 or type 9
  extension to type 2; glyphs walked pairwise, skipping marks (GDEF class 3)
  when the lookup flag has IgnoreMarks; the first matching subtable applies;
  ``XAdvance`` of value record 1 (and 2, which also advances past the pair),
* width = (Σ advances + Σ adjustments) · size / unitsPerEm,
* vertical metrics from hhea (or OS/2 typo metrics when USE_TYPO_METRICS),
* ink: the bounds of the glyph outlines (the engine reads the same bounds from the table
  ``LAvb`` of its outline-free metrics fonts); a text label's box spans from the ink top of
  its first line to the ink bottom of its last line (an edge without ink: the ascent or
  descent; ADR text/measurement). Composite parts keep the ascent and descent.

The bundled Noto Sans subset in ``fonts/`` is used for the family ``default``.
"""
from __future__ import annotations

import bisect
import functools
import math
import struct
from dataclasses import dataclass, field

from fontTools.ttLib import TTFont

from . import paths
from .spec import length
from .unicode_data import COMBINING_MARKS

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
        self.vbounds = self._vbounds(f)

    @staticmethod
    def _vbounds(f: TTFont) -> list[tuple[int, int]] | None:
        """(yMin, yMax) per glyph id, (0, 0) for a glyph without outline: the private table
        ``LAvb`` of an outline-free metrics font (spec §5.2: ``uint16`` version 1, ``uint16``
        numGlyphs, that of ``maxp``, then ``int16`` yMin, yMax per glyph), else the bounds of
        the outlines in ``glyf`` (the bundled Noto Sans); None without either."""
        if "LAvb" in f:
            data = f.getTableData("LAvb")
            if len(data) < 4:
                return None
            version, n = struct.unpack(">HH", data[:4])
            if version != 1 or n != f["maxp"].numGlyphs or len(data) < 4 + 4 * n:
                return None
            v = struct.unpack(f">{2 * n}h", data[4:4 + 4 * n])
            return [(v[2 * i], v[2 * i + 1]) for i in range(n)]
        if "glyf" not in f:
            return None
        glyf = f["glyf"]
        out = []
        for name in f.getGlyphOrder():
            g = glyf[name]
            if g.numberOfContours == 0:
                out.append((0, 0))
                continue
            g.recalcBounds(glyf)
            out.append((g.yMin, g.yMax))
        return out

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

    def _pair_adjustments(self, g: list[int]) -> list[int]:
        """The kerning of the glyph run ``g`` per glyph, in font units: of each matching pair, ``XAdvance`` of
        value record 1 on its first glyph and of value record 2 on its second (see the module docstring)."""
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
        return adj

    @functools.lru_cache(maxsize=200000)
    def units(self, text: str) -> int:
        g = self.glyphs(text)
        return sum(self.adv[x] for x in g) + sum(self._pair_adjustments(g))

    def width(self, text: str, size: float) -> float:
        return self.units(text) * size / self.upem

    def pen_positions(self, text: str, size: float) -> list[float]:
        """x offset (px) of every character's pen position, kerning included (for drawing)."""
        g = self.glyphs(text)
        adj = self._pair_adjustments(g)
        out, x = [], 0
        for k in range(len(g)):
            out.append(x * size / self.upem)
            x += self.adv[g[k]] + adj[k]
        return out

    def ink(self, text: str, size: float) -> tuple[float, float] | None:
        """How far the outlines of the glyphs of ``text`` reach above and below the baseline,
        in px (spec §5.2); None without ``LAvb`` or when no glyph has an outline."""
        if self.vbounds is None:
            return None
        lo = hi = None
        for g in self.glyphs(text):
            y0, y1 = self.vbounds[g]
            if y0 == y1:
                continue
            lo = y0 if lo is None else min(lo, y0)
            hi = y1 if hi is None else max(hi, y1)
        if lo is None:
            return None
        return hi * size / self.upem, -lo * size / self.upem

    def ascent(self, size: float) -> float:
        return self.ascent_u * size / self.upem

    def descent(self, size: float) -> float:
        return self.descent_u * size / self.upem


@functools.lru_cache(maxsize=None)
def _font_at(path: str) -> Font:
    return Font(path)


def font(weight: int = 400) -> Font:
    """Bundled Noto Sans (nearest of 400/700), for every family."""
    return _font_at(font_file(weight))


def resolve_weight(w) -> int:
    if w in (None, "normal"):
        return 400
    if w == "bold":
        return 700
    return int(w)


def font_file(weight: int = 400) -> str:
    return str(paths.FONTS / ("NotoSans-Bold.ttf" if resolve_weight(weight) >= 550 else "NotoSans-Regular.ttf"))


# ---------------------------------------------------------------------------
# Line breaking, wrapping, truncation (spec §5.3)
#
# A transcription of the spec's rules; `conformance/text/wrap-*.json` holds the expected
# results (bench/tests/test_conformance.py). Positions are code point indices; widths are
# compared as the spec says, without a tolerance.
# ---------------------------------------------------------------------------
WHITE_SPACE = frozenset([*range(0x09, 0x0E), 0x20, 0x85, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029,
                         0x202F, 0x205F, 0x3000])  # the Unicode property White_Space
_NO_BREAK_SPACES = frozenset([0xA0, 0x2007, 0x202F])
_SPACES = "".join(map(chr, sorted(WHITE_SPACE)))
_PUNCTUATION = frozenset("/\\._-,;:|")
_DIGITS = frozenset("0123456789")
_CJK = ((0x2E80, 0x9FFF), (0xAC00, 0xD7AF), (0xF900, 0xFAFF), (0xFF00, 0xFFEF), (0x20000, 0x2FFFF))
_MARK_STARTS = [a for a, _ in COMBINING_MARKS]


def is_space(ch: str) -> bool:
    return ord(ch) in WHITE_SPACE


def is_mark(ch: str) -> bool:
    """Combining mark (General_Category Mn, Mc or Me of Unicode 15.1: the table every implementation
    shares, not the one of this Python)."""
    cp = ord(ch)
    i = bisect.bisect_right(_MARK_STARTS, cp) - 1
    return i >= 0 and cp <= COMBINING_MARKS[i][1]


def _is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return any(a <= cp <= b for a, b in _CJK)


def break_opportunities(text: str) -> list[int]:
    """The positions k, ascending, after which a line may end (between ``text[k]`` and ``text[k + 1]``;
    the end of the text is not listed): the table of spec §5.3."""
    out = []
    n = len(text)
    for k in range(n - 1):
        a, b = text[k], text[k + 1]
        if is_mark(b):
            continue
        if is_space(a):
            ok = ord(a) not in _NO_BREAK_SPACES
        elif a in _PUNCTUATION:
            colons = a == ":" and b == ":"
            number = a in ".," and k > 0 and text[k - 1] in _DIGITS and b in _DIGITS
            ok = not colons and not number
        else:
            ok = (a.islower() and b.isupper()  # camelCase (the properties Lowercase and Uppercase)
                  or a.isupper() and b.isupper() and k + 2 < n and text[k + 2].islower()  # acronym
                  or _is_cjk(a) and _is_cjk(b))
        if ok:
            out.append(k)
    return out


def trim(text: str) -> str:
    return text.strip(_SPACES)


class _Wrap:
    """A text prepared for wrapping: its break opportunities, and the width of every line asked for,
    measured once. A line ``(s, e)`` is the text from ``s`` to ``e`` without trailing white space."""

    def __init__(self, text: str, measure):
        self.text = text
        self.n = len(text)
        self.breaks = break_opportunities(text)
        self.measure = measure
        self._widths: dict[tuple[int, int], float] = {}

    def skip_spaces(self, i: int) -> int:
        while i < self.n and is_space(self.text[i]):
            i += 1
        return i

    def line(self, s: int, e: int) -> str:
        return self.text[s:e + 1].rstrip(_SPACES)

    def width(self, s: int, e: int) -> float:
        w = self._widths.get((s, e))
        if w is None:
            w = self._widths[(s, e)] = self.measure(self.line(s, e))
        return w

    def breaks_from(self, s: int) -> list[int]:
        return self.breaks[bisect.bisect_left(self.breaks, s):]

    def segment_end(self, s: int) -> int:
        """The first break opportunity at or after ``s``, else the last position."""
        i = bisect.bisect_left(self.breaks, s)
        return self.breaks[i] if i < len(self.breaks) else self.n - 1

    def greedy(self, w: float) -> list[tuple[int, int]]:
        spans = []
        s = self.skip_spaces(0)
        while s < self.n:
            if self.width(s, self.n - 1) <= w:
                e = self.n - 1
            else:
                e = None
                for k in self.breaks_from(s):  # up to the first break that does not fit
                    if self.width(s, k) > w:
                        break
                    e = k
                if e is None:
                    e = self.emergency(s, w)
            spans.append((s, e))
            s = self.skip_spaces(e + 1)
        return spans

    def emergency(self, s: int, w: float) -> int:
        """No break fits: the line ends inside its first segment, at the last position that fits and is
        not followed by a combining mark, else at the first such position, else at the segment's end."""
        t = self.segment_end(s)
        end = None
        for e in range(s, t):
            if e + 1 < self.n and is_mark(self.text[e + 1]):
                continue
            if self.width(s, e) > w:
                return e if end is None else end
            end = e
        return t if end is None else end

    def balanced(self, n_lines: int, max_width: float | None) -> list[tuple[int, int]]:
        first = self.skip_spaces(0)
        if first >= self.n:
            return []
        starts = [first]
        for k in self.breaks:
            s = self.skip_spaces(k + 1)
            if s < self.n and s != starts[-1]:
                starts.append(s)
        cands = set()
        floor = 0.0  # the widest first segment of a line: a narrower width needs an emergency break
        for s in starts:
            floor = max(floor, self.width(s, self.segment_end(s)))
            for k in self.breaks_from(s) + [self.n - 1]:
                c = self.width(s, k)
                if max_width is not None and c > max_width:
                    break
                cands.add(c)
        if max_width is not None:
            cands.add(max_width)
            floor = min(floor, max_width)
        cands = sorted(c for c in cands if c >= floor)
        if not cands:
            return self.greedy(math.inf if max_width is None else max_width)
        lo, hi = 0, len(cands) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if len(self.greedy(cands[mid])) <= max(n_lines, 1):
                hi = mid
            else:
                lo = mid + 1
        spans = self.greedy(cands[lo])
        if max_width is not None and len(spans) > max(n_lines, 1):
            spans = self.greedy(max_width)
        return spans

    def lines(self, spans: list[tuple[int, int]]) -> list[str]:
        """The lines as strings; a blank text is one empty line."""
        return [self.line(s, e) for s, e in spans] or [""]


def greedy(text: str, max_width: float, measure) -> list[str]:
    """``greedy(W)``: every line takes the rest of the text if it fits, else reaches to the last break
    opportunity that fits; a segment wider than ``max_width`` is broken inside (emergency break)."""
    w = _Wrap(text, measure)
    return w.lines(w.greedy(max_width))


def balanced(text: str, n: int, measure, max_width: float | None = None) -> list[str]:
    """``balanced(N, M)``: the greedy wrap at the smallest candidate width that needs at most ``n``
    lines; with ``max_width`` no candidate is wider, and its greedy wrap is the result if even that
    has more lines."""
    w = _Wrap(text, measure)
    return w.lines(w.balanced(n, max_width))


def truncate_end(text: str, max_width: float, measure) -> str:
    """The text if it fits, else its longest prefix (not cut before a combining mark, without trailing
    white space) that fits with ``…`` appended; ``…`` if none does."""
    if measure(text) <= max_width:
        return text
    best = ELLIPSIS
    for m in range(1, len(text)):
        if is_mark(text[m]):
            continue
        cand = text[:m].rstrip(_SPACES) + ELLIPSIS
        if measure(cand) > max_width:
            break
        best = cand
    return best


def truncate_middle(text: str, max_width: float, max_lines: int, measure) -> list[str]:
    """The greedy wrap of the trimmed text with the fewest code points of its middle replaced by ``…``
    such that it has at most ``max_lines`` lines."""
    text = trim(text)
    max_lines = max(max_lines, 1)
    lines = greedy(text, max_width, measure)
    if len(lines) <= max_lines:
        return lines
    n = len(text)

    def candidate(removed: int) -> str:
        keep = n - removed
        left, right = (keep + 1) // 2, n - keep // 2
        while left > 0 and is_mark(text[left]):
            left -= 1
        while right < n and is_mark(text[right]):
            right += 1
        return text[:left].rstrip(_SPACES) + ELLIPSIS + text[right:].lstrip(_SPACES)

    lo, hi = 1, n
    while lo < hi:
        mid = (lo + hi) // 2
        if len(_Wrap(candidate(mid), measure).greedy(max_width)) <= max_lines:
            hi = mid
        else:
            lo = mid + 1
    return greedy(candidate(lo), max_width, measure)


def wrap_variants(text: str, max_width: float | None, max_lines: int, measure, balance: bool = True,
                  truncate: str = "none") -> list[tuple[list[str], bool]]:
    """The variants of a text label with wrap settings, as (lines, truncated) (spec §5.3 "Variants")."""
    w = _Wrap(text, measure)
    max_lines = max(max_lines, 1)
    if max_width is not None:
        spans = w.greedy(max_width)
    else:
        first = w.skip_spaces(0)
        spans = [(first, w.n - 1)] if first < w.n else []
    l_min = max(len(spans), 1)
    if l_min <= max_lines:
        if not balance:
            return [(w.lines(spans), False)]
        out: list[tuple[list[str], bool]] = []
        for n in range(l_min, min(l_min + 2, max_lines) + 1):
            lines = w.lines(w.balanced(n, max_width))
            if all(v[0] != lines for v in out):
                out.append((lines, False))
        return out
    if truncate == "end":
        lines = [w.line(s, e) for s, e in spans[:max_lines - 1]]
        rest = w.line(spans[max_lines - 1][0], w.n - 1)
        return [(lines + [truncate_end(rest, max_width, measure)], True)]
    if truncate == "middle":
        return [(truncate_middle(text, max_width, max_lines, measure), True)]
    # keep the text and give up the width: the narrowest wrap into max_lines lines
    return [(w.lines(w.balanced(max_lines, None)), False)]


@dataclass
class TextLayout:
    lines: list[str]
    line_widths: list[float]
    width: float          # content width (max line width)
    height: float         # content height
    ascent: float
    descent: float
    font_size: float
    font_weight: int
    used: str = "original"
    truncated: bool = False
    baselines: list[float] = field(default_factory=list)  # relative to the content top
    align: str = "start"  # how the lines are aligned within the widest (spec §5.1)

    def x_offsets(self, padding: float) -> list[float]:
        """Where each line starts from the box's left edge (``text.x_offsets``, ADR text/line-breaking)."""
        f = {"center": 0.5, "end": 1.0}.get(self.align, 0.0)
        return [padding + (self.width - w) * f for w in self.line_widths]


def layout_lines(lines: list[str], size: float, weight: int, line_height: float, ink: bool = True) -> TextLayout:
    """A block of lines: from the ink top of the first line to the ink bottom of the last
    (``ink``, the edges of lines without ink: the ascent and descent), baselines a pitch of
    ``line_height`` apart (spec §5.2)."""
    f = font(weight)
    widths = [f.width(s, size) for s in lines]
    asc, desc = f.ascent(size), f.descent(size)
    first = f.ink(lines[0], size) if ink and lines else None
    last = f.ink(lines[-1], size) if ink and lines else None
    top = first[0] if first else asc
    bottom = last[1] if last else desc
    pitch = line_height * size
    h = top + bottom + (max(len(lines), 1) - 1) * pitch
    return TextLayout(lines=list(lines), line_widths=widths, width=max(widths) if widths else 0.0, height=h,
                      ascent=asc, descent=desc, font_size=size, font_weight=weight,
                      baselines=[top + i * pitch for i in range(len(lines))])


def measure_fn(size: float, weight: int):
    f = font(weight)
    return lambda s: f.width(s, size)


def normal_variant(text: str, size: float, weight: int, line_height: float, wrap: dict | None,
                   truncate: str = "none", em: float | None = None, ink: bool = True) -> TextLayout:
    """The first normal variant of a text label (spec §5.3): its lines between line feeds if it has
    any, without wrap settings the single line, else the first of ``wrap_variants``."""

    def lay_out(lines):
        return layout_lines(lines, size, weight, line_height, ink)

    if "\n" in text:  # hard breaks: the author's lines, never wrapped or truncated
        return lay_out([s[:-1] if s.endswith("\r") else s for s in text.split("\n")])
    if not isinstance(wrap, dict):
        return lay_out([text])
    mw = wrap.get("max_width")
    max_w = length(mw, em if em is not None else size) if mw is not None else None
    # a missing max_lines counts as 1, as in the engine
    lines, truncated = wrap_variants(text, max_w, int(wrap.get("max_lines") or 1), measure_fn(size, weight),
                                     wrap.get("balance", True) is not False, truncate)[0]
    lay = lay_out(lines)
    if truncated:
        lay.used, lay.truncated = "truncated", True
    return lay
