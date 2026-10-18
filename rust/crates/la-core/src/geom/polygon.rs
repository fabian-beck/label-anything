//! Polygon utilities: area, containment, hull, distances, intersection tests, polylabel.
//!
//! A polygon is a list of rings (`Vec<Vec<P>>`); rings are implicitly closed. With the
//! non-zero rule the first ring is usually the outer boundary and the rest are holes
//! (their orientation does not matter for even-odd).

use super::{dist_point_seg, orient, seg_cross_proper, seg_seg_dist, Rect, EPS, P};
use crate::math::{maxf, minf};

/// Signed area (shoelace), positive for counter-clockwise rings in math orientation
/// (clockwise on screen with y down).
pub fn signed_area(ring: &[P]) -> f64 {
    let n = ring.len();
    if n < 3 {
        return 0.0;
    }
    let mut s = 0.0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        s += a.x * b.y - b.x * a.y;
    }
    s * 0.5
}

/// Turns every hole (ring after the first) against the outer ring, so that the non-zero
/// rule cuts it out whichever way it was given (spec §3.2).
pub fn orient_holes(rings: &mut [Vec<P>]) {
    let Some((outer, holes)) = rings.split_first_mut() else {
        return;
    };
    let outer = signed_area(outer);
    for h in holes {
        if signed_area(h) * outer > 0.0 {
            h.reverse();
        }
    }
}

/// Winding number of `p` with respect to one ring.
pub fn winding(ring: &[P], p: P) -> i32 {
    let n = ring.len();
    let mut w = 0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        if a.y <= p.y {
            if b.y > p.y && orient(a, b, p) > 0.0 {
                w += 1;
            }
        } else if b.y <= p.y && orient(a, b, p) < 0.0 {
            w -= 1;
        }
    }
    w
}

/// Point-in-polygon for multi-ring polygons with the non-zero or even-odd rule.
pub fn contains(rings: &[Vec<P>], even_odd: bool, p: P) -> bool {
    if even_odd {
        let mut inside = false;
        for r in rings {
            let n = r.len();
            for i in 0..n {
                let a = r[i];
                let b = r[(i + 1) % n];
                if (a.y > p.y) != (b.y > p.y) {
                    let x = a.x + (p.y - a.y) / (b.y - a.y) * (b.x - a.x);
                    if p.x < x {
                        inside = !inside;
                    }
                }
            }
        }
        inside
    } else {
        let mut w = 0;
        for r in rings {
            w += winding(r, p);
        }
        w != 0
    }
}

/// Distance from `p` to the polygon boundary (unsigned).
pub fn dist_boundary(rings: &[Vec<P>], p: P) -> f64 {
    let mut m = f64::INFINITY;
    for r in rings {
        let n = r.len();
        for i in 0..n {
            m = minf(m, dist_point_seg(p, r[i], r[(i + 1) % n]));
        }
    }
    m
}

/// Convex hull (Andrew's monotone chain). Returns vertices counter-clockwise in math
/// orientation, without collinear points. Deterministic for identical input.
pub fn convex_hull(points: &[P]) -> Vec<P> {
    let mut pts: Vec<P> = points.iter().copied().filter(|p| p.is_finite()).collect();
    crate::sort::sort_by(&mut pts, |a, b| {
        crate::math::cmp_f64(a.x, b.x).then(crate::math::cmp_f64(a.y, b.y))
    });
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let mut lower: Vec<P> = Vec::with_capacity(pts.len());
    for &p in &pts {
        while lower.len() >= 2 && orient(lower[lower.len() - 2], lower[lower.len() - 1], p) <= 0.0 {
            lower.pop();
        }
        lower.push(p);
    }
    let mut upper: Vec<P> = Vec::with_capacity(pts.len());
    for &p in pts.iter().rev() {
        while upper.len() >= 2 && orient(upper[upper.len() - 2], upper[upper.len() - 1], p) <= 0.0 {
            upper.pop();
        }
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

/// All edges of a multi-ring polygon as segment pairs.
pub fn edges(rings: &[Vec<P>]) -> impl Iterator<Item = (P, P)> + '_ {
    rings.iter().flat_map(|r| {
        let n = r.len();
        (0..n).map(move |i| (r[i], r[(i + 1) % n]))
    })
}

/// The open rectangle `r` intersects the polygon's interior (overlap > `EPS`).
pub fn overlaps_rect(rings: &[Vec<P>], even_odd: bool, bbox: &Rect, r: &Rect) -> bool {
    if !bbox.overlaps(r) {
        return false;
    }
    let inner = r.inflate(-EPS);
    if inner.is_empty() {
        return false;
    }
    // 1. A polygon edge passes through the rectangle interior.
    for (a, b) in edges(rings) {
        if super::seg_overlaps_rect(a, b, &inner) {
            return true;
        }
    }
    // 2. No edge enters the rectangle: either the rectangle is inside the polygon or
    //    disjoint (or the polygon is inside the rectangle).
    if contains(rings, even_odd, inner.center()) {
        return true;
    }
    // 3. Polygon inside rectangle: any vertex strictly inside.
    for ring in rings {
        if let Some(&v) = ring.first() {
            if inner.contains_point(v) {
                return true;
            }
        }
    }
    false
}

/// Rectangle `r` lies completely inside the polygon (with clearance `pad` from the
/// boundary).
pub fn contains_rect(rings: &[Vec<P>], even_odd: bool, r: &Rect, pad: f64) -> bool {
    let rr = r.inflate(pad);
    for c in rr.corners() {
        if !contains(rings, even_odd, c) {
            return false;
        }
    }
    let rc = rr.corners();
    for (a, b) in edges(rings) {
        // Any boundary edge entering the rectangle invalidates containment.
        if super::seg_overlaps_rect(a, b, &rr) {
            return false;
        }
        for i in 0..4 {
            if seg_cross_proper(a, b, rc[i], rc[(i + 1) % 4]) {
                return false;
            }
        }
    }
    true
}

/// Distance between the polygon (as an area) and a rectangle; 0 if they overlap or touch.
pub fn dist_rect(rings: &[Vec<P>], even_odd: bool, bbox: &Rect, r: &Rect) -> f64 {
    if overlaps_rect(rings, even_odd, bbox, r) {
        return 0.0;
    }
    let rc = r.corners();
    let mut m = f64::INFINITY;
    for (a, b) in edges(rings) {
        for i in 0..4 {
            m = minf(m, seg_seg_dist(a, b, rc[i], rc[(i + 1) % 4]));
        }
    }
    m
}

/// Starting cells of [`polylabel`] at most (beyond, the cells grow; normal shapes have
/// far fewer: one per `min(w, h)` square of the bounding box).
pub const POLYLABEL_START_CELLS: f64 = 4096.0;

/// Refinement iterations of [`polylabel`] at most: `clamp(POLYLABEL_EDGE_WORK / edges,
/// 256, 100 000)`, so that huge polygons stay fast (polygons of up to 500 edges get the
/// full 100 000).
pub const POLYLABEL_EDGE_WORK: usize = 50_000_000;

/// Polylabel: the pole of inaccessibility (point inside the polygon farthest from its
/// boundary), with the given precision. Returns the point and its distance.
///
/// Deterministic: the queue is ordered by (potential, insertion index).
pub fn polylabel(rings: &[Vec<P>], even_odd: bool, precision: f64) -> (P, f64) {
    let bb = super::bbox_of(rings.first().map(|r| r.as_slice()).unwrap_or(&[]));
    if bb.is_empty() {
        return (P::new(0.0, 0.0), 0.0);
    }
    let w = bb.w();
    let h = bb.h();
    let mut cell = minf(w, h);
    if cell <= 0.0 {
        return (bb.center(), 0.0);
    }
    // at most about POLYLABEL_START_CELLS starting cells (extreme aspect ratios); a
    // cell larger than the short side leaves one row of max(w, h) / cell cells
    if (w / cell) * (h / cell) > POLYLABEL_START_CELLS {
        cell = maxf(
            (w * h / POLYLABEL_START_CELLS).sqrt(),
            maxf(w, h) / POLYLABEL_START_CELLS,
        );
    }
    let sdist = |p: P| -> f64 {
        let d = dist_boundary(rings, p);
        if contains(rings, even_odd, p) {
            d
        } else {
            -d
        }
    };
    #[derive(Clone, Copy)]
    struct Cell {
        c: P,
        h: f64,
        d: f64,
        max: f64,
        seq: u64,
    }
    impl PartialEq for Cell {
        fn eq(&self, o: &Self) -> bool {
            self.seq == o.seq
        }
    }
    impl Eq for Cell {}
    impl PartialOrd for Cell {
        fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
            Some(self.cmp(o))
        }
    }
    impl Ord for Cell {
        // Max-heap on potential; ties: lower sequence number first.
        fn cmp(&self, o: &Self) -> std::cmp::Ordering {
            crate::math::cmp_f64(self.max, o.max).then(o.seq.cmp(&self.seq))
        }
    }
    let sqrt2 = std::f64::consts::SQRT_2;
    let mk = |c: P, h: f64, seq: u64| -> Cell {
        let d = sdist(c);
        Cell {
            c,
            h,
            d,
            max: d + h * sqrt2,
            seq,
        }
    };
    let mut seq = 0u64;
    let mut queue = std::collections::BinaryHeap::new();
    let half = cell * 0.5;
    let mut y = bb.y0;
    while y < bb.y1 {
        let mut x = bb.x0;
        while x < bb.x1 {
            queue.push(mk(P::new(x + half, y + half), half, seq));
            seq += 1;
            x += cell;
        }
        y += cell;
    }
    // Initial best: centroid, then bbox center.
    let centroid = ring_centroid(&rings[0]);
    let mut best = mk(centroid, 0.0, u64::MAX);
    let bc = mk(bb.center(), 0.0, u64::MAX);
    if bc.d > best.d {
        best = bc;
    }
    // bounded work: each iteration evaluates 4 cells, each O(edges)
    let edges: usize = rings.iter().map(|r| r.len()).sum();
    let max_iterations = (POLYLABEL_EDGE_WORK / edges.max(1)).clamp(256, 100_000);
    let mut iterations = 0usize;
    while let Some(c) = queue.pop() {
        iterations += 1;
        if iterations > max_iterations {
            break;
        }
        if c.d > best.d {
            best = c;
        }
        if c.max - best.d <= precision {
            continue;
        }
        let h2 = c.h * 0.5;
        for (dx, dy) in [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)] {
            queue.push(mk(P::new(c.c.x + dx * h2, c.c.y + dy * h2), h2, seq));
            seq += 1;
        }
    }
    (best.c, maxf(best.d, 0.0))
}

/// Area centroid of a ring (falls back to the vertex mean for degenerate rings).
pub fn ring_centroid(ring: &[P]) -> P {
    let n = ring.len();
    if n == 0 {
        return P::new(0.0, 0.0);
    }
    let mut a = 0.0;
    let mut cx = 0.0;
    let mut cy = 0.0;
    for i in 0..n {
        let p = ring[i];
        let q = ring[(i + 1) % n];
        let f = p.x * q.y - q.x * p.y;
        a += f;
        cx += (p.x + q.x) * f;
        cy += (p.y + q.y) * f;
    }
    if a.abs() < 1e-12 {
        let mut s = P::new(0.0, 0.0);
        for &p in ring {
            s = s + p;
        }
        return s * (1.0 / n as f64);
    }
    P::new(cx / (3.0 * a), cy / (3.0 * a))
}

/// Total absolute area of a multi-ring polygon under its fill rule, approximated by the
/// signed-area sum for non-zero (outer minus holes when holes are oppositely oriented)
/// and by |outer| − Σ|holes| for even-odd.
pub fn area(rings: &[Vec<P>], even_odd: bool) -> f64 {
    if rings.is_empty() {
        return 0.0;
    }
    if even_odd {
        let mut a = signed_area(&rings[0]).abs();
        for r in &rings[1..] {
            a -= signed_area(r).abs();
        }
        maxf(a, 0.0)
    } else {
        let mut s = 0.0;
        for r in rings {
            s += signed_area(r);
        }
        s.abs()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(x: f64, y: f64, s: f64) -> Vec<P> {
        vec![
            P::new(x, y),
            P::new(x + s, y),
            P::new(x + s, y + s),
            P::new(x, y + s),
        ]
    }

    #[test]
    fn containment_rules() {
        let outer = square(0.0, 0.0, 10.0);
        let hole = square(3.0, 3.0, 4.0);
        let rings = vec![outer.clone(), hole.clone()];
        assert!(contains(&rings, true, P::new(1.0, 1.0)));
        assert!(!contains(&rings, true, P::new(5.0, 5.0)));
        // non-zero with same orientation: hole is filled
        assert!(contains(&rings, false, P::new(5.0, 5.0)));
        let mut rev = hole;
        rev.reverse();
        assert!(!contains(&[outer, rev], false, P::new(5.0, 5.0)));
    }

    #[test]
    fn hull_square_with_inner_points() {
        let mut pts = square(0.0, 0.0, 10.0);
        pts.push(P::new(5.0, 5.0));
        pts.push(P::new(5.0, 0.0));
        let h = convex_hull(&pts);
        assert_eq!(h.len(), 4);
    }

    #[test]
    fn rect_tests() {
        let poly = vec![square(0.0, 0.0, 10.0)];
        let bb = Rect::xywh(0.0, 0.0, 10.0, 10.0);
        assert!(overlaps_rect(
            &poly,
            false,
            &bb,
            &Rect::xywh(5.0, 5.0, 10.0, 10.0)
        ));
        assert!(!overlaps_rect(
            &poly,
            false,
            &bb,
            &Rect::xywh(10.0, 0.0, 5.0, 5.0)
        ));
        assert!(overlaps_rect(
            &poly,
            false,
            &bb,
            &Rect::xywh(2.0, 2.0, 1.0, 1.0)
        ));
        assert!(contains_rect(
            &poly,
            false,
            &Rect::xywh(2.0, 2.0, 3.0, 3.0),
            0.5
        ));
        assert!(!contains_rect(
            &poly,
            false,
            &Rect::xywh(8.0, 2.0, 3.0, 3.0),
            0.0
        ));
        assert!(
            (dist_rect(&poly, false, &bb, &Rect::xywh(13.0, 0.0, 2.0, 2.0)) - 3.0).abs() < 1e-12
        );
    }

    #[test]
    fn polylabel_square_center() {
        let (p, d) = polylabel(&[square(0.0, 0.0, 10.0)], false, 0.1);
        assert!((p.x - 5.0).abs() < 0.2 && (p.y - 5.0).abs() < 0.2);
        assert!((d - 5.0).abs() < 0.2);
    }

    #[test]
    fn polylabel_l_shape() {
        let l = vec![
            P::new(0.0, 0.0),
            P::new(100.0, 0.0),
            P::new(100.0, 20.0),
            P::new(20.0, 20.0),
            P::new(20.0, 100.0),
            P::new(0.0, 100.0),
        ];
        let (p, d) = polylabel(std::slice::from_ref(&l), false, 0.5);
        assert!(contains(&[l], false, p));
        assert!(d >= 9.0);
    }
}
