#!/usr/bin/env python3
"""Measure the true error of det_math against correctly rounded mpmath references.

Reads conformance/math/<function>.json (and, with --dump DIR, the extra random samples
written by `cargo run -p label-anything-expr --release --example gen_math_vectors --
--dump DIR N`) and prints, per function, the maximum error in ulps of the exact result.
Requires mpmath (`pip install mpmath`). Exits non-zero if an error exceeds the
documented bound.
"""
import json
import math
import os
import struct
import sys
from fractions import Fraction

from mpmath import mp, mpf

mp.prec = 200
HERE = os.path.dirname(os.path.abspath(__file__))

# Documented bounds (ulps of the exact result), see rust/crates/la-expr/src/det_math/mod.rs.
BOUNDS = {
    "ln": 0.51,
    "ln_1p": 0.51,
    "exp": 0.55,
    "pow": 0.55,
    "sin_cos_deg": 0.56,
    "atan2_deg": 0.51,
    "cbrt": 0.51,
}


def f(h):
    return struct.unpack("<d", struct.pack("<Q", int(h, 16)))[0]


def ulp_of(v):
    """ulp of the double nearest to the exact value v (binade of |v|)."""
    a = abs(v)
    if a < mpf(2) ** -1022:
        return mpf(2) ** -1074
    e = int(mp.floor(mp.log(a, 2)))
    # guard against log rounding at binade boundaries
    if mpf(2) ** e > a:
        e -= 1
    if mpf(2) ** (e + 1) <= a:
        e += 1
    return mpf(2) ** (e - 52)


def err_ulps(got, exact):
    """Error of `got` (a double) in ulps of `exact`; None if not comparable."""
    if exact is None:
        return None
    if math.isnan(got):
        return float("inf")
    big = mpf(2) ** 1024 * (1 - mpf(2) ** -54)
    if abs(exact) >= big:
        return 0.0 if math.isinf(got) and (got > 0) == (exact > 0) else float("inf")
    if math.isinf(got):
        return float("inf")
    return float(abs(mpf(got) - exact) / ulp_of(exact))


def sind_cosd(deg):
    d = Fraction(deg)
    r = d - 360 * round(d / 360)  # exact reduction of the dyadic input to [-180, 180]
    if r % 90 == 0:  # exact zeros and ones (mpmath's pi is not exact)
        return [(mpf(0), mpf(1)), (mpf(1), mpf(0)), (mpf(0), mpf(-1)), (mpf(-1), mpf(0))][int(r / 90) % 4]
    x = mpf(r.numerator) / r.denominator * mp.pi / 180
    return mp.sin(x), mp.cos(x)


def exact_values(name, ins):
    """Exact result(s) for finite, non-special inputs, else None."""
    if any(math.isnan(v) or math.isinf(v) for v in ins):
        return None
    if name == "ln":
        x = ins[0]
        return [mp.log(mpf(x))] if x > 0 else None
    if name == "ln_1p":
        x = ins[0]
        return [mp.log1p(mpf(x))] if x > -1 else None
    if name == "exp":
        return [mp.exp(mpf(ins[0]))]
    if name == "pow":
        x, y = ins
        if x == 0 or y == 0 or x == 1:
            return None
        if x < 0:
            if y != math.floor(y):
                return None
            v = mp.power(mpf(-x), mpf(y))
            return [-v if (abs(y) < 2**53 and int(y) % 2 == 1) else v]
        return [mp.power(mpf(x), mpf(y))]
    if name == "sin_cos_deg":
        return list(sind_cosd(ins[0]))
    if name == "atan2_deg":
        y, x = ins
        if y == 0 or x == 0:
            return None
        return [mp.atan2(mpf(y), mpf(x)) * 180 / mp.pi]
    if name == "cbrt":
        x = ins[0]
        if x == 0:
            return None
        v = mp.cbrt(mpf(abs(x)))
        return [-v if x < 0 else v]
    return None


def check_rows(name, rows, n_in, stats):
    for row in rows:
        ins, outs = row[:n_in], row[n_in:]
        ex = exact_values(name, ins)
        if ex is None:
            continue
        for got, e in zip(outs, ex):
            if e == 0:
                continue
            # results that are exactly representable must be returned exactly
            u = err_ulps(got, e)
            if u is None:
                continue
            # skip subnormal results (documented: may be off by one more ulp)
            if abs(e) < mpf(2) ** -1022:
                continue
            if u > stats.get(name, (0.0, None))[0]:
                stats[name] = (u, ins)


def main():
    args = sys.argv[1:]
    dump = None
    if args[:1] == ["--dump"]:
        dump = args[1]
    stats = {}
    counts = {}
    for name in BOUNDS:
        d = json.load(open(os.path.join(HERE, f"{name}.json")))
        rows = [[f(h) for h in r] for r in d["vectors"]]
        counts[name] = len(rows)
        check_rows(name, rows, d["inputs"], stats)
        if dump:
            path = os.path.join(dump, f"{name}.txt")
            if os.path.exists(path):
                extra = [[f(h) for h in line.split()] for line in open(path) if line.strip()]
                counts[name] += len(extra)
                check_rows(name, extra, d["inputs"], stats)
    ok = True
    for name, bound in BOUNDS.items():
        u, ins = stats.get(name, (0.0, None))
        flag = "ok" if u <= bound else "EXCEEDS"
        ok &= u <= bound
        print(f"{name:<12} n={counts[name]:>8}  max error {u:.4f} ulp (bound {bound})  {flag}  worst input {ins}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
