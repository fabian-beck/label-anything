# Expression language

`priority.tiers[].where`, `priority.terms[].expr` and `priority.coverage.by` are
expressions in a small, safe, side-effect-free language, evaluated per item. Examples:

| Expression | Use |
|---|---|
| `attrs.capital == true` | a tier rule: capitals first |
| `attrs.pop > 100000 \|\| attrs.capital == true` | a tier rule with two conditions |
| `attrs.category in ["core", "api"]` | membership in a list |
| `log(attrs.loc) * attrs.cbo` | a priority term from two attributes |
| `coalesce(attrs.rank, 99)` | a default for missing values |
| `startsWith(id, "org.")`, `text.startsWith("X")` | string tests (method syntax is sugar for the call) |
| `attrs.region` | a coverage group |

Variables: `attrs` (the item's attributes), `id`, `index`, `text` (the label text),
`priority`, `tier` (explicit values or `null`), `x`, `y` (anchor in canvas px).
Comparisons do not chain; arithmetic works on numbers only (booleans are not coerced);
division by zero and other undefined results are `null`; evaluation never fails — only
parsing can, with the codes `expr_syntax`, `expr_unknown_identifier` and `expr_arity`.
In terms, numbers are used as they are, booleans as 1/0, anything else counts as missing.

Every implementation parses this grammar with a hand-written recursive-descent parser and
passes the same test cases (`conformance/expr`); `log`, `log1p` and `round` use the shared
deterministic math, so results agree bit for bit.

## Grammar and semantics

The normative definition, [`spec/expr.peg`](gh:spec/expr.peg):

```text
--8<-- "spec/expr.peg"
```
