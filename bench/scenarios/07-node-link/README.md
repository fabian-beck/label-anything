# 07 — Node-link diagrams

**What.** Labeled node-link diagrams: the Les Misérables character co-occurrence network
(77 nodes, 254 edges) and the largest connected component of the Cora citation network
(2,485 papers, 5,069 citation links).

**Why.** Labels must avoid nodes (items) and, softly, edges; node shapes vary (circles,
UML-like rounded rectangles that hold their label inside, ER-like ellipses); leaders are
octilinear (`angles`, preset `graph`).

**Layout.** networkx `forceatlas2_layout` with strong gravity (gravity 0.05) and seed 7
(Les Mis: 600 iterations, unweighted, node sizes 3 + 1.5·sqrt(degree) for overlap
prevention; Cora: 300 iterations), rotated about the centroid so that the principal axis
is horizontal, scaled uniformly into the canvas with a margin, then freed of node
overlaps: overlapping node boxes (Les Mis: the larger node of the two configs) move
apart along the axis of the smaller overlap until 2 px separate them. The earlier
`spring_layout` drew Cora as one dense disc (74 of 150 labels placed, 1,874 overlapping
node pairs); this layout separates its communities (148 of 150, about 2.5 min of layout
time). Edges are straight center-to-center segments: `obstacles.vector` polylines of
class `lines` (0.8 px; Cora 0.6 px).

**Configs** (preset `graph`):

| config | items | node shapes | notes |
|---|---|---|---|
| `lesmis-circles` (quick) | 77 (all) | circles r = 3 + 1.5·sqrt(degree) | canvas 1000 × 760, font 10 px, priority = degree |
| `lesmis-shapes` | 77 | degree ≥ 8: rounded rect (text width + 16) × 24, corner radius 4 (label fits inside); else ellipse rx = 5 + 1.5·sqrt(degree), ry = 0.65·rx | internal labels for rects (policy `auto`) |
| `cora-circles` | 150 most cited papers, label = paper id (alternative: its last 4 digits); topic in `attrs` | circles r = 1.5 + 0.8·sqrt(degree) | canvas 1600 × 1200, font 9 px; the 2,335 other papers are **hard** `nodes` obstacles; priority = log citations |
