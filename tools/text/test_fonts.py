"""Synthetic metrics-only fonts for the text conformance cases (conformance/text/fonts/).

They exercise parts of simple shaping (spec §5.2) that the bundled Noto Sans does not use:

* synthetic-gpos.ttf   unitsPerEm 2048; cmap format 12 (supplementary code points); hhea
                       metrics (no USE_TYPO_METRICS); GPOS kern lookups with IgnoreMarks,
                       ValueFormat2 ≠ 0 (skips the second glyph), class kerning, a pair that
                       falls through from a format 1 to a format 2 subtable, a format 2
                       subtable whose class-0 match hides a later format 1 pair, an extension
                       lookup, a chained-context lookup (ignored), a lookup reachable only as
                       the required feature of Greek/ELL (included: union over all language
                       systems), and a PairPos lookup only in `dist` (excluded)
* synthetic-kern.ttf   no GPOS; Microsoft `kern` table with two summed horizontal subtables
                       and ignored cross-stream and minimum subtables; GDEF marks; typo
                       metrics (USE_TYPO_METRICS)
* synthetic-kern-apple.ttf  Apple `kern` table (version 1.0) with an ignored vertical subtable
* synthetic-cff.otf    CFF outlines (sfnt version 'OTTO') with GPOS kerning
* synthetic.ttc        collection of synthetic-kern.ttf and synthetic-gpos.ttf (the first
                       font is used)
"""
from io import BytesIO

from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.fontBuilder import FontBuilder
from fontTools.misc.timeTools import timestampFromString
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTCollection, TTFont, newTable
from fontTools.ttLib.tables._k_e_r_n import KernTable_format_0

TIMESTAMP = timestampFromString("Fri Oct 16 00:00:00 2026")

# name: (advance, code points)
LATIN = {
    ".notdef": (500, []), "space": (512, [0x20]), "A": (1300, [0x41]), "B": (1200, [0x42]),
    "C": (1150, [0x43]), "T": (1100, [0x54]), "V": (1250, [0x56]), "a": (980, [0x61]),
    "o": (1000, [0x6F]), "y": (900, [0x79]), "period": (500, [0x2E]), "acutecomb": (0, [0x301]),
}

GPOS_FEA = """
languagesystem DFLT dflt;
languagesystem latn dflt;
languagesystem grek dflt;
languagesystem grek ELL;

@LEFT = [A B];
@RIGHT = [V y];

table GDEF {
  GlyphClassDef [A B C T V a o y period Alpha smile deseret], , [acutecomb], ;
} GDEF;

lookup NUDGE { pos A <0 0 50 0>; } NUDGE;

lookup PAIRS {
  lookupflag IgnoreMarks;
  pos A V -150;
  pos V A -140;
  pos o a -20;
  pos T <0 0 -100 0> o <0 0 30 0>;
} PAIRS;

lookup CLASSES {
  lookupflag IgnoreMarks;
  pos @LEFT @RIGHT -60;
  pos C @RIGHT -30;
} CLASSES;

# feaLib puts the format 1 subtable (A o) first: "AV" falls through to the class pairs
lookup FALLTHROUGH {
  pos @LEFT @RIGHT -10;
  pos A o -999;
} FALLTHROUGH;

# reordered by build_fonts(): the class pairs come first and their class-0 match for "Bo"
# hides the later `B o` pair
lookup FIRSTWINS {
  pos @LEFT @RIGHT -7;
  pos B o -555;
} FIRSTWINS;

lookup EXTENDED useExtension {
  pos y period -90;
} EXTENDED;

lookup CONTEXT { pos A' lookup NUDGE V; } CONTEXT;

lookup GREEK { pos Alpha V -77; } GREEK;

lookup DIST { pos A T -500; } DIST;

feature kern {
  script latn;
  lookup PAIRS;
  lookup CLASSES;
  lookup FALLTHROUGH;
  lookup FIRSTWINS;
  lookup EXTENDED;
  lookup CONTEXT;
  script grek;
  language ELL required;
  lookup GREEK;
} kern;

feature dist {
  lookup DIST;
} dist;
"""

CFF_FEA = """
languagesystem DFLT dflt;
feature kern { pos A V -100; pos V A -90; } kern;
"""


def _build(glyphs, upm, hhea, typo, use_typo_metrics, cff=False):
    fb = FontBuilder(upm, isTTF=not cff)
    fb.setupGlyphOrder(list(glyphs))
    fb.setupCharacterMap({cp: name for name, (_, cps) in glyphs.items() for cp in cps})
    if cff:
        charstrings = {name: T2CharStringPen(adv, None).getCharString() for name, (adv, _) in glyphs.items()}
        fb.setupCFF("LabelAnythingTest", {"FullName": "Label Anything Test"}, charstrings, {})
    else:
        fb.setupGlyf({name: TTGlyphPen(None).glyph() for name in glyphs})
    fb.setupHorizontalMetrics({name: (adv, 0) for name, (adv, _) in glyphs.items()})
    ascent, descent, line_gap = hhea
    fb.setupHorizontalHeader(ascent=ascent, descent=descent, lineGap=line_gap)
    fb.setupNameTable({"familyName": "Label Anything Test", "styleName": "Regular"})
    fb.setupOS2(version=4, sTypoAscender=typo[0], sTypoDescender=typo[1], sTypoLineGap=typo[2],
                usWinAscent=ascent, usWinDescent=-descent, fsSelection=0x00C0 if use_typo_metrics else 0x0040)
    fb.setupPost()
    fb.updateHead(created=TIMESTAMP, modified=TIMESTAMP)  # reproducible output
    return fb


def _kern_subtable(pairs, coverage, apple=False):
    """A format 0 subtable; `coverage` is the flags byte of the Microsoft or Apple header."""
    subtable = KernTable_format_0(apple=apple)
    subtable.coverage = coverage
    subtable.tupleIndex = 0 if apple else None
    subtable.kernTable = pairs
    return subtable


def _bytes(font):
    out = BytesIO()
    font.save(out)
    return out.getvalue()


def build_fonts():
    """{file name: bytes} of all synthetic fonts."""
    gpos_glyphs = dict(LATIN, Alpha=(1300, [0x391]), smile=(2000, [0x1F600]), deseret=(1500, [0x10400]))
    gpos = _build(gpos_glyphs, 2048, (1900, -500, 67), (1600, -448, 0), use_typo_metrics=False)
    addOpenTypeFeaturesFromString(gpos.font, GPOS_FEA)
    # lookups are numbered in definition order: NUDGE, PAIRS, CLASSES, FALLTHROUGH, FIRSTWINS, …
    first_wins = gpos.font["GPOS"].table.LookupList.Lookup[4]
    assert [subtable.Format for subtable in first_wins.SubTable] == [1, 2]
    first_wins.SubTable.reverse()

    kern = _build(LATIN, 1000, (950, -250, 0), (800, -200, 100), use_typo_metrics=True)
    addOpenTypeFeaturesFromString(kern.font, "table GDEF { GlyphClassDef [A B C T V a o y period], , [acutecomb], ; } GDEF;")
    table = newTable("kern")
    table.version = 0
    table.kernTables = [
        _kern_subtable({("A", "V"): -80, ("V", "A"): -70, ("T", "o"): -60, ("T", "period"): -40}, 0x01),
        _kern_subtable({("A", "V"): -5, ("y", "period"): -30}, 0x01),
        _kern_subtable({("A", "V"): -1000}, 0x05),  # cross-stream: ignored
        _kern_subtable({("A", "V"): -2000}, 0x03),  # minimum values: ignored
    ]
    kern.font["kern"] = table

    apple = _build(LATIN, 1000, (950, -250, 0), (800, -200, 100), use_typo_metrics=False)
    table = newTable("kern")
    table.version = 1.0
    table.kernTables = [
        _kern_subtable({("A", "V"): -75, ("T", "o"): -55}, 0x00, apple=True),
        _kern_subtable({("A", "V"): -1000}, 0x80, apple=True),  # vertical: ignored
    ]
    apple.font["kern"] = table

    cff = _build(LATIN, 1000, (950, -250, 0), (800, -200, 100), use_typo_metrics=True, cff=True)
    addOpenTypeFeaturesFromString(cff.font, CFF_FEA)

    fonts = {
        "synthetic-gpos.ttf": _bytes(gpos.font),
        "synthetic-kern.ttf": _bytes(kern.font),
        "synthetic-kern-apple.ttf": _bytes(apple.font),
        "synthetic-cff.otf": _bytes(cff.font),
    }
    collection = TTCollection()
    collection.fonts = [TTFont(BytesIO(fonts[name]), recalcTimestamp=False)
                        for name in ("synthetic-kern.ttf", "synthetic-gpos.ttf")]
    fonts["synthetic.ttc"] = _bytes(collection)
    return fonts


def woff2(ttf_bytes):
    """WOFF2 version of a font, with the glyf, loca and hmtx transforms."""
    from fontTools.ttLib.woff2 import compress

    out = BytesIO()
    compress(BytesIO(ttf_bytes), out, transform_tables={"glyf", "loca", "hmtx"})
    return out.getvalue()
