//! PCG32 (PCG-XSH-RR 64/32), the engine's only random number generator.

/// LCG multiplier.
const MULT: u64 = 6364136223846793005;
/// LCG increment (PCG's default stream).
const INC: u64 = 1442695040888963407;

/// PCG-XSH-RR with 64-bit state and 32-bit output (O'Neill 2014), fixed increment.
///
/// Seeding: `state = 0; step(); state += seed; step()`. Identical to `Pcg32` in
/// `ts/packages/core/src/pcg.ts`; test vectors in `conformance/math/pcg32.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pcg32 {
    state: u64,
}

impl Pcg32 {
    /// Creates a generator for `seed`.
    pub fn new(seed: u64) -> Self {
        let mut rng = Pcg32 { state: 0 };
        rng.step();
        rng.state = rng.state.wrapping_add(seed);
        rng.step();
        rng
    }

    #[inline(always)]
    fn step(&mut self) {
        self.state = self.state.wrapping_mul(MULT).wrapping_add(INC);
    }

    /// Next 32-bit output.
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.step();
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform in `[0, 1)`: `next_u32() / 2^32` (exact, 32 random bits).
    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        self.next_u32() as f64 * (1.0 / 4294967296.0)
    }

    /// Integer in `[0, n)`: `floor(next_u32() · n / 2^32)`, computed exactly as
    /// `(u32 · n) >> 32` in 64 bits. Always consumes one output; `next_below(0) = 0`.
    #[inline]
    pub fn next_below(&mut self, n: u32) -> u32 {
        ((self.next_u32() as u64 * n as u64) >> 32) as u32
    }

    /// Fisher–Yates shuffle from the end: for `i = len−1 … 1`, swap `slice[i]` with
    /// `slice[next_below(i + 1)]`. Consumes `len − 1` outputs (none for `len ≤ 1`).
    ///
    /// # Panics
    /// If `slice.len() > u32::MAX` (only possible on 64-bit targets).
    pub fn shuffle<T>(&mut self, slice: &mut [T]) {
        let len =
            u32::try_from(slice.len()).expect("Pcg32::shuffle supports at most 2^32 - 1 elements");
        for i in (1..len).rev() {
            let j = self.next_below(i + 1);
            slice.swap(i as usize, j as usize);
        }
    }
}
