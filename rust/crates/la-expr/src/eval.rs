//! Evaluator. Works on borrowed views of the context and the syntax tree, so scalar
//! results and comparisons of attribute strings allocate nothing; only computed strings
//! (concatenation, `lower`, `upper`), list literals and the final conversion of a list or
//! object result to [`Value`] allocate. Never panics.

use std::collections::BTreeMap;

use crate::ast::{ArithOp, CmpOp, Func, Node, PostOp, Var};
use crate::det_math;
use crate::lexer::number_len_by;
use crate::value::Value;

/// Everything an expression can read about one item.
///
/// `attrs` is the item's `attrs` object (pass `&Value::Obj(BTreeMap::new())` when the item
/// has none). Non-finite `priority`, `x` and `y` read as `null`.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    pub attrs: &'a Value,
    pub id: &'a str,
    pub index: usize,
    pub text: &'a str,
    pub priority: Option<f64>,
    pub tier: Option<i64>,
    pub x: f64,
    pub y: f64,
}

impl<'a> Context<'a> {
    /// A context with the given attrs and defaults for everything else
    /// (`id = ""`, `index = 0`, `text = ""`, no priority/tier, `x = y = 0`).
    pub fn new(attrs: &'a Value) -> Self {
        Context {
            attrs,
            id: "",
            index: 0,
            text: "",
            priority: None,
            tier: None,
            x: 0.0,
            y: 0.0,
        }
    }
}

/// Internal value: borrows strings, lists and objects from the context or the tree.
#[derive(Debug, Clone)]
pub(crate) enum V<'a> {
    Null,
    Bool(bool),
    Num(f64),
    Str(&'a str),
    String(String),
    List(&'a [Value]),
    Items(Vec<V<'a>>),
    Obj(&'a BTreeMap<String, Value>),
}

impl<'a> V<'a> {
    fn view(v: &'a Value) -> V<'a> {
        match v {
            Value::Null => V::Null,
            Value::Bool(b) => V::Bool(*b),
            Value::Num(x) => V::Num(*x),
            Value::Str(s) => V::Str(s),
            Value::List(l) => V::List(l),
            Value::Obj(o) => V::Obj(o),
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            V::Str(s) => Some(s),
            V::String(s) => Some(s),
            _ => None,
        }
    }

    fn list_len(&self) -> Option<usize> {
        match self {
            V::List(l) => Some(l.len()),
            V::Items(v) => Some(v.len()),
            _ => None,
        }
    }

    pub(crate) fn into_value(self) -> Value {
        match self {
            V::Null => Value::Null,
            V::Bool(b) => Value::Bool(b),
            V::Num(x) => Value::Num(x),
            V::Str(s) => Value::Str(s.to_string()),
            V::String(s) => Value::Str(s),
            V::List(l) => Value::List(l.to_vec()),
            V::Items(v) => Value::List(v.into_iter().map(V::into_value).collect()),
            V::Obj(o) => Value::Obj(o.clone()),
        }
    }
}

/// A number result: non-finite values become null.
fn num(x: f64) -> V<'static> {
    if x.is_finite() {
        V::Num(x)
    } else {
        V::Null
    }
}

pub(crate) fn truthy_v(v: &V) -> bool {
    match v {
        V::Null => false,
        V::Bool(b) => *b,
        V::Num(x) => *x != 0.0 && !x.is_nan(),
        V::Str(s) => !s.is_empty(),
        V::String(s) => !s.is_empty(),
        V::List(l) => !l.is_empty(),
        V::Items(v) => !v.is_empty(),
        V::Obj(_) => true,
    }
}

pub(crate) fn term_number_v(v: &V) -> Option<f64> {
    match v {
        V::Num(x) => Some(*x),
        V::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

pub(crate) fn eq_v(a: &V, b: &V) -> bool {
    match (a, b) {
        (V::Null, V::Null) => true,
        (V::Bool(x), V::Bool(y)) => x == y,
        (V::Num(x), V::Num(y)) => x == y,
        (V::Obj(x), V::Obj(y)) => x == y,
        (V::List(x), V::List(y)) => x == y,
        (V::List(x), V::Items(y)) | (V::Items(y), V::List(x)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| eq_v(&V::view(p), q))
        }
        (V::Items(x), V::Items(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| eq_v(p, q))
        }
        _ => match (a.as_str(), b.as_str()) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
    }
}

/// `<`, `<=`, `>`, `>=`: numbers numerically, strings by code points (UTF-8 byte order
/// equals code-point order); any other pair is false.
fn order(op: CmpOp, a: &V, b: &V) -> bool {
    let ord = if let (V::Num(x), V::Num(y)) = (a, b) {
        match x.partial_cmp(y) {
            Some(o) => o,
            None => return false,
        }
    } else if let (Some(x), Some(y)) = (a.as_str(), b.as_str()) {
        x.cmp(y)
    } else {
        return false;
    };
    match op {
        CmpOp::Lt => ord.is_lt(),
        CmpOp::Le => ord.is_le(),
        CmpOp::Gt => ord.is_gt(),
        CmpOp::Ge => ord.is_ge(),
        CmpOp::Eq | CmpOp::Ne => false,
    }
}

fn arith<'a>(op: ArithOp, a: V<'a>, b: V<'a>) -> V<'a> {
    if let (V::Num(x), V::Num(y)) = (&a, &b) {
        let (x, y) = (*x, *y);
        return match op {
            ArithOp::Add => num(x + y),
            ArithOp::Sub => num(x - y),
            ArithOp::Mul => num(x * y),
            ArithOp::Div if y == 0.0 => V::Null,
            ArithOp::Div => num(x / y),
            ArithOp::Rem if y == 0.0 => V::Null,
            ArithOp::Rem => num(x % y),
        };
    }
    if op == ArithOp::Add {
        if let (Some(x), Some(y)) = (a.as_str(), b.as_str()) {
            let mut s = String::with_capacity(x.len() + y.len());
            s.push_str(x);
            s.push_str(y);
            return V::String(s);
        }
    }
    V::Null
}

fn member<'a>(base: V<'a>, name: &str) -> V<'a> {
    match base {
        V::Obj(m) => m.get(name).map(V::view).unwrap_or(V::Null),
        _ => V::Null,
    }
}

fn list_index(len: usize, i: f64) -> Option<usize> {
    if i >= 0.0 && i < len as f64 && det_math::floor(i) == i {
        Some(i as usize)
    } else {
        None
    }
}

fn index<'a>(base: V<'a>, key: V<'a>) -> V<'a> {
    match (base, key) {
        (V::Obj(m), k) => match k.as_str() {
            Some(s) => m.get(s).map(V::view).unwrap_or(V::Null),
            None => V::Null,
        },
        (V::List(l), V::Num(i)) => match list_index(l.len(), i) {
            Some(i) => V::view(&l[i]),
            None => V::Null,
        },
        (V::Items(mut v), V::Num(i)) => match list_index(v.len(), i) {
            Some(i) => v.swap_remove(i),
            None => V::Null,
        },
        _ => V::Null,
    }
}

fn var<'a>(v: Var, cx: &Context<'a>) -> V<'a> {
    match v {
        Var::Attrs => V::view(cx.attrs),
        Var::Id => V::Str(cx.id),
        Var::Index => V::Num(cx.index as f64),
        Var::Text => V::Str(cx.text),
        Var::Priority => cx.priority.map(num).unwrap_or(V::Null),
        Var::Tier => cx.tier.map(|t| V::Num(t as f64)).unwrap_or(V::Null),
        Var::X => num(cx.x),
        Var::Y => num(cx.y),
    }
}

/// `number(s)`: the grammar's Number rule with an optional leading `-`, surrounded by
/// optional whitespace (space, tab, CR, LF); anything else (or a non-finite value) → None.
pub(crate) fn parse_number_str(s: &str) -> Option<f64> {
    let t = s.trim_matches(|c| matches!(c, ' ' | '\t' | '\r' | '\n'));
    let (neg, body) = match t.strip_prefix('-') {
        Some(b) => (true, b),
        None => (false, t),
    };
    let bytes = body.as_bytes();
    let at = |k: usize| if k < bytes.len() { bytes[k] } else { 0 };
    if bytes.is_empty() || number_len_by(at, 0) != bytes.len() {
        return None;
    }
    let v: f64 = body.parse().ok()?;
    if !v.is_finite() {
        return None;
    }
    Some(if neg { -v } else { v })
}

/// Lazily evaluated arguments of a call; for method calls the receiver is argument 0.
struct Args<'a, 'c> {
    recv: Option<V<'a>>,
    shift: usize,
    nodes: &'a [Node],
    cx: &'c Context<'a>,
}

impl<'a> Args<'a, '_> {
    fn len(&self) -> usize {
        self.nodes.len() + self.shift
    }

    /// Argument `i` (evaluate each argument at most once).
    fn get(&mut self, i: usize) -> V<'a> {
        if i < self.shift {
            return self.recv.take().unwrap_or(V::Null);
        }
        match self.nodes.get(i - self.shift) {
            Some(n) => eval(n, self.cx),
            None => V::Null,
        }
    }

    fn num(&mut self, i: usize) -> Option<f64> {
        match self.get(i) {
            V::Num(x) => Some(x),
            _ => None,
        }
    }
}

// Calls and the evaluator proper. `eval` and `call` are small dispatchers; the work is in
// per-node and per-function helpers so that the frames on the recursion path stay small
// (nesting is bounded by MAX_DEPTH, so recursion depth is too).

fn call<'a>(f: Func, recv: Option<V<'a>>, nodes: &'a [Node], cx: &Context<'a>) -> V<'a> {
    let shift = usize::from(recv.is_some());
    let mut a = Args {
        recv,
        shift,
        nodes,
        cx,
    };
    match f {
        Func::Abs
        | Func::Floor
        | Func::Ceil
        | Func::Round
        | Func::Log
        | Func::Log1p
        | Func::Sqrt => fn_math(f, &mut a),
        Func::Min | Func::Max => fn_min_max(f == Func::Min, &mut a),
        Func::Len => fn_len(&mut a),
        Func::Lower | Func::Upper => fn_case(f == Func::Lower, &mut a),
        Func::Number => fn_number(&mut a),
        Func::StartsWith | Func::EndsWith => fn_affix(f == Func::StartsWith, &mut a),
        Func::Contains => fn_contains(&mut a),
        Func::Coalesce => fn_coalesce(&mut a),
    }
}

fn fn_math<'a>(f: Func, a: &mut Args<'a, '_>) -> V<'a> {
    let Some(x) = a.num(0) else { return V::Null };
    num(match f {
        Func::Abs => x.abs(),
        Func::Floor => det_math::floor(x),
        Func::Ceil => det_math::ceil(x),
        Func::Round => det_math::round_half_away(x),
        Func::Log if x > 0.0 => det_math::ln(x),
        Func::Log1p if x > -1.0 => det_math::ln_1p(x),
        Func::Sqrt if x >= 0.0 => det_math::sqrt(x),
        _ => return V::Null,
    })
}

/// `min`/`max` over numbers (a tie keeps the earlier argument); any non-number → null.
fn fn_min_max<'a>(is_min: bool, a: &mut Args<'a, '_>) -> V<'a> {
    let Some(mut acc) = a.num(0) else {
        return V::Null;
    };
    for i in 1..a.len() {
        let Some(x) = a.num(i) else { return V::Null };
        if (is_min && x < acc) || (!is_min && x > acc) {
            acc = x;
        }
    }
    V::Num(acc)
}

fn fn_len<'a>(a: &mut Args<'a, '_>) -> V<'a> {
    let v = a.get(0);
    if let Some(s) = v.as_str() {
        V::Num(s.chars().count() as f64)
    } else if let Some(n) = v.list_len() {
        V::Num(n as f64)
    } else {
        V::Null
    }
}

fn fn_case<'a>(lower: bool, a: &mut Args<'a, '_>) -> V<'a> {
    match a.get(0).as_str() {
        Some(s) if lower => V::String(s.to_ascii_lowercase()),
        Some(s) => V::String(s.to_ascii_uppercase()),
        None => V::Null,
    }
}

fn fn_number<'a>(a: &mut Args<'a, '_>) -> V<'a> {
    match a.get(0) {
        V::Num(x) => V::Num(x),
        V::Bool(b) => V::Num(if b { 1.0 } else { 0.0 }),
        v => match v.as_str().and_then(parse_number_str) {
            Some(x) => V::Num(x),
            None => V::Null,
        },
    }
}

fn fn_affix<'a>(starts: bool, a: &mut Args<'a, '_>) -> V<'a> {
    let s = a.get(0);
    let p = a.get(1);
    match (s.as_str(), p.as_str()) {
        (Some(s), Some(p)) if starts => V::Bool(s.starts_with(p)),
        (Some(s), Some(p)) => V::Bool(s.ends_with(p)),
        _ => V::Null,
    }
}

/// `contains(string, substring)`, or `contains(list, value)` (element equality).
fn fn_contains<'a>(a: &mut Args<'a, '_>) -> V<'a> {
    let s = a.get(0);
    let n = a.get(1);
    if let (Some(h), Some(nd)) = (s.as_str(), n.as_str()) {
        return V::Bool(h.contains(nd));
    }
    match &s {
        V::List(l) => V::Bool(l.iter().any(|e| eq_v(&V::view(e), &n))),
        V::Items(v) => V::Bool(v.iter().any(|e| eq_v(e, &n))),
        _ => V::Null,
    }
}

fn fn_coalesce<'a>(a: &mut Args<'a, '_>) -> V<'a> {
    for i in 0..a.len() {
        let v = a.get(i);
        if !matches!(v, V::Null) {
            return v;
        }
    }
    V::Null
}

fn eval_list<'a>(items: &'a [Node], cx: &Context<'a>) -> V<'a> {
    let mut out = Vec::with_capacity(items.len());
    for i in items {
        out.push(eval(i, cx));
    }
    V::Items(out)
}

fn eval_not<'a>(e: &'a Node, cx: &Context<'a>) -> V<'a> {
    let v = eval(e, cx);
    V::Bool(!truthy_v(&v))
}

fn eval_neg<'a>(e: &'a Node, cx: &Context<'a>) -> V<'a> {
    match eval(e, cx) {
        V::Num(x) => V::Num(-x),
        _ => V::Null,
    }
}

/// `&&` (`all = true`) / `||` (`all = false`), short-circuiting, boolean result.
fn eval_logic<'a>(items: &'a [Node], all: bool, cx: &Context<'a>) -> V<'a> {
    for i in items {
        let v = eval(i, cx);
        if truthy_v(&v) != all {
            return V::Bool(!all);
        }
    }
    V::Bool(all)
}

fn eval_cmp<'a>(op: CmpOp, l: &'a Node, r: &'a Node, cx: &Context<'a>) -> V<'a> {
    let a = eval(l, cx);
    let b = eval(r, cx);
    V::Bool(match op {
        CmpOp::Eq => eq_v(&a, &b),
        CmpOp::Ne => !eq_v(&a, &b),
        _ => order(op, &a, &b),
    })
}

fn eval_in<'a>(lhs: &'a Node, list: &'a [Node], negate: bool, cx: &Context<'a>) -> V<'a> {
    let a = eval(lhs, cx);
    for i in list {
        let v = eval(i, cx);
        if eq_v(&a, &v) {
            return V::Bool(!negate);
        }
    }
    V::Bool(negate)
}

fn eval_arith<'a>(first: &'a Node, rest: &'a [(ArithOp, Node)], cx: &Context<'a>) -> V<'a> {
    let mut acc = eval(first, cx);
    for (op, operand) in rest {
        let b = eval(operand, cx);
        acc = arith(*op, acc, b);
    }
    acc
}

fn eval_postfix<'a>(base: &'a Node, ops: &'a [PostOp], cx: &Context<'a>) -> V<'a> {
    let mut cur = eval(base, cx);
    for op in ops {
        cur = match op {
            PostOp::Member(name) => member(cur, name),
            PostOp::Index(k) => {
                let key = eval(k, cx);
                index(cur, key)
            }
            PostOp::Method(f, args) => call(*f, Some(cur), args, cx),
        };
    }
    cur
}

pub(crate) fn eval<'a>(n: &'a Node, cx: &Context<'a>) -> V<'a> {
    match n {
        Node::Null => V::Null,
        Node::Bool(b) => V::Bool(*b),
        Node::Num(x) => V::Num(*x),
        Node::Str(s) => V::Str(s),
        Node::Var(v) => var(*v, cx),
        Node::List(items) => eval_list(items, cx),
        Node::Not(e) => eval_not(e, cx),
        Node::Neg(e) => eval_neg(e, cx),
        Node::And(items) => eval_logic(items, true, cx),
        Node::Or(items) => eval_logic(items, false, cx),
        Node::Cmp(op, l, r) => eval_cmp(*op, l, r, cx),
        Node::In { lhs, list, negate } => eval_in(lhs, list, *negate, cx),
        Node::Arith { first, rest } => eval_arith(first, rest, cx),
        Node::Postfix { base, ops } => eval_postfix(base, ops, cx),
        Node::Call(f, args) => call(*f, None, args, cx),
    }
}
