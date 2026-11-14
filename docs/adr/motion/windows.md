# Windows

With `canvas.overscan` the canvas is a window on a larger drawing: labels are placed as
if the drawing went on beyond its edges, so a label at the border of a view that pans and
zooms keeps its place and is cut there.

## Context
A canvas keeps its labels inside (`canvas_edge`, hard). That suits a chart, whose edge is
the edge of the picture. The view of a map is not such an edge: the map goes on, and
whoever wants to see more pans. There the rule made the labels at the border the most
restless ones of the view:

- a label changed sides as its point came near the edge, since half of its places left
  the canvas;
- hosts passed only the points in view, so a label went with its point while half of it
  still showed, and one coming in had to find a place among labels placed without it;
- the map examples cut each country to the part in view, and the name went there: the
  pole of the cut polygon moved with the view, and the name with the pole.

On a pan over 600 points (a view of 800 × 600 px, 160 steps of 6 px, warm-started), 10.2 %
of the labels within 60 px of the border changed their place beside their point at each
step, against 0.6 % elsewhere; 24 of them jumped by more than 1 em, and 79 labels went
while still in view. In the playground's world map at zoom 9, 82 % of the names at the
border moved on the map at each pan step of 30 px.

## Decision
- **`canvas.overscan`** (a length; `null`, the default: labels stay inside the canvas).
  The working extent is the canvas grown by the overscan: the grids cover it, and what
  lies there is solved like what is in view. The canvas bounds neither labels nor leaders.
  The host passes the items up to there and cuts what it draws at the edge.
- **`canvas.region` bounds the labels of a window**: the bounds of the whole drawing in
  canvas coordinates, larger than the canvas as a rule. A map that ends somewhere keeps
  its names inside, and at the view of the whole map the labels are those of a canvas.
  Without a region there is no label area: no `canvas_edge` class, no edge term.
- **Areas are passed whole.** The pole, the grid of places and the main axis belong to the
  polygon, not to the view, so a name has its place in the country. For the work to keep
  to the view, the grid's places are those whose label box touches the working extent,
  besides the pole, and they are tested against the polygon cut to the surroundings of
  the extent: the same containment, and the same room up to the 1 em that counts
  (spec §6.5).
- **The map helpers are windows.** Leaflet, MapLibre and sigma label the points up to
  `overscan` px beyond the view, 8 times the font size unless set, and pass it on;
  `overscan: false` gives the labels of a canvas. Their overlays are cut by the map's
  own element.
- **The examples**: the playground's world map and the home page's map of Europe pass
  whole countries and the region of the map; Europe at the whole map is the problem of
  the static figure, a canvas. The world map no longer takes the controls drawn over it
  as obstacles, which pushed labels around like a border, sizes the names by their rank
  among all countries instead of `priority.font_classes`, which ranks the items of each
  problem, and moves the previous labels with the map for the warm start instead of
  leaving that to each country's pole of the moment.

## Consequences
On the pan over 600 points, 2.2 % of the labels at the border change their place per
step (1.3 % elsewhere), none jumps, none goes while in view; with 1,500 points 12.1 %
against 11.2 % elsewhere (contained: 21.3 % against 8.0 %), 15 jumps instead of 182. In
the world map at zoom 9, 4.6 % of the names at the border move on the map per step instead
of 82 %, with 2 jumps of more than 12 px over 24 steps instead of 156; in the map of
Europe at zoom 3, about 1 % instead of 33 %. What still moves does so as labels in the
middle of the view do.

It costs the labels of the overscan: 96 px around 800 × 600 px are three quarters more
items, and a solve of the world map takes 45 ms instead of 25 ms in TypeScript. The
counts of a result include them. A label can show a few pixels only, and the name of a
country far larger than the view is out of view unless its pole is in it: 18 names instead
of 24 show in the world map at zoom 9. `priority.budget.max_ink_fraction` is a fraction of
the working extent. The label of an area 40 times the view takes 10 ms instead of 1.5 s
(Rust); the tests of a place skip the edges farther away than 1 em, which halves the
candidate phase of every problem with areas and changes no result. Without `overscan`
nothing changes.

## Alternatives
- **`allow_outside`**: no edge either, but the grids end at the canvas, so coverage costs
  and free-space seeds do not see the overscan, a region bounds nothing, and whole areas
  cost their size.
- **A soft `canvas_edge`**: the label still changes sides, a little later.
- **A canvas larger than the view**, with every coordinate shifted by the host: the same
  placements (a test holds the two equal), but the host shifts problem and result, and the
  default focus, the boundary sides and raster backgrounds refer to the wrong rectangle.
- **Cutting areas to the view in the host**, as the examples did: fast, but the pole is
  that of the part in view. A pole given with the item would steady it, at the price of
  hosts computing poles.
- **Passing every item and letting the engine drop those out of reach**: each solve would
  read the whole data set.
