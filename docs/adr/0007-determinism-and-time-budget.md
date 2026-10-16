# 0007 — Determinism and the time budget

* Status: accepted
* Date: 2026-10-16

## Context
Solves must be deterministic for the same input and seed, *and* anytime/bounded by
`time_budget_ms`. A wall-clock-driven annealing schedule would make results depend on
machine speed and load.

## Decision
* `time_budget_ms` is converted into a **deterministic iteration budget**:
  `iterations = min(max_iterations, time_budget_ms × rate, 400 × n_items)` with
  `rate = 100` moves/ms (Rust) and `40` (TS). With the default budgets (100 ms Rust,
  250 ms TS) both run the same 10 000 moves. The annealing schedule is a function of the
  iteration index. (Profile note: a move costs ≈ 6 µs on the 200-label/10k-point case on
  the CI container, so 100 moves/ms keeps the default solve inside its budget.)
* A **wall-clock guard** at 3 × `time_budget_ms` stops search on pathologically slow
  machines; this sets `stats.time_guard_hit = true` (the only case where results may
  depend on timing). Greedy always completes.
* Arithmetic determinism across Rust and TS: only `+ − × ÷ sqrt` (IEEE correctly
  rounded) and shared `det_math` implementations of `sin/cos` (degrees), `exp`, `log`,
  `log1p`; no `hypot`, no `Math.round` (use `floor(x + 0.5)`), sequential summation in
  index order, stable sorts with total comparators, no decisions driven by hash-map
  iteration order.
* RNG: PCG32 (XSH-RR) with the constants in spec §10.4; JS implements the 64-bit LCG
  with 16-bit limbs (no BigInt in the hot path).
* Rust `parallel` feature (rayon) is used only for embarrassingly parallel, order-
  preserving work (candidate generation, static costs).

## Consequences
Reproducible results across machines, runs and thread counts; parity tests between
Rust and TS can compare results directly.
