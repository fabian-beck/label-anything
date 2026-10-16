# ggrepel (geom_text_repel) run on one benchmark scene; final label positions are read back
# from the drawn grob tree.
#
#   FONTCONFIG_FILE=... Rscript bench/baselines/ggrepel.R scene.json out.json
#
# scene.json is written by bench/baselines/ggrepel_baseline.py: canvas size, label area, the
# labels in priority order (anchor, text, font size, label box w x h, point size) and the
# obstacle points, in canvas px with y flipped (y up). Method:
#
# * Device: png(type = "cairo") of W x H bigpts at res = 288 (4 device px per canvas px), so
#   1 canvas px = 1/72 in = 1 R "point"; Pango measures the bundled Noto Sans (registered
#   through FONTCONFIG_FILE) with 1/4 px granularity.
# * Plot: theme_void(), no margins, coord_cartesian(0..W, 0..H, expand = FALSE): the panel is
#   the canvas and data units are canvas px. One geom_text_repel layer holds the labels (in
#   priority order: earlier rows win max.overlaps) followed by the obstacle points with empty
#   labels (repelled from, never labeled). size = font px / .pt, point.size from the mark
#   radius (the geom_point size of a circle of that radius), point.padding = the problem's
#   offset, xlim / ylim = the label area, seed fixed, max.iter (default 10000) with a generous
#   max.time so the iteration cap binds; other parameters default.
# * box.padding: ggrepel's box is the text grob's extent (string width x ascent of 'M') plus
#   box.padding on every side. It is set to the smallest value for which every ggrepel box
#   contains the problem's label box (centred), so a label overlap the evaluator finds is also
#   an overlap of ggrepel's own boxes.
# * Extraction: ggplotGrob -> grid.force() (this runs makeContent.textrepeltree, i.e. the
#   repulsion; it is the timed part) -> draw the forced tree -> for every grob named
#   textrepelgrob<i> (i = row among the labeled rows) and segmentrepelgrob<i>, go to its
#   viewport and convert x / y (and the segment end points) with deviceLoc() to inches,
#   i.e. canvas px / 72. Labels without a textrepelgrob were dropped (max.overlaps).
suppressPackageStartupMessages({
  library(ggplot2)
  library(ggrepel)
  library(grid)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 2) stop("usage: Rscript ggrepel.R scene.json out.json")
sc <- fromJSON(args[1], simplifyVector = TRUE)
W <- sc$width
H <- sc$height
RES <- sc$res
K <- RES / 72
L <- as.data.frame(sc$labels)
n <- nrow(L)
P <- if (length(sc$points) > 0) as.data.frame(sc$points) else data.frame(x = numeric(0), y = numeric(0), r = numeric(0))

# geom_point size whose pch 19 circle has radius r bigpts: r = 0.375 * size * .pt
psize <- function(r) pmax(r, 0) / (0.375 * .pt)

png(tempfile(fileext = ".png"), width = ceiling(W * K), height = ceiling(H * K), units = "px", res = RES,
    type = "cairo")
pushViewport(viewport(xscale = c(0, W), yscale = c(0, H)))
ext <- t(vapply(seq_len(n), function(i) {
  tg <- textGrob(L$text[i], x = unit(W / 2, "native"), y = unit(H / 2, "native"),
                 gp = gpar(fontsize = L$size[i], fontfamily = sc$family, fontface = L$face[i]))
  c(convertWidth(grobWidth(tg), "bigpts", TRUE), convertHeight(grobHeight(tg), "bigpts", TRUE))
}, numeric(2)))
if (n == 1) ext <- matrix(ext, nrow = 1)
bp <- if (n > 0) max(0, max((L$w - ext[, 1]) / 2), max((L$h - ext[, 2]) / 2)) else 0
popViewport()

rows <- data.frame(
  x = c(L$x, P$x), y = c(L$y, P$y), label = c(L$text, rep("", nrow(P))),
  size = c(L$size / .pt, rep(1, nrow(P))), face = c(L$face, rep(1L, nrow(P))),
  point.size = psize(c(L$r, P$r)), stringsAsFactors = FALSE
)
a <- sc$area
p <- ggplot(rows, aes(x = x, y = y, label = label)) +
  geom_text_repel(aes(size = size, fontface = face, point.size = point.size),
                  family = sc$family, box.padding = unit(bp, "bigpts"),
                  point.padding = unit(sc$point_padding, "bigpts"), seed = sc$seed,
                  max.iter = sc$max_iter, max.time = sc$max_time, max.overlaps = sc$max_overlaps,
                  xlim = c(a[1], a[3]), ylim = c(a[2], a[4]), show.legend = FALSE) +
  scale_size_identity() +
  coord_cartesian(xlim = c(0, W), ylim = c(0, H), expand = FALSE) +
  theme_void() +
  theme(plot.margin = margin(0, 0, 0, 0), legend.position = "none")

g <- ggplotGrob(p)
t0 <- proc.time()[["elapsed"]]
fg <- grid.force(g)
runtime <- (proc.time()[["elapsed"]] - t0) * 1000
grid.newpage()
grid.draw(fg)

at <- function(pth, fn) {
  depth <- downViewport(attr(pth, "vpPath"))
  on.exit(upViewport(depth))
  fn(grid.get(pth))
}
inch <- function(x, y) {
  d <- deviceLoc(x, y, valueOnly = TRUE)
  c(d$x * 72, d$y * 72)
}
idx <- function(name, prefix) as.integer(sub(prefix, "", name))
# grid.grep also returns the children of matching grobs: keep the paths whose last name matches
named <- function(pattern) {
  Filter(function(p) grepl(pattern, p$name), grid.grep(pattern, grep = TRUE, global = TRUE, viewports = TRUE))
}

out <- vector("list", 0)
for (pth in named("^textrepelgrob[0-9]+$")) {
  r <- at(pth, function(gr) {
    c(inch(gr$x, gr$y), inch(grobX(gr, "west"), grobY(gr, "south")), inch(grobX(gr, "east"), grobY(gr, "north")))
  })
  i <- idx(pth$name, "textrepelgrob")
  out[[length(out) + 1]] <- list(i = i, x = r[1], y = r[2], west = r[3], south = r[4], east = r[5], north = r[6])
}
segs <- vector("list", 0)
for (pth in named("^segmentrepelgrob[0-9]+$")) {
  # a forced curveGrob (curvature 0) is a gTree with one segments child: (x0, y0) on the text box, (x1, y1)
  # next to the data point
  r <- at(pth, function(gr) {
    s <- if (inherits(gr, "segments")) gr else Find(function(ch) inherits(ch, "segments"), gr$children)
    if (is.null(s)) NULL else c(inch(s$x0, s$y0), inch(s$x1, s$y1))
  })
  if (!is.null(r)) {
    segs[[length(segs) + 1]] <- list(i = idx(pth$name, "segmentrepelgrob"), x1 = r[1], y1 = r[2], x2 = r[3], y2 = r[4])
  }
}
invisible(dev.off())

res <- list(
  versions = list(R = paste(R.version$major, R.version$minor, sep = "."),
                  ggrepel = as.character(packageVersion("ggrepel")),
                  ggplot2 = as.character(packageVersion("ggplot2")),
                  jsonlite = as.character(packageVersion("jsonlite"))),
  runtime_ms = runtime, box_padding = bp, labels = out, segments = segs
)
writeLines(toJSON(res, auto_unbox = TRUE, digits = NA), args[2])
