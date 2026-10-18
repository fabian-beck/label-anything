#!/usr/bin/env python3
"""Generate the `text` conformance cases in conformance/text/ (spec §5.2-5.3).

Expected values come from references that are independent of the Rust and TypeScript
implementations:

* Widths: simple shaping (spec §5.2) written on top of fontTools' table parsers, checked
  against HarfBuzz (uharfbuzz) with only `kern` enabled. Simple shaping does not normalize
  and does not hide default-ignorable code points; HarfBuzz decomposes unmapped characters
  (e.g. U+2260 → `=` + U+0338) and hides/skips default ignorables (ZWSP, soft hyphen, ...),
  so strings containing either are checked against fontTools only.
* Breaks, wraps, truncations and variants: a direct Python transcription of spec §5.3 that
  uses the fontTools widths as its measure.

Outputs: conformance/text/widths-*.json and wrap-*.json (bundled Noto Sans), the synthetic
fonts of tools/text/test_fonts.py in conformance/text/fonts/ with their synthetic-*.json
cases (`font.file` is relative to conformance/text/), and the WOFF2 test fixture of the Rust
crate (rust/crates/la-text/tests/data/).

Case files hold, besides the keys documented in conformance/README.md:
  metrics        {units_per_em, ascender, descender, line_gap} of the resolved font
  widths[].units advance in font units (Font::advance_units), exact
  breaks         [{text, breaks}]                 break_opportunities
  wrap           [{text, max_width, lines}]       greedy_wrap
  balanced       [{text, lines_target, max_width (null = none), lines}]   balanced_wrap
  truncate       [{text, max_width, mode: "end", result}] truncate_end;
                 [{text, max_width, mode: "middle", max_lines, lines}] truncate_middle
  variants       [{text, options: {max_width, max_lines, balance, truncate}, variants}]
  extra_variants [{text, max_lines, variants}]    extra_wrap_variants
where a variant is {lines, widths, truncated}; widths are compared with tol 0.01.

Usage: python3 tools/text/gen_text_cases.py [--check]     (pip install -r tools/text/requirements.txt)
"""
import json
import re
import sys
import unicodedata
from io import BytesIO
from pathlib import Path

import uharfbuzz as hb
from fontTools.ttLib import TTFont

from test_fonts import build_fonts, woff2

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "conformance/text"
FONTS = {400: ROOT / "fonts/NotoSans-Regular.metrics.ttf", 700: ROOT / "fonts/NotoSans-Bold.metrics.ttf"}
WOFF2_FIXTURE = ROOT / "rust/crates/la-text/tests/data/NotoSans-Regular.metrics.woff2"
ELLIPSIS = "\u2026"

# --------------------------------------------------------------------------------------
# Simple shaping on fontTools (spec §5.2)
# --------------------------------------------------------------------------------------


class SimpleShaper:
    CMAP_PREFERENCE = [(3, 10), (0, 4), (3, 1), (0, 3)]

    def __init__(self, data):
        self.data = data
        font = TTFont(BytesIO(data), fontNumber=0)
        order = font.getGlyphOrder()
        self.gid = {name: i for i, name in enumerate(order)}
        self.names = order
        self.upm = font["head"].unitsPerEm
        os2, hhea = font["OS/2"], font["hhea"]
        if os2.fsSelection & 0x80:
            self.metrics = (os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap)
        else:
            self.metrics = (hhea.ascent, hhea.descent, hhea.lineGap)
        candidates = [(self.CMAP_PREFERENCE.index((t.platformID, t.platEncID)), i, t)
                      for i, t in enumerate(font["cmap"].tables)
                      if (t.platformID, t.platEncID) in self.CMAP_PREFERENCE and t.format in (4, 12)]
        self.cmap = min(candidates, key=lambda c: (c[0], c[1]))[2].cmap
        self.advance = [font["hmtx"][name][0] for name in order]
        classes = font["GDEF"].table.GlyphClassDef.classDefs if "GDEF" in font else {}
        self.is_mark = [classes.get(name) == 3 for name in order]
        # (IgnoreMarks, [PairPos subtables]) per kern lookup, ascending
        self.lookups, has_kern_feature, kern = [], False, set()
        gpos = font["GPOS"].table if "GPOS" in font else None
        for record in gpos.ScriptList.ScriptRecord if gpos else []:
            systems = [record.Script.DefaultLangSys] if record.Script.DefaultLangSys else []
            systems += [lang.LangSys for lang in record.Script.LangSysRecord]
            for system in systems:
                indices = list(system.FeatureIndex)
                if system.ReqFeatureIndex != 0xFFFF:
                    indices.append(system.ReqFeatureIndex)
                for index in indices:
                    feature = gpos.FeatureList.FeatureRecord[index]
                    if feature.FeatureTag == "kern":
                        has_kern_feature = True
                        kern.update(feature.Feature.LookupListIndex)
        for index in sorted(kern):
            lookup = gpos.LookupList.Lookup[index]
            if lookup.LookupType == 2:
                subtables = list(lookup.SubTable)
            elif lookup.LookupType == 9:
                subtables = [s.ExtSubTable for s in lookup.SubTable if s.ExtensionLookupType == 2]
            else:
                continue
            self.lookups.append((bool(lookup.LookupFlag & 0x0008), subtables))
        # legacy `kern` table: summed pair values of the horizontal format 0 subtables
        self.legacy = {}
        if not has_kern_feature and "kern" in font:
            for subtable in font["kern"].kernTables:
                flags_ok = (subtable.coverage & 0xE0) == 0 if subtable.apple else (subtable.coverage & 0x07) == 0x01
                if subtable.format == 0 and flags_ok:
                    for (left, right), value in subtable.kernTable.items():
                        key = (self.gid[left], self.gid[right])
                        self.legacy[key] = self.legacy.get(key, 0) + value

    def glyphs(self, text):
        return [self.gid[self.cmap[ord(c)]] if ord(c) in self.cmap else 0 for c in text]

    @staticmethod
    def _x(record, name):
        value = getattr(record, name, None)
        return (getattr(value, "XAdvance", 0) or 0) if value is not None else 0

    def _match(self, subtable, first, second):
        """(adjustment, skip second) if the PairPos subtable applies, else None."""
        coverage = subtable.Coverage.glyphs
        a, b = self.names[first], self.names[second]
        if a not in coverage:
            return None
        if subtable.Format == 1:
            index = coverage.index(a)
            if index >= len(subtable.PairSet):
                return None
            for record in subtable.PairSet[index].PairValueRecord:
                if record.SecondGlyph == b:
                    return self._x(record, "Value1") + self._x(record, "Value2"), subtable.ValueFormat2 != 0
            return None
        class1 = subtable.ClassDef1.classDefs.get(a, 0) if subtable.ClassDef1 else 0
        class2 = subtable.ClassDef2.classDefs.get(b, 0) if subtable.ClassDef2 else 0
        if class1 >= subtable.Class1Count or class2 >= subtable.Class2Count:
            return None
        record = subtable.Class1Record[class1].Class2Record[class2]
        return self._x(record, "Value1") + self._x(record, "Value2"), subtable.ValueFormat2 != 0

    def units(self, text):
        glyphs = self.glyphs(text)
        total = sum(self.advance[g] for g in glyphs)
        if self.legacy:  # one IgnoreMarks lookup; a pair never skips its second glyph
            i = 0
            while i < len(glyphs):
                if self.is_mark[glyphs[i]]:
                    i += 1
                    continue
                j = i + 1
                while j < len(glyphs) and self.is_mark[glyphs[j]]:
                    j += 1
                if j >= len(glyphs):
                    break
                value = self.legacy.get((glyphs[i], glyphs[j]))
                if value is None:
                    i += 1
                else:
                    total += value
                    i = j
        for ignore_marks, subtables in self.lookups:
            i = 0
            while i < len(glyphs):
                if ignore_marks and self.is_mark[glyphs[i]]:
                    i += 1
                    continue
                j = i + 1
                while ignore_marks and j < len(glyphs) and self.is_mark[glyphs[j]]:
                    j += 1
                if j >= len(glyphs):
                    break
                for subtable in subtables:
                    found = self._match(subtable, glyphs[i], glyphs[j])
                    if found is not None:
                        total += found[0]
                        i = j + 1 if found[1] else j
                        break
                else:
                    i += 1
        return total

    def width(self, text, size):
        return self.units(text) * size / self.upm


HB_FEATURES = {"kern": True, "liga": False, "clig": False, "calt": False, "ccmp": False, "locl": False,
               "mark": False, "mkmk": False, "dist": False, "rlig": False, "rclt": False, "curs": False}
# Default_Ignorable_Code_Point (DerivedCoreProperties.txt)
DEFAULT_IGNORABLE = [(0x00AD, 0x00AD), (0x034F, 0x034F), (0x061C, 0x061C), (0x115F, 0x1160), (0x17B4, 0x17B5),
                     (0x180B, 0x180F), (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3164, 0x3164),
                     (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3),
                     (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF)]


def harfbuzz_units(data, text):
    font = hb.Font(hb.Face(hb.Blob(data)))
    buffer = hb.Buffer()
    buffer.add_str(text)
    buffer.guess_segment_properties()
    hb.shape(font, buffer, HB_FEATURES)
    return sum(p.x_advance for p in buffer.glyph_positions or [])


def harfbuzz_differs(shaper, text):
    """Whether HarfBuzz would hide/skip a default ignorable or decompose an unmapped character."""
    ignorable = any(a <= ord(c) <= b for c in text for a, b in DEFAULT_IGNORABLE)
    decomposable = any(ord(c) not in shaper.cmap and unicodedata.decomposition(c)[:1] not in ("", "<")
                       for c in text)
    return ignorable or decomposable


# --------------------------------------------------------------------------------------
# Line breaking, wrapping, truncation (spec §5.3)
# --------------------------------------------------------------------------------------

WHITE_SPACE = {*range(0x09, 0x0E), 0x20, 0x85, 0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F,
               0x205F, 0x3000}
NO_BREAK_SPACES = {0xA0, 0x2007, 0x202F}
PUNCTUATION = set("/\\._-,;:|")
CJK = [(0x2E80, 0x9FFF), (0xAC00, 0xD7AF), (0xF900, 0xFAFF), (0xFF00, 0xFFEF), (0x20000, 0x2FFFF)]


def is_space(c):
    return ord(c) in WHITE_SPACE


def is_mark(c):
    return unicodedata.category(c) in ("Mn", "Mc", "Me")


def is_cjk(c):
    return any(a <= ord(c) <= b for a, b in CJK)


def breaks(text):
    out = []
    for k in range(len(text) - 1):
        a, b = text[k], text[k + 1]
        if is_mark(b):
            continue
        if is_space(a) and ord(a) not in NO_BREAK_SPACES:
            out.append(k)
        elif a in PUNCTUATION:
            colons = a == ":" and b == ":"
            number = a in ".," and k > 0 and text[k - 1] in "0123456789" and b in "0123456789"
            if not colons and not number:
                out.append(k)
        elif a.islower() and b.isupper():
            out.append(k)
        elif a.isupper() and b.isupper() and k + 2 < len(text) and text[k + 2].islower():
            out.append(k)
        elif is_cjk(a) and is_cjk(b):
            out.append(k)
    return out


def line(text, s, e):
    return text[s:e + 1].rstrip("".join(map(chr, WHITE_SPACE)))


def skip_spaces(text, i):
    while i < len(text) and is_space(text[i]):
        i += 1
    return i


def last_fitting(candidates, fits):
    """Scans ascending and stops at the first candidate that does not fit:
    (last fitting candidate or None, first non-fitting candidate or None)."""
    last = None
    for c in candidates:
        if not fits(c):
            return last, c
        last = c
    return last, None


def greedy_spans(text, w, measure):
    n, bks, spans = len(text), breaks(text), []
    s = skip_spaces(text, 0)
    while s < n:
        def fits(k):
            return measure(line(text, s, k)) <= w

        if fits(n - 1):
            e = n - 1
        else:
            e, _ = last_fitting([k for k in bks if k >= s], fits)
            if e is None:  # emergency break inside the segment [s..t]
                t = min([k for k in bks if k >= s] + [n - 1])
                ends = [c for c in range(s, t) if c + 1 >= n or not is_mark(text[c + 1])]
                e, first_misfit = last_fitting(ends, fits)
                if e is None:
                    e = first_misfit if first_misfit is not None else t
        spans.append((s, e))
        s = skip_spaces(text, e + 1)
    return spans


def as_lines(text, spans):
    return [line(text, s, e) for s, e in spans] or [""]


def greedy(text, w, measure):
    return as_lines(text, greedy_spans(text, w, measure))


def balanced(text, n_lines, max_width, measure):
    return as_lines(text, balanced_spans(text, n_lines, max_width, measure))


def balanced_spans(text, n_lines, max_width, measure):
    n, bks = len(text), breaks(text)
    first = skip_spaces(text, 0)
    if first >= n:
        return []
    starts = [first] + [skip_spaces(text, k + 1) for k in bks]
    starts = [s for s in starts if s < n]
    cands = set()
    floor = 0.0  # the widest first segment of a line: narrower widths need an emergency break
    for s in starts:
        floor = max(floor, measure(line(text, s, min([k for k in bks if k >= s] + [n - 1]))))
        for k in [k for k in bks if k >= s] + [n - 1]:
            c = measure(line(text, s, k))
            if max_width is not None and c > max_width:
                break
            cands.add(c)
    if max_width is not None:
        cands = {c for c in cands | {max_width} if c <= max_width}
        floor = min(floor, max_width)
    cands = sorted(c for c in cands if c >= floor)
    lo, hi = 0, len(cands) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if len(greedy_spans(text, cands[mid], measure)) <= n_lines:
            hi = mid
        else:
            lo = mid + 1
    spans = greedy_spans(text, cands[lo], measure)
    if len(spans) > n_lines and max_width is not None:
        spans = greedy_spans(text, max_width, measure)
    return spans


def truncate_end(text, w, measure):
    if measure(text) <= w:
        return text
    prefixes = [text[:m].rstrip("".join(map(chr, WHITE_SPACE))) + ELLIPSIS
                for m in range(1, len(text)) if not is_mark(text[m])]
    best, _ = last_fitting(prefixes, lambda p: measure(p) <= w)
    return best if best is not None else ELLIPSIS


def truncate_middle(text, w, max_lines, measure):
    spaces = "".join(map(chr, WHITE_SPACE))
    text = text.strip(spaces)
    if len(greedy_spans(text, w, measure)) <= max_lines:
        return greedy(text, w, measure)
    n = len(text)

    def candidate(r):
        keep = n - r
        left, right = (keep + 1) // 2, n - keep // 2
        while left > 0 and is_mark(text[left]):
            left -= 1
        while right < n and is_mark(text[right]):
            right += 1
        return text[:left].rstrip(spaces) + ELLIPSIS + text[right:].lstrip(spaces)

    lo, hi = 1, n
    while lo < hi:
        mid = (lo + hi) // 2
        if len(greedy_spans(candidate(mid), w, measure)) <= max_lines:
            hi = mid
        else:
            lo = mid + 1
    return greedy(candidate(lo), w, measure)


def variant(lines, measure, truncated=False):
    return {"lines": lines, "widths": [measure(x) for x in lines], "truncated": truncated}


def wrap_variants(text, options, measure):
    m, max_lines = options["max_width"], max(options["max_lines"], 1)
    if m is not None:
        spans = greedy_spans(text, m, measure)
    else:
        first = skip_spaces(text, 0)
        spans = [(first, len(text) - 1)] if first < len(text) else []
    l_min = max(len(spans), 1)
    if l_min <= max_lines:
        if not options["balance"]:
            return [variant(as_lines(text, spans), measure)]
        out = []
        for n in range(l_min, min(l_min + 2, max_lines) + 1):
            lines = balanced(text, n, m, measure)
            if all(v["lines"] != lines for v in out):
                out.append(variant(lines, measure))
        return out
    if options["truncate"] == "end":
        lines = [line(text, s, e) for s, e in spans[:max_lines - 1]]
        rest = line(text, spans[max_lines - 1][0], len(text) - 1)
        return [variant(lines + [truncate_end(rest, m, measure)], measure, True)]
    if options["truncate"] == "middle":
        return [variant(truncate_middle(text, m, max_lines, measure), measure, True)]
    return [variant(balanced(text, max_lines, None, measure), measure)]


def extra_wrap_variants(text, max_lines, measure):
    out, bks = [], set(breaks(text))
    for n in range(2, max_lines + 1):
        spans = balanced_spans(text, n, None, measure)
        if len(spans) < 2 or any(e + 1 < len(text) and e not in bks for _, e in spans):
            continue  # single line, or a line ends inside a word (emergency break)
        lines = as_lines(text, spans)
        if all(v["lines"] != lines for v in out):
            out.append(variant(lines, measure))
    return out


# --------------------------------------------------------------------------------------
# Cases
# --------------------------------------------------------------------------------------

WIDTH_STRINGS = [
    # kerning pairs and kerned words
    "AV", "To", "Wa", "Yo", "L'", "F.", "P,", "Tr", "Ve", "LT", "LV", "AT", "Ty", "r.", "y,", "AVAVAV",
    "WAVY", "Typography", "Yellow", "Hello, World",
    # digits, punctuation, symbols
    "0123456789", "3.14159", "1,000,000", "\u221212.5 %", "2026-10-16",
    "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~", "\u201cQuoted\u201d \u2014 \u2018single\u2019 \u2026",
    "a/b\\c|d", "foo::bar", "x_y-z", "\u20ac100 \u00a350 \u00a530 $20", "a \u2192 b", "x \u2264 y \u2260 z",
    "\u25a0 \u25a1 \u25b2", "x\u207d\u207f\u207e", "H\u208d\u2082\u208e",
    # accents: precomposed and combining
    "\u00c6r\u00f8sk\u00f8bing", "Cr\u00e8me br\u00fbl\u00e9e", "\u017b\u00f3\u0142\u0107 g\u0119\u015bl\u0105",
    "\u00c5ngstr\u00f6m", "na\u00efve caf\u00e9", "T\u00e9", "Te\u0301", "e\u0301", "A\u0308V",
    "n\u0303o", "Wa\u0300y", "o\u0302\u0301", "\u0301x",
    # Greek and Cyrillic
    "\u0391\u03b8\u03ae\u03bd\u03b1", "\u0391\u03a5\u03a4\u039f\u039a\u0399\u039d\u0397\u03a4\u039f",
    "\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac", "\u03b1\u03b2\u03b3\u03b4\u03b5\u03b6\u03b7\u03b8",
    "\u041c\u043e\u0441\u043a\u0432\u0430", "\u0422\u0410\u0422\u042c\u042f\u041d\u0410",
    "\u041f\u0440\u0438\u0432\u0435\u0442, \u043c\u0438\u0440", "\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430",
    "\u0413\u043e\u0433\u043e\u043b\u044c", "\u0391V", "A\u03a5",
    # Java fully qualified class names
    "org.example.package.ClassName", "java.util.concurrent.ConcurrentHashMap",
    "org.springframework.beans.factory.support.DefaultListableBeanFactory",
    "com.fasterxml.jackson.databind.ObjectMapper$1",
    # unmapped code points (glyph 0): CJK, Hangul, emoji, Devanagari, tab
    "\u4e2d\u6587", "\u65e5\u672c\u8a9e\u30c6\u30ad\u30b9\u30c8", "\ud55c\uad6d\uc5b4", "\U0001F600\U0001F389",
    "x\U0001F600y", "\u0915\u093f", "tab\tchar",
    # ligature candidates (no ligatures in simple shaping)
    "office", "ffi", "fl", "\ufb01",
    # spaces
    "a b", "a\u00a0b", "a\u2009b", " leading", "trailing ", "multiple   spaces",
    # default ignorables (simple shaping measures their glyphs)
    "A\u200bV", "co\u00adop",
    # long texts and the empty string
    "The quick brown fox jumps over the lazy dog", "Pack my box with five dozen liquor jugs.", "",
    "org\u2026Foo", "Mr. Smith\u2026",
]

BREAK_TEXTS = [
    "org.example.package.ClassName", "XMLHttpRequestFactory", "getElementsByTagName", "std::collections::HashMap",
    "a:::b", "C:\\Program Files\\Label Anything", "https://example.com/path/to/file_name-v2.txt?q=1|x;y",
    "Version 3.14.159 has 1,000,000 users, 2.5x faster", "10\u00a0km and 5\u202fkg", "\u4e2d\u6587\u6807\u7b7e\u6d4b\u8bd5",
    "a\u4e2d\u6587b", "Cr\u00e8me Br\u00fbl\u00e9e", "e\u0301-x \u0301y", "\u0391\u03b8\u03ae\u03bd\u03b1\u039a\u03b1\u03b9",
    "\u041c\u043e\u0441\u043a\u0432\u0430\u0420\u0438\u043c", "line\none\ttab", "  spaced  out  ", "ABC", "aB", "",
    "x", "1.5.3", "a.1", "1.a", ",5",
]

WRAP_TEXTS = [
    "org.example.package.ClassName", "java.util.concurrent.ConcurrentHashMap", "XMLHttpRequestFactory",
    "The quick brown fox jumps over the lazy dog", "std::collections::HashMap<String, Vec<u8>>",
    "C:\\Program Files\\Label Anything\\bin", "https://example.com/path/to/resource?query=1",
    "first_name-last_name|middle_name", "Version 3.14.159 released on 2026-10-16", "1,000,000 items; 2,500 sold",
    "\u4e2d\u6587\u6807\u7b7e\u6d4b\u8bd5\u6587\u672c", "Supercalifragilisticexpialidocious",
    "\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac \u03ba\u03b1\u03b9 \u0420\u0443\u0441\u0441\u043a\u0438\u0439 \u0442\u0435\u043a\u0441\u0442",
    "Cr\u00e8me br\u00fbl\u00e9e \u00e0 la carte", "e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301",
    "multiple   spaces   between   words", "  leading and trailing  ", "AVAVAV AVAVAV", "x",
]

TRUNCATE_TEXTS = [
    "org.example.package.ClassName", "The quick brown fox jumps over the lazy dog",
    "java.util.concurrent.ConcurrentHashMap", "Cr\u00e8me br\u00fbl\u00e9e \u00e0 la carte",
    "e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301", "Supercalifragilisticexpialidocious", "short",
]


SYNTHETIC_STRINGS = {
    "synthetic-gpos.ttf": ["AV", "VA", "AVA", "ÁV", "́AV", "To", "Toa", "oa", "Ao", "Bo", "BV", "By", "Cy", "Ty",
                           "y.", "AT", "ΑV", "A V", "AVAVAV", "\U0001F600", "\U00010400", "A\U0001F600V",
                           "\U0010FFFF", ""],
    "synthetic-kern.ttf": ["AV", "VA", "AVA", "VAV", "To", "T.", "y.", "ÁV", "Ay", "A V", ""],
    "synthetic-kern-apple.ttf": ["AV", "VA", "To", "AVA", "ÁV", ""],
    "synthetic-cff.otf": ["AV", "VA", "AVA", "To", ""],
    "synthetic.ttc": ["AV", "VA", "AVA", "To", "T.", "ÁV", "\U0001F600"],
}
SYNTHETIC_SIZE = {"synthetic-gpos.ttf": 13.3}


def width_cases(shaper, strings, size, harfbuzz=True):
    entries = []
    for text in strings:
        units = shaper.units(text)
        if harfbuzz and not harfbuzz_differs(shaper, text):
            reference = harfbuzz_units(shaper.data, text)
            if reference != units:
                sys.exit(f"fontTools and HarfBuzz disagree on {text!r}: {units} != {reference}")
        entries.append({"text": text, "units": units, "width": units * size / shaper.upm, "tol": 0.01})
    return entries


def metrics_of(shaper):
    ascender, descender, line_gap = shaper.metrics
    return {"units_per_em": shaper.upm, "ascender": ascender, "descender": descender, "line_gap": line_gap}


def wrap_case(shaper, weight, size):
    def measure(s):
        return shaper.width(s, size)

    case = {"breaks": [{"text": t, "breaks": breaks(t)} for t in BREAK_TEXTS], "wrap": [], "balanced": [],
            "truncate": [], "variants": [], "extra_variants": []}
    for text in WRAP_TEXTS:
        full = measure(text.strip())
        for w in sorted({round(full * f, 2) for f in (0.3, 0.5, 0.75)} | {round(size * 0.5, 2), round(full + 1, 2)}):
            case["wrap"].append({"text": text, "max_width": w, "lines": greedy(text, w, measure)})
        for n in (2, 3):
            case["balanced"].append({"text": text, "lines_target": n, "max_width": None,
                                     "lines": balanced(text, n, None, measure)})
        m = round(full * 0.4, 2)
        case["balanced"].append({"text": text, "lines_target": 2, "max_width": m,
                                 "lines": balanced(text, 2, m, measure)})
        for options in ({"max_width": round(full * 0.45, 2), "max_lines": 3, "balance": True, "truncate": "none"},
                        {"max_width": round(full * 0.45, 2), "max_lines": 3, "balance": False, "truncate": "none"},
                        {"max_width": round(full * 0.3, 2), "max_lines": 2, "balance": True, "truncate": "end"},
                        {"max_width": round(full * 0.3, 2), "max_lines": 2, "balance": True, "truncate": "middle"},
                        {"max_width": round(full * 0.3, 2), "max_lines": 1, "balance": True, "truncate": "none"},
                        {"max_width": None, "max_lines": 3, "balance": True, "truncate": "none"}):
            case["variants"].append({"text": text, "options": options,
                                     "variants": wrap_variants(text, options, measure)})
        case["extra_variants"].append({"text": text, "max_lines": 3,
                                       "variants": extra_wrap_variants(text, 3, measure)})
    for text in TRUNCATE_TEXTS:
        full = measure(text)
        for w in sorted({round(full * f, 2) for f in (0.2, 0.5, 0.9)} | {round(full, 2), 1.0}):
            case["truncate"].append({"text": text, "max_width": w, "mode": "end",
                                     "result": truncate_end(text, w, measure)})
            case["truncate"].append({"text": text, "max_width": w, "mode": "middle", "max_lines": 1,
                                     "lines": truncate_middle(text, w, 1, measure)})
        w = round(full * 0.3, 2)
        case["truncate"].append({"text": text, "max_width": w, "mode": "middle", "max_lines": 2,
                                 "lines": truncate_middle(text, w, 2, measure)})
    return case


# --------------------------------------------------------------------------------------
# Output: one entry per line, invisible and combining characters escaped
# --------------------------------------------------------------------------------------

def escape_invisible(text):
    def esc(match):
        return "".join(f"\\u{ord(c):04x}" for c in match.group(0))
    return re.sub(r"[\u0000-\u001f\u007f-\u00a0\u00ad\u0300-\u036f\u2000-\u200f\u2028-\u202f\u205f-\u206f\ufeff]",
                  esc, text)


def dump(obj):
    def compact(value):
        return escape_invisible(json.dumps(value, ensure_ascii=False))

    lines = ["{"]
    items = list(obj.items())
    for i, (key, value) in enumerate(items):
        comma = "," if i + 1 < len(items) else ""
        if isinstance(value, list) and value and isinstance(value[0], dict):
            lines.append(f"  {json.dumps(key)}: [")
            lines += [f"    {compact(v)}{',' if j + 1 < len(value) else ''}" for j, v in enumerate(value)]
            lines.append(f"  ]{comma}")
        else:
            lines.append(f"  {json.dumps(key)}: {compact(value)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main():
    if unicodedata.unidata_version != "15.1.0":
        sys.exit(f"needs Python's unicodedata 15.1.0 (Python 3.13), found {unicodedata.unidata_version}")
    check = "--check" in sys.argv[1:]
    comment = ("Generated by tools/text/gen_text_cases.py (fontTools simple shaping, checked against HarfBuzz). "
               "DO NOT EDIT. Keys are described in the generator's docstring.")
    outputs = {}  # path -> bytes
    for weight, path in FONTS.items():
        shaper = SimpleShaper(path.read_bytes())
        for size in (9, 12, 16.5):
            outputs[OUT / f"widths-{weight}-{size:g}.json"] = {
                "$comment": comment, "kind": "text", "name": f"Noto Sans {weight} at {size:g} px: widths",
                "font": {"family": "default", "weight": weight}, "size": size, "metrics": metrics_of(shaper),
                "widths": width_cases(shaper, WIDTH_STRINGS, size)}
        size = 12 if weight == 400 else 16.5
        outputs[OUT / f"wrap-{weight}-{size:g}.json"] = {
            "$comment": comment, "kind": "text", "name": f"Noto Sans {weight} at {size:g} px: breaks, wrapping, truncation",
            "font": {"family": "default", "weight": weight}, "size": size, **wrap_case(shaper, weight, size)}
    synthetic_comment = ("Generated by tools/text/gen_text_cases.py (fontTools simple shaping; synthetic fonts from "
                         "tools/text/test_fonts.py exercise rules where simple shaping deliberately differs from "
                         "HarfBuzz, so there is no HarfBuzz check). DO NOT EDIT.")
    for file, data in build_fonts().items():
        outputs[OUT / "fonts" / file] = data
        shaper, size = SimpleShaper(data), SYNTHETIC_SIZE.get(file, 11)
        outputs[OUT / f"{file.split('.')[0]}{'-ttc' if file.endswith('.ttc') else ''}.json"] = {
            "$comment": synthetic_comment, "kind": "text", "name": f"{file}: simple shaping",
            "font": {"file": f"fonts/{file}"}, "size": size, "metrics": metrics_of(shaper),
            "widths": width_cases(shaper, SYNTHETIC_STRINGS[file], size, harfbuzz=False)}
    outputs[WOFF2_FIXTURE] = woff2(FONTS[400].read_bytes())

    stale = False
    for path, content in outputs.items():
        data = content if isinstance(content, bytes) else dump(content).encode("utf-8")
        if path.exists() and path.read_bytes() == data:
            continue
        stale = True
        if check:
            print(f"stale: {path.relative_to(ROOT)}", file=sys.stderr)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            print(f"wrote {path.relative_to(ROOT)}")
    if check and stale:
        sys.exit(1)
    if not stale:
        print("text cases: up to date")


if __name__ == "__main__":
    main()
