# 0041 — The wrap step leaves no short line on its own

* Status: accepted
* Date: 2026-10-18
* Area: Text
* Affects: spec §5.3; Rust `la-core`, TypeScript `@label-anything/core`

## Context
The `wrap` ladder step offers the balanced wraps of a label into 2 … `wrap_max_lines`
lines. Any break opportunity qualified, so short trailing words ended up on lines of their
own: in a d3 scatter plot of countries, `France 3`, `Turkey 2` and `Iraq 2` became
`France / 3`, `Turkey / 2` and `Iraq / 2`; in an Observable Plot chart `Car model 22`
became the three-line stack `Car / model / 22`. A line of one or two narrow characters
reads as a separate label, or as a stray number next to the mark, and names such as
`Apollo 11` or `Route 66` are common in charts.

## Decision
Labels without wrap settings drop the wrap-step variants that have a line narrower than
1.5 em of the label's font at its current scale (`MIN_WRAP_LINE_EM`). The filter sits
where the core asks for the variants (`extra_wrap` in `labels.rs`, `extraWrap` in
`labels.ts`); `extra_wrap_variants` of the text packages is unchanged. Labels with wrap
settings are unchanged: their width and line limits are the caller's choice.

1.5 em keeps a three-letter word (`Car`, `New`, `Los`: 1.6–1.9 em in Noto Sans) and drops
one or two digits (0.6–1.2 em), two-letter words (`of`, `La`, `St.`: 1.1–1.2 em) and a
single CJK character (1 em).

## Consequences
`France 3` stays on one line and goes to the next ladder step (a leader, eviction,
shrinking or omission); `Car model 22` can still wrap as `Car / model 22`. No placement of
the sample problems changed: two parity fixtures (`leaders-angles`, `priority-prefix`)
generate fewer candidates, and an omitted label of `priority-prefix` no longer lists
`canvas_edge` among its blocking classes. The new conformance case `wrap-no-short-lines`
pins the rule.
