//! TEMPORARY placeholder used while the real crate is developed on another branch.
//! Provides the `det_math` API surface with std implementations.
pub mod det_math {
    pub fn ln(x: f64) -> f64 { x.ln() }
    pub fn ln_1p(x: f64) -> f64 { x.ln_1p() }
    pub fn exp(x: f64) -> f64 { x.exp() }
    pub fn pow(x: f64, y: f64) -> f64 { x.powf(y) }
    pub fn cbrt(x: f64) -> f64 { x.cbrt() }
    pub fn sin_cos_deg(deg: f64) -> (f64, f64) { let r = deg.to_radians(); (r.sin(), r.cos()) }
    pub fn atan2_deg(y: f64, x: f64) -> f64 { y.atan2(x).to_degrees() }
    pub fn round_half_away(x: f64) -> f64 { x.round() }
    pub struct Pcg32 { state: u64 }
    impl Pcg32 {
        const MUL: u64 = 6364136223846793005;
        const INC: u64 = 1442695040888963407;
        pub fn new(seed: u64) -> Self { let mut p = Pcg32 { state: 0 }; p.step(); p.state = p.state.wrapping_add(seed); p.step(); p }
        fn step(&mut self) { self.state = self.state.wrapping_mul(Self::MUL).wrapping_add(Self::INC); }
        pub fn next_u32(&mut self) -> u32 { let old = self.state; self.step(); let x = (((old >> 18) ^ old) >> 27) as u32; x.rotate_right((old >> 59) as u32) }
        pub fn next_f64(&mut self) -> f64 { self.next_u32() as f64 / 4294967296.0 }
        pub fn next_below(&mut self, n: u32) -> u32 { ((self.next_u32() as u64 * n as u64) >> 32) as u32 }
    }
}
