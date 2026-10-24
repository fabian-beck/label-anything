# Line breaking

Wrapped labels end lines only at break opportunities, never strand a short word on a line
of its own, keep the line feeds their author typed, and center their lines.

## Context
A label too wide for its place may wrap into two or three lines, from its wrap settings or
from the `wrap` step of the ladder. Charts showed what went wrong: wraps that split words
(`uimanager.UI / Implementat / ionProvider`), stray short lines (`France / 3`,
`Car / model / 22`) that read as separate labels or numbers next to the mark, and a line
feed in `"Paris\n2.1M"` treated as a space, so the engine's one-line box disagreed with
every renderer that drew two lines. And every line started at the left edge of the box:
on the economies chart of the home page "of America" hung under the left half of "United
States". `label.align` existed but was only passed through.

## Decision
- **Break opportunities only.** The balanced wrap drops widths narrower than the widest
  first segment of a line (at most `max_width`), below which the greedy wrap would break
  inside a word. Only a word wider than `max_width` still breaks inside.
- **No short lines from the `wrap` step.** For labels without wrap settings, a wrap with a
  line narrower than 1.5 em is not offered. That keeps three-letter words (`Car`, `Los`:
  1.6–1.9 em) and drops one or two digits, `of`, `St.` or a single CJK character. Labels
  with wrap settings get what their width and line limits allow.
- **Line feeds are hard breaks.** A text with a line feed has exactly its lines (a `\r`
  before the `\n` is dropped); wrapping and truncation leave it alone, and the other
  ladder steps apply as usual.
- **Centered lines.** The lines of a label align within its widest line: `center` by
  default (`defaults.align`; per label `label.align`, also `start` and `end`). The result
  reports where each line starts (`text.x_offsets`) and `text.align`; boxes do not change.

## Consequences
Wrapped labels split at spaces, punctuation, camelCase and acronyms. `France 3` stays on
one line and moves on to the next ladder step. `"Paris\n2.1M"` is two lines in every
language and helper, and host measurement sees each line. The benchmark's software chart
places 77 labels instead of 74. Names on two lines are centered; a host that draws every
line at `text.x_offset` keeps them flush left, and one that draws at `text.x_offsets`
follows the alignment.
