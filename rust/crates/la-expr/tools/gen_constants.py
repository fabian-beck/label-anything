#!/usr/bin/env python3
"""Derive every non-trivial constant used by det_math (Rust and TypeScript).

Maintainer tool; requires mpmath (`pip install mpmath`). The output is pasted verbatim
into `src/det_math/consts.rs` (Rust) and `ts/packages/core/src/detmath.ts` (TypeScript).
Both files spell each constant with the same shortest round-trip decimal literal, which
both languages parse to the same IEEE-754 double (correct rounding).

Usage:  python3 gen_constants.py [rust|ts]
"""
import sys

from mpmath import mp, mpf, log, pi, atan, floor

mp.prec = 400


def dbl(v):
    """Nearest double (mpmath rounds to nearest on conversion)."""
    return float(v)


def split(v):
    """(hi, lo) with hi = nearest double of v and lo = nearest double of v - hi."""
    hi = dbl(v)
    lo = dbl(v - mpf(hi))
    return hi, lo


def split_bits(v, bits):
    """(hi, lo) where hi has at most `bits` significant bits (round to nearest)."""
    e = int(floor(log(abs(v), 2)))  # v in [2^e, 2^(e+1))
    q = mpf(2) ** (e - bits + 1)
    hi = dbl(floor(v / q + mpf("0.5")) * q)
    lo = dbl(v - mpf(hi))
    return hi, lo


def lit(x):
    """Shortest round-trip decimal literal that both Rust and JS accept as f64."""
    r = repr(float(x))
    if r in ("0.0", "-0.0"):
        return r
    if "e" in r or "E" in r:
        mant, exp = r.split("e")
        if "." not in mant:
            mant += ".0"
        return f"{mant}e{int(exp)}"
    if "." not in r:
        r += ".0"
    return r


LN2 = log(2)
LN2_HI, LN2_LO = split_bits(LN2, 32)
INV_LN2 = dbl(1 / LN2)
D2R_HI, D2R_LO = split(pi / 180)
R2D_HI, R2D_LO = split(180 / pi)

# ln(j/64) for j = 45..=91 (reduction points for m in [sqrt(1/2), sqrt(2)))
LN_J0, LN_J1 = 45, 91
LN_TAB = [split(log(mpf(j) / 64)) for j in range(LN_J0, LN_J1 + 1)]

# atan(j/8) in degrees for j = 0..=8
ATAN_TAB = [split(atan(mpf(j) / 8) * 180 / pi) for j in range(0, 9)]

# Initial approximation for cbrt(m), m in [1, 2): least-squares cubic on Chebyshev nodes,
# coefficients rounded to 6 decimals (only the starting point of Newton's method).
def cbrt_poly():
    import numpy as np

    n = 64
    xs = [1.5 + 0.5 * np.cos((2 * k + 1) * np.pi / (2 * n)) for k in range(n)]
    ys = [x ** (1.0 / 3.0) for x in xs]
    c = np.polyfit(xs, ys, 3)  # highest power first
    return [round(float(v), 6) for v in c[::-1]]  # c0, c1, c2, c3


CBRT_C = cbrt_poly()
CBRT2 = dbl(mpf(2) ** (mpf(1) / 3))
CBRT4 = dbl(mpf(4) ** (mpf(1) / 3))


def check():
    assert LN2_HI + LN2_LO == dbl(LN2)
    for j in range(1, 2048):
        assert float(mpf(j) * mpf(LN2_HI)) == j * LN2_HI  # k * LN2_HI is exact
    assert ATAN_TAB[8] == (45.0, 0.0)
    assert LN_TAB[64 - LN_J0] == (0.0, 0.0)


def emit(lang):
    check()
    out = []
    if lang == "rust":
        c = lambda name, v: out.append(f"pub(crate) const {name}: f64 = {lit(v)};")
        arr = lambda name, vals: out.append(
            f"pub(crate) const {name}: [f64; {len(vals)}] = [\n"
            + "".join(f"    {lit(v)},\n" for v in vals)
            + "];"
        )
    else:
        c = lambda name, v: out.append(f"const {name} = {lit(v)};")
        arr = lambda name, vals: out.append(
            f"const {name}: readonly number[] = [\n"
            + "".join(f"  {lit(v)},\n" for v in vals)
            + "];"
        )
    c("LN2_HI", LN2_HI)
    c("LN2_LO", LN2_LO)
    c("INV_LN2", INV_LN2)
    c("D2R_HI", D2R_HI)
    c("D2R_LO", D2R_LO)
    c("R2D_HI", R2D_HI)
    c("R2D_LO", R2D_LO)
    arr("LN_TAB_HI", [h for h, _ in LN_TAB])
    arr("LN_TAB_LO", [l for _, l in LN_TAB])
    arr("ATAN_TAB_HI", [h for h, _ in ATAN_TAB])
    arr("ATAN_TAB_LO", [l for _, l in ATAN_TAB])
    for i, v in enumerate(CBRT_C):
        c(f"CBRT_C{i}", v)
    c("CBRT2", CBRT2)
    c("CBRT4", CBRT4)
    print("\n".join(out))


if __name__ == "__main__":
    emit(sys.argv[1] if len(sys.argv) > 1 else "rust")
