import pytest

from bench.eval import expr as ex


def ev(src, **ctx):
    base = {"attrs": {}, "id": "a", "index": 0.0, "text": "", "priority": None, "tier": None, "x": 0.0, "y": 0.0}
    base.update(ctx)
    return ex.evaluate(ex.parse(src), base)


def test_arithmetic_and_precedence():
    assert ev("1 + 2 * 3") == 7.0
    assert ev("(1 + 2) * 3") == 9.0
    assert ev("-2 * -3") == 6.0
    assert ev("7 % 3") == 1.0 and ev("-7 % 3") == -1.0
    assert ev("1 / 0") is None
    assert ev("true + 1") is None          # no boolean coercion
    assert ev("'a' + 'b'") == "ab"


def test_comparison_logic_membership():
    assert ev("attrs.cbo > 10 && attrs.category == 'core'", attrs={"cbo": 41, "category": "core"}) is True
    assert ev("attrs.missing == null") is True
    assert ev("1 == true") is False
    assert ev("'b' > 'a'") is True and ev("1 < 'a'") is False
    assert ev("attrs.c in ['x', 'y']", attrs={"c": "y"}) is True
    assert ev("attrs.c not in ['x', 'y']", attrs={"c": "z"}) is True
    assert ev("!0") is True and ev("![]") is True and ev("!'s'") is False
    assert ev("[1, 2] == [1, 2]") is True


def test_members_functions_methods():
    a = {"name": "org.example.Foo", "tags": ["a", "b"], "o": {"k": 3}}
    assert ev("attrs.name.startsWith('org.')", attrs=a) is True
    assert ev("startsWith(attrs.name, 'com.')", attrs=a) is False
    assert ev("attrs.tags[1]", attrs=a) == "b" and ev("attrs.tags[5]", attrs=a) is None
    assert ev("attrs['o'].k", attrs=a) == 3.0
    assert ev("len(attrs.tags) + len('abc')", attrs=a) == 5.0
    assert ev("max(1, 5, 3)") == 5.0 and ev("min(2, 1)") == 1.0
    assert ev("round(2.5)") == 3.0 and ev("round(-2.5)") == -3.0
    assert ev("log(0)") is None and ev("sqrt(-1)") is None
    assert ev("coalesce(attrs.none, 4)") == 4.0
    assert ev("number('12.5') + number(true)") == 13.5
    assert ev("upper(text)", text="ab") == "AB"


@pytest.mark.parametrize("src,code", [("attrs.x +", "expr_syntax"), ("foo", "expr_unknown_identifier"),
                                      ("abs(1, 2)", "expr_arity"), ("bar(1)", "expr_unknown_identifier")])
def test_errors(src, code):
    with pytest.raises(ex.ExprError) as e:
        ex.parse(src)
    assert e.value.code == code


def test_canonical_group_keys():
    assert ex.canonical(3.0) == "3" and ex.canonical("a") == '"a"' and ex.canonical(None) == "null"
