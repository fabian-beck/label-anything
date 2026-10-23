//! Obstacle preparation (spec §4): class policies, coverage grids with SATs, exact
//! primitive indexes and the distance transform of the static hard classes.

use crate::geom::{dist_point_seg, dist_seg_rect, polygon, seg_overlaps_rect, Rect, EPS, P};
use crate::grid::dt::{distance_transform, dt_maxima};
use crate::grid::raster::MaskRaster;
use crate::grid::regions::RegionMap;
use crate::grid::{Backdrop, GridSpec, Sat};
use crate::index::StaticIndex;
use crate::math::{maxf, minf};
use crate::model::{Model, Prim};
use serde_json::Value;
use std::collections::BTreeSet;

/// Interaction policy of one class with labels or leaders.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AvoidW {
    Hard,
    Ignore,
    Soft(f64),
}

impl AvoidW {
    pub fn parse(v: Option<&Value>) -> Option<AvoidW> {
        match v? {
            Value::String(s) if s == "hard" => Some(AvoidW::Hard),
            Value::String(s) if s == "ignore" => Some(AvoidW::Ignore),
            Value::Number(n) => {
                let w = n.as_f64().unwrap_or(0.0);
                Some(if w > 0.0 {
                    AvoidW::Soft(w)
                } else {
                    AvoidW::Ignore
                })
            }
            _ => None,
        }
    }
    #[inline]
    pub fn is_hard(self) -> bool {
        self == AvoidW::Hard
    }
    #[inline]
    pub fn weight(self) -> f64 {
        match self {
            AvoidW::Soft(w) => w,
            _ => 0.0,
        }
    }
}

/// Own-mark policy for external labels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OwnMark {
    Hard,
    Ignore,
    Partial(f64),
}

/// A static obstacle class.
#[derive(Clone, Debug)]
pub struct Class {
    pub name: String,
    pub label: AvoidW,
    pub leader: AvoidW,
    pub buffer: f64,
    pub relaxable: bool,
    /// Coverage grid (absent when the class never costs anything on the grid).
    pub sat: Option<Sat>,
    /// Exact primitives exist (vector classes).
    pub has_prims: bool,
    /// Raster coverage contributes (hard tests must use the grid).
    pub has_raster: bool,
}

/// Policies of the reserved dynamic classes.
#[derive(Clone, Copy, Debug)]
pub struct Dynamic {
    pub label_labels: AvoidW,
    pub label_items: AvoidW,
    /// Labels vs. the marks of items of lower priority key (`avoid.label.lower_items`, else
    /// `items`).
    pub label_lower: AvoidW,
    pub label_edge: AvoidW,
    pub leader_leaders: AvoidW,
    pub leader_labels: AvoidW,
    pub leader_items: AvoidW,
    /// Leaders vs. the marks of items of lower priority key (`avoid.leader.lower_items`,
    /// else `items`).
    pub leader_lower: AvoidW,
    /// `avoid.label.lower_items` is given and not hard: a label covering the mark of a
    /// less important item conflicts with that item's label.
    pub lower_cover: bool,
    pub buffer_items: f64,
    pub buffer_leaders: f64,
    pub buffer_labels: f64,
    pub own_mark: OwnMark,
}

/// Prepared static obstacles.
pub struct Obstacles {
    pub grid: GridSpec,
    pub classes: Vec<Class>,
    pub dynamic: Dynamic,
    /// Exact vector primitives (class index, primitive).
    pub prims: Vec<(usize, Prim)>,
    pub prim_index: StaticIndex,
    /// Item marks.
    pub item_index: StaticIndex,
    /// Cells inside item marks, when labels may overlap no mark at all (`label_items`,
    /// `label_lower` and the own-mark policy hard): quick, exact rejection of non-internal label boxes
    /// during candidate generation.
    pub item_occ: Option<crate::grid::occupancy::Occupancy>,
    /// Coverage of all item marks, and of each item's own mark on an aligned local grid
    /// (to exclude the own mark from `items` costs).
    pub items_sat: Sat,
    pub own: Vec<(GridSpec, Sat)>,
    /// The luma behind labels, for the `contrast` cost term (`None` without rasters, with
    /// `weights.contrast` 0, or when the backdrop is uniform).
    pub backdrop: Option<Backdrop>,
    /// The region map (`None` without regions, or when the region weights are all 0).
    pub regions: Option<RegionMap>,
    /// The home region of every item (0 = open; all 0 without a region map).
    pub home: Vec<u32>,
    /// Free space, computed on first use (see [`Obstacles::free_space`]).
    free: std::sync::OnceLock<FreeSpace>,
    pub label_area: Option<Rect>,
    pub leader_area: Option<Rect>,
    pub index_cell: f64,
}

/// The distance transform of the static hard obstacles and its local maxima, the
/// free-space seeds of distant candidates.
pub struct FreeSpace {
    /// Distance (px) from each cell center to the nearest static hard obstacle.
    pub dt: Vec<f64>,
    /// Local maxima of the distance transform: (cell center, clearance, col, row).
    pub seeds: Vec<(P, f64, usize, usize)>,
    pub seed_index: StaticIndex,
}

impl Obstacles {
    /// The free space of the obstacles prepared from `model`. Only free-space seeds of
    /// distant candidates need it, so it is computed on first use.
    pub fn free_space(&self, model: &Model) -> &FreeSpace {
        self.free.get_or_init(|| free_space(model, self))
    }

    /// Whether some relaxable class is hard (otherwise the `soft_overlap` ladder step
    /// cannot change anything: every relaxed-feasible candidate is feasible).
    pub fn any_relaxable_hard(&self) -> bool {
        self.classes
            .iter()
            .any(|c| c.relaxable && (c.label.is_hard() || c.leader.is_hard()))
    }
}

/// Most grid cells (spec §4.1): enough for any practical canvas, and SAT sums of `u8`
/// coverage stay exact (below 2³² / 255 ≈ 16.8 M cells).
pub const MAX_GRID_CELLS: f64 = 16_000_000.0;

/// Number of cells of the grid covering the model extent with cell size `c`.
pub fn grid_cells(model: &Model, c: f64) -> f64 {
    maxf((model.extent.w() / c).ceil(), 1.0) * maxf((model.extent.h() / c).ceil(), 1.0)
}

/// Choose the grid cell size (spec §4.1): `solver.grid_cell`, else `clamp(min_font / 4,
/// 1, 4)` grown (by factors of 1.25) until the grid has at most [`MAX_GRID_CELLS`] cells.
/// The extent must be finite; an explicit cell size may exceed the cell limit (checked
/// by the caller).
pub fn grid_cell(model: &Model, min_font: f64) -> f64 {
    match model.grid_cell {
        Some(c) if c > 0.0 => c,
        _ => {
            let mut c = (min_font / 4.0).clamp(1.0, 4.0);
            if grid_cells(model, c) > MAX_GRID_CELLS {
                c = maxf(
                    c,
                    (model.extent.w() * model.extent.h() / MAX_GRID_CELLS).sqrt(),
                );
                while grid_cells(model, c) > MAX_GRID_CELLS {
                    c *= 1.25;
                }
            }
            c
        }
    }
}

pub fn prepare(model: &Model, min_font: f64) -> Obstacles {
    let cell = grid_cell(model, min_font);
    let grid = GridSpec::covering(&model.extent, cell);
    // class names
    let mut names: BTreeSet<String> = BTreeSet::new();
    for (c, _) in &model.vector {
        if !names.contains(&**c) {
            names.insert(c.to_string());
        }
    }
    let mut raster_cov: Vec<(String, Vec<u8>)> = Vec::new();
    let rgrid = la_raster::GridSpec {
        origin_x: grid.ox,
        origin_y: grid.oy,
        cell: grid.cell,
        cols: grid.cols,
        rows: grid.rows,
    };
    for r in &model.rasters {
        let place = la_raster::RasterPlacement {
            scale: r.opts.scale,
            offset: [r.opts.offset.x, r.opts.offset.y],
        };
        for cc in la_raster::process(&r.img, &r.opts.mode, &r.opts.class, &place, &rgrid) {
            if cc.class != "ignore" && cc.coverage.len() == grid.cells() {
                names.insert(cc.class.clone());
                raster_cov.push((cc.class, cc.coverage));
            }
        }
    }
    let backdrop = if model.weights.contrast > 0.0 && !model.rasters.is_empty() {
        let layers: Vec<(&la_raster::Rgba, la_raster::RasterPlacement)> = model
            .rasters
            .iter()
            .map(|r| {
                (
                    &r.img,
                    la_raster::RasterPlacement {
                        scale: r.opts.scale,
                        offset: [r.opts.offset.x, r.opts.offset.y],
                    },
                )
            })
            .collect();
        let bg = Backdrop::grid_of(&grid);
        let bgrid = la_raster::GridSpec {
            origin_x: bg.ox,
            origin_y: bg.oy,
            cell: bg.cell,
            cols: bg.cols,
            rows: bg.rows,
        };
        Backdrop::new(
            bg,
            &la_raster::backdrop_luma(&layers, model.background, &bgrid),
        )
    } else {
        None
    };
    // the region map and the home of every item (spec §4.8)
    let w = &model.weights;
    let regions = if w.straddle > 0.0 || w.foreign > 0.0 || w.leader_borders > 0.0 {
        RegionMap::new(grid, &model.region_fills)
    } else {
        None
    };
    let home: Vec<u32> = match &regions {
        Some(rm) => model
            .items
            .iter()
            .map(|it| {
                match it
                    .region
                    .as_ref()
                    .and_then(|name| model.region_ids.get(name))
                {
                    Some(&r) => r,
                    None => rm.home(it.shape.reference(), &it.shape.bbox()),
                }
            })
            .collect(),
        None => vec![0; model.items.len()],
    };
    names.remove("ignore");
    names.remove("items");
    names.remove("labels");
    names.remove("leaders");
    names.remove("canvas_edge");
    let pol = |map: &serde_json::Map<String, Value>, k: &str| -> AvoidW {
        AvoidW::parse(map.get(k))
            .or_else(|| AvoidW::parse(map.get("*")))
            .unwrap_or(AvoidW::Soft(1.0))
    };
    let buf = |k: &str| {
        model
            .avoid_buffer
            .get(k)
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0)
    };
    let mut classes: Vec<Class> = names
        .iter()
        .map(|n| Class {
            name: n.clone(),
            label: pol(&model.avoid_label, n),
            leader: pol(&model.avoid_leader, n),
            buffer: buf(n),
            relaxable: model.relaxable.iter().any(|r| r == n),
            sat: None,
            has_prims: false,
            has_raster: false,
        })
        .collect();
    let class_of = |n: &str, classes: &[Class]| classes.iter().position(|c| c.name == n);
    // collect the exact primitives of the classes that matter, then rasterize them per
    // class into masks
    let mut prims = Vec::new();
    // consecutive primitives mostly share their class (and its name)
    let mut last: Option<(&std::sync::Arc<str>, Option<usize>)> = None;
    for (cname, prim) in &model.vector {
        let ci = match last {
            Some((n, ci)) if std::sync::Arc::ptr_eq(n, cname) => ci,
            _ => class_of(cname, &classes),
        };
        last = Some((cname, ci));
        let Some(ci) = ci else {
            continue;
        };
        let c = &classes[ci];
        if c.label == AvoidW::Ignore && c.leader == AvoidW::Ignore && c.buffer == 0.0 {
            continue;
        }
        prims.push((ci, prim.clone()));
    }
    for (ci, m) in rasterize_classes(grid, classes.len(), &prims)
        .into_iter()
        .enumerate()
    {
        if let Some(m) = m {
            classes[ci].has_prims = true;
            classes[ci].sat = Some(Sat::from_coverage(grid.cols, grid.rows, &m.into_coverage()));
        }
    }
    // merge raster coverage (max with vector coverage)
    for (cname, cov) in raster_cov {
        let Some(ci) = class_of(&cname, &classes) else {
            continue;
        };
        classes[ci].has_raster = true;
        let merged: Vec<u8> = match &classes[ci].sat {
            Some(s) => (0..grid.cells())
                .map(|i| s.cell(i % grid.cols, i / grid.cols).max(cov[i]))
                .collect(),
            None => cov,
        };
        classes[ci].sat = Some(Sat::from_coverage(grid.cols, grid.rows, &merged));
    }
    // dynamic/reserved policies
    let own_mark = match model.avoid_label.get("own_mark") {
        Some(Value::String(s)) if s == "ignore" => OwnMark::Ignore,
        Some(Value::String(s)) if s.starts_with("partial:") => {
            OwnMark::Partial(s[8..].parse().unwrap_or(0.0))
        }
        _ => OwnMark::Hard,
    };
    // lower_items: the policy for the marks of less important items, `items` when not given
    let lower = |map: &serde_json::Map<String, Value>| -> AvoidW {
        AvoidW::parse(map.get("lower_items")).unwrap_or_else(|| pol(map, "items"))
    };
    let dynamic = Dynamic {
        label_labels: pol(&model.avoid_label, "labels"),
        label_items: pol(&model.avoid_label, "items"),
        label_lower: lower(&model.avoid_label),
        label_edge: if model.label_area.is_some() {
            pol(&model.avoid_label, "canvas_edge")
        } else {
            AvoidW::Ignore
        },
        leader_leaders: pol(&model.avoid_leader, "leaders"),
        leader_labels: pol(&model.avoid_leader, "labels"),
        leader_items: pol(&model.avoid_leader, "items"),
        leader_lower: lower(&model.avoid_leader),
        lower_cover: !matches!(
            AvoidW::parse(model.avoid_label.get("lower_items")),
            None | Some(AvoidW::Hard)
        ),
        buffer_items: buf("items"),
        buffer_leaders: buf("leaders"),
        buffer_labels: buf("labels"),
        own_mark,
    };
    // indexes
    let n_items = model.items.len().max(1) as f64;
    let ext_area = maxf(model.extent.area(), 1.0);
    let index_cell = (ext_area / n_items).sqrt().clamp(16.0, 128.0);
    let prim_index = StaticIndex::new(
        prims.iter().map(|(_, p)| p.bbox()).collect(),
        &model.extent,
        index_cell,
    );
    let item_index = StaticIndex::new(
        model.items.iter().map(|it| it.shape.bbox()).collect(),
        &model.extent,
        index_cell,
    );
    // items coverage (global and per item)
    let mut all_items = MaskRaster::new(grid);
    for it in &model.items {
        all_items.shape(&it.shape);
    }
    let own = crate::par::map(model.items.len(), |i| {
        let it = &model.items[i];
        let (c0, c1, r0, r1) = grid.cell_range(&it.shape.bbox().inflate(cell));
        let local = GridSpec {
            ox: grid.ox + c0 as f64 * cell,
            oy: grid.oy + r0 as f64 * cell,
            cell,
            cols: (c1 - c0).max(1),
            rows: (r1 - r0).max(1),
        };
        let mut m = MaskRaster::new(local);
        m.shape(&it.shape);
        (
            local,
            Sat::from_coverage(local.cols, local.rows, &m.into_coverage()),
        )
    });
    let items_sat = Sat::from_coverage(grid.cols, grid.rows, &all_items.into_coverage());
    let item_occ = if dynamic.label_items.is_hard()
        && dynamic.label_lower.is_hard()
        && dynamic.own_mark == OwnMark::Hard
    {
        let mut occ = crate::grid::occupancy::Occupancy::new(&model.extent);
        for it in &model.items {
            occ.mark_shape(&it.shape);
        }
        // static from here on: O(1) window queries
        occ.freeze();
        (!occ.is_empty()).then_some(occ)
    } else {
        None
    };
    Obstacles {
        grid,
        classes,
        dynamic,
        prims,
        prim_index,
        item_index,
        item_occ,
        items_sat,
        own,
        backdrop,
        regions,
        home,
        free: std::sync::OnceLock::new(),
        label_area: model.label_area,
        leader_area: model.leader_area,
        index_cell,
    }
}

/// Distance transform of the static hard obstacles (incl. item marks when labels must
/// avoid them, and the outside of the label area) and its local maxima.
fn free_space(model: &Model, obs: &Obstacles) -> FreeSpace {
    let (grid, classes, dynamic, index_cell) =
        (obs.grid, &obs.classes, &obs.dynamic, obs.index_cell);
    let mut hard_mask = MaskRaster::new(grid);
    if dynamic.label_items.is_hard() {
        for it in &model.items {
            hard_mask.shape(&it.shape);
        }
    }
    let hard_cov = hard_mask.into_coverage();
    let hard_classes: Vec<usize> = (0..classes.len())
        .filter(|&i| classes[i].label.is_hard())
        .collect();
    let la = model.label_area;
    // on a region map, the free space is the open space (spec §4.8): seeds lie in the sea
    let regions = obs.regions.as_ref().map(|rm| &rm.ids);
    let dt = distance_transform(&grid, |i| {
        if hard_cov[i] > 0 || regions.is_some_and(|ids| ids[i] != 0) {
            return true;
        }
        let (c, r) = (i % grid.cols, i / grid.cols);
        for &k in &hard_classes {
            if let Some(s) = &classes[k].sat {
                if s.cell(c, r) > 0 {
                    return true;
                }
            }
        }
        match la {
            Some(a) => !a.contains_point(grid.cell_center(c, r)),
            None => false,
        }
    });
    let seeds = dt_maxima(&grid, &dt, model.default_em * 0.4);
    let seed_index = StaticIndex::new(
        seeds
            .iter()
            .map(|s| Rect::from_center(s.0, 0.0, 0.0))
            .collect(),
        &model.extent,
        index_cell * 2.0,
    );
    FreeSpace {
        dt,
        seeds,
        seed_index,
    }
}

/// Masks of the classes `0..n_classes` from their primitives (`None` for a class without
/// any). Rasterizing only sets bits, so chunks of primitives are rasterized into masks of
/// their own (in parallel with the `parallel` feature) and merged by bitwise or: the
/// result does not depend on the split.
fn rasterize_classes(
    grid: GridSpec,
    n_classes: usize,
    prims: &[(usize, Prim)],
) -> Vec<Option<MaskRaster>> {
    let chunks = crate::par::threads().min(prims.len() / 2048).max(1);
    let len = prims.len().div_ceil(chunks).max(1);
    let parts = crate::par::map(chunks, |k| {
        let mut masks: Vec<Option<MaskRaster>> = (0..n_classes).map(|_| None).collect();
        for (ci, p) in &prims[(k * len).min(prims.len())..((k + 1) * len).min(prims.len())] {
            rasterize_prim(masks[*ci].get_or_insert_with(|| MaskRaster::new(grid)), p);
        }
        masks
    });
    let mut out: Vec<Option<MaskRaster>> = (0..n_classes).map(|_| None).collect();
    for part in parts {
        for (ci, m) in part.into_iter().enumerate() {
            if let Some(m) = m {
                match &mut out[ci] {
                    Some(o) => o.or_from(&m),
                    None => out[ci] = Some(m),
                }
            }
        }
    }
    out
}

fn rasterize_prim(m: &mut MaskRaster, p: &Prim) {
    match p {
        Prim::Disc { c, r } => m.disc(*c, *r),
        Prim::Rect(r) => m.rect(r.x0, r.y0, r.x1, r.y1),
        Prim::Polygon {
            rings, even_odd, ..
        } => m.polygon(rings, *even_odd),
        Prim::Polyline { points, hw, closed } => {
            let n = points.len();
            if n == 1 {
                m.disc(points[0], *hw);
            }
            for i in 0..n.saturating_sub(1) {
                m.capsule(points[i], points[i + 1], *hw);
            }
            if *closed && n > 2 {
                m.capsule(points[n - 1], points[0], *hw);
            }
        }
        Prim::Shape(s) => m.shape(s),
    }
}

impl Prim {
    /// The open rectangle overlaps the primitive's interior.
    pub fn overlaps_rect(&self, r: &Rect) -> bool {
        match self {
            Prim::Disc { c, r: rad } => {
                if *rad <= EPS {
                    r.inflate(-EPS).contains_point(*c)
                } else {
                    r.dist_point(*c) < rad - EPS
                }
            }
            Prim::Rect(b) => b.overlaps(r),
            Prim::Polygon {
                rings,
                even_odd,
                bbox,
            } => polygon::overlaps_rect(rings, *even_odd, bbox, r),
            Prim::Polyline { points, hw, closed } => {
                let n = points.len();
                let segs = n.saturating_sub(1) + if *closed && n > 2 { 1 } else { 0 };
                for i in 0..segs {
                    let a = points[i];
                    let b = points[(i + 1) % n];
                    if *hw <= EPS {
                        if seg_overlaps_rect(a, b, r) {
                            return true;
                        }
                    } else if dist_seg_rect(a, b, r) < hw - EPS {
                        return true;
                    }
                }
                n == 1 && r.dist_point(points[0]) < hw - EPS
            }
            Prim::Shape(s) => s.overlaps_rect(r),
        }
    }

    /// Distance between segment `ab` and the primitive (0 if they intersect).
    pub fn dist_segment(&self, a: P, b: P) -> f64 {
        match self {
            Prim::Disc { c, r } => maxf(dist_point_seg(*c, a, b) - r, 0.0),
            Prim::Rect(rect) => dist_seg_rect(a, b, rect),
            Prim::Polygon {
                rings, even_odd, ..
            } => {
                if polygon::contains(rings, *even_odd, a) || polygon::contains(rings, *even_odd, b)
                {
                    return 0.0;
                }
                let mut m = f64::INFINITY;
                for (p, q) in polygon::edges(rings) {
                    m = minf(m, crate::geom::seg_seg_dist(a, b, p, q));
                }
                m
            }
            Prim::Polyline { points, hw, closed } => {
                let n = points.len();
                let segs = n.saturating_sub(1) + if *closed && n > 2 { 1 } else { 0 };
                let mut m = f64::INFINITY;
                for i in 0..segs {
                    m = minf(
                        m,
                        crate::geom::seg_seg_dist(a, b, points[i], points[(i + 1) % n]),
                    );
                }
                if n == 1 {
                    m = dist_point_seg(points[0], a, b);
                }
                maxf(m - hw, 0.0)
            }
            Prim::Shape(s) => s.dist_segment(a, b),
        }
    }
}

impl Obstacles {
    /// Covered area (px²) of `r` by the marks of all items except `i`.
    pub fn other_items_covered(&self, i: usize, r: &Rect) -> f64 {
        let all = self.items_sat.covered_area(&self.grid, r);
        if all <= 0.0 {
            return 0.0;
        }
        let (g, s) = &self.own[i];
        maxf(all - s.covered_area(g, r), 0.0)
    }

    /// Covered area (px²) of `r` by the mark of item `j`.
    pub fn own_covered(&self, j: usize, r: &Rect) -> f64 {
        let (g, s) = &self.own[j];
        s.covered_area(g, r)
    }

    /// Mean class coverage (0..1) sampled along segment `ab` once per cell length, times
    /// the length.
    pub fn covered_len(&self, sat: &Sat, a: P, b: P) -> f64 {
        let len = a.dist(b);
        if len <= 0.0 || !sat.nonempty {
            return 0.0;
        }
        let step = self.grid.cell;
        let n = ((len / step).ceil() as usize).max(1);
        // only the samples that can fall on the grid (the others never count; the margin
        // of one cell absorbs rounding)
        let g = &self.grid;
        let area = Rect {
            x0: g.ox,
            y0: g.oy,
            x1: g.ox + g.cols as f64 * step,
            y1: g.oy + g.rows as f64 * step,
        }
        .inflate(step);
        let (k0, k1) = crate::geom::sample_range_in_rect(a, b, n, &area);
        let mut acc = 0.0;
        for k in k0..k1 {
            let p = a.lerp(b, (k as f64 + 0.5) / n as f64);
            let (u, v) = self.grid.to_cell(p);
            if u >= 0.0 && v >= 0.0 && u < self.grid.cols as f64 && v < self.grid.rows as f64 {
                acc += sat.cell(u as usize, v as usize) as f64 / 255.0;
            }
        }
        acc * len / n as f64
    }
}
