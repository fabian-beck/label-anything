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
* **The logo is the demo.** The home page has its own template (`home.html`): a header
  whose logo is drawn large, with the name on its label. A script makes it live: the name
  is one item among small scenes of what the engine labels, placed by the engine while
  the reader plays with them:
  * a map: a lake (an area, labeled inside), a river (an obstacle), five cities in a
    cluster with type sized by importance, map pins (icon marks with a silhouette) whose
    labels are composites of an icon and a text, an airport name with shorter
    alternatives, and five districts too close together to label beside them (leaders,
    or left out);
  * a network: a hub labeled inside, nodes of several shapes (circle, diamond, rotated
    rectangles) labeled on pills, edges as obstacles;
  * a chart: unlabeled points and a trend line as soft obstacles, an outlier, a callout
    wrapped into two lines on a leader, three points that share one label (a group);
  * Saturn (an ellipse) and Polaris (a star polygon) above.

  Labels keep off the header's text (its lines, the language chips, the buttons and the
  hint are rectangles of class `text`), each other and what is hard for them. Things and
  labels can be dragged, a click adds another (a pin, a city, a star, a node), the leader
  style can be switched (straight, elbow, curved), *Reset* restores the start, and
  hovering a label or a mark tells how its label was placed or why it was left out, from
  the result (`model`, `anchor_side`, `members`, the text `used`, `reason`, `blocked_by`).
  The name's item has only the `distant` model, so it keeps its leader wherever it goes,
  and is `required` with the highest priority; it may cover the marks of other items
  (`lower_items`), which then lose their labels. Where it finds no place at all, its dot
  glides back, once let go, to where it last had one: the name always shows.
* **Room for the scenes.** On wide headers the scenes stand beside the text; below
  1100 px the header grows a strip below the buttons for the map (and the network, from
  620 px), the CSS saying which (`--la-hero-layout`). The things a scene starts with keep
  clear of the text and the logo; dragged ones stop at the text's edge.
* **Static first.** The logo is HTML and SVG in the template. The script reads the
  label's and the dot's boxes from the page and passes them as the name's `warm_start`,
  so the first live solve keeps the name exactly where the static logo has it (the
  browser test checks it to the pixel), and the drawing takes over without a jump.
* **The playground's engine.** The script is built with the playground (`dist/hero.js`,
  about 40 KB) and solves with its TypeScript worker (`engine-ts.js`), which the
  playground's visitors have in their cache anyway; the home page loads it from
  `playground/`. Without the playground next to the site (`mkdocs serve`) the static logo
  stays.
* **Fonts.** The engine measures the scenes' labels with its bundled Noto Sans (so
  wrapping and alternatives work), and the header draws them with the same font file,
  loaded from the playground. The name is drawn in the page's own font: the browser
  measures it and passes its `width` and `height`, and its box is the static label's box.
* **Small budgets, fewer candidates.** 10 ms at rest, 4 ms while dragging (the Rust
  core's, as in the playground), with fewer candidates than the defaults (2 slider
  positions per quadrant, 3 rings × 12 directions of distant ones, no free-space seeds, a
  6 px grid): about 800 candidates became about 200 and a solve of the 30 items takes
  30–40 ms in TypeScript instead of 60–90, for a layout of about the same cost. The hint
  counts the labels placed and left out, not the time, which depends on the reader's
  device more than on the engine.

Considered and rejected: *a recording or an animation* would not show that the labels are
placed live, nor react; *the name as the page's text with only small labels around* would
leave the logo out; *the WebAssembly engine* would add the module's download to the home
page; *a leader style per scene* is not in the problem format (one `leaders.style` per
problem), so the reader switches it for all.

## Consequences
The home page leads with what the project does, shown and then told; the experimental
status moves from the top of the page to a section below (the announcement bar on every
page stays). The home page loads about 0.9 MB more, uncompressed (the engine's worker
and the font), after the page itself. The playground's browser tests cover the header
(on a page with its markup): the name keeps its place, no label overlaps another or the
text, the lake and the hub are labeled inside, the sensors share a label, the pins'
labels have an icon, the callout wraps, every leader follows the style switched to,
dragging, clicking and resetting work, and the name comes back where it has no room.
