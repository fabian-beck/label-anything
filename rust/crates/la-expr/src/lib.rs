//! Label Anything expression language (`spec/expr.peg`) and deterministic math.
//!
//! [`det_math`] holds the deterministic math functions and the PCG32 generator shared bit
//! for bit with the TypeScript implementation (`ts/packages/core/src/detmath.ts`,
//! `pcg.ts`).

pub mod det_math;
