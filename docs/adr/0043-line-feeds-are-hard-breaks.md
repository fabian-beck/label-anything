# 0043 — Line feeds are hard breaks

* Status: accepted (spec §5.3; Rust `la-core`, TypeScript `@label-anything/core`)
* Date: 2026-10-18

## Context
A line feed in a label's text was ordinary white space: `"Paris\n2.1M"` got a one-line
box as wide as both lines together. Every renderer that draws the text itself then
disagreed with the box: matplotlib draws two lines (the second overlapped the marker),
Vega draws a text array as several lines (the Vega transform joins it with `\n`), and the
helpers that draw the result's lines got the line feed in the middle of one line. Two-line
labels — a name and a value — are common in charts and maps.

## Decision
A text that contains a line feed has one normal variant: its lines, split at the line
feeds (a `\r` before a line feed is dropped, so CRLF works), as given. The wrap settings
and the `wrap` and `truncate` ladder steps leave it alone: the author chose the lines.
The other steps (alternatives, shrinking, leaders, omission) apply as usual. The rule sits
in the core's variant construction; the line-breaking functions of the text packages
(`greedy`, `balanced`) are unchanged and still treat a line feed as white space.

## Consequences
`"Paris\n2.1M"` is laid out as two lines in every language and helper, and host
measurement callbacks see the single lines. No sample problem contains a line feed; no
parity fixture changed. The conformance case `hard-line-breaks` pins the rule (LF and
CRLF).
