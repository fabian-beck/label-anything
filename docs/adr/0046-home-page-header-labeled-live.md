# 0046 — The home page's header: the logo, labeled live

* Status: accepted (docs/_overrides/home.html, ts/packages/playground/src/hero.ts; not an engine change)
* Date: 2026-10-18

## Context
The home page opened with a warning, two dense paragraphs and a static figure. It said
correctly what the project is, but a reader had to read it all to find out, and nothing
on it showed the engine at work; the playground, which does, was one link among many.
The playground's logo — a label, its leader and a dot — was used nowhere else: the site
had Material's default book icon.

## Decision
* **The logo everywhere.** The site's header icon (`docs/_overrides/.icons/la/logo.svg`,
  drawn in the header's colour) and favicon (`docs/assets/logo.svg`) are the playground's
  logo.
* **The logo is the demo.** The home page has its own template (`home.html`): a header
  whose logo is drawn large, with the name on its label. A script makes it live: it
  places the name and the labels of a handful of dots — things one labels on charts, maps
  and networks — with the engine, keeping every label off the header's text (its lines,
  the language chips and the buttons are rectangles of class `text`). Dots and labels can
  be dragged, a click adds a dot, *Reset* restores the start. The name's item has only the
  `distant` model, so it keeps its leader wherever it goes, and is `required` with the
  highest priority; it may cover the dots of other items (`lower_items`), which then lose
  their labels. Where it finds no place at all, its dot glides back, once let go, to where
  it last had one: the name always shows.
* **Static first.** The logo is HTML and SVG in the template. The script reads the
  label's and the dot's boxes from the page and passes them as the name's `warm_start`,
  so the first live solve keeps the name exactly where the static logo has it (the
  browser test checks it to the pixel), and the drawing takes over without a jump. The
  dots the header starts with keep clear of the logo and the text.
* **The playground's engine.** The script is built with the playground (`dist/hero.js`,
  25 KB) and solves with its TypeScript worker (`engine-ts.js`), which the playground's
  visitors have in their cache anyway; the home page loads it from `playground/`.
  Without the playground next to the site (`mkdocs serve`) the static logo stays.
* **The site's font.** Unlike the playground, the header draws in the page's own font:
  the browser measures the texts and passes their `width` and `height`, and the name's
  box is the static label's box.
* **Small budgets.** 10 ms at rest, 4 ms while dragging (the Rust core's, as in the
  playground): about 10 ms per solve for the 18 labels. The first solve compiles the
  engine's code and takes about ten times as long, so the header solves once more right
  after it, and the time it shows is the second one's.

Considered and rejected: *a recording or an animation* would not show that the labels are
placed live, nor react; *the name as the page's text with only small labels around* would
leave the logo out; *the WebAssembly engine* would add the module's download to the home
page for a problem of 18 labels.

## Consequences
The home page leads with what the project does, shown and then told; the experimental
status moves from the top of the page to a section below (the announcement bar on every
page stays). The playground's browser tests cover the header (on a page with its markup):
the name keeps its place, no label overlaps another or the text, dragging, clicking and
resetting work, and the name comes back where it has no room.
