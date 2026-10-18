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
        Issue {
            pointer: pointer.into(),
            code: code.to_string(),
            message: message.into(),
        }
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
pub const RESERVED_CLASSES: [&str; 6] =
    ["items", "labels", "leaders", "canvas_edge", "ink", "text"];

fn schema() -> &'static Value {
    static S: OnceLock<Value> = OnceLock::new();
    S.get_or_init(|| {
        serde_json::from_str(PROBLEM_SCHEMA_JSON).expect("embedded schema is valid JSON")
    })
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
    let interp = Interp {
        root: schema(),
        regexes: RefCell::new(BTreeMap::new()),
    };
    let mut errors = Vec::new();
    interp.check(
        schema(),
        problem,
        &Path::Root(""),
        false,
        false,
        &mut Sink::Collect(&mut errors),
    );
    let mut warnings = Vec::new();
    semantic(problem, &mut errors, &mut warnings);
    errors.sort();
    errors.dedup_by(|a, b| a.pointer == b.pointer && a.code == b.code);
    warnings.sort();
    warnings.dedup_by(|a, b| a.pointer == b.pointer && a.code == b.code);
    Report {
        valid: errors.is_empty(),
        errors,
        warnings,
    }
}

// ---------------------------------------------------------------------------------------
// Schema interpreter
// ---------------------------------------------------------------------------------------

struct Interp<'s> {
    root: &'s Value,
    regexes: RefCell<BTreeMap<String, regex_lite::Regex>>,
}

/// A lazily materialized JSON pointer (built only when an error is reported).
#[derive(Clone, Copy)]
enum Path<'p> {
    Root(&'p str),
    Key(&'p Path<'p>, &'p str),
    Idx(&'p Path<'p>, usize),
}

impl Path<'_> {
    fn render(&self) -> String {
        let mut segs: Vec<String> = Vec::new();
        let mut cur = self;
        let root = loop {
            match cur {
                Path::Root(r) => break *r,
                Path::Key(p, k) => {
                    segs.push(ptr_token(k));
                    cur = p;
                }
                Path::Idx(p, i) => {
                    segs.push(i.to_string());
                    cur = p;
                }
            }
        };
        let mut out = root.to_string();
        for s in segs.iter().rev() {
            out.push('/');
            out.push_str(s);
        }
        out
    }
}

/// The known property `k` was most likely meant as: equal up to ASCII case, `_` and `-`,
/// else within an edit distance of a third of its length (at least 1); ties go to the
/// alphabetically first.
fn suggest<'a>(k: &str, known: impl Iterator<Item = &'a String>) -> Option<&'a str> {
    let norm = |s: &str| -> Vec<char> {
        s.chars()
            .filter(|&c| c != '_' && c != '-')
            .map(|c| c.to_ascii_lowercase())
            .collect()
    };
    let a = norm(k);
    let limit = (a.len() / 3).max(1);
    let mut best: Option<(usize, &str)> = None;
    for cand in known {
        let d = edit_distance(&a, &norm(cand));
        if d <= limit && best.is_none_or(|(bd, bs)| d < bd || (d == bd && cand.as_str() < bs)) {
            best = Some((d, cand.as_str()));
        }
    }
    best.map(|(_, s)| s)
}

/// Edit distance of two code point sequences: insertions, deletions, substitutions and
/// swaps of two neighbours (`widht`) cost 1 (optimal string alignment).
fn edit_distance(a: &[char], b: &[char]) -> usize {
    let w = b.len() + 1;
    let mut d: Vec<usize> = vec![0; (a.len() + 1) * w];
    for (j, x) in d.iter_mut().enumerate().take(w) {
        *x = j;
    }
    for i in 1..=a.len() {
        d[i * w] = i;
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut v = (d[(i - 1) * w + j - 1] + cost)
                .min(d[(i - 1) * w + j] + 1)
                .min(d[i * w + j - 1] + 1);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(d[(i - 2) * w + j - 2] + 1);
            }
            d[i * w + j] = v;
        }
    }
    d[a.len() * w + b.len()]
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
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).map(|w| json_eq(v, w)).unwrap_or(false))
        }
        _ => a == b,
    }
}

fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 60 {
        format!(
            "{}…",
            &s[..s.char_indices().nth(57).map(|c| c.0).unwrap_or(s.len())]
        )
    } else {
        s
    }
}

/// Where errors go: collected with pointers, or just "did anything fail" (fail fast).
enum Sink<'o> {
    Collect(&'o mut Vec<Issue>),
    Quick(bool),
}

impl Sink<'_> {
    #[inline]
    fn err(&mut self, ptr: &Path, code: &str, msg: impl FnOnce() -> String) {
        match self {
            Sink::Collect(v) => v.push(Issue::new(ptr.render(), code, msg())),
            Sink::Quick(f) => *f = true,
        }
    }
    #[inline]
    fn push(&mut self, issue: Issue) {
        match self {
            Sink::Collect(v) => v.push(issue),
            Sink::Quick(f) => *f = true,
        }
    }
    #[inline]
    fn failed(&self) -> bool {
        matches!(self, Sink::Quick(true))
    }
}

impl<'s> Interp<'s> {
    fn resolve(&self, r: &str) -> Option<&'s Value> {
        let mut cur = self.root;
        for tok in r.strip_prefix("#/")?.split('/') {
            cur = if tok.contains('~') {
                cur.get(tok.replace("~1", "/").replace("~0", "~"))?
            } else {
                cur.get(tok)?
            };
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

    /// Fail-fast validity of `v` against `s` (no error objects).
    fn valid(&self, s: &'s Value, v: &Value, unit: bool) -> bool {
        let mut q = Sink::Quick(false);
        self.check(s, v, &Path::Root(""), unit, false, &mut q);
        !q.failed()
    }

    /// Property names evaluated by `s` at `v` (for `unevaluatedProperties`); `v` is valid.
    fn evaluated_of<'v>(&self, s: &'s Value, v: &'v Value, unit: bool) -> Vec<&'v str> {
        let mut sink_vec = Vec::new();
        self.check(
            s,
            v,
            &Path::Root(""),
            unit,
            true,
            &mut Sink::Collect(&mut sink_vec),
        )
    }

    /// Check `v` against schema `s`. When `collect` is set, returns the property names
    /// evaluated at this location (for `unevaluatedProperties`). In `Quick` mode returns
    /// as soon as anything fails.
    fn check<'v>(
        &self,
        s: &'s Value,
        v: &'v Value,
        ptr: &Path,
        unit: bool,
        collect: bool,
        sink: &mut Sink,
    ) -> Vec<&'v str> {
        let mut evaluated: Vec<&'v str> = Vec::new();
        let o = match s {
            Value::Bool(true) => return evaluated,
            Value::Bool(false) => {
                sink.err(ptr, "invalid_value", || "value not allowed here".into());
                return evaluated;
            }
            Value::Object(o) => o,
            _ => return evaluated,
        };
        let need = collect || o.contains_key("unevaluatedProperties");
        if let Some(Value::String(r)) = o.get("$ref") {
            if let Some(target) = self.resolve(r) {
                let unit2 = unit || r == "#/$defs/length" || r == "#/$defs/nonNegLength";
                let ev = self.check(target, v, ptr, unit2, need, sink);
                if sink.failed() {
                    return evaluated;
                }
                if need {
                    evaluated.extend(ev);
                }
            }
        }
        if let Some(t) = o.get("type") {
            let ok = match t {
                Value::String(t) => type_is(t, v),
                Value::Array(ts) => ts.iter().filter_map(|t| t.as_str()).any(|t| type_is(t, v)),
                _ => true,
            };
            if !ok {
                sink.err(ptr, "type", || {
                    let want = match t {
                        Value::String(t) => t.clone(),
                        Value::Array(ts) => ts
                            .iter()
                            .filter_map(|t| t.as_str())
                            .collect::<Vec<_>>()
                            .join(" or "),
                        _ => String::new(),
                    };
                    format!("expected {want}, got {}", type_name(v))
                });
                return evaluated;
            }
        }
        if let Some(c) = o.get("const") {
            if !json_eq(c, v) {
                sink.err(ptr, "const", || format!("must be {}", short(c)));
                if sink.failed() {
                    return evaluated;
                }
            }
        }
        if let Some(Value::Array(e)) = o.get("enum") {
            if !e.iter().any(|x| json_eq(x, v)) {
                sink.err(ptr, "enum", || {
                    let list: Vec<String> = e.iter().map(short).collect();
                    format!("must be one of {}", list.join(", "))
                });
                if sink.failed() {
                    return evaluated;
                }
            }
        }
        match v {
            Value::Number(n) => {
                let x = n.as_f64().unwrap_or(0.0);
                for (kw, msg) in [
                    ("minimum", ">="),
                    ("maximum", "<="),
                    ("exclusiveMinimum", ">"),
                    ("exclusiveMaximum", "<"),
                ] {
                    if let Some(m) = o.get(kw).and_then(|m| m.as_f64()) {
                        let bad = match kw {
                            "minimum" => x < m,
                            "maximum" => x > m,
                            "exclusiveMinimum" => x <= m,
                            _ => x >= m,
                        };
                        if bad {
                            sink.err(ptr, "range", || format!("must be {msg} {m}"));
                        }
                    }
                }
            }
            Value::String(st) => {
                if let Some(m) = o.get("minLength").and_then(|m| m.as_u64()) {
                    if (st.chars().count() as u64) < m {
                        sink.err(ptr, "length", || {
                            format!("must have at least {m} characters")
                        });
                    }
                }
                if let Some(Value::String(p)) = o.get("pattern") {
                    if !self.regex_match(p, st) {
                        let code = if unit { "unit" } else { "pattern" };
                        sink.err(ptr, code, || {
                            if unit {
                                format!(
                                    "invalid length {}: use a number (px) or <number>px|pt|em",
                                    short(v)
                                )
                            } else {
                                format!("{} does not match {p}", short(v))
                            }
                        });
                    }
                }
            }
            Value::Array(a) => {
                if let Some(m) = o.get("minItems").and_then(|m| m.as_u64()) {
                    if (a.len() as u64) < m {
                        sink.err(ptr, "length", || format!("must have at least {m} items"));
                    }
                }
                if let Some(m) = o.get("maxItems").and_then(|m| m.as_u64()) {
                    if (a.len() as u64) > m {
                        sink.err(ptr, "length", || format!("must have at most {m} items"));
                    }
                }
                if sink.failed() {
                    return evaluated;
                }
                let mut start = 0;
                if let Some(Value::Array(pre)) = o.get("prefixItems") {
                    for (i, ps) in pre.iter().enumerate() {
                        if let Some(item) = a.get(i) {
                            self.check(ps, item, &Path::Idx(ptr, i), unit, false, sink);
                            if sink.failed() {
                                return evaluated;
                            }
                        }
                    }
                    start = pre.len();
                }
                if let Some(is) = o.get("items") {
                    // fast path for the common `[x, y]` point arrays
                    let is_point = is.get("$ref").and_then(|r| r.as_str()) == Some("#/$defs/point");
                    for (i, item) in a.iter().enumerate().skip(start) {
                        if is_point {
                            if let Value::Array(xy) = item {
                                if xy.len() == 2 && xy[0].is_number() && xy[1].is_number() {
                                    continue;
                                }
                            }
                        }
                        self.check(is, item, &Path::Idx(ptr, i), unit, false, sink);
                        if sink.failed() {
                            return evaluated;
                        }
                    }
                }
                if o.get("uniqueItems") == Some(&Value::Bool(true)) {
                    'outer: for i in 0..a.len() {
                        for j in 0..i {
                            if json_eq(&a[i], &a[j]) {
                                sink.err(&Path::Idx(ptr, i), "unique", || "duplicate entry".into());
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
                            sink.err(&Path::Key(ptr, r), "required", || {
                                format!("missing required property '{r}'")
                            });
                        }
                    }
                }
                if sink.failed() {
                    return evaluated;
                }
                let props = o.get("properties").and_then(|p| p.as_object());
                if let Some(props) = props {
                    for (k, val) in m {
                        if let Some(ps) = props.get(k) {
                            self.check(ps, val, &Path::Key(ptr, k), false, false, sink);
                            if sink.failed() {
                                return evaluated;
                            }
                            if need {
                                evaluated.push(k.as_str());
                            }
                        }
                    }
                }
                if let Some(ap) = o.get("additionalProperties") {
                    for (k, val) in m {
                        if props.map(|p| p.contains_key(k)).unwrap_or(false) {
                            continue;
                        }
                        if ap == &Value::Bool(false) {
                            sink.err(&Path::Key(ptr, k), "unknown_property", || {
                                let known = props.into_iter().flat_map(|p| p.keys());
                                match suggest(k, known) {
                                    Some(s) => {
                                        format!("unknown property '{k}' (did you mean '{s}'?)")
                                    }
                                    None => format!("unknown property '{k}'"),
                                }
                            });
                        } else {
                            self.check(ap, val, &Path::Key(ptr, k), false, false, sink);
                        }
                        if sink.failed() {
                            return evaluated;
                        }
                        if need {
                            evaluated.push(k.as_str());
                        }
                    }
                }
                if let Some(pn) = o.get("propertyNames") {
                    for k in m.keys() {
                        self.check(
                            pn,
                            &Value::String(k.clone()),
                            &Path::Key(ptr, k),
                            false,
                            false,
                            sink,
                        );
                        if sink.failed() {
                            return evaluated;
                        }
                    }
                }
                if let Some(Value::Object(dr)) = o.get("dependentRequired") {
                    for (k, deps) in dr {
                        if m.contains_key(k) {
                            for d in deps
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|d| d.as_str())
                            {
                                if !m.contains_key(d) {
                                    sink.err(&Path::Key(ptr, d), "required", || {
                                        format!("'{d}' is required when '{k}' is given")
                                    });
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        if sink.failed() {
            return evaluated;
        }
        if let Some(Value::Array(all)) = o.get("allOf") {
            for sub in all {
                let ev = self.check(sub, v, ptr, unit, need, sink);
                if sink.failed() {
                    return evaluated;
                }
                if need {
                    evaluated.extend(ev);
                }
            }
        }
        if let Some(Value::Array(any)) = o.get("anyOf") {
            let valid: Vec<usize> = (0..any.len())
                .filter(|&k| self.valid(&any[k], v, unit))
                .collect();
            if valid.is_empty() {
                if let Sink::Collect(_) = sink {
                    let p = ptr.render();
                    if required_only(any) {
                        let first = any[0]["required"][0].as_str().unwrap_or("");
                        let names = required_names(any);
                        sink.push(Issue::new(
                            ptr_join(&p, first),
                            "required",
                            format!("one of {names} is required"),
                        ));
                    } else {
                        let results = any
                            .iter()
                            .map(|sub| self.errors_of(sub, v, ptr, unit))
                            .collect();
                        for e in best_alternative(results, &p) {
                            sink.push(e);
                        }
                    }
                } else {
                    sink.push(Issue::new(String::new(), "", String::new()));
                    return evaluated;
                }
            } else if need {
                for k in valid {
                    evaluated.extend(self.evaluated_of(&any[k], v, unit));
                }
            }
        }
        if let Some(Value::Array(one)) = o.get("oneOf") {
            let valid: Vec<usize> = (0..one.len())
                .filter(|&k| self.valid(&one[k], v, unit))
                .collect();
            match valid.len() {
                1 => {
                    if need {
                        evaluated.extend(self.evaluated_of(&one[valid[0]], v, unit));
                    }
                }
                0 => {
                    if let Sink::Collect(_) = sink {
                        let p = ptr.render();
                        if required_only(one) {
                            sink.push(Issue::new(
                                p,
                                "exclusive",
                                format!("exactly one of {} is required", required_names(one)),
                            ));
                        } else {
                            let results = one
                                .iter()
                                .map(|sub| self.errors_of(sub, v, ptr, unit))
                                .collect();
                            for e in best_alternative(results, &p) {
                                sink.push(e);
                            }
                        }
                    } else {
                        sink.push(Issue::new(String::new(), "", String::new()));
                        return evaluated;
                    }
                }
                _ => {
                    sink.err(ptr, "exclusive", || {
                        if required_only(one) {
                            format!("only one of {} may be given", required_names(one))
                        } else {
                            "value matches more than one alternative".to_string()
                        }
                    });
                    if sink.failed() {
                        return evaluated;
                    }
                }
            }
        }
        if let Some(cond) = o.get("if") {
            if self.valid(cond, v, unit) {
                if need {
                    evaluated.extend(self.evaluated_of(cond, v, unit));
                }
                if let Some(t) = o.get("then") {
                    let ev = self.check(t, v, ptr, unit, need, sink);
                    if sink.failed() {
                        return evaluated;
                    }
                    if need {
                        evaluated.extend(ev);
                    }
                }
            } else if let Some(e) = o.get("else") {
                let ev = self.check(e, v, ptr, unit, need, sink);
                if sink.failed() {
                    return evaluated;
                }
                if need {
                    evaluated.extend(ev);
                }
            }
        }
        if let (Some(up), Value::Object(m)) = (o.get("unevaluatedProperties"), v) {
            for (k, val) in m {
                if evaluated.contains(&k.as_str()) {
                    continue;
                }
                if up == &Value::Bool(false) {
                    sink.err(&Path::Key(ptr, k), "unknown_property", || {
                        format!("unknown property '{k}'")
                    });
                } else {
                    self.check(up, val, &Path::Key(ptr, k), false, false, sink);
                }
                if sink.failed() {
                    return evaluated;
                }
                evaluated.push(k.as_str());
            }
        }
        evaluated
    }

    /// All errors of `v` against `s` (reporting path only).
    fn errors_of(&self, s: &'s Value, v: &Value, ptr: &Path, unit: bool) -> Vec<Issue> {
        let mut errs = Vec::new();
        self.check(s, v, ptr, unit, false, &mut Sink::Collect(&mut errs));
        errs
    }
}

fn required_only(alts: &[Value]) -> bool {
    alts.iter().all(|a| {
        a.as_object()
            .map(|o| o.len() == 1 && o.contains_key("required"))
            .unwrap_or(false)
    })
}

fn required_names(alts: &[Value]) -> String {
    let names: Vec<String> = alts
        .iter()
        .map(|a| {
            let r: Vec<&str> = a["required"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|x| x.as_str())
                .collect();
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
        let disc = errs.iter().any(|e| {
            (e.pointer == disc_type || e.pointer == disc_shape)
                && (e.code == "const" || e.code == "enum")
        }) as u8;
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
                errors.push(Issue::new(
                    format!("{base}/type"),
                    "unsupported",
                    "anchor type 'line' is reserved for v2",
                ));
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
                errors.push(Issue::new(
                    ptr,
                    "duplicate_id",
                    format!("id '{id}' is already used by item {first}"),
                ));
            } else {
                ids.insert(id, i);
            }
        }
        for (i, it) in items.iter().enumerate() {
            if let Some(Value::Array(kw)) = it.get("keep_with") {
                for (j, r) in kw.iter().enumerate() {
                    if let Some(r) = r.as_str() {
                        if !ids.contains_key(r) {
                            errors.push(Issue::new(
                                format!("/items/{i}/keep_with/{j}"),
                                "unknown_ref",
                                format!("unknown item id '{r}'"),
                            ));
                        }
                    }
                }
            }
            // icon/box with shape polygon need polygon points
            let label = it.get("label");
            let check_poly = |lab: Option<&Value>, base: String, errors: &mut Vec<Issue>| {
                if let Some(l) = lab {
                    if l.get("shape").and_then(|s| s.as_str()) == Some("polygon")
                        && l.get("polygon").is_none()
                    {
                        errors.push(Issue::new(
                            format!("{base}/polygon"),
                            "required",
                            "shape 'polygon' needs 'polygon' points",
                        ));
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
                        errors.push(Issue::new(
                            format!("/items/{i}/anchor/polygon"),
                            "invalid_value",
                            "area polygon has zero area",
                        ));
                    }
                }
            }
        }
    }
    // expressions
    let check_expr = |ptr: String, v: Option<&Value>, errors: &mut Vec<Issue>| {
        if let Some(Value::String(src)) = v {
            if let Err(e) = la_expr::parse(src) {
                errors.push(Issue::new(
                    ptr,
                    e.code,
                    format!("{} (at {})", e.message, e.offset),
                ));
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
        check_expr(
            "/priority/coverage/by".into(),
            pr.pointer("/coverage/by"),
            errors,
        );
    }
    // y_axis "up" needs a canvas height (explicit or from a background)
    if root.get("y_axis").and_then(|v| v.as_str()) == Some("up") && root.get("canvas").is_none() {
        let has_bg =
            p.pointer("/obstacles/raster").is_some() || p.pointer("/obstacles/svg").is_some();
        if !has_bg {
            errors.push(Issue::new(
                "/canvas",
                "required",
                "y_axis 'up' needs a canvas (or a background) to flip y",
            ));
        }
    }
    // unknown classes in avoid → warnings
    let known = known_classes(root);
    if let Some(av) = root.get("avoid").and_then(|a| a.as_object()) {
        for section in ["label", "leader", "buffer"] {
            if let Some(Value::Object(m)) = av.get(section) {
                for k in m.keys() {
                    if k == "*"
                        || (section == "label" && k == "own_mark")
                        || (section != "buffer" && k == "lower_items")
                        || known.contains(k.as_str())
                    {
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
                        warnings.push(Issue::new(
                            format!("/avoid/relaxable/{i}"),
                            "unknown_class",
                            format!("class '{k}' is not produced by any obstacle source"),
                        ));
                    }
                }
            }
        }
    }
    // priority terms on attributes that no item has → warnings (the term is 0 everywhere)
    if let Some(Value::Array(terms)) = p.pointer("/priority/terms") {
        let has = |name: &str| {
            items.is_some_and(|its| {
                its.iter()
                    .any(|it| it.get("attrs").and_then(|a| a.get(name)).is_some())
            })
        };
        for (i, t) in terms.iter().enumerate() {
            if let Some(name) = t.get("attr").and_then(|a| a.as_str()) {
                if !has(name) {
                    warnings.push(Issue::new(
                        format!("/priority/terms/{i}/attr"),
                        "unknown_attr",
                        format!("no item has the attribute '{name}' (in attrs): the term is 0 for every item"),
                    ));
                }
            }
        }
    }
}

/// Classes produced by the problem's obstacle sources, plus reserved classes.
fn known_classes(root: &Map<String, Value>) -> BTreeSet<String> {
    let mut k: BTreeSet<String> = RESERVED_CLASSES.iter().map(|s| s.to_string()).collect();
    let preset = root
        .get("preset")
        .and_then(|p| p.as_str())
        .unwrap_or("auto");
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
        r.errors
            .iter()
            .map(|e| (e.pointer.clone(), e.code.clone()))
            .collect()
    }

    #[test]
    fn minimal_problem_is_valid() {
        let r = validate(
            &json!({"items": [{"anchor": {"type": "point", "x": 1, "y": 2}, "label": {"type": "text", "text": "A"}}]}),
        );
        assert!(r.valid, "{:?}", r.errors);
    }

    #[test]
    fn unknown_properties_suggest_close_names() {
        let r = validate(&json!({"items": [], "priorty": {}, "fontsize": 10,
            "canvas": {"widht": 8, "height": 6}, "defaults": {"font": {"lineHeight": 1.4}}}));
        let msgs: Vec<_> = r.errors.iter().map(|e| e.message.as_str()).collect();
        assert!(msgs.contains(&"unknown property 'priorty' (did you mean 'priority'?)"));
        assert!(msgs.contains(&"unknown property 'widht' (did you mean 'width'?)"));
        assert!(msgs.contains(&"unknown property 'lineHeight' (did you mean 'line_height'?)"));
        assert!(msgs.contains(&"unknown property 'fontsize'"));
        let known = ["mark".to_string(), "margin".to_string()];
        assert_eq!(suggest("marx", known.iter()), Some("mark"));
        assert_eq!(edit_distance(&['a', 'b', 'c'], &['b', 'a', 'c']), 1);
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
        assert!(
            c.contains(&("/canvas/width".into(), "range".into())),
            "{c:?}"
        );
        assert!(
            c.contains(&("/items/0/anchor/y".into(), "required".into())),
            "{c:?}"
        );
        assert!(
            c.contains(&("/items/1/id".into(), "duplicate_id".into())),
            "{c:?}"
        );
        assert!(
            c.contains(&("/items/1/anchor/mark/w".into(), "unknown_property".into())),
            "{c:?}"
        );
        assert!(
            c.contains(&("/items/1/label/padding".into(), "unit".into())),
            "{c:?}"
        );
        assert!(
            c.contains(&("/items/2/anchor/type".into(), "unsupported".into())),
            "{c:?}"
        );
        assert!(
            c.contains(&("/items/2/label/height".into(), "required".into())),
            "{c:?}"
        );
        assert!(
            c.contains(&("/frobnicate".into(), "unknown_property".into())),
            "{c:?}"
        );
        assert_eq!(r.warnings[0].code, "unknown_class");
    }

    #[test]
    fn exclusive_alternatives() {
        let r = validate(&json!({
            "items": [],
            "obstacles": {"svg": {"source": "<svg/>", "path": "x.svg"}}
        }));
        assert_eq!(
            codes(&r),
            vec![("/obstacles/svg".to_string(), "exclusive".to_string())]
        );
    }

    #[test]
    fn parse_errors() {
        let r = validate_str("{\"items\": [");
        assert_eq!(r.errors[0].code, "parse");
    }
}
