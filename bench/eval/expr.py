"""The Label Anything expression language (spec/expr.peg), parsed and evaluated in
pure Python for the evaluator (coverage groups, tier rules, expression terms).

A tokenizer and a recursive-descent parser over the PEG, with the errors of the grammar's
notes (code and offset in code points, the first error in reading order, 256 nesting
levels), and the semantics documented in expr.peg (no boolean coercion in arithmetic,
structural equality, null on type errors, ASCII case mapping, exact rounding).
``conformance/expr/*.json`` holds the expected results (bench/tests/test_conformance.py).

One deviation remains: ``log`` and ``log1p`` are those of the platform's math library, not
the engine's deterministic ones (spec §10.4), so their last bit can differ.
"""
from __future__ import annotations

import json
import math
import re
import sys
from typing import Any

VARIABLES = ("attrs", "id", "index", "text", "priority", "tier", "x", "y")
FUNCS = {  # name: (min_args, max_args or None)
    "abs": (1, 1), "min": (1, None), "max": (1, None), "log": (1, 1), "sqrt": (1, 1), "floor": (1, 1),
    "ceil": (1, 1), "round": (1, 1), "log1p": (1, 1), "len": (1, 1), "lower": (1, 1), "upper": (1, 1),
    "number": (1, 1), "startsWith": (2, 2), "endsWith": (2, 2), "contains": (2, 2), "coalesce": (1, None),
}
KEYWORDS = ("true", "false", "null", "in", "not")
MAX_DEPTH = 256  # nesting levels: groups, lists, indices, argument lists, prefix '!' and '-'

_WS = " \t\r\n"
_NUMBER = re.compile(r"(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_HEX4 = re.compile(r"[0-9a-fA-F]{4}")
_OPS = ("||", "&&", "==", "!=", "<=", ">=", "!", "<", ">", "+", "-", "*", "/", "%", ".", "(", ")", "[", "]", ",")
_CMP = ("==", "!=", "<=", ">=", "<", ">")
_LOWER = {c: c + 32 for c in range(ord("A"), ord("Z") + 1)}
_UPPER = {c: c - 32 for c in range(ord("a"), ord("z") + 1)}
# Python frames that MAX_DEPTH nesting levels need at most, in the parser (six a level) and in the
# evaluation (three a level)
_FRAMES = 8 * MAX_DEPTH


class ExprError(Exception):
    """A parse error: its code (``expr_syntax``, ``expr_unknown_identifier``, ``expr_arity``) and the
    offset of the offending token in code points. Evaluation never fails."""

    def __init__(self, code: str, message: str, offset: int = 0):
        super().__init__(message)
        self.code = code
        self.offset = offset


def _syntax(offset: int, message: str) -> ExprError:
    return ExprError("expr_syntax", message, offset)


# -- tokens ---------------------------------------------------------------------------------------------
# (kind, value, offset): num, str, ident, a keyword or an operator as its own kind, eof, and error (the
# value is the ExprError): the tokenizer stops there, and the parser reports it when it gets there, so
# that the first error in reading order wins.

def _string(src: str, start: int) -> tuple[str, int]:
    """The string literal that opens at ``start``: its value and the position after it."""
    quote, n = src[start], len(src)
    out = []
    i = start + 1
    while True:
        if i >= n:
            raise _syntax(start, "unterminated string")
        c = src[i]
        if c == quote:
            return "".join(out), i + 1
        if c != "\\":
            out.append(c)
            i += 1
            continue
        if i + 1 >= n:
            raise _syntax(start, "unterminated string")
        e = src[i + 1]
        if e != "u":
            out.append({"n": "\n", "t": "\t"}.get(e, e))
            i += 2
            continue
        if not _HEX4.match(src, i + 2):
            raise _syntax(i, "invalid \\u escape: expected 4 hex digits")
        cp = int(src[i + 2:i + 6], 16)
        if 0xD800 <= cp < 0xDC00:  # a high surrogate: with the escaped low one, one code point
            low = int(src[i + 8:i + 12], 16) if src.startswith("\\u", i + 6) and _HEX4.match(src, i + 8) else 0
            if not 0xDC00 <= low < 0xE000:
                raise _syntax(i, "invalid \\u escape: unpaired surrogate")
            out.append(chr(0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00)))
            i += 12
            continue
        if 0xDC00 <= cp < 0xE000:
            raise _syntax(i, "invalid \\u escape: unpaired surrogate")
        out.append(chr(cp))
        i += 6


def _tokenize(src: str) -> list[tuple[str, Any, int]]:
    out: list[tuple[str, Any, int]] = []
    n = len(src)
    i = 0
    while True:
        while i < n and src[i] in _WS:
            i += 1
        if i >= n:
            out.append(("eof", None, n))
            return out
        c = src[i]
        try:
            m = _NUMBER.match(src, i)
            if m:
                v = float(m.group())
                if not math.isfinite(v):
                    raise _syntax(i, "number out of range")
                tok = ("num", v, i)
                i = m.end()
            elif c in "\"'":
                s, end = _string(src, i)
                tok = ("str", s, i)
                i = end
            elif _IDENT.match(src, i):
                word = _IDENT.match(src, i).group()
                tok = (word, None, i) if word in KEYWORDS else ("ident", word, i)
                i += len(word)
            else:
                op = next((o for o in _OPS if src.startswith(o, i)), None)
                if op is None:
                    hint = {"=": " (use '==' to compare)", "&": " (use '&&')", "|": " (use '||')"}.get(c, "")
                    raise _syntax(i, f"unexpected character {c!r}{hint}")
                tok = (op, None, i)
                i += len(op)
        except ExprError as e:
            out.append(("error", e, e.offset))
            return out
        out.append(tok)


def _describe(tok: tuple[str, Any, int]) -> str:
    kind, value, _ = tok
    if kind == "ident":
        return f"identifier {value!r}"
    return {"num": "a number", "str": "a string", "eof": "end of input", "error": "an invalid token"}.get(
        kind, repr(kind))


# -- parser ---------------------------------------------------------------------------------------------
# Nodes: ("lit", value), ("var", name), ("list", items), ("not", e), ("neg", e), ("and", items),
# ("or", items), ("cmp", op, a, b), ("in", e, items, negated), ("arith", first, [(op, e), ...]) for a
# chain of one precedence, ("postfix", base, [("member", name) | ("index", e) | ("method", name, args)]),
# ("call", name, args). Chains are flat, so that only nesting, which is bounded, recurses.

class _Parser:
    def __init__(self, src: str):
        self.toks = _tokenize(src)
        self.i = 0
        self.depth = 0

    @property
    def kind(self) -> str:
        return self.toks[self.i][0]

    @property
    def offset(self) -> int:
        return self.toks[self.i][2]

    def bump(self):
        tok = self.toks[self.i]
        if self.i + 1 < len(self.toks):
            self.i += 1
        return tok

    def unexpected(self, expected: str) -> ExprError:
        tok = self.toks[self.i]
        if tok[0] == "error":
            return tok[1]
        return _syntax(tok[2], f"expected {expected}, found {_describe(tok)}")

    def expect(self, kind: str, what: str):
        if self.kind != kind:
            raise self.unexpected(what)
        self.bump()

    def enter(self):
        """Opens a nesting level at the current token."""
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise _syntax(self.offset, f"expression nested too deeply (more than {MAX_DEPTH} levels)")

    def prefixes(self, op: str) -> int:
        n = 0
        while self.kind == op:
            self.enter()
            self.bump()
            n += 1
        return n

    def parse(self):
        node = self.or_()
        if self.kind != "eof":
            raise self.unexpected("end of input")
        return node

    def or_(self):
        items = [self.and_()]
        while self.kind == "||":
            self.bump()
            items.append(self.and_())
        return items[0] if len(items) == 1 else ("or", items)

    def and_(self):
        items = [self.not_()]
        while self.kind == "&&":
            self.bump()
            items.append(self.not_())
        return items[0] if len(items) == 1 else ("and", items)

    def not_(self):
        """``Not <- '!' Not / Cmp``, ``Cmp <- Add (CmpOp Add / 'in' List / 'not' 'in' List)?``"""
        nots = self.prefixes("!")
        node = self.arith()
        if self.kind in _CMP:
            op = self.bump()[0]
            node = ("cmp", op, node, self.arith())
        elif self.kind in ("in", "not"):
            negated = self.bump()[0] == "not"
            if negated:
                self.expect("in", "'in' after 'not'")
            if self.kind != "[":
                raise self.unexpected("'[' after 'in'")
            node = ("in", node, self.items("]"), negated)
        for _ in range(nots):
            node = ("not", node)
        self.depth -= nots
        return node

    def arith(self):
        """``Add <- Mul (('+' / '-') Mul)*``, ``Mul <- Unary (('*' / '/' / '%') Unary)*``"""
        def chain(first, rest):
            return ("arith", first, rest) if rest else first

        sums: list = []       # the products before the current one, each with the operator after it
        first, rest = self.unary(), []  # the current product
        while self.kind in ("+", "-", "*", "/", "%"):
            op = self.bump()[0]
            operand = self.unary()
            if op in "+-":
                sums.append((chain(first, rest), op))
                first, rest = operand, []
            else:
                rest.append((op, operand))
        last = chain(first, rest)
        if not sums:
            return last
        ops = [op for _, op in sums]
        operands = [node for node, _ in sums[1:]] + [last]
        return ("arith", sums[0][0], list(zip(ops, operands)))

    def unary(self):
        """``Unary <- '-' Unary / Postfix``, ``Postfix <- Primary (…)*``"""
        negs = self.prefixes("-")
        kind = self.kind
        if kind == "(":
            self.enter()
            self.bump()
            node = self.or_()
            self.expect(")", "')'")
            self.depth -= 1
        elif kind == "[":
            node = ("list", self.items("]"))
        elif kind == "ident":
            node = self.ident()
        elif kind in ("num", "str"):
            node = ("lit", self.bump()[1])
        elif kind in ("true", "false", "null"):
            self.bump()
            node = ("lit", {"true": True, "false": False, "null": None}[kind])
        else:
            raise self.unexpected("an expression")
        ops = []
        while True:
            if self.kind == ".":
                self.bump()
                if self.kind != "ident":  # keywords are not identifiers, also not here
                    raise self.unexpected("a member name after '.'")
                _, name, offset = self.bump()
                if self.kind == "(":  # a method: the receiver is the first argument
                    self.function(name, offset)
                    args = self.items(")")
                    self.arity(name, len(args) + 1, offset)
                    ops.append(("method", name, args))
                else:
                    ops.append(("member", name))
            elif self.kind == "[":
                self.enter()
                self.bump()
                ops.append(("index", self.or_()))
                self.expect("]", "']'")
                self.depth -= 1
            else:
                break
        if ops:
            node = ("postfix", node, ops)
        for _ in range(negs):
            node = ("neg", node)
        self.depth -= negs
        return node

    def ident(self):
        """A call or a variable: the name is resolved when it is read, the arity after the ``)``."""
        _, name, offset = self.bump()
        if self.kind != "(":
            if name not in VARIABLES:
                raise ExprError("expr_unknown_identifier", f"unknown identifier {name!r}", offset)
            return ("var", name)
        self.function(name, offset)
        args = self.items(")")
        self.arity(name, len(args), offset)
        return ("call", name, args)

    @staticmethod
    def function(name: str, offset: int):
        if name not in FUNCS:
            raise ExprError("expr_unknown_identifier", f"unknown function {name!r}", offset)

    @staticmethod
    def arity(name: str, n: int, offset: int):
        lo, hi = FUNCS[name]
        if n < lo or (hi is not None and n > hi):
            raise ExprError("expr_arity", f"{name}() takes {'at least ' if hi is None else ''}{lo} "
                                          f"argument{'' if lo == 1 else 's'}, got {n}", offset)

    def items(self, close: str) -> list:
        """A list literal or an argument list, at its opening bracket, up to ``close``."""
        self.enter()
        self.bump()
        out = []
        if self.kind == close:
            self.bump()
        else:
            while True:
                out.append(self.or_())
                if self.kind == ",":
                    self.bump()
                    continue
                self.expect(close, f"',' or '{close}'")
                break
        self.depth -= 1
        return out


def _deep(fn, *args):
    """``fn(*args)``, with room on Python's stack for the nesting an expression may have: MAX_DEPTH
    levels of a few frames each are more than the default recursion limit allows."""
    try:
        return fn(*args)
    except RecursionError:
        limit = sys.getrecursionlimit()
        sys.setrecursionlimit(limit + _FRAMES)
        try:
            return fn(*args)
        finally:
            sys.setrecursionlimit(limit)


def parse(src: str):
    """The syntax tree of an expression; ``ExprError`` if it is none."""
    return _deep(lambda: _Parser(src).parse())


# -- values ---------------------------------------------------------------------------------------------
# null: None, booleans, numbers: finite floats, strings, lists, objects: dicts (only from attrs).

def _is_num(v) -> bool:
    return isinstance(v, float) or (isinstance(v, int) and not isinstance(v, bool))


def _fin(v: float):
    """A number result: null if it is not finite."""
    return v if math.isfinite(v) else None


def _norm(v):
    """A JSON value as an expression value: numbers are finite floats, any other number is null."""
    if _is_num(v):
        try:
            return _fin(float(v))
        except OverflowError:  # an integer beyond the doubles
            return None
    return v


def truthy(v) -> bool:
    if v is None or isinstance(v, bool):
        return bool(v)
    if _is_num(v):
        return not (v == 0 or math.isnan(v))
    if isinstance(v, (str, list)):
        return len(v) > 0
    return True


def term_number(v) -> float | None:
    """The value of a priority term: a number as it is, booleans as 1 and 0, anything else is missing."""
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    return float(v) if _is_num(v) else None


def _eq(a, b) -> bool:
    """Structural equality: numbers numerically, strings by code points, booleans and null by identity,
    lists elementwise, objects by equal key sets with equal values; different types are unequal."""
    a, b = _norm(a), _norm(b)
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, float) or isinstance(b, float):
        return isinstance(a, float) and isinstance(b, float) and a == b
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_eq(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_eq(a[k], b[k]) for k in a)
    return False


def _arith(op: str, a, b):
    if isinstance(a, float) and isinstance(b, float):
        if op == "+":
            return _fin(a + b)
        if op == "-":
            return _fin(a - b)
        if op == "*":
            return _fin(a * b)
        if b == 0:
            return None
        return _fin(a / b if op == "/" else math.fmod(a, b))
    if op == "+" and isinstance(a, str) and isinstance(b, str):
        return a + b
    return None


def _index(obj, key):
    if isinstance(obj, dict):
        return _norm(obj.get(key)) if isinstance(key, str) else None
    if isinstance(obj, list) and isinstance(key, float) and 0 <= key < len(obj) and key == math.floor(key):
        return _norm(obj[int(key)])
    return None


def _variable(name: str, ctx: dict):
    v = ctx.get(name)
    if name == "attrs":  # any JSON value; an item without attrs has {}
        return {} if v is None else _norm(v)
    if name in ("id", "text"):
        return v if isinstance(v, str) else ""
    return None if isinstance(v, bool) else _norm(v)


def _eval(node, ctx: dict) -> Any:
    k = node[0]
    if k == "lit":
        return node[1]
    if k == "var":
        return _variable(node[1], ctx)
    if k == "postfix":
        v = _eval(node[1], ctx)
        for op in node[2]:
            if op[0] == "member":
                v = _norm(v.get(op[1])) if isinstance(v, dict) else None
            elif op[0] == "index":
                v = _index(v, _eval(op[1], ctx))
            else:
                v = _call(op[1], [v] + [_eval(a, ctx) for a in op[2]])
        return v
    if k == "call":
        return _call(node[1], [_eval(a, ctx) for a in node[2]])
    if k == "cmp":
        op, a, b = node[1], _eval(node[2], ctx), _eval(node[3], ctx)
        if op == "==":
            return _eq(a, b)
        if op == "!=":
            return not _eq(a, b)
        if (isinstance(a, float) and isinstance(b, float)) or (isinstance(a, str) and isinstance(b, str)):
            return a < b if op == "<" else a <= b if op == "<=" else a > b if op == ">" else a >= b
        return False
    if k == "and":
        return all(truthy(_eval(n, ctx)) for n in node[1])
    if k == "or":
        return any(truthy(_eval(n, ctx)) for n in node[1])
    if k == "not":
        return not truthy(_eval(node[1], ctx))
    if k == "in":
        a = _eval(node[1], ctx)
        return any(_eq(a, _eval(n, ctx)) for n in node[2]) != node[3]
    if k == "arith":
        v = _eval(node[1], ctx)
        for op, operand in node[2]:
            v = _arith(op, v, _eval(operand, ctx))
        return v
    if k == "neg":
        v = _eval(node[1], ctx)
        return -v if isinstance(v, float) else None
    if k == "list":
        return [_eval(n, ctx) for n in node[1]]
    raise ValueError(f"not a syntax tree node: {k!r}")


def evaluate(node, ctx: dict) -> Any:
    """The value of a parsed expression for one item (``item_context``). Total: it never fails."""
    return _deep(_eval, node, ctx)


def _whole(v: float, x: float) -> float:
    """The integer ``v`` that ``x`` was rounded to, as a float with the sign of ``x`` if it is zero."""
    return math.copysign(0.0, x) if v == 0 else float(v)


def _number(s: str):
    """``number(string)``: the grammar's Number with an optional leading ``-``, in optional white space."""
    s = s.strip(_WS)
    neg = s.startswith("-")
    if not _NUMBER.fullmatch(s, 1 if neg else 0):
        return None
    v = _fin(float(s[1:] if neg else s))
    return -v if neg and v is not None else v


def _call(name: str, args: list) -> Any:
    a = args[0]
    if name in ("abs", "log", "sqrt", "floor", "ceil", "round", "log1p"):
        if not isinstance(a, float):
            return None
        if name == "abs":
            return abs(a)
        if name == "floor":
            return _whole(math.floor(a), a)
        if name == "ceil":
            return _whole(math.ceil(a), a)
        if name == "round":  # halves away from zero; a + 0.5 would round 0.49999999999999994 up
            t = math.floor(abs(a))
            return _whole(math.copysign(t + 1 if abs(a) - t >= 0.5 else t, a), a)
        if name == "sqrt":
            return math.sqrt(a) if a >= 0 else None
        if name == "log":
            return _fin(math.log(a)) if a > 0 else None
        return _fin(math.log1p(a)) if a > -1 else None
    if name in ("min", "max"):
        if not all(isinstance(v, float) for v in args):
            return None
        acc = a
        for v in args[1:]:  # a tie keeps the earlier argument: min(-0, 0) is -0
            if (v < acc) if name == "min" else (v > acc):
                acc = v
        return acc
    if name == "len":
        return float(len(a)) if isinstance(a, (str, list)) else None
    if name in ("lower", "upper"):  # ASCII only: the Unicode case mappings differ between platforms
        return a.translate(_LOWER if name == "lower" else _UPPER) if isinstance(a, str) else None
    if name == "number":
        if isinstance(a, bool):
            return 1.0 if a else 0.0
        return a if isinstance(a, float) else _number(a) if isinstance(a, str) else None
    if name in ("startsWith", "endsWith", "contains"):
        b = args[1]
        if isinstance(a, str) and isinstance(b, str):
            return a.startswith(b) if name == "startsWith" else a.endswith(b) if name == "endsWith" else b in a
        if name == "contains" and isinstance(a, list):
            return any(_eq(x, b) for x in a)
        return None
    if name == "coalesce":
        return next((v for v in args if v is not None), None)
    raise ValueError(f"not a function: {name!r}")


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
