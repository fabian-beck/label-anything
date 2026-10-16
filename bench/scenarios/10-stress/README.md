# 10 — Stress and scale (synthetic from real)

**What.** Runtime and quality curves over problem size: 200, 500, 1,000, 2,000, 5,000,
10,000 and 20,000 airport anchors on the same 1800 × 710 world canvas.

**SYNTHETIC.** Scenario 05 at 10× density: every served airport plus 9 copies jittered by
a Gaussian with σ = 0.6° in longitude and latitude (seed 10). A fixed permutation
(seed 10) of the pool gives nested problems (each size is a prefix of the next), so
density grows with n. Real data only gives 3,221 served airports; the copies make larger,
denser, still realistically clustered instances.

**Configs.** `n00200` (quick) … `n20000`; IATA labels (copies keep their original's
code), 9 px; marks and priority as in scenario 05; no background, no obstacles besides
the items; preset `map`. Problem sizes up to 3.5 MB.
