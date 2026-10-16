//! Effective options: `spec/defaults.md` ← preset ← problem (spec §2.4).

use crate::generated::spec_data::{DEFAULTS_JSON, PRESETS};
use crate::units::Length;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// The defaults table as a flat map from dotted key to JSON value.
pub fn defaults() -> &'static Map<String, Value> {
    static D: OnceLock<Map<String, Value>> = OnceLock::new();
    D.get_or_init(|| match serde_json::from_str(DEFAULTS_JSON) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    })
}

/// A preset by name (`None` if unknown).
pub fn preset(name: &str) -> Option<&'static Value> {
    static P: OnceLock<BTreeMap<&'static str, Value>> = OnceLock::new();
    let all = P.get_or_init(|| {
        PRESETS
            .iter()
            .filter_map(|(n, j)| serde_json::from_str(j).ok().map(|v| (*n, v)))
            .collect()
    });
    all.get(name)
}

/// Deep merge: objects merge recursively, everything else in `over` replaces `base`.
pub fn deep_merge(base: &Value, over: &Value) -> Value {
    match (base, over) {
        (Value::Object(a), Value::Object(b)) => {
            let mut out = a.clone();
            for (k, v) in b {
                let merged = match out.get(k) {
                    Some(old) => deep_merge(old, v),
                    None => v.clone(),
                };
                out.insert(k.clone(), merged);
            }
            Value::Object(out)
        }
        (_, o) => o.clone(),
    }
}

/// Look up a dotted path in a JSON value.
pub fn lookup<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    let mut cur = v;
    for part in key.split('.') {
        cur = cur.as_object()?.get(part)?;
    }
    Some(cur)
}

/// Effective options of one problem.
pub struct Opts {
    /// The problem with the preset's options merged underneath.
    pub merged: Value,
    pub preset_name: String,
    pub preset: Option<&'static Value>,
    /// Which implementation's per-implementation defaults apply ("rust" or "ts").
    pub implementation: &'static str,
}

impl Opts {
    pub fn new(problem: &Value) -> Opts {
        let preset_name = problem
            .get("preset")
            .and_then(|p| p.as_str())
            .unwrap_or_else(|| {
                defaults()
                    .get("preset")
                    .and_then(|p| p.as_str())
                    .unwrap_or("auto")
            });
        let preset = preset(preset_name);
        let merged = match preset.and_then(|p| p.get("options")) {
            Some(opts) => deep_merge(opts, problem),
            None => problem.clone(),
        };
        Opts {
            merged,
            preset_name: preset_name.to_string(),
            preset,
            implementation: "rust",
        }
    }

    /// The explicitly given value (problem or preset) at `key`.
    pub fn given(&self, key: &str) -> Option<&Value> {
        lookup(&self.merged, key).filter(|v| !v.is_null())
    }

    /// Whether the *problem itself* (not the preset) sets `key`.
    pub fn user_sets(&self, problem: &Value, key: &str) -> bool {
        lookup(problem, key).is_some()
    }

    /// Effective value: given value, else the default (resolving per-implementation
    /// defaults), else `Null`.
    pub fn get(&self, key: &str) -> Value {
        if let Some(v) = self.given(key) {
            return v.clone();
        }
        default_of(key, self.implementation)
    }

    pub fn f64(&self, key: &str) -> f64 {
        self.get(key).as_f64().unwrap_or(0.0)
    }
    pub fn bool(&self, key: &str) -> bool {
        self.get(key).as_bool().unwrap_or(false)
    }
    pub fn string(&self, key: &str) -> String {
        self.get(key).as_str().unwrap_or("").to_string()
    }
    pub fn length(&self, key: &str) -> Length {
        Length::from_value(&self.get(key)).unwrap_or(Length::Px(0.0))
    }
    pub fn strings(&self, key: &str) -> Vec<String> {
        self.get(key)
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }
    pub fn numbers(&self, key: &str) -> Vec<f64> {
        self.get(key)
            .as_array()
            .map(|a| a.iter().filter_map(|s| s.as_f64()).collect())
            .unwrap_or_default()
    }

    /// A class-keyed map: the default map overlaid with the given map, per key.
    pub fn map(&self, key: &str) -> Map<String, Value> {
        let mut out = match default_of(key, self.implementation) {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        if let Some(Value::Object(m)) = self.given(key) {
            for (k, v) in m {
                out.insert(k.clone(), v.clone());
            }
        }
        out
    }
}

/// The default for `key`, with per-implementation values (`{"rust": .., "ts": ..}`)
/// resolved.
pub fn default_of(key: &str, implementation: &str) -> Value {
    match defaults().get(key) {
        Some(Value::Object(m)) if m.contains_key("rust") && m.contains_key("ts") => {
            m.get(implementation).cloned().unwrap_or(Value::Null)
        }
        Some(v) => v.clone(),
        None => Value::Null,
    }
}

/// Look up an option of a source object (vector layer, svg or raster source): the
/// object's own value at `key`, else the default at `<prefix>.<key>`.
pub fn source_opt(src: &Value, prefix: &str, key: &str) -> Value {
    if let Some(v) = lookup(src, key).filter(|v| !v.is_null()) {
        return v.clone();
    }
    default_of(&format!("{prefix}.{key}"), "rust")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn precedence() {
        let p = json!({"preset": "scatter", "placement": {"offset": 5}, "items": []});
        let o = Opts::new(&p);
        assert_eq!(o.f64("placement.offset"), 5.0);
        assert_eq!(
            o.strings("placement.models"),
            vec!["adjacent", "slider", "distant"]
        );
        assert_eq!(o.f64("solver.time_budget_ms"), 100.0);
        let m = o.map("avoid.label");
        assert_eq!(m["points"], json!(0.3));
        assert_eq!(m["labels"], json!("hard"));
        let auto = Opts::new(&json!({"items": []}));
        assert_eq!(auto.preset_name, "auto");
        assert_eq!(auto.strings("placement.models"), vec!["adjacent", "slider"]);
    }
}
