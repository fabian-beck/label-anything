use std::collections::BTreeMap;

/// A value of the expression language.
///
/// Numbers are finite IEEE-754 doubles (evaluation turns non-finite results into
/// `Null`). `Obj` only arises from `attrs` (JSON objects inside attrs). The derived
/// `PartialEq` is the language's structural equality, identical to [`values_equal`].
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    List(Vec<Value>),
    Obj(BTreeMap<String, Value>),
}

impl From<&serde_json::Value> for Value {
    /// JSON → value. Numbers go through `as_f64` (integers beyond 2^53 round to the
    /// nearest double, as `JSON.parse` does).
    fn from(v: &serde_json::Value) -> Self {
        match v {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(b) => Value::Bool(*b),
            serde_json::Value::Number(n) => match n.as_f64() {
                Some(x) if x.is_finite() => Value::Num(x),
                _ => Value::Null,
            },
            serde_json::Value::String(s) => Value::Str(s.clone()),
            serde_json::Value::Array(a) => Value::List(a.iter().map(Value::from).collect()),
            serde_json::Value::Object(o) => {
                Value::Obj(o.iter().map(|(k, v)| (k.clone(), Value::from(v))).collect())
            }
        }
    }
}

impl From<&Value> for serde_json::Value {
    /// Value → JSON (non-finite numbers, which evaluation never produces, become null).
    fn from(v: &Value) -> Self {
        match v {
            Value::Null => serde_json::Value::Null,
            Value::Bool(b) => serde_json::Value::Bool(*b),
            Value::Num(x) => serde_json::Number::from_f64(*x)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null),
            Value::Str(s) => serde_json::Value::String(s.clone()),
            Value::List(l) => serde_json::Value::Array(l.iter().map(Into::into).collect()),
            Value::Obj(o) => {
                serde_json::Value::Object(o.iter().map(|(k, v)| (k.clone(), v.into())).collect())
            }
        }
    }
}

/// Truthiness: `false`, `null`, `0` (and `-0`), NaN, `""` and `[]` are falsy; everything
/// else (including every object) is truthy.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Num(x) => *x != 0.0 && !x.is_nan(),
        Value::Str(s) => !s.is_empty(),
        Value::List(l) => !l.is_empty(),
        Value::Obj(_) => true,
    }
}

/// Value of a priority term: numbers as is, booleans as 1/0, anything else is missing.
pub fn term_number(v: &Value) -> Option<f64> {
    match v {
        Value::Num(x) => Some(*x),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// Structural equality used by `==`, `!=`, `in` and coverage grouping: numbers compare
/// numerically (`-0 == 0`), strings by code points, booleans and null by identity,
/// lists elementwise, objects by equal key sets with equal values. Values of different
/// types are unequal.
pub fn values_equal(a: &Value, b: &Value) -> bool {
    a == b
}
