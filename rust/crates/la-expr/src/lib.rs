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

// ---- placeholder expression API (replaced by the real implementation) ----
use std::collections::BTreeMap;
#[derive(Clone, Debug, PartialEq)]
pub enum Value { Null, Bool(bool), Num(f64), Str(String), List(Vec<Value>), Obj(BTreeMap<String, Value>) }
impl From<&serde_json::Value> for Value {
    fn from(v: &serde_json::Value) -> Value {
        match v {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(b) => Value::Bool(*b),
            serde_json::Value::Number(n) => Value::Num(n.as_f64().unwrap_or(0.0)),
            serde_json::Value::String(s) => Value::Str(s.clone()),
            serde_json::Value::Array(a) => Value::List(a.iter().map(Value::from).collect()),
            serde_json::Value::Object(o) => Value::Obj(o.iter().map(|(k, v)| (k.clone(), Value::from(v))).collect()),
        }
    }
}
#[derive(Clone, Debug)]
pub struct ExprError { pub code: &'static str, pub message: String, pub offset: usize }
#[derive(Clone, Debug)]
pub struct Expr { src: String }
pub fn parse(src: &str) -> Result<Expr, ExprError> {
    if src.trim().is_empty() { return Err(ExprError { code: "expr_syntax", message: "empty expression".into(), offset: 0 }); }
    Ok(Expr { src: src.to_string() })
}
pub struct Context<'a> { pub attrs: &'a Value, pub id: &'a str, pub index: usize, pub text: &'a str, pub priority: Option<f64>, pub tier: Option<i64>, pub x: f64, pub y: f64 }
impl Expr { pub fn eval(&self, _ctx: &Context) -> Value { let _ = &self.src; Value::Null } }
pub fn truthy(v: &Value) -> bool { !matches!(v, Value::Null | Value::Bool(false)) && *v != Value::Num(0.0) }
pub fn term_number(v: &Value) -> Option<f64> { match v { Value::Num(n) => Some(*n), Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }), _ => None } }
pub fn values_equal(a: &Value, b: &Value) -> bool { a == b }
