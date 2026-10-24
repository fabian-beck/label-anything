# Determinism

The same problem and seed give the same result on every machine, run and thread count, and
the Rust and TypeScript cores make the same decisions.

## Context
Hosts expect a re-solve to reproduce a layout, and the parity tests compare the results of
both cores directly. Platform math libraries, hash-map order and thread scheduling differ
from machine to machine and between languages.

## Decision
- Floating-point code uses only IEEE `+ − × ÷ sqrt`, which are correctly rounded, and the
  shared `det_math` functions (`sin` and `cos` in degrees, `exp`, `ln`, `ln_1p`, `pow`,
  `atan2`, `cbrt`), implemented with the same operations in both languages. No `hypot`, no
  `Math.round` (`round_half_away` instead; `floor(x + 0.5)` fails for
  0.49999999999999994). Sums run in index order.
- Sorts are stable with total comparators; no decision depends on hash-map order.
- Random numbers come from PCG32 (spec §10.4); TypeScript emulates its 64-bit state with
  16-bit limbs, without `BigInt` in the hot path.
- Rust's `parallel` feature uses threads only for order-preserving work: candidate
  generation and static costs.
- The time budget is an iteration budget, not a clock (ADR solver/time-budget).

## Consequences
Results reproduce across machines, runs and threads, and the parity fixtures compare Rust
and TypeScript bit for bit (`conformance/parity/`, `conformance/math/`). Every new
floating-point computation goes through these rules (CONTRIBUTING, ground rule 5).
