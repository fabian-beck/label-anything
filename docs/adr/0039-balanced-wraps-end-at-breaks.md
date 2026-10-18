# 0039 — Balanced wraps end lines at break opportunities

* Status: accepted (spec §5.3 `balanced`; Rust `la-text`, TypeScript `@label-anything/text`)
* Date: 2026-10-18

## Context
`balanced(N, M)` takes the narrowest candidate width at which the greedy wrap needs at most
`N` lines. A candidate narrower than a word lets the greedy wrap break inside that word
(an emergency break) and so reach `N` lines: the gallery's software chart showed
`uimanager.UI / Implementat / ionProvider`, a variant of a label with wrap settings
(`max_width` 16 em, 3 lines). The ladder's `wrap` step already dropped such variants for
labels without wrap settings, but only after the fact: the text then got no variant with
that many lines at all, even where one exists (`leading / and / trailing`).

## Decision
`balanced` drops the candidates narrower than the widest first segment of a line (the
width from a line start to the next break opportunity), capped at `M`. Above that floor the
greedy wrap never needs an emergency break; only a segment wider than `M` still forces one,
as the label's width limit demands.

## Consequences
Wrapped labels split only at break opportunities (spaces, punctuation, camelCase,
acronyms) unless a word is wider than `max_width`. The three-line variant of
`uimanager.UIImplementationProvider` is `uimanager.UI / Implementation / Provider`; the
benchmark chart `01-software-metrics/cbo-rfc-100-svg` places 77 labels instead of 74.
Labels without wrap settings gain the variants the old filter removed. Four `text`
conformance cases changed; no sample problem's placement changed (the parity fixtures are
unchanged).
