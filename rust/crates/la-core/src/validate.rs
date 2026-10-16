//! `validate(problem)`: structured errors with JSON pointers (ADR 0003).
//!
//! The syntax check interprets the embedded `spec/schema/problem.v1.json` (the keywords
//! of JSON Schema 2020-12 that the schema uses), so the schema stays the single source
//! of truth. Semantic checks (ids, references, expressions, unknown classes, …) follow.
//! The TypeScript implementation is a line-by-line port.

use crate::generated::spec_data::{PRESETS, PROBLEM_SCHEMA_JSON};
use serde::Serialize;
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

/// One validation error or warning.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Issue {
    pub pointer: String,
    pub code: String,
    pub message: String,
}

impl Issue {
    pub fn new(pointer: impl Into<String>, code: &str, message: impl Into<String>) -> Issue {
        Issue { pointer: pointer.into(), code: code.to_string(), message: message.into() }
    }
}

/// Result of `validate`.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Report {
    pub valid: bool,
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
}

/// Reserved obstacle classes.
pub const RESERVED_CLASSES: [&str; 6] = ["items", "labels", "leaders", "canvas_edge", "ink", "text"];

fn schema() -> &'static Value {
    static S: OnceLock<Value> = OnceLock::new();
    S.get_or_init(|| serde_json::from_str(PROBLEM_SCHEMA_JSON).expect("embedded schema is valid JSON"))
}

/// Escape one JSON-pointer reference token (RFC 6901).
pub fn ptr_token(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

/// Append a token to a pointer.
pub fn ptr_join(base: &str, token: &str) -> String {
    let mut p = String::with_capacity(base.len() + token.len() + 1);
    p.push_str(base);
    p.push('/');
    p.push_str(&ptr_token(token));
    p
}

/// Validate a problem given as JSON text.
pub fn validate_str(text: &str) -> Report {
    match serde_json::from_str::<Value>(text) {
        Ok(v) => validate(&v),
        Err(e) => Report {
            valid: false,
            errors: vec![Issue::new("", "parse", format!("invalid JSON: {e}"))],
            warnings: vec![],
        },
    }
}

/// Validate a problem value.
pub fn validate(problem: &Value) -> Report {
    let interp = Interp { root: schema(), regexes: RefCell::new(BTreeMap::new()) };
    let mut errors = Vec::new();
    interp.check(schema(), problem, "", false, &mut errors);
    let mut warnings = Vec::new();
    semantic(problem, &mut errors, &mut warnings);
    errors.sort();
    errors.dedup_by(|a, b| a.pointer == b.pointer && a.code == b.code);
    warnings.sort();
    warnings.dedup_by(|a, b| a.pointer == b.pointer && a.code == b.code);
    Report { valid: errors.is_empty(), errors, warnings }
}

// ---------------------------------------------------------------------------------------
// Schema interpreter
// ---------------------------------------------------------------------------------------

struct Interp<'s> {
    root: &'s Value,
    regexes: RefCell<BTreeMap<String, regex_lite::Regex>>,
}

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn type_is(t: &str, v: &Value) -> bool {
    match t {
        "integer" => v.as_f64().map(|f| f.fract() == 0.0).unwrap_or(false),
        "number" => v.is_number(),
        other => type_name(v) == other,
    }
}

fn json_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q)),
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).map(|w| json_eq(v, w)).unwrap_or(false))
        }
        _ => a == b,
    }
}

fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 60 {
        format!("{}…", &s[..s.char_indices().nth(57).map(|c| c.0).unwrap_or(s.len())])
    } else {
        s
    }
}

impl<'s> Interp<'s> {
    fn resolve(&self, r: &str) -> Option<&'s Value> {
        let mut cur = self.root;
        for tok in r.strip_prefix("#/")?.split('/') {
            cur = cur.get(tok.replace("~1", "/").replace("~0", "~"))?;
        }
        Some(cur)
    }

    fn regex_match(&self, pattern: &str, s: &str) -> bool {
        let mut cache = self.regexes.borrow_mut();
        if !cache.contains_key(pattern) {
            match regex_lite::Regex::new(pattern) {
                Ok(r) => {
                    cache.insert(pattern.to_string(), r);
                }
                Err(_) => return true,
            }
        }
        cache[pattern].is_match(s)
    }

    /// Check `v` against schema `s`; returns the property names evaluated at this location.
    fn check(&self, s: &'s Value, v: &Value, ptr: &str, unit: bool, out: &mut Vec<Issue>) -> BTreeSet<String> {
        let mut evaluated = BTreeSet::new();
        let o = match s {
            Value::Bool(true) => return evaluated,
            Value::Bool(false) => {
                out.push(Issue::new(ptr, "invalid_value", "value not allowed here"));
                return evaluated;
            }
            Value::Object(o) => o,
            _ => return evaluated,
        };
        if let Some(Value::String(r)) = o.get("$ref") {
            if let Some(target) = self.resolve(r) {
                let unit2 = unit || r == "#/$defs/length" || r == "#/$defs/nonNegLength";
                evaluated.extend(self.check(target, v, ptr, unit2, out));
            }
        }
        if let Some(t) = o.get("type") {
            let ok = match t {
                Value::String(t) => type_is(t, v),
                Value::Array(ts) => ts.iter().filter_map(|t| t.as_str()).any(|t| type_is(t, v)),
                _ => true,
            };
            if !ok {
                let want = match t {
                    Value::String(t) => t.clone(),
                    Value::Array(ts) => ts.iter().filter_map(|t| t.as_str()).collect::<Vec<_>>().join(" or "),
                    _ => String::new(),
                };
                out.push(Issue::new(ptr, "type", format!("expected {want}, got {}", type_name(v))));
                return evaluated;
            }
        }
        if let Some(c) = o.get("const") {
            if !json_eq(c, v) {
                out.push(Issue::new(ptr, "const", format!("must be {}", short(c))));
            }
        }
        if let Some(Value::Array(e)) = o.get("enum") {
            if !e.iter().any(|x| json_eq(x, v)) {
                let list: Vec<String> = e.iter().map(short).collect();
                out.push(Issue::new(ptr, "enum", format!("must be one of {}", list.join(", "))));
            }
        }
        match v {
            Value::Number(n) => {
                let x = n.as_f64().unwrap_or(0.0);
                if let Some(m) = o.get("minimum").and_then(|m| m.as_f64()) {
                    if x < m {
                        out.push(Issue::new(ptr, "range", format!("must be >= {m}")));
                    }
                }
                if let Some(m) = o.get("maximum").and_then(|m| m.as_f64()) {
                    if x > m {
                        out.push(Issue::new(ptr, "range", format!("must be <= {m}")));
                    }
                }
                if let Some(m) = o.get("exclusiveMinimum").and_then(|m| m.as_f64()) {
                    if x <= m {
                        out.push(Issue::new(ptr, "range", format!("must be > {m}")));
                    }
                }
                if let Some(m) = o.get("exclusiveMaximum").and_then(|m| m.as_f64()) {
                    if x >= m {
                        out.push(Issue::new(ptr, "range", format!("must be < {m}")));
                    }
                }
            }
            Value::String(st) => {
                if let Some(m) = o.get("minLength").and_then(|m| m.as_u64()) {
                    if (st.chars().count() as u64) < m {
                        out.push(Issue::new(ptr, "length", format!("must have at least {m} characters")));
                    }
                }
                if let Some(Value::String(p)) = o.get("pattern") {
                    if !self.regex_match(p, st) {
                        let code = if unit { "unit" } else { "pattern" };
                        let msg = if unit {
                            format!("invalid length {}: use a number (px) or <number>px|pt|em", short(v))
                        } else {
                            format!("{} does not match {p}", short(v))
                        };
                        out.push(Issue::new(ptr, code, msg));
                    }
                }
            }
            Value::Array(a) => {
                if let Some(m) = o.get("minItems").and_then(|m| m.as_u64()) {
                    if (a.len() as u64) < m {
                        out.push(Issue::new(ptr, "length", format!("must have at least {m} items")));
                    }
                }
                if let Some(m) = o.get("maxItems").and_then(|m| m.as_u64()) {
                    if (a.len() as u64) > m {
                        out.push(Issue::new(ptr, "length", format!("must have at most {m} items")));
                    }
                }
                let mut start = 0;
                if let Some(Value::Array(pre)) = o.get("prefixItems") {
                    for (i, ps) in pre.iter().enumerate() {
                        if let Some(item) = a.get(i) {
                            self.check(ps, item, &format!("{ptr}/{i}"), unit, out);
                        }
                    }
                    start = pre.len();
                }
                if let Some(is) = o.get("items") {
                    for (i, item) in a.iter().enumerate().skip(start) {
                        self.check(is, item, &format!("{ptr}/{i}"), unit, out);
                    }
                }
                if o.get("uniqueItems") == Some(&Value::Bool(true)) {
                    'outer: for i in 0..a.len() {
                        for j in 0..i {
                            if json_eq(&a[i], &a[j]) {
                                out.push(Issue::new(format!("{ptr}/{i}"), "unique", "duplicate entry"));
                                break 'outer;
                            }
                        }
                    }
                }
            }
            Value::Object(m) => {
                if let Some(Value::Array(req)) = o.get("required") {
                    for r in req.iter().filter_map(|r| r.as_str()) {
                        if !m.contains_key(r) {
                            out.push(Issue::new(ptr_join(ptr, r), "required", format!("missing required property '{r}'")));
                        }
                    }
                }
                let props = o.get("properties").and_then(|p| p.as_object());
                if let Some(props) = props {
                    for (k, ps) in props {
                        if let Some(val) = m.get(k) {
                            self.check(ps, val, &ptr_join(ptr, k), false, out);
                            evaluated.insert(k.clone());
                        }
                    }
                }
                if let Some(ap) = o.get("additionalProperties") {
                    for (k, val) in m {
                        if props.map(|p| p.contains_key(k)).unwrap_or(false) {
                            continue;
                        }
                        if ap == &Value::Bool(false) {
                            out.push(Issue::new(ptr_join(ptr, k), "unknown_property", format!("unknown property '{k}'")));
                        } else {
                            self.check(ap, val, &ptr_join(ptr, k), false, out);
                        }
                        evaluated.insert(k.clone());
                    }
                }
                if let Some(pn) = o.get("propertyNames") {
                    for k in m.keys() {
                        self.check(pn, &Value::String(k.clone()), &ptr_join(ptr, k), false, out);
                    }
                }
                if let Some(Value::Object(dr)) = o.get("dependentRequired") {
                    for (k, deps) in dr {
                        if m.contains_key(k) {
                            for d in deps.as_array().into_iter().flatten().filter_map(|d| d.as_str()) {
                                if !m.contains_key(d) {
                                    out.push(Issue::new(ptr_join(ptr, d), "required", format!("'{d}' is required when '{k}' is given")));
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        if let Some(Value::Array(all)) = o.get("allOf") {
            for sub in all {
                evaluated.extend(self.check(sub, v, ptr, unit, out));
            }
        }
        if let Some(Value::Array(any)) = o.get("anyOf") {
            let mut results = Vec::new();
            let mut valid_any = false;
            for sub in any {
                let mut errs = Vec::new();
                let ev = self.check(sub, v, ptr, unit, &mut errs);
                if errs.is_empty() {
                    valid_any = true;
                    evaluated.extend(ev);
                }
                results.push(errs);
            }
            if !valid_any {
                if required_only(any) {
                    let first = any[0]["required"][0].as_str().unwrap_or("");
                    let names = required_names(any);
                    out.push(Issue::new(ptr_join(ptr, first), "required", format!("one of {names} is required")));
                } else {
                    out.extend(best_alternative(results, ptr));
                }
            }
        }
        if let Some(Value::Array(one)) = o.get("oneOf") {
            let mut results = Vec::new();
            let mut valid = Vec::new();
            for (i, sub) in one.iter().enumerate() {
                let mut errs = Vec::new();
                let ev = self.check(sub, v, ptr, unit, &mut errs);
                if errs.is_empty() {
                    valid.push((i, ev));
                }
                results.push(errs);
            }
            match valid.len() {
                1 => evaluated.extend(valid.pop().map(|x| x.1).unwrap_or_default()),
                0 => {
                    if required_only(one) {
                        out.push(Issue::new(ptr, "exclusive", format!("exactly one of {} is required", required_names(one))));
                    } else {
                        out.extend(best_alternative(results, ptr));
                    }
                }
                _ => {
                    let msg = if required_only(one) {
                        format!("only one of {} may be given", required_names(one))
                    } else {
                        "value matches more than one alternative".to_string()
                    };
                    out.push(Issue::new(ptr, "exclusive", msg));
                }
            }
        }
        if let Some(cond) = o.get("if") {
            let mut errs = Vec::new();
            let ev = self.check(cond, v, ptr, unit, &mut errs);
            if errs.is_empty() {
                evaluated.extend(ev);
                if let Some(t) = o.get("then") {
                    evaluated.extend(self.check(t, v, ptr, unit, out));
                }
            } else if let Some(e) = o.get("else") {
                evaluated.extend(self.check(e, v, ptr, unit, out));
            }
        }
        if let (Some(up), Value::Object(m)) = (o.get("unevaluatedProperties"), v) {
            for (k, val) in m {
                if evaluated.contains(k) {
                    continue;
                }
                if up == &Value::Bool(false) {
                    out.push(Issue::new(ptr_join(ptr, k), "unknown_property", format!("unknown property '{k}'")));
                } else {
                    self.check(up, val, &ptr_join(ptr, k), false, out);
                }
                evaluated.insert(k.clone());
            }
        }
        evaluated
    }
}

fn required_only(alts: &[Value]) -> bool {
    alts.iter().all(|a| a.as_object().map(|o| o.len() == 1 && o.contains_key("required")).unwrap_or(false))
}

fn required_names(alts: &[Value]) -> String {
    let names: Vec<String> = alts
        .iter()
        .map(|a| {
            let r: Vec<&str> = a["required"].as_array().into_iter().flatten().filter_map(|x| x.as_str()).collect();
            r.join("+")
        })
        .collect();
    names.join(" | ")
}

/// Choose the most plausible failed alternative: no type error at the location, no
/// discriminator (`type`/`shape`) mismatch, then the fewest errors; ties → first.
fn best_alternative(results: Vec<Vec<Issue>>, ptr: &str) -> Vec<Issue> {
    let disc_type = ptr_join(ptr, "type");
    let disc_shape = ptr_join(ptr, "shape");
    let mut best: Option<((u8, u8, usize), Vec<Issue>)> = None;
    for errs in results {
        let root_type = errs.iter().any(|e| e.pointer == ptr && e.code == "type") as u8;
        let disc = errs
            .iter()
            .any(|e| (e.pointer == disc_type || e.pointer == disc_shape) && (e.code == "const" || e.code == "enum"))
            as u8;
        let score = (root_type, disc, errs.len());
        if best.as_ref().map(|b| score < b.0).unwrap_or(true) {
            best = Some((score, errs));
        }
    }
    best.map(|b| b.1).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------
// Semantic checks
// ---------------------------------------------------------------------------------------

fn semantic(p: &Value, errors: &mut Vec<Issue>, warnings: &mut Vec<Issue>) {
    let Some(root) = p.as_object() else { return };
    let items = root.get("items").and_then(|v| v.as_array());
    // anchor type "line" is reserved for v2
    if let Some(items) = items {
        for (i, it) in items.iter().enumerate() {
            if it.pointer("/anchor/type").and_then(|t| t.as_str()) == Some("line") {
                let base = format!("/items/{i}/anchor");
                errors.retain(|e| e.pointer != base && !e.pointer.starts_with(&format!("{base}/")));
                errors.push(Issue::new(format!("{base}/type"), "unsupported", "anchor type 'line' is reserved for v2"));
            }
        }
    }
    // ids
    let mut ids: BTreeMap<String, usize> = BTreeMap::new();
    if let Some(items) = items {
        for (i, it) in items.iter().enumerate() {
            let (id, ptr) = match it.get("id").and_then(|v| v.as_str()) {
                Some(s) => (s.to_string(), format!("/items/{i}/id")),
                None => (i.to_string(), format!("/items/{i}")),
            };
            if let Some(&first) = ids.get(&id) {
                errors.push(Issue::new(ptr, "duplicate_id", format!("id '{id}' is already used by item {first}")));
            } else {
                ids.insert(id, i);
            }
        }
        for (i, it) in items.iter().enumerate() {
            if let Some(Value::Array(kw)) = it.get("keep_with") {
                for (j, r) in kw.iter().enumerate() {
                    if let Some(r) = r.as_str() {
                        if !ids.contains_key(r) {
                            errors.push(Issue::new(format!("/items/{i}/keep_with/{j}"), "unknown_ref", format!("unknown item id '{r}'")));
                        }
                    }
                }
            }
            // icon/box with shape polygon need polygon points
            let label = it.get("label");
            let check_poly = |lab: Option<&Value>, base: String, errors: &mut Vec<Issue>| {
                if let Some(l) = lab {
                    if l.get("shape").and_then(|s| s.as_str()) == Some("polygon") && l.get("polygon").is_none() {
                        errors.push(Issue::new(format!("{base}/polygon"), "required", "shape 'polygon' needs 'polygon' points"));
                    }
                }
            };
            check_poly(label, format!("/items/{i}/label"), errors);
            if let Some(Value::Array(parts)) = label.and_then(|l| l.get("parts")) {
                for (j, part) in parts.iter().enumerate() {
                    check_poly(Some(part), format!("/items/{i}/label/parts/{j}"), errors);
                }
            }
            // area anchors must have a non-degenerate polygon
            if it.pointer("/anchor/type").and_then(|t| t.as_str()) == Some("area") {
                if let Some(Value::Array(poly)) = it.pointer("/anchor/polygon") {
                    let pts: Vec<(f64, f64)> = poly
                        .iter()
                        .filter_map(|q| Some((q.get(0)?.as_f64()?, q.get(1)?.as_f64()?)))
                        .collect();
                    let mut a = 0.0;
                    for k in 0..pts.len() {
                        let (x0, y0) = pts[k];
                        let (x1, y1) = pts[(k + 1) % pts.len()];
                        a += x0 * y1 - x1 * y0;
                    }
                    if pts.len() >= 3 && a.abs() < 1e-12 {
                        errors.push(Issue::new(format!("/items/{i}/anchor/polygon"), "invalid_value", "area polygon has zero area"));
                    }
                }
            }
        }
    }
    // expressions
    let check_expr = |ptr: String, v: Option<&Value>, errors: &mut Vec<Issue>| {
        if let Some(Value::String(src)) = v {
            if let Err(e) = la_expr::parse(src) {
                errors.push(Issue::new(ptr, e.code, format!("{} (at {})", e.message, e.offset)));
            }
        }
    };
    if let Some(pr) = root.get("priority") {
        if let Some(Value::Array(tiers)) = pr.get("tiers") {
            for (i, t) in tiers.iter().enumerate() {
                check_expr(format!("/priority/tiers/{i}/where"), t.get("where"), errors);
            }
        }
        if let Some(Value::Array(terms)) = pr.get("terms") {
            for (i, t) in terms.iter().enumerate() {
                check_expr(format!("/priority/terms/{i}/expr"), t.get("expr"), errors);
            }
        }
        check_expr("/priority/coverage/by".into(), pr.pointer("/coverage/by"), errors);
    }
    // y_axis "up" needs a canvas height (explicit or from a background)
    if root.get("y_axis").and_then(|v| v.as_str()) == Some("up") && root.get("canvas").is_none() {
        let has_bg = p.pointer("/obstacles/raster").is_some() || p.pointer("/obstacles/svg").is_some();
        if !has_bg {
            errors.push(Issue::new("/canvas", "required", "y_axis 'up' needs a canvas (or a background) to flip y"));
        }
    }
    // unknown classes in avoid → warnings
    let known = known_classes(root);
    if let Some(av) = root.get("avoid").and_then(|a| a.as_object()) {
        for section in ["label", "leader", "buffer"] {
            if let Some(Value::Object(m)) = av.get(section) {
                for k in m.keys() {
                    if k == "*" || (section == "label" && k == "own_mark") || known.contains(k.as_str()) {
                        continue;
                    }
                    warnings.push(Issue::new(
                        format!("/avoid/{section}/{}", ptr_token(k)),
                        "unknown_class",
                        format!("class '{k}' is not produced by any obstacle source"),
                    ));
                }
            }
        }
        if let Some(Value::Array(rel)) = av.get("relaxable") {
            for (i, k) in rel.iter().enumerate() {
                if let Some(k) = k.as_str() {
                    if !known.contains(k) {
                        warnings.push(Issue::new(format!("/avoid/relaxable/{i}"), "unknown_class", format!("class '{k}' is not produced by any obstacle source")));
                    }
                }
            }
        }
    }
}

/// Classes produced by the problem's obstacle sources, plus reserved classes.
fn known_classes(root: &Map<String, Value>) -> BTreeSet<String> {
    let mut k: BTreeSet<String> = RESERVED_CLASSES.iter().map(|s| s.to_string()).collect();
    let preset = root.get("preset").and_then(|p| p.as_str()).unwrap_or("auto");
    if let Some(obs) = root.get("obstacles") {
        if let Some(Value::Array(layers)) = obs.get("vector") {
            for l in layers {
                if let Some(c) = l.get("class").and_then(|c| c.as_str()) {
                    k.insert(c.to_string());
                }
            }
        }
        let svgs: Vec<&Value> = match obs.get("svg") {
            Some(Value::Array(a)) => a.iter().collect(),
            Some(v @ Value::Object(_)) => vec![v],
            _ => vec![],
        };
        for s in svgs {
            match s.get("classes") {
                Some(Value::Array(rules)) => {
                    for r in rules {
                        if let Some(c) = r.get("class").and_then(|c| c.as_str()) {
                            k.insert(c.to_string());
                        }
                    }
                }
                _ => {
                    for (name, json) in PRESETS {
                        if *name == preset {
                            if let Ok(v) = serde_json::from_str::<Value>(json) {
                                for r in v["svg_classes"].as_array().into_iter().flatten() {
                                    if let Some(c) = r.get("class").and_then(|c| c.as_str()) {
                                        k.insert(c.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if let Some(c) = s.get("default_class").and_then(|c| c.as_str()) {
                k.insert(c.to_string());
            }
        }
        let rasters: Vec<&Value> = match obs.get("raster") {
            Some(Value::Array(a)) => a.iter().collect(),
            Some(v @ Value::Object(_)) => vec![v],
            _ => vec![],
        };
        for r in rasters {
            if let Some(c) = r.get("class").and_then(|c| c.as_str()) {
                k.insert(c.to_string());
            }
            if let Some(Value::Object(cm)) = r.get("classmap") {
                for c in cm.values().filter_map(|c| c.as_str()) {
                    k.insert(c.to_string());
                }
            }
        }
    }
    k.remove("ignore");
    k
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn codes(r: &Report) -> Vec<(String, String)> {
        r.errors.iter().map(|e| (e.pointer.clone(), e.code.clone())).collect()
    }

    #[test]
    fn minimal_problem_is_valid() {
        let r = validate(&json!({"items": [{"anchor": {"type": "point", "x": 1, "y": 2}, "label": {"type": "text", "text": "A"}}]}));
        assert!(r.valid, "{:?}", r.errors);
    }

    #[test]
    fn structural_errors_have_pointers() {
        let r = validate(&json!({
            "canvas": {"width": -1, "height": 10},
            "items": [
                {"id": "a", "anchor": {"type": "point", "x": 1}, "label": {"type": "text", "text": "A"}},
                {"id": "a", "anchor": {"type": "point", "x": 1, "y": 2, "mark": {"shape": "circle", "r": 2, "w": 1}}, "label": {"type": "text", "text": "B", "padding": "3qq"}},
                {"anchor": {"type": "line"}, "label": {"type": "icon", "width": 4}}
            ],
            "avoid": {"label": {"outlierz": "hard"}},
            "frobnicate": 1
        }));
        let c = codes(&r);
        assert!(c.contains(&("/canvas/width".into(), "range".into())), "{c:?}");
        assert!(c.contains(&("/items/0/anchor/y".into(), "required".into())), "{c:?}");
        assert!(c.contains(&("/items/1/id".into(), "duplicate_id".into())), "{c:?}");
        assert!(c.contains(&("/items/1/anchor/mark/w".into(), "unknown_property".into())), "{c:?}");
        assert!(c.contains(&("/items/1/label/padding".into(), "unit".into())), "{c:?}");
        assert!(c.contains(&("/items/2/anchor/type".into(), "unsupported".into())), "{c:?}");
        assert!(c.contains(&("/items/2/label/height".into(), "required".into())), "{c:?}");
        assert!(c.contains(&("/frobnicate".into(), "unknown_property".into())), "{c:?}");
        assert_eq!(r.warnings[0].code, "unknown_class");
    }

    #[test]
    fn exclusive_alternatives() {
        let r = validate(&json!({
            "items": [],
            "obstacles": {"svg": {"source": "<svg/>", "path": "x.svg"}}
        }));
        assert_eq!(codes(&r), vec![("/obstacles/svg".to_string(), "exclusive".to_string())]);
    }

    #[test]
    fn parse_errors() {
        let r = validate_str("{\"items\": [");
        assert_eq!(r.errors[0].code, "parse");
    }
}
