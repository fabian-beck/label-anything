//! Candidate generation (spec §6): adjacent, slider, internal (distant and boundary
//! candidates live in `leaders.rs` / `boundary.rs`).

use crate::geom::shape::{sign_dir, Shape};
use crate::geom::{dist_point_seg, Rect, P};
use crate::labels::Variant;
use crate::math::{maxf, sin_cos_deg};
use crate::model::opts::{InternalPolicy, LeaderStyle, Models, Pos};
use crate::model::Item;

/// Candidate model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Adjacent,
    Slider,
    Internal,
    Distant,
    Boundary,
    Fan,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Adjacent => "adjacent",
            Kind::Slider => "slider",
            Kind::Internal => "internal",
            Kind::Distant => "distant",
            Kind::Boundary => "boundary",
            Kind::Fan => "fan",
        }
    }
}

/// Reported anchor side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Pos(Pos),
    Internal,
    Distant,
    Boundary,
    Fan,
}

impl Side {
    pub fn name(self) -> &'static str {
        match self {
            Side::Pos(p) => p.name(),
            Side::Internal => "internal",
            Side::Distant => "distant",
            Side::Boundary => "boundary",
            Side::Fan => "fan",
        }
    }
}

/// Why a candidate is infeasible.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Block {
    Edge,
    Items,
    Labels,
    Leaders,
    /// A label too much in other items' regions (`placement.max_foreign`).
    Regions,
    /// A static obstacle class (index into `Obstacles::classes`).
    Class(u16),
}

/// A leader polyline from the item to the label's port.
#[derive(Clone, Debug, PartialEq)]
pub struct Leader {
    /// From the item (boundary + gap, or tip) to the port.
    pub pts: Vec<P>,
    pub port: P,
    pub style: LeaderStyle,
    pub bends: u8,
    pub len: f64,
    /// Underline below the first text line (port = baseline).
    pub underline: Option<(P, P)>,
    /// Quadratic Bézier control points for curved leaders: (start, control, end).
    pub curve: Option<[P; 3]>,
    /// For fan leaders: which member the leader points to.
    pub member: Option<u32>,
    /// A stub (spec §6.9): the short leader of an adjacent or slider label near other
    /// marks.
    pub stub: bool,
}

impl Leader {
    pub fn new(pts: Vec<P>, style: LeaderStyle) -> Leader {
        let mut len = 0.0;
        for w in pts.windows(2) {
            len += w[0].dist(w[1]);
        }
        let bends = pts.len().saturating_sub(2) as u8;
        let port = *pts.last().unwrap_or(&P::new(0.0, 0.0));
        Leader {
            pts,
            port,
            style,
            bends,
            len,
            underline: None,
            curve: None,
            member: None,
            stub: false,
        }
    }
    /// Segments including the underline.
    pub fn segments(&self) -> impl Iterator<Item = (P, P)> + '_ {
        self.pts
            .windows(2)
            .map(|w| (w[0], w[1]))
            .chain(self.underline.iter().copied())
    }
    pub fn bbox(&self) -> Rect {
        let mut r = crate::geom::bbox_of(&self.pts);
        if let Some((a, b)) = self.underline {
            r = r.add_point(a).add_point(b);
        }
        r
    }
}

/// A turned label (spec §6.5): the label of an area anchor along the polygon's main axis.
#[derive(Clone, Debug, PartialEq)]
pub struct Turn {
    /// Degrees, clockwise on screen.
    pub angle: f64,
    /// The label box before it is turned about its center (the reported box).
    pub upright: Rect,
    /// The cover: the bounding boxes of the pieces the label is cut into along its
    /// length, which stand for it in the tests against upright boxes.
    pub cover: Vec<Rect>,
}

/// Most pieces of a turned label's cover.
const COVER_MAX: f64 = 32.0;

impl Turn {
    /// The label of half size (`hw`, `hh`) around `c`, turned by `angle` (its `cos` and
    /// `sin`): its bounding box, the turn and its exact shape.
    pub fn of(c: P, hw: f64, hh: f64, angle: f64, cos: f64, sin: f64) -> (Rect, Turn, Shape) {
        let (ac, asn) = (cos.abs(), sin.abs());
        let bbox = Rect::from_center(c, hw * ac + hh * asn, hw * asn + hh * ac);
        let n = if hh > 0.0 {
            crate::math::clampf(crate::math::ceil_fast(hw / hh), 1.0, COVER_MAX)
        } else {
            COVER_MAX
        };
        let phw = hw / n;
        let (ex, ey) = (phw * ac + hh * asn, phw * asn + hh * ac);
        let cover = (0..n as usize)
            .map(|k| {
                let t = ((k as f64 + 0.5) / n - 0.5) * 2.0 * hw;
                Rect::from_center(c + P::new(t, 0.0).rotate(cos, sin), ex, ey)
            })
            .collect();
        let shape = Shape::RoundRect {
            c,
            hw,
            hh,
            r: 0.0,
            cos,
            sin,
        };
        let turn = Turn {
            angle,
            upright: Rect::from_center(c, hw, hh),
            cover,
        };
        (bbox, turn, shape)
    }
}

/// A label candidate.
#[derive(Clone, Debug)]
pub struct Cand {
    pub item: u32,
    pub variant: u16,
    pub level: u8,
    pub kind: Kind,
    pub side: Side,
    /// Position rank (cost term `w_position · rank / 8`).
    pub rank: f64,
    /// The label box; of a turned label its bounding box.
    pub rect: Rect,
    /// A turned label (`lshape` is then the turned box).
    pub turn: Option<Box<Turn>>,
    /// A label inside its area: the room it lacks and its distance from the pole (spec
    /// §6.5; cost term `w_distance · inside`).
    pub inside: f64,
    pub leaders: Vec<Leader>,
    /// Static cost (valid when `feasible` or `relaxed`).
    pub cost: f64,
    /// Statically feasible under the strict policy.
    pub feasible: bool,
    /// Feasible when the relaxable classes are relaxed (soft_overlap); `relax_cost` is
    /// the extra cost then.
    pub relaxed: bool,
    pub relax_cost: f64,
    /// The first hard constraint that rejected the candidate.
    pub blocked: Option<Block>,
    /// Static cost and feasibility are computed (ladder candidates are evaluated lazily,
    /// only once they are free of placed labels).
    pub evaluated: bool,
    /// Boundary side (0 left, 1 right, 2 top, 3 bottom) of boundary candidates.
    pub bside: u8,
    /// Exact label shape for non-rectangular labels (icons with circle, rounded or
    /// polygon shapes); `None` = the box itself.
    pub lshape: Option<Box<Shape>>,
    /// A warm-start candidate: the previous box (at any size) or a nudge of it; it keeps
    /// [`WARM_MARGIN`] of the margin.
    pub warm: bool,
}

/// The share of `defaults.margin` a label needs to keep its warm-start place (spec
/// §4.4): from another label that keeps its own, and from other marks. A label takes a
/// new place only with the whole margin but leaves its old one only when its neighbours
/// come closer than half of it.
pub const WARM_MARGIN: f64 = 0.5;

/// Whether labels of this shape are their box ([`label_shape`] gives `None`).
pub fn is_rect_shape(shape: &crate::model::LabelShape) -> bool {
    use crate::model::LabelShape;
    match shape {
        LabelShape::Rect => true,
        LabelShape::Rounded(r) => *r <= 0.0,
        LabelShape::Circle => false,
        LabelShape::Polygon(pts) => pts.len() < 3,
    }
}

/// The exact shape of a label box with the given label shape (`None` for rectangles).
pub fn label_shape(rect: &Rect, shape: &crate::model::LabelShape) -> Option<Box<Shape>> {
    use crate::model::LabelShape;
    match shape {
        LabelShape::Rect => None,
        LabelShape::Rounded(r) if *r <= 0.0 => None,
        LabelShape::Rounded(r) => Some(Box::new(Shape::rect(
            rect.center(),
            rect.w(),
            rect.h(),
            *r,
            0.0,
        ))),
        LabelShape::Circle => Some(Box::new(Shape::circle(
            rect.center(),
            rect.w().min(rect.h()) * 0.5,
        ))),
        LabelShape::Polygon(pts) if pts.len() >= 3 => {
            let o = P::new(rect.x0, rect.y0);
            Some(Box::new(Shape::polygon(
                vec![pts.iter().map(|q| *q + o).collect()],
                false,
                rect.center(),
            )))
        }
        _ => None,
    }
}

impl Cand {
    /// Interiors of the two labels overlap (exact for non-rectangular labels).
    pub fn label_overlaps(&self, other: &Cand) -> bool {
        if !self.rect.overlaps(&other.rect) {
            return false;
        }
        match (&self.lshape, &other.lshape) {
            (None, None) => true,
            (Some(a), None) => a.overlaps_rect(&other.rect),
            (None, Some(b)) => b.overlaps_rect(&self.rect),
            (Some(a), Some(b)) => crate::geom::shape::shapes_overlap(a, b),
        }
    }
    /// The labels overlap or, with `gap > EPS`, their boxes come closer than `gap`
    /// ([`WARM_MARGIN`] of it when both are warm-start candidates). Boxes `gap` apart up
    /// to rounding (stacked columns) keep it.
    pub fn label_overlaps_gap(&self, other: &Cand, gap: f64) -> bool {
        let gap = if self.warm && other.warm {
            WARM_MARGIN * gap
        } else {
            gap
        };
        if gap > crate::geom::EPS {
            if self.turn.is_none() && other.turn.is_none() {
                return self.rect.dist_rect(&other.rect) < gap - crate::geom::EPS;
            }
            // a turned label keeps the gap with every box of its cover
            self.rect.dist_rect(&other.rect) < gap - crate::geom::EPS
                && self.boxes().iter().any(|a| {
                    other
                        .boxes()
                        .iter()
                        .any(|b| a.dist_rect(b) < gap - crate::geom::EPS)
                })
        } else {
            self.label_overlaps(other)
        }
    }
    /// The upright boxes that stand for the label: its box, or the cover of a turned
    /// label.
    pub fn boxes(&self) -> &[Rect] {
        match &self.turn {
            Some(t) => &t.cover,
            None => std::slice::from_ref(&self.rect),
        }
    }
    /// The label box as reported: before a turned label is turned.
    pub fn upright(&self) -> Rect {
        match &self.turn {
            Some(t) => t.upright,
            None => self.rect,
        }
    }
    /// The rotation of the label (degrees, clockwise on screen; 0 when it is not turned).
    pub fn angle(&self) -> f64 {
        self.turn.as_ref().map_or(0.0, |t| t.angle)
    }
    /// The distance between the label (its boxes) and shape `s`.
    pub fn dist_shape(&self, s: &Shape) -> f64 {
        let mut d = f64::INFINITY;
        for b in self.boxes() {
            d = crate::math::minf(d, s.dist_rect(b));
        }
        d
    }
    /// Whether leader `l` hits the label (`leaders::leader_hits_label` for its boxes).
    pub fn leader_hits(&self, l: &Leader, gap: f64) -> bool {
        self.boxes()
            .iter()
            .any(|b| crate::leaders::leader_hits_label(l, b, gap))
    }
    /// Set the exact shape of the label for the label shape `shape` (a turned label keeps
    /// its own).
    pub fn set_lshape(&mut self, shape: &crate::model::LabelShape) {
        if self.turn.is_none() {
            self.lshape = label_shape(&self.rect, shape);
        }
    }
    /// The label's interior overlaps shape `s`.
    pub fn label_overlaps_shape(&self, s: &Shape) -> bool {
        match &self.lshape {
            None => s.overlaps_rect(&self.rect),
            Some(l) => crate::geom::shape::shapes_overlap(l, s),
        }
    }
}

impl Cand {
    pub fn new(
        item: u32,
        variant: u16,
        level: u8,
        kind: Kind,
        side: Side,
        rank: f64,
        rect: Rect,
    ) -> Cand {
        Cand {
            item,
            variant,
            level,
            kind,
            side,
            rank,
            rect,
            turn: None,
            inside: 0.0,
            leaders: Vec::new(),
            cost: 0.0,
            feasible: true,
            relaxed: true,
            relax_cost: 0.0,
            blocked: None,
            evaluated: false,
            bside: 255,
            lshape: None,
            warm: false,
        }
    }
    /// The static cost, with the extra cost of the relaxed classes when the candidate is
    /// only feasible with them relaxed.
    #[inline]
    pub fn relaxed_cost(&self) -> f64 {
        self.cost + if self.feasible { 0.0 } else { self.relax_cost }
    }
    /// The label has a stub (spec §6.9).
    pub fn has_stub(&self) -> bool {
        self.leaders.first().is_some_and(|l| l.stub)
    }
    /// Bounding box of label and leaders.
    pub fn bbox(&self) -> Rect {
        let mut r = self.rect;
        for l in &self.leaders {
            r = r.union(&l.bbox());
        }
        r
    }
}

/// Screen direction for an angle in degrees (counter-clockwise on screen, 0 = right).
#[inline]
pub fn dir_of(angle_deg: f64) -> P {
    let (s, c) = sin_cos_deg(angle_deg);
    P::new(c, -s)
}

/// Label center touching `S ⊕ o` in direction `d` (spec §6.1).
#[inline]
pub fn touch_center(shape: &Shape, o: f64, d: P, hw: f64, hh: f64) -> P {
    let s = shape.support_inflated(d, o);
    let (sx, sy) = sign_dir(d);
    P::new(s.x + sx * hw, s.y + sy * hh)
}

/// [`touch_center`] from the support point `s = shape.support_inflated(d, o)`.
#[inline]
fn touch_from_support(s: P, d: P, hw: f64, hh: f64) -> P {
    let (sx, sy) = sign_dir(d);
    P::new(s.x + sx * hw, s.y + sy * hh)
}

/// Support points of an item's inflated mark (`S ⊕ o`) in the directions of the fixed
/// positions and of the gap tables. They do not depend on the label size, so all
/// variants of the item share them (`support_table`).
#[derive(Clone, Debug)]
pub struct SupportTable {
    /// By angular index of the fixed positions.
    pos: [P; 8],
    /// Per gap `k`: at `gap_table(k).dirs[j]` and at `gap_table(k).mids[j]`.
    dirs: [[P; MAX_GAP_VERTS]; 8],
    mids: [[P; MAX_GAP_VERTS]; 8],
}

/// The support table of an item (computed once).
fn support_table(item: &Item) -> &SupportTable {
    item.supports.get_or_init(|| {
        let (shape, o) = (&item.shape, item.len.offset);
        let zero = P::new(0.0, 0.0);
        let mut t = Box::new(SupportTable {
            pos: [zero; 8],
            dirs: [[zero; MAX_GAP_VERTS]; 8],
            mids: [[zero; MAX_GAP_VERTS]; 8],
        });
        for k in 0..8 {
            t.pos[k] = shape.support_inflated(pos_dirs()[k], o);
            let g = gap_table(k);
            for (j, &d) in g.dirs.iter().enumerate() {
                t.dirs[k][j] = shape.support_inflated(d, o);
            }
            for (j, &d) in g.mids.iter().enumerate() {
                t.mids[k][j] = shape.support_inflated(d, o);
            }
        }
        t
    })
}

/// For concave polygons, labels placed against the convex hull are pushed toward the
/// true shape until they touch it (spec §4.5 rule 1: "a final push-out so the label clears
/// the inflated shape exactly").
fn push_in(shape: &Shape, o: f64, c: P, hw: f64, hh: f64) -> P {
    let Shape::Polygon(p) = shape else { return c };
    if p.rings.len() == 1 && p.rings[0].len() == p.hull.len() {
        return c; // convex
    }
    let gap = shape.dist_rect(&Rect::from_center(c, hw, hh)) - o;
    if gap <= 0.25 {
        return c;
    }
    let d = (c - shape.reference()).norm();
    if d.len2() == 0.0 {
        return c;
    }
    let (mut lo, mut hi) = (0.0, gap + hw.max(hh));
    for _ in 0..30 {
        let mid = (lo + hi) * 0.5;
        let r = Rect::from_center(c - d * mid, hw, hh);
        if shape.dist_rect(&r) >= o - 1e-9 && !shape.overlaps_rect(&r) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    c - d * lo
}

/// The warm-start box of an item as a candidate of variant `vi` (whose size must match),
/// so that an unchanged position costs no stability penalty (spec §8): a slider-kind
/// candidate on the side its center points to when it touches the inflated mark (gap
/// ≤ offset + 1 px), else a distant candidate with a straight leader (straight style,
/// within the leader length limits) or with the leader it came with (see
/// `warm_leader`). `None` when neither applies.
pub fn warm(
    model: &crate::model::Model,
    item: &Item,
    vi: usize,
    v: &Variant,
    rect: Rect,
) -> Option<Cand> {
    let it = item.index as u32;
    if let Some(area) = &item.area {
        // inside the area: an internal candidate, turned as it was
        if let Some(c) = area_warm(model, item, area, vi, v, rect) {
            return Some(c);
        }
    }
    let gap = item.shape.dist_rect(&rect);
    if gap < -1e-6 || item.shape.overlaps_rect(&rect) {
        return None; // on the own mark: internal candidates cover that
    }
    let refp = item.shape.reference();
    if gap <= item.len.offset + 1.0 {
        let d = rect.center() - refp;
        if d.len2() == 0.0 {
            return None;
        }
        // nearest of the item's allowed positions by direction
        let mut best: Option<(f64, Pos, f64)> = None;
        for (rank, &p) in item.positions.iter().enumerate() {
            let pd = pos_dirs()[p.angular_index()];
            let dot = (pd.x * d.x + pd.y * d.y) / d.len2().sqrt();
            if best.map(|b| dot > b.0).unwrap_or(true) {
                best = Some((dot, p, rank as f64));
            }
        }
        let (_, pos, rank) = best?;
        return Some(Cand::new(
            it,
            vi as u16,
            v.level,
            Kind::Slider,
            Side::Pos(pos),
            rank + 0.25,
            rect,
        ));
    }
    if model.leaders.style != LeaderStyle::Straight {
        return warm_leader(model, item, vi, v, rect);
    }
    let port = rect.closest_point(refp);
    let start = crate::leaders::leader_start(model, item, port);
    let port = rect.closest_point(start);
    let l = Leader::new(vec![start, port], model.leaders.style);
    if l.len < item.len.leader_min || l.len > item.len.leader_max + 1e-9 {
        return None;
    }
    let mut c = Cand::new(
        it,
        vi as u16,
        v.level,
        Kind::Distant,
        Side::Distant,
        8.0,
        rect,
    );
    c.leaders.push(l);
    Some(c)
}

/// cos 0.5°: the tolerance of a warm-start leader's direction.
const COS_HALF_DEGREE: f64 = 0.999_961_923_064_171_4;

/// A warm-start box away from the mark as a distant candidate with the leader it came
/// with, moved with it (`angles`, `elbow` and `orthogonal` styles): when that leader
/// still starts where the item's leaders start and ends on the box (both within 0.5 px),
/// keeps within the length limits and, for `angles` and `elbow`, leaves the item along
/// one of the allowed directions (within 0.5°). Items labeling a group take none.
fn warm_leader(
    model: &crate::model::Model,
    item: &Item,
    vi: usize,
    v: &Variant,
    rect: Rect,
) -> Option<Cand> {
    let style = model.leaders.style;
    let pts = model.warm_leaders.get(&item.id)?;
    if pts.len() < 2 || model.group_members(item.index).len() >= 2 {
        return None;
    }
    let (s0, port) = (pts[0], pts[pts.len() - 1]);
    if s0.dist(crate::leaders::leader_start(model, item, s0)) > 0.5 {
        return None;
    }
    let inside = (port.x - rect.x0)
        .min(rect.x1 - port.x)
        .min(port.y - rect.y0)
        .min(rect.y1 - port.y);
    if rect.dist_point(port) > 0.5 || inside > 0.5 {
        return None;
    }
    if matches!(style, LeaderStyle::Angles | LeaderStyle::Elbow) {
        let d = (pts[1] - s0).norm();
        if !crate::leaders::distant_dirs(model)
            .iter()
            .any(|&(_, u)| d.dot(u) >= COS_HALF_DEGREE)
        {
            return None;
        }
    }
    let mut l = Leader::new(pts.clone(), style);
    if l.len < item.len.leader_min || l.len > item.len.leader_max + 1e-9 {
        return None;
    }
    // the `baseline` port's underline, for this variant's text (as `leaders::distant`)
    if model.leaders.port == crate::model::opts::Port::Baseline && style != LeaderStyle::Orthogonal
    {
        if let Some(t) = &v.text {
            let x0 = rect.x0 + t.x_offsets[0];
            let far = if port.x <= rect.center().x {
                x0 + t.widths[0]
            } else {
                x0
            };
            l.underline = Some((port, P::new(far, port.y)));
        }
    }
    let mut c = Cand::new(
        item.index as u32,
        vi as u16,
        v.level,
        Kind::Distant,
        Side::Distant,
        8.0,
        rect,
    );
    c.leaders.push(l);
    Some(c)
}

/// Label centers along the slider paths of an item's allowed gaps (the C-space paths of
/// [`adjacent`], whose curved stretches are followed by their chords between vertices
/// 9° apart), chained into runs of consecutive allowed gaps; a run that goes all around
/// the mark is closed (its last point is its first).
fn slider_runs(item: &Item, hw: f64, hh: f64) -> Vec<Vec<P>> {
    let mut allowed_pos = [false; 8];
    for p in &item.positions {
        allowed_pos[p.angular_index()] = true;
    }
    let allowed = |k: usize| allowed_pos[k % 8] && allowed_pos[(k + 1) % 8];
    let st = support_table(item);
    let (shape, o) = (&item.shape, item.len.offset);
    // start after a gap that is not allowed, so that no run is split at the start
    let start = (0..8).find(|&k| allowed(k) && !allowed(k + 7)).unwrap_or(0);
    let mut runs: Vec<Vec<P>> = Vec::new();
    let mut cur: Vec<P> = Vec::new();
    let mut path = [CVertex::ZERO; MAX_GAP_VERTS];
    for j in 0..8 {
        let k = (start + j) % 8;
        if !allowed(k) {
            if cur.len() >= 2 {
                runs.push(std::mem::take(&mut cur));
            }
            cur.clear();
            continue;
        }
        let n = cspace_path(shape, o, hw, hh, k, Some(st), &mut path);
        for v in &path[..n] {
            if cur.last().is_some_and(|q| q.dist(v.p) < 1e-9) {
                continue;
            }
            cur.push(v.p);
        }
    }
    if cur.len() >= 2 {
        runs.push(cur);
    }
    runs
}

/// The point `s` px (signed) along `run` from the point at parameter `t` of segment
/// `seg`; a closed run wraps around, an open one ends (`None` past its ends).
fn walk_run(run: &[P], seg: usize, t: f64, s: f64) -> Option<P> {
    let n = run.len();
    let mut cum = vec![0.0; n];
    for i in 1..n {
        cum[i] = cum[i - 1] + run[i - 1].dist(run[i]);
    }
    let total = cum[n - 1];
    if total <= 1e-9 {
        return None;
    }
    let closed = run[0].dist(run[n - 1]) < 1e-9;
    let mut target = cum[seg] + (cum[seg + 1] - cum[seg]) * t + s;
    if closed {
        target = target.rem_euclid(total);
    } else if !(0.0..=total).contains(&target) {
        return None;
    }
    let mut i = 0;
    while i + 2 < n && cum[i + 1] < target {
        i += 1;
    }
    let len = cum[i + 1] - cum[i];
    let u = if len > 0.0 {
        (target - cum[i]) / len
    } else {
        0.0
    };
    Some(run[i].lerp(run[i + 1], u))
}

/// Candidates of variant `vi` near a warm-start box that touches the mark: its center
/// moved `steps` px (each step forwards, then backwards) along the slider paths of the
/// item's allowed gaps, as slider candidates (spec §6.7). For a box that a small change
/// blocked: a nudge instead of a jump. Empty when the box is not on a slider path (it
/// does not touch the mark, or the item has no slider model). Returns `(step index,
/// candidate)` pairs.
pub fn warm_nudges(
    item: &Item,
    vi: usize,
    v: &Variant,
    rect: Rect,
    steps: &[f64],
    models: Models,
) -> Vec<(usize, Cand)> {
    if !models.has(Models::SLIDER) {
        return Vec::new();
    }
    let (hw, hh) = (v.w * 0.5, v.h * 0.5);
    let runs = slider_runs(item, hw, hh);
    let c0 = rect.center();
    // the nearest point of the paths: (distance, run, segment, parameter)
    let mut near: Option<(f64, usize, usize, f64)> = None;
    for (r, run) in runs.iter().enumerate() {
        for k in 0..run.len() - 1 {
            let (a, b) = (run[k], run[k + 1]);
            let ab = b - a;
            let l2 = ab.len2();
            let t = if l2 > 0.0 {
                (((c0 - a).x * ab.x + (c0 - a).y * ab.y) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            let d = c0.dist(a.lerp(b, t));
            if near.map(|n| d < n.0).unwrap_or(true) {
                near = Some((d, r, k, t));
            }
        }
    }
    let Some((d, r, k, t)) = near else {
        return Vec::new();
    };
    if d > 0.75 {
        return Vec::new();
    }
    let refp = item.shape.reference();
    let it = item.index as u32;
    let mut out = Vec::new();
    for (si, &step) in steps.iter().enumerate() {
        for s in [step, -step] {
            let Some(c) = walk_run(&runs[r], k, t, s) else {
                continue;
            };
            let c = push_in(&item.shape, item.len.offset, c, hw, hh);
            let dd = c - refp;
            if dd.len2() == 0.0 {
                continue;
            }
            // the nearest of the item's allowed positions by direction, as for `warm`
            let mut best: Option<(f64, Pos, f64)> = None;
            for (rank, &p) in item.positions.iter().enumerate() {
                let pd = pos_dirs()[p.angular_index()];
                let dot = (pd.x * dd.x + pd.y * dd.y) / dd.len2().sqrt();
                if best.map(|b| dot > b.0).unwrap_or(true) {
                    best = Some((dot, p, rank as f64));
                }
            }
            let Some((_, pos, rank)) = best else {
                continue;
            };
            out.push((
                si,
                Cand::new(
                    it,
                    vi as u16,
                    v.level,
                    Kind::Slider,
                    Side::Pos(pos),
                    rank + 0.25,
                    Rect::from_center(c, hw, hh),
                ),
            ));
        }
    }
    out
}

/// Adjacent and slider candidates of one variant. With `stubs`, a candidate that another
/// item's mark comes near is replaced by the same position `stub_length` farther out, with a
/// stub, where the stub meets a side of the label squarely and the candidate is statically
/// feasible (spec §6.9).
pub fn adjacent(
    item: &Item,
    vi: usize,
    v: &Variant,
    slider_per_gap: usize,
    models: Models,
    stubs: Option<&crate::leaders::Stubs>,
    out: &mut Vec<Cand>,
) {
    let hw = v.w * 0.5;
    let hh = v.h * 0.5;
    let o = item.len.offset;
    // the offset of labels with a stub
    let os = o + item.len.stub_length;
    let shape = &item.shape;
    // rank of each fixed position by angular index (its first occurrence in the order)
    let mut rank_at = [None; 8];
    for (r, p) in item.positions.iter().enumerate() {
        rank_at[p.angular_index()].get_or_insert(r as f64);
    }
    let it = item.index as u32;
    let st = support_table(item);
    if models.has(Models::ADJACENT) {
        for (r, &p) in item.positions.iter().enumerate() {
            let a = p.angular_index();
            let c = touch_from_support(st.pos[a], pos_dirs()[a], hw, hh);
            let c = push_in(shape, o, c, hw, hh);
            let cand = |rect| {
                Cand::new(
                    it,
                    vi as u16,
                    v.level,
                    Kind::Adjacent,
                    Side::Pos(p),
                    r as f64,
                    rect,
                )
            };
            let plain = cand(Rect::from_center(c, hw, hh));
            let stubbed = match stubs {
                Some(s) if s.ambiguous(item, &plain.rect) => {
                    let mut c = touch_center(shape, os, pos_dirs()[a], hw, hh);
                    if matches!(p, Pos::Left | Pos::Right) {
                        // the stub meets the middle of the label's side
                        c.y = shape.reference().y;
                    }
                    let c = push_in(shape, os, c, hw, hh);
                    s.stubbed(item, v, cand(Rect::from_center(c, hw, hh)))
                }
                _ => None,
            };
            out.push(stubbed.unwrap_or(plain));
        }
    }
    if !models.has(Models::SLIDER) || slider_per_gap == 0 {
        return;
    }
    let mut path = [CVertex::ZERO; MAX_GAP_VERTS];
    for k in 0..8 {
        let a = Pos::from_angular_index(k);
        let b = Pos::from_angular_index(k + 1);
        let (Some(ra), Some(rb)) = (rank_at[k], rank_at[(k + 1) % 8]) else {
            continue;
        };
        let cand = |j: usize, c: P| {
            let t = (j + 1) as f64 / (slider_per_gap + 1) as f64;
            let rank = ra + (rb - ra) * t + 0.25;
            let side = if t < 0.5 { a } else { b };
            Cand::new(
                it,
                vi as u16,
                v.level,
                Kind::Slider,
                Side::Pos(side),
                rank,
                Rect::from_center(c, hw, hh),
            )
        };
        let n = cspace_path(shape, o, hw, hh, k, Some(st), &mut path);
        let Some(s) = stubs else {
            sample_path(&path[..n], slider_per_gap, shape, o, hw, hh, |j, c| {
                out.push(cand(j, push_in(shape, o, c, hw, hh)))
            });
            continue;
        };
        let mut samples: Vec<P> = Vec::with_capacity(slider_per_gap);
        sample_path(&path[..n], slider_per_gap, shape, o, hw, hh, |_, c| {
            samples.push(push_in(shape, o, c, hw, hh))
        });
        // the boxes another mark comes near, and the samples of the path of labels with
        // a stub (made only when needed)
        let near: Vec<bool> = samples
            .iter()
            .map(|&c| s.ambiguous(item, &Rect::from_center(c, hw, hh)))
            .collect();
        let mut far: Vec<P> = Vec::new();
        if near.contains(&true) {
            let n = cspace_path(shape, os, hw, hh, k, None, &mut path);
            sample_path(&path[..n], slider_per_gap, shape, os, hw, hh, |_, c| {
                far.push(push_in(shape, os, c, hw, hh))
            });
        }
        for (j, &c) in samples.iter().enumerate() {
            let stubbed = match far.get(j) {
                Some(&cf) if near[j] => s.stubbed(item, v, cand(j, cf)),
                _ => None,
            };
            out.push(stubbed.unwrap_or_else(|| cand(j, c)));
        }
    }
}

/// A vertex of the configuration-space boundary: position, angle, and whether the
/// segment to the next vertex is straight (exact) or curved (re-evaluate by angle).
#[derive(Clone, Copy, Debug)]
struct CVertex {
    p: P,
    phi: f64,
    straight_next: bool,
}

impl CVertex {
    const ZERO: CVertex = CVertex {
        p: P { x: 0.0, y: 0.0 },
        phi: 0.0,
        straight_next: false,
    };
}

/// Most vertices of the C-space path of one gap (see `gap_table`: the two fixed
/// positions, the samples between them every `SAMPLE_STEP_DEG`, and the offsets next
/// to axis directions).
const MAX_GAP_VERTS: usize = 10;

const SAMPLE_STEP_DEG: f64 = 9.0;
const EPS_DEG: f64 = 1e-4;

#[inline]
fn c_at(shape: &Shape, o: f64, hw: f64, hh: f64, phi: f64) -> P {
    touch_center(shape, o, dir_of(phi), hw, hh)
}

fn is_axis(phi: f64) -> bool {
    let r = phi.rem_euclid(90.0);
    r < 1e-9 || 90.0 - r < 1e-9
}

/// Unit directions (`dir_of`) of the 8 fixed positions by angular index (computed once).
fn pos_dirs() -> &'static [P; 8] {
    static D: std::sync::OnceLock<[P; 8]> = std::sync::OnceLock::new();
    D.get_or_init(|| std::array::from_fn(|k| dir_of(45.0 * k as f64)))
}

/// Vertex angles of the C-space path of gap `k` (between the fixed positions `k` and
/// `k + 1` in angular order), with their directions and the directions of the angle
/// midpoints between consecutive vertices. These depend only on `k`, so the
/// trigonometry is done once per process.
struct GapTable {
    phis: Vec<f64>,
    dirs: Vec<P>,
    mids: Vec<P>,
}

fn gap_table(k: usize) -> &'static GapTable {
    static T: std::sync::OnceLock<Vec<GapTable>> = std::sync::OnceLock::new();
    &T.get_or_init(|| {
        (0..8)
            .map(|k| {
                let fa = 45.0 * k as f64;
                let fb = if k == 7 { 360.0 } else { 45.0 * (k + 1) as f64 };
                let mut phis: Vec<f64> = vec![fa];
                if is_axis(fa) {
                    phis.push(fa + EPS_DEG);
                }
                let n = ((fb - fa) / SAMPLE_STEP_DEG).ceil().max(1.0) as usize;
                for j in 1..n {
                    phis.push(fa + (fb - fa) * j as f64 / n as f64);
                }
                if is_axis(fb) {
                    phis.push(fb - EPS_DEG);
                }
                phis.push(fb);
                assert!(phis.len() <= MAX_GAP_VERTS);
                let dirs = phis.iter().map(|&phi| dir_of(phi)).collect();
                let mids = phis
                    .windows(2)
                    .map(|w| dir_of((w[0] + w[1]) * 0.5))
                    .collect();
                GapTable { phis, dirs, mids }
            })
            .collect()
    })[k]
}

/// Boundary of `(S ⊕ o) ⊕ (−B)` over gap `k` (between two fixed positions), written to
/// `verts`; returns the number of vertices.
fn cspace_path(
    shape: &Shape,
    o: f64,
    hw: f64,
    hh: f64,
    k: usize,
    supports: Option<&SupportTable>,
    verts: &mut [CVertex; MAX_GAP_VERTS],
) -> usize {
    let t = gap_table(k);
    let mut n = 0;
    // table index of every kept vertex
    let mut idx = [0usize; MAX_GAP_VERTS];
    for (j, &phi) in t.phis.iter().enumerate() {
        let p = match supports {
            Some(st) => touch_from_support(st.dirs[k][j], t.dirs[j], hw, hh),
            None => touch_center(shape, o, t.dirs[j], hw, hh),
        };
        if n > 0 && verts[n - 1].p.dist(p) < 1e-12 {
            continue;
        }
        verts[n] = CVertex {
            p,
            phi,
            straight_next: true,
        };
        idx[n] = j;
        n += 1;
    }
    for i in 0..n.saturating_sub(1) {
        let (a, b) = (verts[i], verts[i + 1]);
        let mid = if idx[i + 1] == idx[i] + 1 {
            let d = t.mids[idx[i]];
            match supports {
                Some(st) => touch_from_support(st.mids[k][idx[i]], d, hw, hh),
                None => touch_center(shape, o, d, hw, hh),
            }
        } else {
            touch_center(shape, o, dir_of((a.phi + b.phi) * 0.5), hw, hh)
        };
        verts[i].straight_next = dist_point_seg(mid, a.p, b.p) <= 1e-9;
    }
    n
}

/// `k` samples at equal arc length, excluding the endpoints: `emit(j, point)` for
/// `j` in `0..k` (none for degenerate paths).
fn sample_path(
    path: &[CVertex],
    k: usize,
    shape: &Shape,
    o: f64,
    hw: f64,
    hh: f64,
    mut emit: impl FnMut(usize, P),
) {
    if path.len() < 2 {
        return;
    }
    let mut cum = [0.0; MAX_GAP_VERTS];
    for i in 1..path.len() {
        cum[i] = cum[i - 1] + path[i - 1].p.dist(path[i].p);
    }
    let total = cum[path.len() - 1];
    if total <= 1e-9 {
        return;
    }
    let mut seg = 0;
    for j in 1..=k {
        let target = total * j as f64 / (k + 1) as f64;
        while seg + 1 < path.len() - 1 && cum[seg + 1] < target {
            seg += 1;
        }
        let a = path[seg];
        let b = path[seg + 1];
        let len = cum[seg + 1] - cum[seg];
        let t = if len > 0.0 {
            (target - cum[seg]) / len
        } else {
            0.0
        };
        emit(
            j - 1,
            if a.straight_next {
                a.p.lerp(b.p, t)
            } else {
                c_at(shape, o, hw, hh, a.phi + (b.phi - a.phi) * t)
            },
        );
    }
}

/// Whether internal candidates apply to this item, and their rank.
pub fn internal_rank(item: &Item, v: &Variant, models: Models, circle_ratio: f64) -> Option<f64> {
    // prefer: ahead of every external position; allow: on par with the best one (the
    // distance term then favours the label that sits on its mark)
    let prefer = Some(-1.0);
    let allow = Some(0.0);
    match item.internal {
        InternalPolicy::Never => None,
        InternalPolicy::Prefer => prefer,
        InternalPolicy::Allow => allow,
        InternalPolicy::Auto => {
            if item.area.is_some() {
                return prefer;
            }
            if item.tip {
                return None;
            }
            match &item.shape {
                Shape::Circle { r, .. } => {
                    if *r >= circle_ratio * v.h || models.has(Models::INTERNAL) {
                        allow
                    } else {
                        None
                    }
                }
                _ => prefer,
            }
        }
    }
}

/// The grid of an area anchor's internal candidates has about this many samples at most
/// (spec §6.5).
const AREA_SAMPLES: f64 = 65536.0;

/// Whether the labels of variant `v` may be turned (spec §6.5): text in a rectangular
/// box.
pub fn can_turn(v: &Variant) -> bool {
    v.text.is_some() && v.parts.is_empty() && is_rect_shape(&v.shape)
}

/// The rank of an area anchor's internal candidates (`None`: it has none).
pub fn area_rank(item: &Item) -> Option<f64> {
    match item.internal {
        InternalPolicy::Never => None,
        InternalPolicy::Allow => Some(0.0),
        InternalPolicy::Prefer | InternalPolicy::Auto => Some(-1.0),
    }
}

/// The frame of an area's labels of one direction: the polygon as the labels see it (for
/// turned labels: turned back), with the label size.
struct AreaFrame<'a> {
    shape: &'a Shape,
    pole: P,
    radius: f64,
    em: f64,
    hw: f64,
    hh: f64,
    pad: f64,
}

impl AreaFrame<'_> {
    fn fits(&self, c: P) -> bool {
        let r = Rect::from_center(c, self.hw, self.hh);
        // (a box inside the polygon lies in its bounding box: the cheap test first)
        self.shape.bbox().contains_rect(&r.inflate(self.pad))
            && self.shape.contains_rect(&r, self.pad)
    }
    /// What the place `c` lacks (spec §6.5): the room the label lacks to 1 em from the
    /// polygon's boundary, in em, plus its distance from the pole relative to the
    /// polygon's size.
    fn lack(&self, c: P) -> f64 {
        self.tight(c) + self.off(c, self.pole)
    }
    /// The room the label lacks at `c` to 1 em from the polygon's boundary, in em.
    fn tight(&self, c: P) -> f64 {
        let Shape::Polygon(p) = self.shape else {
            return 0.0;
        };
        let room =
            crate::geom::polygon::room_rect(&p.rings, &Rect::from_center(c, self.hw, self.hh));
        maxf(0.0, 1.0 - room / self.em)
    }
    /// The distance of `c` from `from` relative to the polygon's size.
    fn off(&self, c: P, from: P) -> f64 {
        if self.radius > 0.0 {
            c.dist(from) / self.radius
        } else {
            0.0
        }
    }

    /// The points of the sampling grid with spacing `step`, row by row from the top
    /// (spec §6.5): from the bounding box's top-left corner plus half the label size.
    fn grid(&self, step: f64, mut f: impl FnMut(P)) {
        let bb = self.shape.bbox();
        let mut y = bb.y0 + self.hh;
        while y <= bb.y1 - self.hh + 1e-9 {
            let mut x = bb.x0 + self.hw;
            while x <= bb.x1 - self.hw + 1e-9 {
                f(P::new(x, y));
                // coordinates so large that a step no longer changes them
                if x + step <= x {
                    break;
                }
                x += step;
            }
            if y + step <= y {
                break;
            }
            y += step;
        }
    }

    /// The places of the area's labels in this frame with what they lack (spec §6.5):
    /// the best sample, improved, then one sample of each of the 3 × 3 cells of the
    /// samples' bounding box (the one that lacks least as seen from the cell's middle),
    /// in ascending order.
    fn places(&self) -> Vec<(P, f64)> {
        let (hw, hh) = (self.hw, self.hh);
        // (center, lack, room lacking)
        let mut pts: Vec<(P, f64, f64)> = Vec::new();
        let sample = |c: P| {
            let t = self.tight(c);
            (c, t + self.off(c, self.pole), t)
        };
        if self.fits(self.pole) {
            pts.push(sample(self.pole));
        }
        // grid samples where the label fits; an area far larger than any picture (a
        // country beyond the view of a map) is sampled more coarsely, at about
        // `AREA_SAMPLES` places
        let bb = self.shape.bbox();
        let step = maxf(maxf(2.0 * hh, 4.0), (bb.w() * bb.h() / AREA_SAMPLES).sqrt());
        let first = pts.len();
        self.grid(step, |c| {
            if self.fits(c) {
                pts.push(sample(c));
            }
        });
        if pts.is_empty() {
            return Vec::new();
        }
        // where the label fits only narrowly, the grid's samples lie in fewer than three
        // rows (columns), and the cells below would have no places above and below
        // (beside) each other: the points half a spacing below (right of, and with both
        // below and right of) the grid's points are sampled too
        let mut gb = Rect::EMPTY;
        for &(c, _, _) in &pts[first..] {
            gb = gb.add_point(c);
        }
        let rows = gb.h() < 1.5 * step;
        let cols = gb.w() < 1.5 * step;
        if rows || cols {
            let s = step * 0.5;
            let (x1, y1) = (bb.x1 - hw + 1e-9, bb.y1 - hh + 1e-9);
            let shifts = [
                (rows, P::new(0.0, s)),
                (cols, P::new(s, 0.0)),
                (rows && cols, P::new(s, s)),
            ];
            self.grid(step, |c| {
                for &(on, d) in &shifts {
                    let q = c + d;
                    if on && q.x <= x1 && q.y <= y1 && self.fits(q) {
                        pts.push(sample(q));
                    }
                }
            });
        }
        let mut best = 0;
        let mut sb = Rect::EMPTY;
        for (k, &(c, g, _)) in pts.iter().enumerate() {
            if g < pts[best].1 {
                best = k;
            }
            sb = sb.add_point(c);
        }
        // one sample of each cell: near the cell's middle, where the label has room
        let cell = |v: f64, lo: f64, hi: f64| {
            if hi > lo {
                crate::math::clampf(
                    crate::math::floor_fast(3.0 * (v - lo) / (hi - lo)),
                    0.0,
                    2.0,
                ) as usize
            } else {
                0
            }
        };
        let mid = |k: usize, lo: f64, hi: f64| lo + (k as f64 + 0.5) * (hi - lo) / 3.0;
        let mut cells: [Option<(usize, f64)>; 9] = [None; 9];
        for (k, &(c, _, t)) in pts.iter().enumerate() {
            let (qx, qy) = (cell(c.x, sb.x0, sb.x1), cell(c.y, sb.y0, sb.y1));
            let m = P::new(mid(qx, sb.x0, sb.x1), mid(qy, sb.y0, sb.y1));
            let g = t + self.off(c, m);
            let q = 3 * qy + qx;
            if cells[q].is_none_or(|b| g < b.1) {
                cells[q] = Some((k, g));
            }
        }
        let mut rest: Vec<usize> = cells
            .iter()
            .flatten()
            .map(|b| b.0)
            .filter(|&k| k != best)
            .collect();
        crate::sort::sort_by(&mut rest, |&a, &b| {
            crate::math::cmp_f64(pts[a].1, pts[b].1).then(a.cmp(&b))
        });
        // the best sample moves, by half the grid spacing and then by half of that again
        // and again down to 0.5 px, to where it lacks less
        let (mut c, mut g) = (pts[best].0, pts[best].1);
        let mut s = step * 0.5;
        while s.is_finite() && s >= 0.5 {
            for _ in 0..16 {
                let mut moved = false;
                for d in [
                    P::new(s, 0.0),
                    P::new(-s, 0.0),
                    P::new(0.0, s),
                    P::new(0.0, -s),
                ] {
                    let q = c + d;
                    if !self.fits(q) {
                        continue;
                    }
                    let gq = self.lack(q);
                    if gq < g - 1e-9 {
                        (c, g) = (q, gq);
                        moved = true;
                        break;
                    }
                }
                if !moved {
                    break;
                }
            }
            s *= 0.5;
        }
        let mut out = vec![(c, g)];
        out.extend(rest.into_iter().map(|k| (pts[k].0, pts[k].1)));
        out
    }
}

/// Internal candidates of an area anchor for one variant (spec §6.5): upright ones, then
/// the ones turned along the polygon's main axis.
pub fn area(item: &Item, vi: usize, v: &Variant, rank: f64, out: &mut Vec<Cand>) {
    let Some(area) = &item.area else { return };
    let (hw, hh) = (v.w * 0.5, v.h * 0.5);
    let it = item.index as u32;
    let frame = |shape| AreaFrame {
        shape,
        pole: area.pole,
        radius: area.radius,
        em: item.em(),
        hw,
        hh,
        pad: item.len.inner_padding,
    };
    let cand = |rect| {
        Cand::new(
            it,
            vi as u16,
            v.level,
            Kind::Internal,
            Side::Internal,
            rank,
            rect,
        )
    };
    for (c, g) in frame(&area.shape).places() {
        let mut cd = cand(Rect::from_center(c, hw, hh));
        cd.inside = g;
        out.push(cd);
    }
    let Some(t) = area.turn.as_ref().filter(|_| can_turn(v)) else {
        return;
    };
    for (c, g) in frame(&t.shape).places() {
        let c = area.pole + (c - area.pole).rotate(t.cos, t.sin);
        let (bbox, turn, shape) = Turn::of(c, hw, hh, t.angle, t.cos, t.sin);
        let mut cd = cand(bbox);
        cd.inside = g;
        cd.turn = Some(Box::new(turn));
        cd.lshape = Some(Box::new(shape));
        out.push(cd);
    }
}

/// The warm-start box of an area item as an internal candidate of variant `vi`, where it
/// lies inside the polygon (with the inner padding), turned by the rotation it came with.
fn area_warm(
    model: &crate::model::Model,
    item: &Item,
    area: &crate::model::Area,
    vi: usize,
    v: &Variant,
    rect: Rect,
) -> Option<Cand> {
    let rank = area_rank(item)?;
    let (hw, hh) = (v.w * 0.5, v.h * 0.5);
    let c = rect.center();
    let angle = model.warm_rotation.get(&item.id).copied().unwrap_or(0.0);
    let mut cd = Cand::new(
        item.index as u32,
        vi as u16,
        v.level,
        Kind::Internal,
        Side::Internal,
        rank,
        Rect::from_center(c, hw, hh),
    );
    let frame = |shape, pole| AreaFrame {
        shape,
        pole,
        radius: area.radius,
        em: item.em(),
        hw,
        hh,
        pad: item.len.inner_padding,
    };
    if angle == 0.0 {
        let f = frame(&area.shape, area.pole);
        if !f.fits(c) {
            return None;
        }
        cd.inside = f.lack(c);
        return Some(cd);
    }
    if !can_turn(v) {
        return None;
    }
    // the polygon turned back about the label's center
    let Shape::Polygon(p) = &area.shape else {
        return None;
    };
    let (sin, cos) = sin_cos_deg(angle);
    let back = |q: P| c + (q - c).unrotate(cos, sin);
    let turned = Shape::polygon(
        p.rings
            .iter()
            .map(|r| r.iter().map(|&q| back(q)).collect())
            .collect(),
        false,
        back(area.pole),
    );
    let f = frame(&turned, back(area.pole));
    if !f.fits(c) {
        return None;
    }
    let (bbox, turn, shape) = Turn::of(c, hw, hh, angle, cos, sin);
    cd.rect = bbox;
    cd.inside = f.lack(c);
    cd.turn = Some(Box::new(turn));
    cd.lshape = Some(Box::new(shape));
    Some(cd)
}

/// Internal candidates of one variant (spec §6.3; area anchors: [`area`]).
pub fn internal(item: &Item, vi: usize, v: &Variant, rank: f64, out: &mut Vec<Cand>) {
    let hw = v.w * 0.5;
    let hh = v.h * 0.5;
    let pad = item.len.inner_padding;
    let it = item.index as u32;
    let push = |c: P, out: &mut Vec<Cand>| {
        let r = Rect::from_center(c, hw, hh);
        let dup = out.iter().any(|x| {
            x.item == it && x.variant == vi as u16 && x.kind == Kind::Internal && x.rect == r
        });
        if !dup {
            out.push(Cand::new(
                it,
                vi as u16,
                v.level,
                Kind::Internal,
                Side::Internal,
                rank,
                r,
            ));
        }
    };
    let shape = &item.shape;
    let mut centers = vec![shape.reference()];
    match shape {
        Shape::Polygon(_) => centers.insert(0, item.pole()),
        _ => centers.insert(0, shape.bbox().center()),
    }
    for c in centers {
        if shape.contains_rect(&Rect::from_center(c, hw, hh), pad) {
            push(c, out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::shape::Shape;

    fn gap_to(shape: &Shape, r: &Rect, o: f64) -> f64 {
        shape.dist_rect(r) - o
    }

    #[test]
    fn cover_of_a_turned_label() {
        for (hw, hh, deg) in [
            (40.0, 8.0, 30.0),
            (40.0, 8.0, -90.0),
            (5.0, 20.0, 45.0),
            (500.0, 2.0, 10.0),
        ] {
            let c = P::new(100.0, 50.0);
            let (sin, cos) = sin_cos_deg(deg);
            let (bbox, turn, shape) = Turn::of(c, hw, hh, deg, cos, sin);
            assert_eq!(turn.upright, Rect::from_center(c, hw, hh));
            assert!(turn.cover.len() as f64 == (hw / hh).ceil().clamp(1.0, 32.0));
            // the label lies in its cover, and the cover in the label's bounding box
            for k in 0..=40 {
                for j in 0..=4 {
                    let q = P::new(
                        -hw + 2.0 * hw * k as f64 / 40.0,
                        -hh + 2.0 * hh * j as f64 / 4.0,
                    );
                    let p = c + q.rotate(cos, sin);
                    assert!(
                        turn.cover.iter().any(|b| b.inflate(1e-9).contains_point(p)),
                        "{deg}: {p:?}"
                    );
                }
            }
            for b in &turn.cover {
                assert!(
                    bbox.inflate(1e-9).contains_rect(b),
                    "{deg}: {b:?} in {bbox:?}"
                );
            }
            let sb = shape.bbox();
            assert!((sb.x0 - bbox.x0).abs() < 1e-9 && (sb.y1 - bbox.y1).abs() < 1e-9);
        }
    }

    #[test]
    fn adjacent_touch_circle_tangent() {
        let s = Shape::circle(P::new(100.0, 100.0), 10.0);
        let o = 2.0;
        for k in 0..8 {
            let p = Pos::from_angular_index(k);
            let c = touch_center(&s, o, dir_of(p.angle()), 20.0, 8.0);
            let r = Rect::from_center(c, 20.0, 8.0);
            let g = gap_to(&s, &r, o);
            assert!(g.abs() < 1e-9, "{p:?}: gap {g}");
        }
    }

    #[test]
    fn adjacent_rect_matches_bbox_positions() {
        let s = Shape::rect(P::new(0.0, 0.0), 40.0, 20.0, 0.0, 0.0);
        let c = touch_center(&s, 0.0, dir_of(45.0), 10.0, 5.0);
        assert!(
            (c.x - 30.0).abs() < 1e-12 && (c.y + 15.0).abs() < 1e-12,
            "{c:?}"
        );
        let c = touch_center(&s, 0.0, dir_of(90.0), 10.0, 5.0);
        assert!(c.x.abs() < 1e-12 && (c.y + 15.0).abs() < 1e-12, "{c:?}");
    }

    #[test]
    fn slider_samples_touch_the_shape() {
        for shape in [
            Shape::circle(P::new(0.0, 0.0), 12.0),
            Shape::ellipse(P::new(0.0, 0.0), 20.0, 8.0, 25.0),
            Shape::rect(P::new(0.0, 0.0), 30.0, 12.0, 3.0, 17.0),
            Shape::polygon(
                vec![vec![
                    P::new(-20.0, -10.0),
                    P::new(20.0, -15.0),
                    P::new(5.0, 0.0),
                    P::new(25.0, 12.0),
                    P::new(-15.0, 10.0),
                ]],
                false,
                P::new(0.0, 0.0),
            ),
        ] {
            for k in 0..8 {
                let mut path = [CVertex::ZERO; MAX_GAP_VERTS];
                let n = cspace_path(&shape, 2.0, 15.0, 6.0, k, None, &mut path);
                let mut samples = Vec::new();
                sample_path(&path[..n], 6, &shape, 2.0, 15.0, 6.0, |_, c| {
                    samples.push(c)
                });
                assert_eq!(samples.len(), 6);
                for c in samples {
                    let c = push_in(&shape, 2.0, c, 15.0, 6.0);
                    let r = Rect::from_center(c, 15.0, 6.0);
                    let g = shape.dist_rect(&r) - 2.0;
                    // touches the inflated shape (hull for concave) within tolerance
                    assert!(g > -1e-6 && g < 0.5, "{shape:?} k={k}: gap {g}");
                }
            }
        }
    }
}
