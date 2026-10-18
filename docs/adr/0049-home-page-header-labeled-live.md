# 0049 — The home page's header: the logo, labeled live

* Status: accepted (docs/_overrides/home.html, ts/packages/playground/src/hero.ts; not an engine change)
* Date: 2026-10-18

## Context
The home page opened with a warning, two dense paragraphs and a static figure. It said
correctly what the project is, but a reader had to read it all to find out, and nothing
on it showed the engine at work; the playground, which does, was one link among many.
The playground's logo — a label, its leader and a dot — was used nowhere else: the site
had Material's default book icon, the README none.

## Decision
* **The logo everywhere.** The site's header icon (`docs/_overrides/.icons/la/logo.svg`,
  drawn in the header's colour) and favicon (`docs/assets/logo.svg`) are the playground's
  logo. The README opens with the logo carrying the name (`docs/assets/logo-lockup*.svg`,
  the name as outlines of the bundled Noto Sans Bold, made by `tools/logo/make_lockup.py`).
* **The logo is the demo, and *anything* is meant literally.** The home page has its own
  template (`home.html`): a header whose logo is drawn large, with the name on its label.
  A script makes it live: the name is one item among random things — a rubber duck, a cup
  of coffee, a cactus, a banana, a key, a paper plane, a cat, a pair of socks, the moon,
  a rocket, a balloon, an umbrella, a slice of pizza, a donut, a crown — each drawn with
  its outline, which is its mark (a polygon, the key and the donut with a hole; the moon
  a circle). Their labels show what the engine does without a word of explanation:
  labels touch the true outlines (into the banana's curve), the moon is labeled inside,
  the two socks share one label (a group: "a pair of socks, sort of"), long labels have
  shorter alternatives, the donut's wraps into two lines, and the crown's ("a very
  important label") is set larger and placed first. A pile of things on one side and a
  cluster on the other make the labels compete; clicking adds more until some need
  leaders or are left out.

  Labels keep off the header's text (its lines, the language chips, the buttons and the
  hint are rectangles of class `text`), each other and the things. Things and labels can
  be dragged (the socks move as a pair), a click adds another thing, *Shuffle* moves every
  thing to a random free place, the leader style can be switched (straight, elbow,
  curved), *Reset* restores the start, and hovering a label or a thing tells how its label
  was placed or why it was left out, from the result (`model`, `anchor_side`, `members`,
  the text `used`, `reason`, `blocked_by`). The name's item has only the `distant` model,
  so it keeps its leader wherever it goes, and is `required` with the highest priority; it
  may cover the marks of other items (`lower_items`), which then lose their labels. Where
  it finds no place at all, its dot glides back, once let go, to where it last had one:
  the name always shows.
* **Nothing moves by itself.** Moving labels cannot be read, so the header is still until
  the reader does something: no idle animation, no drift. A drag moves what is dragged
  and the labels make way; a shuffle or a reset glides the things to their new places in
  0.6 s, and the labels follow once (the browser test checks that, left alone, nothing
  is drawn anew).
* **Room for the things.** On wide headers the things stand beside the text; below
  1100 px the header grows a strip below the buttons for some of them, the CSS saying
  which layout (`--la-hero-layout`). The things the header starts with keep clear of the
  text and the logo; dragged ones stop at the text's edge.
* **Static first.** The logo is HTML and SVG in the template. The script reads the
  label's and the dot's boxes from the page and passes them as the name's `warm_start`,
  so the first live solve keeps the name exactly where the static logo has it (the
  browser test checks it to the pixel), and the drawing takes over without a jump.
* **The playground's engine.** The script is built with the playground (`dist/hero.js`,
  about 40 KB) and solves with its TypeScript worker (`engine-ts.js`), which the
  playground's visitors have in their cache anyway; the home page loads it from
  `playground/`. Without the playground next to the site (`mkdocs serve`) the static logo
  stays.
* **Fonts.** The engine measures the things' labels with its bundled Noto Sans (so
  wrapping and alternatives work), and the header draws them with the same font file,
  loaded from the playground. The name is drawn in the page's own font: the browser
  measures it and passes its `width` and `height`, and its box is the static label's box.
* **Small budgets, fewer candidates.** 10 ms at rest, 4 ms while dragging (the Rust
  core's, as in the playground), with fewer candidates than the defaults (2 slider
  positions per quadrant, 3 rings × 12 directions of distant ones, no free-space seeds, a
  6 px grid): a solve of the 18 items takes about 170 candidates and 15–30 ms in
  TypeScript (polygon and circle marks; ellipses would cost several times more). The hint
  counts the labels placed and left out, not the time, which depends on the reader's
  device more than on the engine.

Considered and rejected: *a recording or an animation* would not show that the labels are
placed live, nor react; *the name as the page's text with only small labels around* would
leave the logo out; *the WebAssembly engine* would add the module's download to the home
page; *a leader style per scene* is not in the problem format (one `leaders.style` per
problem), so the reader switches it for all; *small scenes of a map, a network and a chart*
(the first version) made the header look like a geographic library, and nobody moves a
lake; *a gentle idle motion* would make the labels move while being read.

### The example below the header
The page's one figure is a real chart that a reader recognizes, labeled with every main
feature at once: the world's economies as a bubble chart (Natural Earth, 2019; the
playground's `world.json`), every country a bubble sized by its GDP, drawn as an SVG and
handed to the engine as its background with CSS selector classes (grid lines ignored;
axes, their text and the legend hard). Every country has a label in the order of its GDP:
the largest set larger and bold (font classes), China's inside its bubble, the crowded
ones on leaders, long names falling back to their ISO code, and what does not fit left out
(strict priority; large economies' labels may cover small economies' bubbles at a cost).
`examples/showcase/make_showcase.py` writes the chart, the problem and the figure (solved
by the CLI, the text in embedded Noto Sans). It replaces the scatter plot of outliers
(still the subject of "Five lines" and its tutorial) and the grid of tutorial renderings
in their debugging colours, which the tutorials keep.

## Consequences
The home page leads with what the project does, shown and then told; the experimental
status moves from the top of the page to a section below (the announcement bar on every
page stays). The home page loads about 0.9 MB more, uncompressed (the engine's worker
and the font), after the page itself. The playground's browser tests cover the header
(on a page with its markup): the name keeps its place, no label overlaps another or the
text, the moon is labeled inside, the socks share a label, the donut's wraps, every leader
follows the style switched to, nothing moves while nobody interacts, a shuffle keeps the
pair together and the labels off the text, dragging, clicking and resetting work, and the
name comes back where it has no room.
