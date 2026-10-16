"""The Label Anything expression language (spec/expr.peg), parsed and evaluated in
pure Python for the evaluator (coverage groups, tier rules, expression terms).

Recursive-descent parser over the PEG; semantics as documented in expr.peg
(no boolean coercion in arithmetic, structural equality, null on type errors).
"""
from __future__ import annotations

import json
import math
import re
from typing import Any

VARIABLES = ("attrs", "id", "index", "text", "priority", "tier", "x", "y")
FUNCS = {  # name: (min_args, max_args or None)
    "abs": (1, 1), "min": (1, None), "max": (1, None), "log": (1, 1), "sqrt": (1, 1), "floor": (1, 1),
    "ceil": (1, 1), "round": (1, 1), "log1p": (1, 1), "len": (1, 1), "lower": (1, 1), "upper": (1, 1),
    "number": (1, 1), "startsWith": (2, 2), "endsWith": (2, 2), "contains": (2, 2), "coalesce": (1, None),
}
KEYWORDS = ("true", "false", "null", "in", "not")


class ExprError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


_TOKEN = re.compile(r"""
    (?P<ws>[ \t\r\n]+)
  | (?P<num>(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)
  | (?P<str>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')
  | (?P<op>\|\||&&|==|!=|<=|>=|[!<>+\-*/%().,\[\]])
  | (?P<ident>[A-Za-z_][A-Za-z0-9_]*)
""", re.VERBOSE)


def _tokenize(src: str) -> list[tuple[str, str]]:
    pos = 0
    out = []
    while pos < len(src):
        m = _TOKEN.match(src, pos)
        if not m:
            raise ExprError("expr_syntax", f"unexpected character {src[pos]!r} at {pos}")
        pos = m.end()
        kind = m.lastgroup
        if kind == "ws":
            continue
        out.append((kind, m.group(kind)))
    out.append(("eof", ""))
    return out


def _unescape(s: str) -> str:
    body = s[1:-1]
    out = []
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            n = body[i + 1]
            if n == "n":
                out.append("\n")
                i += 2
            elif n == "t":
                out.append("\t")
                i += 2
            elif n == "u" and i + 5 < len(body) + 0 and re.match(r"[0-9a-fA-F]{4}", body[i + 2:i + 6]):
                out.append(chr(int(body[i + 2:i + 6], 16)))
                i += 6
            else:
                out.append(n)
                i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


class _Parser:
    def __init__(self, src: str):
        self.toks = _tokenize(src)
        self.i = 0

    def peek(self, k: int = 0):
        return self.toks[self.i + k]

    def next(self):
        t = self.toks[self.i]
        self.i += 1
        return t

    def accept(self, kind: str, val: str | None = None) -> bool:
        t = self.peek()
        if t[0] == kind and (val is None or t[1] == val):
            self.i += 1
            return True
        return False

    def expect(self, kind: str, val: str | None = None):
        if not self.accept(kind, val):
            t = self.peek()
            raise ExprError("expr_syntax", f"expected {val or kind}, got {t[1] or t[0]!r}")

    def parse(self):
        node = self.or_()
        self.expect("eof")
        return node

    def or_(self):
        node = self.and_()
        while self.accept("op", "||"):
            node = ("or", node, self.and_())
        return node

    def and_(self):
        node = self.not_()
        while self.accept("op", "&&"):
            node = ("and", node, self.not_())
        return node

    def not_(self):
        if self.accept("op", "!"):
            return ("not", self.not_())
        return self.cmp()

    def cmp(self):
        left = self.add()
        t = self.peek()
        if t[0] == "op" and t[1] in ("==", "!=", "<=", ">=", "<", ">"):
            self.next()
            return ("cmp", t[1], left, self.add())
        if t == ("ident", "in"):
            self.next()
            return ("in", left, self.list_(), False)
        if t == ("ident", "not") and self.peek(1) == ("ident", "in"):
            self.next()
            self.next()
            return ("in", left, self.list_(), True)
        return left

    def add(self):
        node = self.mul()
        while self.peek()[0] == "op" and self.peek()[1] in ("+", "-"):
            op = self.next()[1]
            node = ("bin", op, node, self.mul())
        return node

    def mul(self):
        node = self.unary()
        while self.peek()[0] == "op" and self.peek()[1] in ("*", "/", "%"):
            op = self.next()[1]
            node = ("bin", op, node, self.unary())
        return node

    def unary(self):
        if self.accept("op", "-"):
            return ("neg", self.unary())
        return self.postfix()

    def postfix(self):
        node = self.primary()
        while True:
            if self.accept("op", "."):
                t = self.next()
                if t[0] != "ident":
                    raise ExprError("expr_syntax", "expected identifier after '.'")
                name = t[1]
                if self.accept("op", "("):
                    args = self.args()
                    node = self._call(name, [node] + args)
                else:
                    node = ("member", node, ("lit", name))
            elif self.accept("op", "["):
                idx = self.or_()
                self.expect("op", "]")
                node = ("member", node, idx)
            else:
                return node

    def args(self):
        args = []
        if self.accept("op", ")"):
            return args
        args.append(self.or_())
        while self.accept("op", ","):
            args.append(self.or_())
        self.expect("op", ")")
        return args

    def _call(self, name, args):
        if name not in FUNCS:
            raise ExprError("expr_unknown_identifier", f"unknown function {name!r}")
        lo, hi = FUNCS[name]
        if len(args) < lo or (hi is not None and len(args) > hi):
            raise ExprError("expr_arity", f"{name} takes {lo}{'' if hi == lo else '+'} arguments")
        return ("call", name, args)

    def list_(self):
        self.expect("op", "[")
        items = []
        if not self.accept("op", "]"):
            items.append(self.or_())
            while self.accept("op", ","):
                items.append(self.or_())
            self.expect("op", "]")
        return ("list", items)

    def primary(self):
        t = self.peek()
        if t[0] == "num":
            self.next()
            return ("lit", float(t[1]))
        if t[0] == "str":
            self.next()
            return ("lit", _unescape(t[1]))
        if t[0] == "op" and t[1] == "(":
            self.next()
            node = self.or_()
            self.expect("op", ")")
            return node
        if t[0] == "op" and t[1] == "[":
            return self.list_()
        if t[0] == "ident":
            name = t[1]
            if name == "true":
                self.next()
                return ("lit", True)
            if name == "false":
                self.next()
                return ("lit", False)
            if name == "null":
                self.next()
                return ("lit", None)
            if name in ("in", "not"):
                raise ExprError("expr_syntax", f"unexpected keyword {name!r}")
            self.next()
            if self.accept("op", "("):
                return self._call(name, self.args())
            if name not in VARIABLES:
                raise ExprError("expr_unknown_identifier", f"unknown identifier {name!r}")
            return ("var", name)
        raise ExprError("expr_syntax", f"unexpected token {t[1] or t[0]!r}")


def parse(src: str):
    return _Parser(src).parse()


def _is_num(v) -> bool:
    return isinstance(v, float) or (isinstance(v, int) and not isinstance(v, bool))


def _fin(v):
    if v is None:
        return None
    v = float(v)
    return v if math.isfinite(v) else None


def truthy(v) -> bool:
    if v is None or v is False:
        return False
    if _is_num(v):
        return not (v == 0 or math.isnan(v))
    if isinstance(v, (str, list)):
        return len(v) > 0
    return True


def _eq(a, b) -> bool:
    if _is_num(a) and _is_num(b):
        return float(a) == float(b)
    if isinstance(a, bool) or isinstance(b, bool) or a is None or b is None:
        return a is b or (isinstance(a, bool) and isinstance(b, bool) and a == b)
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_eq(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_eq(a[k], b[k]) for k in a)
    return False


def _norm(v):
    """JSON attribute values to expression values (ints become floats)."""
    if _is_num(v):
        return float(v)
    return v


def evaluate(node, ctx: dict) -> Any:
    k = node[0]
    if k == "lit":
        return node[1]
    if k == "var":
        return _norm(ctx.get(node[1]))
    if k == "list":
        return [evaluate(n, ctx) for n in node[1]]
    if k == "or":
        return truthy(evaluate(node[1], ctx)) or truthy(evaluate(node[2], ctx))
    if k == "and":
        return truthy(evaluate(node[1], ctx)) and truthy(evaluate(node[2], ctx))
    if k == "not":
        return not truthy(evaluate(node[1], ctx))
    if k == "neg":
        v = evaluate(node[1], ctx)
        return _fin(-v) if _is_num(v) else None
    if k == "member":
        obj = evaluate(node[1], ctx)
        key = evaluate(node[2], ctx)
        if isinstance(obj, dict) and isinstance(key, str):
            return _norm(obj.get(key))
        if isinstance(obj, list) and _is_num(key) and float(key).is_integer():
            i = int(key)
            return _norm(obj[i]) if 0 <= i < len(obj) else None
        return None
    if k == "bin":
        op, a, b = node[1], evaluate(node[2], ctx), evaluate(node[3], ctx)
        if op == "+" and isinstance(a, str) and isinstance(b, str):
            return a + b
        if not (_is_num(a) and _is_num(b)):
            return None
        a, b = float(a), float(b)
        if op == "+":
            return _fin(a + b)
        if op == "-":
            return _fin(a - b)
        if op == "*":
            return _fin(a * b)
        if op == "/":
            return None if b == 0 else _fin(a / b)
        if op == "%":
            return None if b == 0 else _fin(math.fmod(a, b))
    if k == "cmp":
        op, a, b = node[1], evaluate(node[2], ctx), evaluate(node[3], ctx)
        if op == "==":
            return _eq(a, b)
        if op == "!=":
            return not _eq(a, b)
        if (_is_num(a) and _is_num(b)) or (isinstance(a, str) and isinstance(b, str)):
            return {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]
        return False
    if k == "in":
        a = evaluate(node[1], ctx)
        lst = evaluate(node[2], ctx)
        r = any(_eq(a, x) for x in lst)
        return (not r) if node[3] else r
    if k == "call":
        return _call(node[1], [evaluate(a, ctx) for a in node[2]])
    raise ExprError("expr_syntax", f"bad node {k}")


def _call(name: str, args: list) -> Any:
    def num(v):
        return float(v) if _is_num(v) else None

    if name in ("abs", "log", "sqrt", "floor", "ceil", "round", "log1p"):
        v = num(args[0])
        if v is None:
            return None
        if name == "abs":
            return abs(v)
        if name == "log":
            return None if v <= 0 else _fin(math.log(v))
        if name == "sqrt":
            return None if v < 0 else math.sqrt(v)
        if name == "floor":
            return float(math.floor(v))
        if name == "ceil":
            return float(math.ceil(v))
        if name == "round":
            return float(math.floor(abs(v) + 0.5)) * (1 if v >= 0 else -1)
        if name == "log1p":
            return None if v <= -1 else _fin(math.log1p(v))
    if name in ("min", "max"):
        vals = [num(a) for a in args]
        if any(v is None for v in vals):
            return None
        return min(vals) if name == "min" else max(vals)
    if name == "len":
        a = args[0]
        return float(len(a)) if isinstance(a, (str, list)) else None
    if name in ("lower", "upper"):
        a = args[0]
        if not isinstance(a, str):
            return None
        return a.lower() if name == "lower" else a.upper()
    if name == "number":
        a = args[0]
        if isinstance(a, bool):
            return 1.0 if a else 0.0
        if _is_num(a):
            return float(a)
        if isinstance(a, str):
            s = a.strip()
            if re.fullmatch(r"(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", s) or \
                    re.fullmatch(r"-(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", s):
                return float(s)
        return None
    if name in ("startsWith", "endsWith", "contains"):
        a, b = args
        if not (isinstance(a, str) and isinstance(b, str)):
            return None
        return a.startswith(b) if name == "startsWith" else a.endswith(b) if name == "endsWith" else b in a
    if name == "coalesce":
        for a in args:
            if a is not None:
                return a
        return None
    raise ExprError("expr_unknown_identifier", name)


def item_context(item_raw: dict, index: int, ref: tuple[float, float]) -> dict:
    label = item_raw.get("label", {})
    txt = label.get("text", "") if label.get("type") == "text" else ""
    return {"attrs": item_raw.get("attrs", {}) or {}, "id": item_raw.get("id", str(index)), "index": float(index),
            "text": txt, "priority": item_raw.get("priority"), "tier": item_raw.get("tier"),
            "x": ref[0], "y": ref[1]}


def canonical(v) -> str:
    """Canonical JSON text of a value (coverage group keys)."""
    def fix(x):
        if _is_num(x) and float(x).is_integer() and abs(x) < 2 ** 53:
            return int(x)
        if isinstance(x, list):
            return [fix(y) for y in x]
        if isinstance(x, dict):
            return {k: fix(y) for k, y in x.items()}
        return x
    return json.dumps(fix(v), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
