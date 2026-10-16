//! Differential oracle of the geometry kernel for the TypeScript port.
//!
//! Generates deterministic pseudo-random inputs (PCG32 with a fixed seed), evaluates them
//! with this crate (points, rectangles, segments, affine maps, polygons, the shape kernel,
//! SVG paths, the vector rasterizer, summed-area tables, the distance transform and the
//! spatial indexes) and writes inputs and outputs to
//! `conformance/geometry/core-geometry.json`. `ts/packages/core/test/geometry-oracle.test.ts`
//! recomputes every output and compares it bit for bit (`Object.is`).
//!
//! Run from `rust/`:
//!
//! ```text
//! cargo run -p label-anything-core --example geom_oracle             # rewrite the fixture
//! cargo run -p label-anything-core --example geom_oracle -- --check  # fail if it is stale
//! ```
//!
//! `cargo test -p label-anything-core --test geom_oracle` runs the check as well.
//!
//! Format: `{"kind": "geometry", ..., "sections": {name: [{"in": {...}, "out": {...}}]}}`.
//! Floats are JSON numbers in shortest round-trip form (`JSON.parse` reads them exactly);
//! non-finite values are the strings `"inf"`, `"-inf"` and `"nan"`. Coverage grids are
//! base64 strings of the `u8` cells (row-major).

use la_expr::det_math::{sin_cos_deg, Pcg32};
use label_anything_core::geom::path::flatten;
use label_anything_core::geom::shape::{shapes_overlap, sign_dir, Shape};
use label_anything_core::geom::{self, polygon, Affine, Rect, P};
use label_anything_core::grid::dt::{distance_transform, dt_maxima};
use label_anything_core::grid::raster::MaskRaster;
use label_anything_core::grid::{quantize, GridSpec, Sat};
use label_anything_core::index::{DynIndex, StaticIndex};
use label_anything_core::math;
use serde_json::{Map, Value};

/// The fixture, relative to the repository root.
pub const FIXTURE: &str = "conformance/geometry/core-geometry.json";

/// Seed of the input generator.
const SEED: u64 = 20261016;

/// Largest fixture size we accept (bytes).
const MAX_BYTES: usize = 300_000;

/// Absolute path of the fixture.
pub fn fixture_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join(FIXTURE)
}

#[allow(dead_code)]
fn main() {
    let check = std::env::args().any(|a| a == "--check");
    let text = generate();
    let path = fixture_path();
    if check {
        let old = std::fs::read_to_string(&path).unwrap_or_default();
        if old != text {
            eprintln!(
                "{} is stale: run `cargo run -p label-anything-core --example geom_oracle`",
                FIXTURE
            );
            std::process::exit(1);
        }
        eprintln!("{FIXTURE} is up to date ({} bytes)", text.len());
    } else {
        std::fs::create_dir_all(path.parent().expect("fixture dir")).expect("create dir");
        std::fs::write(&path, &text).expect("write fixture");
        eprintln!("wrote {FIXTURE} ({} bytes)", text.len());
    }
}

// ---------------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------------

fn num(v: f64) -> Value {
    if v.is_nan() {
        Value::from("nan")
    } else if v == f64::INFINITY {
        Value::from("inf")
    } else if v == f64::NEG_INFINITY {
        Value::from("-inf")
    } else {
        Value::from(v)
    }
}

fn pt(p: P) -> Value {
    Value::Array(vec![num(p.x), num(p.y)])
}

fn pts(ps: &[P]) -> Value {
    Value::Array(ps.iter().map(|&p| pt(p)).collect())
}

fn rings_json(rs: &[Vec<P>]) -> Value {
    Value::Array(rs.iter().map(|r| pts(r)).collect())
}

fn rect(r: &Rect) -> Value {
    Value::Array(vec![num(r.x0), num(r.y0), num(r.x1), num(r.y1)])
}

fn nums(v: &[f64]) -> Value {
    Value::Array(v.iter().map(|&x| num(x)).collect())
}

fn ints<T: Copy + Into<u64>>(v: &[T]) -> Value {
    Value::Array(v.iter().map(|&x| Value::from(x.into())).collect())
}

/// A point list as its length, end points and the FNV-1a (32-bit) hash of the
/// little-endian bytes of all coordinates (x, y per point).
fn digest(ps: &[P]) -> Value {
    let mut h: u32 = 0x811c_9dc5;
    for p in ps {
        for v in [p.x, p.y] {
            for b in v.to_bits().to_le_bytes() {
                h = (h ^ u32::from(b)).wrapping_mul(0x0100_0193);
            }
        }
    }
    obj(vec![
        ("n", Value::from(ps.len())),
        ("first", ps.first().map_or(Value::Null, |&p| pt(p))),
        ("last", ps.last().map_or(Value::Null, |&p| pt(p))),
        ("fnv1a32", Value::from(format!("{h:08x}"))),
    ])
}

fn obj(fields: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in fields {
        m.insert(k.to_string(), v);
    }
    Value::Object(m)
}

fn case(input: Value, output: Value) -> Value {
    obj(vec![("in", input), ("out", output)])
}

fn grid_json(g: &GridSpec) -> Value {
    obj(vec![
        ("ox", num(g.ox)),
        ("oy", num(g.oy)),
        ("cell", num(g.cell)),
        ("cols", Value::from(g.cols)),
        ("rows", Value::from(g.rows)),
    ])
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        s.push(A[(n >> 18) as usize & 63] as char);
        s.push(A[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 {
            A[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        s.push(if c.len() > 2 {
            A[n as usize & 63] as char
        } else {
            '='
        });
    }
    s
}

// ---------------------------------------------------------------------------------
// Input generator
// ---------------------------------------------------------------------------------

struct Gen(Pcg32);

impl Gen {
    fn f(&mut self) -> f64 {
        self.0.next_f64()
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.f()
    }
    fn below(&mut self, n: u32) -> u32 {
        self.0.next_below(n)
    }
    fn int(&mut self, lo: u32, hi: u32) -> u32 {
        lo + self.below(hi - lo + 1)
    }
    fn chance(&mut self, p: f64) -> bool {
        self.f() < p
    }
    /// A coordinate: snapped to quarters (to provoke ties and touching) or rounded to
    /// three decimals (short in JSON, still inexact in binary).
    fn coord(&mut self, lo: f64, hi: f64) -> f64 {
        let v = self.range(lo, hi);
        if self.chance(0.4) {
            (v * 4.0).round() / 4.0
        } else {
            (v * 1000.0).round() / 1000.0
        }
    }
    fn point(&mut self, lo: f64, hi: f64) -> P {
        let x = self.coord(lo, hi);
        let y = self.coord(lo, hi);
        P::new(x, y)
    }
    fn rect(&mut self, lo: f64, hi: f64, max_size: f64) -> Rect {
        let x = self.coord(lo, hi);
        let y = self.coord(lo, hi);
        let w = self.coord(0.0, max_size);
        let h = self.coord(0.0, max_size);
        Rect::xywh(x, y, w, h)
    }
    /// A direction: one of the 8 compass directions, the zero vector or a random one.
    fn dir(&mut self) -> P {
        const D: [(f64, f64); 9] = [
            (1.0, 0.0),
            (1.0, 1.0),
            (0.0, 1.0),
            (-1.0, 1.0),
            (-1.0, 0.0),
            (-1.0, -1.0),
            (0.0, -1.0),
            (1.0, -1.0),
            (0.0, 0.0),
        ];
        if self.chance(0.5) {
            let (x, y) = D[self.below(9) as usize];
            P::new(x, y)
        } else {
            let a = self.range(-180.0, 180.0);
            let l = self.range(0.1, 3.0);
            P::new(a.to_radians().cos() * l, a.to_radians().sin() * l)
        }
    }
}

/// A star-shaped ring around `c` (concave for alternating radii); clockwise on screen
/// when `ccw` is false.
fn star(g: &mut Gen, c: P, n: usize, r0: f64, r1: f64, ccw: bool) -> Vec<P> {
    let snap = g.chance(0.3);
    let mut ring = Vec::with_capacity(n);
    for k in 0..n {
        let a = (k as f64 + g.range(-0.2, 0.2)) / n as f64 * std::f64::consts::TAU;
        let a = if ccw { a } else { -a };
        let r = if k % 2 == 0 { r0 } else { r1 } * g.range(0.85, 1.15);
        let mut p = P::new(c.x + a.cos() * r, c.y + a.sin() * r);
        if snap {
            p = P::new((p.x * 2.0).round() / 2.0, (p.y * 2.0).round() / 2.0);
        }
        ring.push(p);
    }
    ring
}

/// A polygon: concave stars, holes (either orientation), axis-aligned and
/// self-intersecting rings, degenerate rings.
fn random_rings(g: &mut Gen, c: P, size: f64) -> Vec<Vec<P>> {
    match g.below(6) {
        0 => {
            let n = g.int(5, 14) as usize;
            let ccw = g.chance(0.5);
            let r1 = size * g.range(0.4, 0.9);
            vec![star(g, c, n, size, r1, ccw)]
        }
        1 => {
            let n = g.int(6, 12) as usize;
            let outer = star(g, c, n, size, size * 0.8, true);
            let hole_ccw = g.chance(0.5);
            let hole = star(g, c, 4, size * 0.35, size * 0.3, hole_ccw);
            let mut rings = vec![outer, hole];
            if g.chance(0.4) {
                let c2 = P::new(c.x + size * 0.5, c.y);
                rings.push(star(g, c2, 3, size * 0.15, size * 0.15, true));
            }
            rings
        }
        2 => {
            // axis-aligned, integer coordinates (edges on cell boundaries, touching cases)
            let x0 = c.x.round();
            let y0 = c.y.round();
            let s = size.round().max(2.0);
            vec![
                vec![
                    P::new(x0 - s, y0 - s),
                    P::new(x0 + s, y0 - s),
                    P::new(x0 + s, y0),
                    P::new(x0, y0),
                    P::new(x0, y0 + s),
                    P::new(x0 - s, y0 + s),
                ],
                vec![
                    P::new(x0 - s + 1.0, y0 - s + 1.0),
                    P::new(x0 - s + 1.0, y0 - 1.0),
                    P::new(x0 - 1.0, y0 - 1.0),
                    P::new(x0 - 1.0, y0 - s + 1.0),
                ],
            ]
        }
        3 => {
            // self-intersecting
            let n = g.int(5, 8) as usize;
            let mut ring = Vec::with_capacity(n);
            for _ in 0..n {
                let x = c.x + g.range(-size, size);
                let y = c.y + g.range(-size, size);
                ring.push(P::new(x, y));
            }
            vec![ring]
        }
        4 => {
            // pentagram (winding number 2 in the middle)
            let mut ring = Vec::new();
            for k in 0..5 {
                let a = (k as f64 * 2.0 / 5.0) * std::f64::consts::TAU;
                ring.push(P::new(c.x + a.cos() * size, c.y + a.sin() * size));
            }
            vec![ring]
        }
        _ => {
            // triangle plus a degenerate ring
            vec![
                vec![
                    P::new(c.x - size, c.y + size),
                    P::new(c.x + size, c.y + size),
                    P::new(c.x, c.y - size),
                ],
                vec![P::new(c.x, c.y), P::new(c.x + 1.0, c.y)],
            ]
        }
    }
}

/// Shape descriptor (what the TypeScript test passes to the `Shape` constructors).
#[derive(Clone)]
enum Desc {
    Circle(P, f64),
    Ellipse(P, f64, f64, f64),
    Rect(P, f64, f64, f64, f64),
    Polygon(Vec<Vec<P>>, bool, P),
}

impl Desc {
    fn build(&self) -> Shape {
        match self {
            Desc::Circle(c, r) => Shape::circle(*c, *r),
            Desc::Ellipse(c, rx, ry, rot) => Shape::ellipse(*c, *rx, *ry, *rot),
            Desc::Rect(c, w, h, cr, rot) => Shape::rect(*c, *w, *h, *cr, *rot),
            Desc::Polygon(rings, eo, reference) => Shape::polygon(rings.clone(), *eo, *reference),
        }
    }
    fn json(&self) -> Value {
        match self {
            Desc::Circle(c, r) => obj(vec![
                ("kind", "circle".into()),
                ("c", pt(*c)),
                ("r", num(*r)),
            ]),
            Desc::Ellipse(c, rx, ry, rot) => obj(vec![
                ("kind", "ellipse".into()),
                ("c", pt(*c)),
                ("rx", num(*rx)),
                ("ry", num(*ry)),
                ("rotation", num(*rot)),
            ]),
            Desc::Rect(c, w, h, cr, rot) => obj(vec![
                ("kind", "rect".into()),
                ("c", pt(*c)),
                ("w", num(*w)),
                ("h", num(*h)),
                ("corner_radius", num(*cr)),
                ("rotation", num(*rot)),
            ]),
            Desc::Polygon(rings, eo, reference) => obj(vec![
                ("kind", "polygon".into()),
                ("rings", rings_json(rings)),
                ("even_odd", Value::from(*eo)),
                ("reference", pt(*reference)),
            ]),
        }
    }
}

fn random_desc(g: &mut Gen, kind: u32, k: u32) -> Desc {
    let c = g.point(20.0, 80.0);
    let rot = match k % 4 {
        0 => 0.0,
        1 => 90.0,
        2 => 30.0,
        _ => g.coord(-360.0, 360.0),
    };
    match kind {
        0 => {
            let r = match k % 4 {
                0 => 0.0,
                1 => g.coord(0.0, 2.0),
                _ => g.coord(2.0, 25.0),
            };
            Desc::Circle(c, r)
        }
        1 => {
            let rx = g.coord(1.0, 25.0);
            let ry = match k % 5 {
                0 => rx,
                1 => 0.0,
                _ => g.coord(1.0, 25.0),
            };
            Desc::Ellipse(c, rx, ry, rot)
        }
        2 => {
            let w = if k % 7 == 3 { 0.0 } else { g.coord(0.0, 40.0) };
            let h = g.coord(0.0, 30.0);
            let cr = match k % 3 {
                0 => 0.0,
                1 => g.coord(0.0, 8.0),
                _ => 100.0,
            };
            Desc::Rect(c, w, h, cr, rot)
        }
        _ => {
            let size = g.coord(6.0, 25.0);
            let rings = random_rings(g, c, size);
            let eo = g.chance(0.5);
            let reference = if k % 4 == 3 {
                P::new(c.x + size * 3.0, c.y)
            } else {
                c
            };
            Desc::Polygon(rings, eo, reference)
        }
    }
}

/// The fields of a built shape (the TypeScript class fields).
fn shape_fields(s: &Shape) -> Value {
    match s {
        Shape::Circle { c, r } => obj(vec![
            ("kind", "circle".into()),
            ("c", pt(*c)),
            ("r", num(*r)),
        ]),
        Shape::Ellipse {
            c,
            rx,
            ry,
            cos,
            sin,
        } => obj(vec![
            ("kind", "ellipse".into()),
            ("c", pt(*c)),
            ("rx", num(*rx)),
            ("ry", num(*ry)),
            ("cos", num(*cos)),
            ("sin", num(*sin)),
        ]),
        Shape::RoundRect {
            c,
            hw,
            hh,
            r,
            cos,
            sin,
        } => obj(vec![
            ("kind", "roundRect".into()),
            ("c", pt(*c)),
            ("hw", num(*hw)),
            ("hh", num(*hh)),
            ("r", num(*r)),
            ("cos", num(*cos)),
            ("sin", num(*sin)),
        ]),
        Shape::Polygon(p) => obj(vec![
            ("kind", "polygon".into()),
            ("hull", pts(&p.hull)),
            ("bbox", rect(&p.bbox)),
        ]),
    }
}

// ---------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------

fn section_math() -> Vec<Value> {
    let special = [0.0, -0.0, 1.0, -2.5, f64::INFINITY, f64::NAN, 3.0];
    let mut out = Vec::new();
    for &a in &special {
        for &b in &special {
            let cmp = match math::cmp_f64(a, b) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            };
            out.push(case(
                obj(vec![("a", num(a)), ("b", num(b))]),
                obj(vec![
                    ("minf", num(math::minf(a, b))),
                    ("maxf", num(math::maxf(a, b))),
                    ("clampf", num(math::clampf(a, b, 2.0))),
                    ("sign_eps", num(math::sign_eps(a, b.abs()))),
                    ("cmp_f64", Value::from(cmp)),
                    ("len2d", num(math::len2d(a, b))),
                ]),
            ));
        }
    }
    let xs = [
        0.0,
        -0.0,
        0.5,
        -0.5,
        2.5,
        -2.5,
        4503599627370495.5,
        -4503599627370495.5,
        9.3e18,
        -9.3e18,
        9223372036854775807.0,
        -9223372036854775808.0,
        1e300,
        -1e300,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NAN,
    ];
    out.push(case(
        obj(vec![("floor_ceil", nums(&xs))]),
        obj(vec![
            (
                "floor_fast",
                nums(&xs.iter().map(|&x| math::floor_fast(x)).collect::<Vec<_>>()),
            ),
            (
                "ceil_fast",
                nums(&xs.iter().map(|&x| math::ceil_fast(x)).collect::<Vec<_>>()),
            ),
        ]),
    ));
    out
}

fn section_point(g: &mut Gen) -> Vec<Value> {
    let mut out = Vec::new();
    for i in 0..16 {
        let a = if i == 0 {
            P::new(0.0, 0.0)
        } else {
            g.point(-50.0, 50.0)
        };
        let b = g.point(-50.0, 50.0);
        let t = g.coord(-0.5, 1.5);
        let s = g.coord(-3.0, 3.0);
        let deg = if i % 3 == 0 {
            90.0 * (i / 3) as f64
        } else {
            g.coord(-720.0, 720.0)
        };
        let (sin, cos) = sin_cos_deg(deg);
        out.push(case(
            obj(vec![
                ("a", pt(a)),
                ("b", pt(b)),
                ("t", num(t)),
                ("s", num(s)),
                ("deg", num(deg)),
            ]),
            obj(vec![
                ("sin_cos", nums(&[sin, cos])),
                ("dot", num(a.dot(b))),
                ("cross", num(a.cross(b))),
                ("len", num(a.len())),
                ("len2", num(a.len2())),
                ("norm", pt(a.norm())),
                ("perp", pt(a.perp())),
                ("dist", num(a.dist(b))),
                ("lerp", pt(a.lerp(b, t))),
                ("rotate", pt(a.rotate(cos, sin))),
                ("unrotate", pt(a.unrotate(cos, sin))),
                ("add", pt(a + b)),
                ("sub", pt(a - b)),
                ("mul", pt(a * s)),
                ("neg", pt(-a)),
                ("is_finite", Value::from(a.is_finite())),
                ("sign_dir", {
                    let (x, y) = sign_dir(a);
                    nums(&[x, y])
                }),
            ]),
        ));
    }
    out
}

fn section_rect(g: &mut Gen) -> Vec<Value> {
    let mut out = Vec::new();
    for i in 0..24 {
        let a = match i % 12 {
            0 => Rect::EMPTY,
            1 => {
                // inverted
                let r = g.rect(0.0, 50.0, 20.0);
                Rect::new(r.x1, r.y1, r.x0, r.y0)
            }
            _ => g.rect(0.0, 50.0, 30.0),
        };
        let b = if i % 4 == 0 {
            // touching or slightly overlapping a
            let dx = [0.0, 1e-7, 2e-6, -1e-6][g.below(4) as usize];
            Rect::xywh(a.x1 - dx, a.y0, g.coord(1.0, 10.0), g.coord(1.0, 10.0))
        } else {
            g.rect(0.0, 50.0, 30.0)
        };
        let p = if i % 5 == 0 {
            P::new(a.x0, a.y1)
        } else {
            g.point(-10.0, 70.0)
        };
        let d = g.coord(-3.0, 3.0);
        out.push(case(
            obj(vec![
                ("a", rect(&a)),
                ("b", rect(&b)),
                ("p", pt(p)),
                ("d", num(d)),
            ]),
            obj(vec![
                ("w", num(a.w())),
                ("h", num(a.h())),
                ("area", num(a.area())),
                ("center", pt(a.center())),
                ("is_empty", Value::from(a.is_empty())),
                ("inflate", rect(&a.inflate(d))),
                ("translate", rect(&a.translate(p))),
                ("union", rect(&a.union(&b))),
                ("add_point", rect(&a.add_point(p))),
                ("overlaps", Value::from(a.overlaps(&b))),
                ("touches", Value::from(a.touches(&b))),
                ("intersection", rect(&a.intersection(&b))),
                ("overlap_area", num(a.overlap_area(&b))),
                ("contains_point", Value::from(a.contains_point(p))),
                ("contains_rect", Value::from(a.contains_rect(&b))),
                ("dist_point", num(a.dist_point(p))),
                ("closest_point", pt(a.closest_point(p))),
                ("dist_rect", num(a.dist_rect(&b))),
                ("corners", pts(&a.corners())),
                ("xywh", rect(&Rect::xywh(p.x, p.y, d, d * 2.0))),
                ("from_center", rect(&Rect::from_center(p, d, -d))),
            ]),
        ));
    }
    out
}

fn section_affine(g: &mut Gen) -> Vec<Value> {
    let mut out = Vec::new();
    for i in 0..8 {
        let mut m = [0.0; 6];
        for v in m.iter_mut() {
            *v = g.coord(-3.0, 3.0);
        }
        if i == 0 {
            m = Affine::IDENTITY.0;
        }
        let a = Affine(m);
        let mut n = [0.0; 6];
        for v in n.iter_mut() {
            *v = g.coord(-3.0, 3.0);
        }
        let b = Affine(n);
        let p = g.point(-100.0, 100.0);
        out.push(case(
            obj(vec![("a", nums(&a.0)), ("b", nums(&b.0)), ("p", pt(p))]),
            obj(vec![
                ("apply", pt(a.apply(p))),
                ("then", nums(&a.then(&b).0)),
                ("is_identity", Value::from(a.is_identity())),
            ]),
        ));
    }
    out
}

fn section_segment(g: &mut Gen) -> Vec<Value> {
    let mut out = Vec::new();
    for i in 0..56 {
        let (a, b, c, d) = match i % 5 {
            0 => {
                // integer grid: collinear, touching and crossing cases
                let mut q = || P::new(g.int(0, 6) as f64, g.int(0, 6) as f64);
                (q(), q(), q(), q())
            }
            1 => {
                // degenerate first segment
                let a = g.point(0.0, 10.0);
                (a, a, g.point(0.0, 10.0), g.point(0.0, 10.0))
            }
            2 => {
                // cd crosses (or touches) ab at its middle
                let a = g.point(0.0, 10.0);
                let b = g.point(0.0, 10.0);
                let m = a.lerp(b, 0.5);
                let n = (b - a).perp() * [0.0, 0.25, 1.0][g.below(3) as usize];
                (a, b, m + n, m - n * g.range(0.0, 2.0))
            }
            _ => (
                g.point(0.0, 10.0),
                g.point(0.0, 10.0),
                g.point(0.0, 10.0),
                g.point(0.0, 10.0),
            ),
        };
        let p = g.point(-1.0, 11.0);
        let r = match i % 7 {
            0 => Rect::new(a.x, a.y, a.x + 3.0, a.y + 3.0), // segment starts on a corner
            1 => Rect::new(4.0, 4.0, 4.0, 9.0),             // zero width
            2 => Rect::from_center(a.lerp(b, 0.5), 1.0, 0.5), // overlapping the middle
            3 => Rect::new(a.x.min(b.x), a.y, a.x.max(b.x) + 1.0, a.y + 2.0), // a on an edge
            _ => g.rect(0.0, 8.0, 5.0),
        };
        let clip = match geom::clip_seg_rect(a, b, &r) {
            Some((t0, t1)) => nums(&[t0, t1]),
            None => Value::Null,
        };
        out.push(case(
            obj(vec![
                ("a", pt(a)),
                ("b", pt(b)),
                ("c", pt(c)),
                ("d", pt(d)),
                ("p", pt(p)),
                ("r", rect(&r)),
            ]),
            obj(vec![
                ("orient", num(geom::orient(a, b, c))),
                ("dist_point_seg", num(geom::dist_point_seg(p, a, b))),
                ("closest_on_seg", pt(geom::closest_on_seg(p, a, b))),
                (
                    "seg_intersects",
                    Value::from(geom::seg_intersects(a, b, c, d)),
                ),
                (
                    "seg_cross_proper",
                    Value::from(geom::seg_cross_proper(a, b, c, d)),
                ),
                ("seg_seg_dist", num(geom::seg_seg_dist(a, b, c, d))),
                ("seg_len_in_rect", num(geom::seg_len_in_rect(a, b, &r))),
                ("clip_seg_rect", clip),
                (
                    "seg_overlaps_rect",
                    Value::from(geom::seg_overlaps_rect(a, b, &r)),
                ),
                ("dist_seg_rect", num(geom::dist_seg_rect(a, b, &r))),
                ("bbox_of", rect(&geom::bbox_of(&[a, b, c, d, p]))),
            ]),
        ));
    }
    out
}

fn section_polygon(g: &mut Gen) -> Vec<Value> {
    let mut out = Vec::new();
    for i in 0..12 {
        let c = g.point(30.0, 70.0);
        let size = g.coord(8.0, 25.0);
        let rings = random_rings(g, c, size);
        let all: Vec<P> = rings.iter().flatten().copied().collect();
        let bbox = geom::bbox_of(&all);
        let mut points: Vec<P> = (0..7)
            .map(|_| {
                P::new(
                    g.coord(bbox.x0 - 3.0, bbox.x1 + 3.0),
                    g.coord(bbox.y0 - 3.0, bbox.y1 + 3.0),
                )
            })
            .collect();
        points.push(c);
        points.push(rings[0][0]); // a vertex
        points.push(rings[0][0].lerp(rings[0][1], 0.5)); // on an edge
        let mut rects: Vec<Rect> = (0..5)
            .map(|_| {
                let x = g.coord(bbox.x0 - 5.0, bbox.x1 + 2.0);
                let y = g.coord(bbox.y0 - 5.0, bbox.y1 + 2.0);
                Rect::xywh(x, y, g.coord(0.0, size), g.coord(0.0, size))
            })
            .collect();
        rects.push(Rect::new(bbox.x1, bbox.y0, bbox.x1 + 5.0, bbox.y1)); // touching the bbox
        rects.push(Rect::from_center(c, 1.0, 1.0));
        let pad = g.coord(0.0, 2.0);
        let precision = [0.5, 1.0, 0.1][i % 3];
        let per_point = |eo: bool| -> Value {
            Value::Array(
                points
                    .iter()
                    .map(|&p| Value::from(polygon::contains(&rings, eo, p)))
                    .collect(),
            )
        };
        let per_rect = |eo: bool| -> Value {
            Value::Array(
                rects
                    .iter()
                    .map(|r| {
                        Value::Array(vec![
                            Value::from(polygon::overlaps_rect(&rings, eo, &bbox, r)),
                            Value::from(polygon::contains_rect(&rings, eo, r, pad)),
                            num(polygon::dist_rect(&rings, eo, &bbox, r)),
                        ])
                    })
                    .collect(),
            )
        };
        let pole = |eo: bool| -> Value {
            let (p, d) = polygon::polylabel(&rings, eo, precision);
            Value::Array(vec![pt(p), num(d)])
        };
        out.push(case(
            obj(vec![
                ("rings", rings_json(&rings)),
                ("points", pts(&points)),
                ("rects", Value::Array(rects.iter().map(rect).collect())),
                ("pad", num(pad)),
                ("precision", num(precision)),
            ]),
            obj(vec![
                (
                    "signed_area",
                    nums(
                        &rings
                            .iter()
                            .map(|r| polygon::signed_area(r))
                            .collect::<Vec<_>>(),
                    ),
                ),
                ("area_even_odd", num(polygon::area(&rings, true))),
                ("area_nonzero", num(polygon::area(&rings, false))),
                ("ring_centroid", pt(polygon::ring_centroid(&rings[0]))),
                ("convex_hull", pts(&polygon::convex_hull(&all))),
                (
                    "winding",
                    Value::Array(
                        points
                            .iter()
                            .map(|&p| Value::from(polygon::winding(&rings[0], p)))
                            .collect(),
                    ),
                ),
                ("contains_even_odd", per_point(true)),
                ("contains_nonzero", per_point(false)),
                (
                    "dist_boundary",
                    nums(
                        &points
                            .iter()
                            .map(|&p| polygon::dist_boundary(&rings, p))
                            .collect::<Vec<_>>(),
                    ),
                ),
                ("rects_even_odd", per_rect(true)),
                ("rects_nonzero", per_rect(false)),
                ("polylabel_even_odd", pole(true)),
                ("polylabel_nonzero", pole(false)),
            ]),
        ));
    }
    // convex hulls of point clouds with duplicates, collinear points and non-finite ones
    for i in 0..8 {
        let n = g.int(0, 25);
        let mut cloud: Vec<P> = (0..n)
            .map(|_| {
                if i % 2 == 0 {
                    P::new(g.int(0, 5) as f64, g.int(0, 5) as f64)
                } else {
                    g.point(0.0, 10.0)
                }
            })
            .collect();
        if i == 3 {
            cloud.push(P::new(f64::NAN, 1.0));
            cloud.push(P::new(2.0, f64::INFINITY));
        }
        if i == 5 {
            cloud = (0..6).map(|k| P::new(k as f64, 2.0 * k as f64)).collect();
            cloud.push(P::new(-0.0, 0.0));
        }
        out.push(case(
            obj(vec![("hull_of", pts(&cloud))]),
            obj(vec![("convex_hull", pts(&polygon::convex_hull(&cloud)))]),
        ));
    }
    out
}

fn shape_case(g: &mut Gen, desc: &Desc) -> Value {
    let s = desc.build();
    let bb = s.bbox();
    let cx = (bb.x0 + bb.x1) * 0.5;
    let cy = (bb.y0 + bb.y1) * 0.5;
    let ext = (bb.w().max(bb.h()) * 0.5 + 4.0).min(60.0);
    let dirs: Vec<P> = (0..8).map(|_| g.dir()).collect();
    let mut points: Vec<P> = (0..4)
        .map(|_| P::new(g.coord(cx - ext, cx + ext), g.coord(cy - ext, cy + ext)))
        .collect();
    points.push(s.reference());
    points.push(P::new(cx + 500.0, cy - 3.0));
    // near the boundary: support points of random directions, nudged
    for k in 0..4 {
        let d = dirs[k];
        let sp = s.support(d);
        let nd = d.norm();
        let nudge = [0.0, 1e-7, -1e-7, 0.01][k];
        points.push(sp + nd * nudge);
    }
    let mut rects: Vec<Rect> = (0..3)
        .map(|_| {
            let x = g.coord(cx - ext, cx + ext);
            let y = g.coord(cy - ext, cy + ext);
            Rect::xywh(x, y, g.coord(0.0, ext), g.coord(0.0, ext))
        })
        .collect();
    // rects with a corner on the support point of a diagonal (tangent cases), and nudged
    for (k, (sx, sy)) in [(1.0, -1.0), (-1.0, 1.0), (1.0, 1.0), (-1.0, -1.0)]
        .iter()
        .enumerate()
    {
        let t = s.support(P::new(*sx, *sy));
        let (x0, x1) = if *sx > 0.0 {
            (t.x, t.x + 30.0)
        } else {
            (t.x - 30.0, t.x)
        };
        let (y0, y1) = if *sy > 0.0 {
            (t.y, t.y + 10.0)
        } else {
            (t.y - 10.0, t.y)
        };
        let r = Rect::new(x0, y0, x1, y1);
        rects.push(r);
        if k < 1 {
            rects.push(r.translate(P::new(-0.3 * sx, -0.3 * sy)));
        }
    }
    rects.push(Rect::new(bb.x1, bb.y0, bb.x1 + 3.0, bb.y1)); // touching the bbox
    rects.push(Rect::from_center(s.reference(), 0.5, 0.5));
    let segs: Vec<(P, P, f64)> = (0..4)
        .map(|k| {
            let a = P::new(g.coord(cx - ext, cx + ext), g.coord(cy - ext, cy + ext));
            let b = if k == 0 {
                a
            } else {
                P::new(g.coord(cx - ext, cx + ext), g.coord(cy - ext, cy + ext))
            };
            let clearance = [0.0, 1.0, -1.0, 3.0][k % 4];
            (a, b, clearance)
        })
        .collect();
    let pad = g.coord(0.0, 1.5);
    let inner: Vec<Rect> = vec![
        Rect::from_center(s.reference(), 1.0, 1.0),
        Rect::from_center(P::new(cx, cy), bb.w() * 0.2, bb.h() * 0.2),
        Rect::from_center(P::new(cx, cy), bb.w() * 0.6, bb.h() * 0.1),
    ];
    let offset = g.coord(0.0, 5.0);
    let delta = g.point(-10.0, 10.0);
    let moved = s.translated(delta);
    let step = [0.5, 0.1, 2.0][g.below(3) as usize];
    // the outline of curved shapes has 64 or 68 points; polygons: the hull
    let outline = s.outline();
    case(
        obj(vec![
            ("shape", desc.json()),
            ("dirs", pts(&dirs)),
            ("offset", num(offset)),
            ("points", pts(&points)),
            ("rects", Value::Array(rects.iter().map(rect).collect())),
            (
                "segs",
                Value::Array(
                    segs.iter()
                        .map(|&(a, b, c)| Value::Array(vec![pt(a), pt(b), num(c)]))
                        .collect(),
                ),
            ),
            ("step", num(step)),
            ("pad", num(pad)),
            ("inner", Value::Array(inner.iter().map(rect).collect())),
            ("delta", pt(delta)),
        ]),
        obj(vec![
            ("fields", shape_fields(&s)),
            ("bbox", rect(&bb)),
            ("area", num(s.area())),
            ("reference", pt(s.reference())),
            ("is_circle", Value::from(s.is_circle())),
            (
                "support",
                pts(&dirs.iter().map(|&d| s.support(d)).collect::<Vec<_>>()),
            ),
            (
                "support_inflated",
                pts(&dirs
                    .iter()
                    .map(|&d| s.support_inflated(d, offset))
                    .collect::<Vec<_>>()),
            ),
            (
                "signed_distance",
                nums(
                    &points
                        .iter()
                        .map(|&p| s.signed_distance(p))
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "contains",
                Value::Array(points.iter().map(|&p| Value::from(s.contains(p))).collect()),
            ),
            (
                "overlaps_rect",
                Value::Array(
                    rects
                        .iter()
                        .map(|r| Value::from(s.overlaps_rect(r)))
                        .collect(),
                ),
            ),
            (
                "dist_rect",
                nums(&rects.iter().map(|r| s.dist_rect(r)).collect::<Vec<_>>()),
            ),
            (
                "dist_segment",
                nums(
                    &segs
                        .iter()
                        .map(|&(a, b, _)| s.dist_segment(a, b))
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "near_segment",
                Value::Array(
                    segs.iter()
                        .map(|&(a, b, c)| Value::from(s.near_segment(a, b, c)))
                        .collect(),
                ),
            ),
            (
                "covered_len",
                nums(
                    &segs
                        .iter()
                        .map(|&(a, b, _)| s.covered_len(a, b, step))
                        .collect::<Vec<_>>(),
                ),
            ),
            (
                "boundary_point",
                pts(&dirs
                    .iter()
                    .map(|&d| s.boundary_point(d))
                    .collect::<Vec<_>>()),
            ),
            (
                "contains_rect",
                Value::Array(
                    inner
                        .iter()
                        .map(|r| Value::from(s.contains_rect(r, pad)))
                        .collect(),
                ),
            ),
            ("outline", digest(&outline)),
            ("outline_rings", Value::from(s.outline_rings().len())),
            (
                "translated",
                obj(vec![
                    ("bbox", rect(&moved.bbox())),
                    ("reference", pt(moved.reference())),
                    ("support", pt(moved.support(dirs[0]))),
                    ("signed_distance", num(moved.signed_distance(points[0]))),
                ]),
            ),
        ]),
    )
}

fn section_shape(g: &mut Gen) -> (Vec<Value>, Vec<Value>) {
    let mut descs = Vec::new();
    for kind in 0..4 {
        let n = if kind == 3 { 8 } else { 6 };
        for k in 0..n {
            descs.push(random_desc(g, kind, k));
        }
    }
    let cases: Vec<Value> = descs.iter().map(|d| shape_case(g, d)).collect();
    // shape pairs: overlap tests (moved close to each other so that both outcomes occur)
    let mut pairs = Vec::new();
    for i in 0..24 {
        let a = &descs[g.below(descs.len() as u32) as usize];
        let b = &descs[g.below(descs.len() as u32) as usize];
        let sa = a.build();
        let sb = b.build();
        let ca = sa.bbox().center();
        let cb = sb.bbox().center();
        // translate b towards a by a random fraction of the center distance
        let f = if i % 10 == 0 { 1.0 } else { g.range(0.3, 1.1) };
        let delta = (ca - cb) * f;
        let delta = P::new((delta.x * 8.0).round() / 8.0, (delta.y * 8.0).round() / 8.0);
        let moved = sb.translated(delta);
        pairs.push(case(
            obj(vec![("a", a.json()), ("b", b.json()), ("delta", pt(delta))]),
            obj(vec![
                ("overlap", Value::from(shapes_overlap(&sa, &moved))),
                ("overlap_rev", Value::from(shapes_overlap(&moved, &sa))),
            ]),
        ));
    }
    (cases, pairs)
}

fn fmt_num(g: &mut Gen, v: f64) -> String {
    let s = match g.below(5) {
        0 => format!("{v}"),
        1 => format!("{v:.3}"),
        2 => format!("{v:e}"),
        3 => format!("{:.1}", v),
        _ => format!("{}", (v * 4.0).round() / 4.0),
    };
    let s = if v >= 0.0 && g.chance(0.1) {
        format!("+{s}")
    } else {
        s
    };
    // drop a leading zero sometimes ("0.5" → ".5", "-0.5" → "-.5")
    if g.chance(0.3) {
        if let Some(rest) = s.strip_prefix("0.") {
            return format!(".{rest}");
        }
        if let Some(rest) = s.strip_prefix("-0.") {
            return format!("-.{rest}");
        }
    }
    s
}

fn random_path(g: &mut Gen) -> String {
    let sep = |g: &mut Gen| -> &'static str {
        match g.below(4) {
            0 => " ",
            1 => ",",
            2 => " , ",
            _ => "  ",
        }
    };
    let mut s = String::new();
    let rel = g.chance(0.5);
    s.push(if rel { 'm' } else { 'M' });
    let x = g.range(0.0, 50.0);
    let y = g.range(0.0, 50.0);
    s.push_str(&fmt_num(g, x));
    s.push_str(sep(g));
    s.push_str(&fmt_num(g, y));
    let n = g.int(2, 7);
    for _ in 0..n {
        let cmd = b"LHVCSQTAZlhvcsqtaz"[g.below(18) as usize] as char;
        s.push_str(sep(g));
        s.push(cmd);
        let count = match cmd.to_ascii_uppercase() {
            'L' | 'T' => 2,
            'H' | 'V' => 1,
            'C' => 6,
            'S' | 'Q' => 4,
            'A' => 7,
            _ => 0,
        };
        // occasionally repeat the parameters (implicit repetition)
        let reps = if count > 0 && g.chance(0.25) { 2 } else { 1 };
        for rep in 0..reps {
            for k in 0..count {
                if k > 0 || rep > 0 || g.chance(0.6) {
                    s.push_str(sep(g));
                }
                if cmd.eq_ignore_ascii_case(&'A') && (k == 3 || k == 4) {
                    s.push(if g.chance(0.5) { '1' } else { '0' });
                } else if cmd.eq_ignore_ascii_case(&'A') && k < 2 {
                    let r = if g.chance(0.1) {
                        0.0
                    } else {
                        g.range(0.5, 40.0)
                    };
                    s.push_str(&fmt_num(g, r));
                } else {
                    let v = g.range(-30.0, 60.0);
                    s.push_str(&fmt_num(g, v));
                }
            }
        }
    }
    s
}

fn section_path(g: &mut Gen) -> Vec<Value> {
    let fixed: &[(&str, f64)] = &[
        ("", 0.25),
        ("   ", 0.25),
        ("M0 0 H10 V10 H0 Z", 0.25),
        ("m10,10 5,0 0,5 z m 20 0 l 1 1", 0.25),
        ("M 10 0 A 10 10 0 1 1 -10 0 A 10 10 0 1 1 10 0 Z", 0.1),
        ("M0 0 C 0 10 10 10 10 0", 0.05),
        ("M0 0 C 0 10 10 10 10 0 S 20 -10 20 0 s 10 10 10 0", 0.25),
        ("M0 0 Q 5 10 10 0 T 20 0 t 10 0 Q 30 -5 40 0", 0.1),
        ("M 0 0 S 1 1 2 2", 0.25),
        ("M 0 0 T 5 5", 0.25),
        ("M 0 0 Q 1 1 2 2 L 3 3 T 4 4", 0.25),
        ("M 0 0 A 0 5 0 0 1 10 10", 0.25),
        ("M 5 5 A 10 10 0 0 0 5 5", 0.25),
        ("M 0 0 A 1 1 0 0 1 100 0", 0.25),
        ("M 0 0 A 30 10 45 1 0 50 20", 0.25),
        ("M 0 0 a 30 10 -30 0 1 50 20 a 5 5 0 1 0 -10 0", 0.5),
        ("M0 0A10 10 0 1110 10", 0.25),
        ("M0 0 C 0 0 0 0 0 0", 0.25),
        ("M 10 10 H 20 h -5 V 5 v 3 h 0", 0.25),
        ("M 5 5 c 1 2 3 4 5 6 q 1 1 2 0 t 3 0 Z", 0.25),
        ("M.5.5-.5-.5l1e1-1E-1 +2,+3", 0.25),
        ("M 0 0 L 1e2 1.5e-3 L -1.25E+1 4", 0.25),
        ("M0 0Z L 5 5", 0.25),
        ("M0 0 L 5 0 L 5 5 z z", 0.25),
        ("L 10 10", 0.25),
        ("M 1 2 M 3 4 L 5 6", 0.25),
        ("M 0 0 L 10 0", 0.0),
        ("M 0 0 Q 10 10 20 0", -1.0),
        ("M 0 0 C 30 40 -10 40 20 0", 3.0),
        ("M 0.000000000000000000000000000001 1e-320 L 1e300 1", 0.25),
        // errors
        ("M 10", 0.25),
        ("M 10 20 L", 0.25),
        ("M 0 0 Q 1 1", 0.25),
        ("M 0 0 A 10 10 0 3 1 5 5", 0.25),
        ("M 0 0 A 10 10 0 1", 0.25),
        ("M 0 0 B 1 2", 0.25),
        ("M 1e400 0", 0.25),
        ("M 0,0 L 5,5 \u{e9}", 0.25),
        ("M 0 0 L 1e 2", 0.25),
        ("M0 0 Z 5 5", 0.25),
        ("1 2", 0.25),
        ("X 1 2", 0.25),
        ("M 0 0 L . 5", 0.25),
        ("M 0 0 L - 5", 0.25),
        ("M 0 0 L 5 5 #", 0.25),
        ("M0 0 L 10 \u{1f600}", 0.25),
        ("M0 0 L 2e01.5 L1E+1-1e-1", 0.25),
    ];
    let mut inputs: Vec<(String, f64)> = fixed.iter().map(|&(d, t)| (d.to_string(), t)).collect();
    for _ in 0..16 {
        let d = random_path(g);
        let tol = [0.25, 0.5, 1.0, 2.0][g.below(4) as usize];
        inputs.push((d, tol));
    }
    inputs
        .into_iter()
        .map(|(d, tol)| {
            let out = match flatten(&d, tol) {
                Ok(subs) => obj(vec![(
                    "subpaths",
                    Value::Array(
                        subs.iter()
                            .map(|s| {
                                obj(vec![
                                    ("closed", Value::from(s.closed)),
                                    ("points", pts(&s.points)),
                                ])
                            })
                            .collect(),
                    ),
                )]),
                Err(e) => obj(vec![(
                    "error",
                    obj(vec![
                        ("offset", Value::from(e.offset)),
                        ("message", Value::from(e.message)),
                    ]),
                )]),
            };
            case(obj(vec![("d", Value::from(d)), ("tol", num(tol))]), out)
        })
        .collect()
}

fn random_grid(g: &mut Gen) -> GridSpec {
    let cell = [1.0, 1.5, 2.0, 2.5, 4.0, g.range(0.7, 3.0)][g.below(6) as usize];
    GridSpec {
        ox: g.coord(-10.0, 10.0),
        oy: g.coord(-10.0, 10.0),
        cell,
        cols: g.int(6, 32) as usize,
        rows: g.int(4, 22) as usize,
    }
}

fn section_raster(g: &mut Gen) -> Vec<Value> {
    let mut out = Vec::new();
    for i in 0..18 {
        let grid = random_grid(g);
        let ext = grid.extent();
        let (x0, y0, x1, y1) = (ext.x0, ext.y0, ext.x1, ext.y1);
        let w = x1 - x0;
        let h = y1 - y0;
        let mut m = MaskRaster::new(grid);
        let mut prims = Vec::new();
        let n = g.int(3, 12);
        for k in 0..n {
            let kind = if i < 4 { i } else { g.below(7) };
            let c = P::new(
                g.coord(x0 - w * 0.2, x1 + w * 0.2),
                g.coord(y0 - h * 0.2, y1 + h * 0.2),
            );
            match kind {
                0 => {
                    let r = match k % 4 {
                        0 => 0.0,
                        1 => g.coord(0.0, 1.0),
                        _ => g.coord(0.5, w.min(h) * 0.4),
                    };
                    m.disc(c, r);
                    prims.push(obj(vec![("disc", Value::Array(vec![pt(c), num(r)]))]));
                }
                1 => {
                    let (rw, rh) = (g.coord(-2.0, w * 0.5), g.coord(-2.0, h * 0.5));
                    let r = Rect::new(c.x, c.y, c.x + rw, c.y + rh);
                    m.rect(r.x0, r.y0, r.x1, r.y1);
                    prims.push(obj(vec![("rect", rect(&r))]));
                }
                2 => {
                    let b = P::new(g.coord(x0, x1), g.coord(y0, y1));
                    let hw = match k % 3 {
                        0 => 0.0,
                        1 => g.coord(0.0, 0.3),
                        _ => g.coord(0.3, 4.0),
                    };
                    m.capsule(c, b, hw);
                    prims.push(obj(vec![(
                        "capsule",
                        Value::Array(vec![pt(c), pt(b), num(hw)]),
                    )]));
                }
                3 => {
                    let size = g.coord(2.0, w.min(h) * 0.5);
                    let rings = random_rings(g, c, size);
                    let eo = g.chance(0.5);
                    m.polygon(&rings, eo);
                    prims.push(obj(vec![(
                        "polygon",
                        Value::Array(vec![rings_json(&rings), Value::from(eo)]),
                    )]));
                }
                4 => {
                    let kind = g.below(4);
                    let k2 = g.below(8);
                    let mut d = random_desc(g, kind, k2);
                    // re-center the shape on c and scale it to the grid
                    d = match d {
                        Desc::Circle(_, r) => Desc::Circle(c, r * 0.5),
                        Desc::Ellipse(_, rx, ry, rot) => Desc::Ellipse(c, rx * 0.5, ry * 0.5, rot),
                        Desc::Rect(_, rw, rh, cr, rot) => {
                            Desc::Rect(c, rw * 0.5, rh * 0.5, cr, rot)
                        }
                        Desc::Polygon(rings, eo, reference) => Desc::Polygon(rings, eo, reference),
                    };
                    m.shape(&d.build());
                    prims.push(obj(vec![("shape", d.json())]));
                }
                5 => {
                    let b = if g.chance(0.3) {
                        P::new(g.range(-1e6, 1e6), g.range(-1e6, 1e6))
                    } else {
                        P::new(g.coord(x0, x1), g.coord(y0, y1))
                    };
                    m.touch_segment(c, b);
                    prims.push(obj(vec![("touch", Value::Array(vec![pt(c), pt(b)]))]));
                }
                _ => {
                    // a polyline as capsules (like vector obstacles)
                    let hw = g.coord(0.0, 1.5);
                    let mut pl = vec![c];
                    for _ in 0..g.int(1, 4) {
                        pl.push(P::new(g.coord(x0, x1), g.coord(y0, y1)));
                    }
                    for s in pl.windows(2) {
                        m.capsule(s[0], s[1], hw);
                        prims.push(obj(vec![(
                            "capsule",
                            Value::Array(vec![pt(s[0]), pt(s[1]), num(hw)]),
                        )]));
                    }
                }
            }
        }
        let cov = m.into_coverage();
        out.push(case(
            obj(vec![
                ("grid", grid_json(&grid)),
                ("prims", Value::Array(prims)),
            ]),
            obj(vec![("coverage", Value::from(base64(&cov)))]),
        ));
    }
    // Large polygons (more than 32 edges, and more than 32 crossings per sample row): a
    // comb and a self-intersecting 90-gon with both fill rules, plus curved outlines.
    let grid = GridSpec {
        ox: -0.5,
        oy: 0.25,
        cell: 1.5,
        cols: 40,
        rows: 24,
    };
    let mut comb = Vec::new();
    for k in 0..36 {
        comb.push(P::new(1.0 + k as f64 * 1.6, 2.0));
        comb.push(P::new(1.8 + k as f64 * 1.6, 33.0));
    }
    comb.push(P::new(59.0, 34.0));
    comb.push(P::new(0.5, 34.0));
    let wild: Vec<P> = (0..90)
        .map(|_| P::new(g.coord(0.0, 60.0), g.coord(0.0, 36.0)))
        .collect();
    for eo in [true, false] {
        let mut m = MaskRaster::new(grid);
        let rings = vec![comb.clone(), wild.clone()];
        m.polygon(&rings, eo);
        let ell = Desc::Ellipse(P::new(30.0, 18.0), 20.0, 9.0, 17.5);
        let rr = Desc::Rect(P::new(12.0, 30.0), 14.0, 6.0, 2.5, -30.0);
        m.shape(&ell.build());
        m.shape(&rr.build());
        out.push(case(
            obj(vec![
                ("grid", grid_json(&grid)),
                (
                    "prims",
                    Value::Array(vec![
                        obj(vec![(
                            "polygon",
                            Value::Array(vec![rings_json(&rings), Value::from(eo)]),
                        )]),
                        obj(vec![("shape", ell.json())]),
                        obj(vec![("shape", rr.json())]),
                    ]),
                ),
            ]),
            obj(vec![("coverage", Value::from(base64(&m.into_coverage())))]),
        ));
    }
    // Non-finite and huge inputs (NaN and saturation paths of floor_fast/ceil_fast).
    let nan = f64::NAN;
    let grid = GridSpec {
        ox: 0.5,
        oy: -1.0,
        cell: 2.0,
        cols: 12,
        rows: 9,
    };
    let mut m = MaskRaster::new(grid);
    let mut prims = Vec::new();
    for (c, r) in [
        (P::new(nan, 5.0), 3.0),
        (P::new(8.0, 6.0), nan),
        (P::new(30.0, 4.0), 1e300),
        (P::new(1e20, 1e20), 5.0),
    ] {
        m.disc(c, r);
        prims.push(obj(vec![("disc", Value::Array(vec![pt(c), num(r)]))]));
    }
    for r in [
        Rect::new(-1e20, -1e20, 1e20, 5.5),
        Rect::new(nan, 7.0, 5.0, 9.0),
        Rect::new(10.0, nan, 14.0, 12.0),
        Rect::new(3.0, 11.0, 1e300, nan),
    ] {
        m.rect(r.x0, r.y0, r.x1, r.y1);
        prims.push(obj(vec![("rect", rect(&r))]));
    }
    for (a, b, hw) in [
        (P::new(0.0, 0.0), P::new(1e19, 3e18), 1.5),
        (P::new(nan, 0.0), P::new(5.0, 5.0), 1.0),
        (P::new(2.0, 14.0), P::new(20.0, 14.0), nan),
        (P::new(-1e300, 12.0), P::new(1e300, 12.5), 0.5),
    ] {
        m.capsule(a, b, hw);
        prims.push(obj(vec![(
            "capsule",
            Value::Array(vec![pt(a), pt(b), num(hw)]),
        )]));
    }
    for (a, b) in [
        (P::new(1e300, 1e300), P::new(-1e300, -1e300)),
        (P::new(nan, 1.0), P::new(3.0, 3.0)),
    ] {
        m.touch_segment(a, b);
        prims.push(obj(vec![("touch", Value::Array(vec![pt(a), pt(b)]))]));
    }
    let rings = vec![
        vec![P::new(1.0, 1.0), P::new(nan, 9.0), P::new(9.0, 2.0)],
        vec![P::new(-1e20, 3.0), P::new(1e20, 4.0), P::new(5.0, 1e20)],
    ];
    for eo in [true, false] {
        m.polygon(&rings, eo);
        prims.push(obj(vec![(
            "polygon",
            Value::Array(vec![rings_json(&rings), Value::from(eo)]),
        )]));
    }
    out.push(case(
        obj(vec![
            ("grid", grid_json(&grid)),
            ("prims", Value::Array(prims)),
        ]),
        obj(vec![("coverage", Value::from(base64(&m.into_coverage())))]),
    ));
    out
}

fn section_sat(g: &mut Gen) -> Vec<Value> {
    let mut out = Vec::new();
    for i in 0..6 {
        let grid = random_grid(g);
        let cells = grid.cells();
        let cov: Vec<u8> = (0..cells)
            .map(|_| {
                if i == 0 || g.chance(0.6) {
                    0
                } else if g.chance(0.3) {
                    255
                } else {
                    g.int(1, 254) as u8
                }
            })
            .collect();
        let sat = Sat::from_coverage(grid.cols, grid.rows, &cov);
        let ext = grid.extent();
        let c = grid.cell;
        let mut rects = Vec::new();
        for k in 0..24 {
            let r = match k % 8 {
                0 => {
                    // cell-aligned
                    let c0 = g.int(0, grid.cols as u32) as f64;
                    let r0 = g.int(0, grid.rows as u32) as f64;
                    Rect::new(
                        grid.ox + c0 * c,
                        grid.oy + r0 * c,
                        grid.ox + (c0 + g.int(0, 4) as f64) * c,
                        grid.oy + (r0 + g.int(0, 4) as f64) * c,
                    )
                }
                1 => ext.inflate(g.range(0.0, 10.0)),
                2 => Rect::new(ext.x1 + 1.0, ext.y0, ext.x1 + 5.0, ext.y1), // outside
                3 => {
                    let r = g.rect(ext.x0, ext.x1, c * 3.0);
                    Rect::new(r.x1, r.y1, r.x0, r.y0) // inverted
                }
                _ => {
                    let x = g.range(ext.x0 - c * 2.0, ext.x1);
                    let y = g.range(ext.y0 - c * 2.0, ext.y1);
                    Rect::xywh(x, y, g.range(0.0, c * 8.0), g.range(0.0, c * 6.0))
                }
            };
            rects.push(r);
        }
        let nan = f64::NAN;
        rects.extend([
            Rect::new(nan, 0.0, 10.0, 10.0),
            Rect::new(0.0, 0.0, nan, nan),
            Rect::new(-1e300, -1e300, 1e300, 1e300),
            Rect::new(-1e20, 3.0, 1e20, 3.5),
        ]);
        let blocks: Vec<[u32; 4]> = (0..8)
            .map(|_| {
                let c0 = g.int(0, grid.cols as u32);
                let c1 = g.int(0, grid.cols as u32);
                let r0 = g.int(0, grid.rows as u32);
                let r1 = g.int(0, grid.rows as u32);
                [c0, c1, r0, r1]
            })
            .collect();
        let cells_q: Vec<[u32; 2]> = (0..8)
            .map(|_| [g.below(grid.cols as u32), g.below(grid.rows as u32)])
            .collect();
        out.push(case(
            obj(vec![
                ("grid", grid_json(&grid)),
                ("coverage", Value::from(base64(&cov))),
                ("rects", Value::Array(rects.iter().map(rect).collect())),
                (
                    "blocks",
                    Value::Array(blocks.iter().map(|b| ints(b)).collect()),
                ),
                (
                    "cells",
                    Value::Array(cells_q.iter().map(|b| ints(b)).collect()),
                ),
            ]),
            obj(vec![
                ("nonempty", Value::from(sat.nonempty)),
                (
                    "integral",
                    nums(
                        &rects
                            .iter()
                            .map(|r| sat.integral(&grid, r))
                            .collect::<Vec<_>>(),
                    ),
                ),
                (
                    "covered_area",
                    nums(
                        &rects
                            .iter()
                            .map(|r| sat.covered_area(&grid, r))
                            .collect::<Vec<_>>(),
                    ),
                ),
                (
                    "any",
                    Value::Array(
                        rects
                            .iter()
                            .map(|r| Value::from(sat.any(&grid, r)))
                            .collect(),
                    ),
                ),
                (
                    "cell_range",
                    Value::Array(
                        rects
                            .iter()
                            .map(|r| {
                                let (a, b, c, d) = grid.cell_range(r);
                                ints(&[a as u64, b as u64, c as u64, d as u64])
                            })
                            .collect(),
                    ),
                ),
                (
                    "block",
                    ints(
                        &blocks
                            .iter()
                            .map(|b| {
                                sat.block(
                                    b[0] as usize,
                                    b[1] as usize,
                                    b[2] as usize,
                                    b[3] as usize,
                                )
                            })
                            .collect::<Vec<_>>(),
                    ),
                ),
                (
                    "cell",
                    ints(
                        &cells_q
                            .iter()
                            .map(|q| sat.cell(q[0] as usize, q[1] as usize))
                            .collect::<Vec<_>>(),
                    ),
                ),
            ]),
        ));
    }
    out
}

fn section_grid(g: &mut Gen) -> Vec<Value> {
    let mut out = Vec::new();
    for i in 0..16 {
        let extent = if i == 0 {
            Rect::new(5.0, 5.0, 5.0, 5.0)
        } else {
            g.rect(-50.0, 50.0, 300.0)
        };
        let cell = [1.0, 4.0, 3.3, 0.7][i % 4];
        let grid = GridSpec::covering(&extent, cell);
        let p = g.point(-60.0, 360.0);
        let (u, v) = grid.to_cell(p);
        let (col, row) = (
            g.below(grid.cols as u32) as usize,
            g.below(grid.rows as u32) as usize,
        );
        let mut fs: Vec<f64> = (0..6)
            .map(|k| [0.0, -0.1, 1e-9, 0.5, 1.0, g.f()][k])
            .collect();
        fs.extend([f64::NAN, f64::INFINITY, 1e300, -0.0]);
        out.push(case(
            obj(vec![
                ("extent", rect(&extent)),
                ("cell", num(cell)),
                ("p", pt(p)),
                ("col", Value::from(col)),
                ("row", Value::from(row)),
                ("quantize", nums(&fs)),
            ]),
            obj(vec![
                ("grid", grid_json(&grid)),
                ("cells", Value::from(grid.cells())),
                ("to_cell", nums(&[u, v])),
                ("cell_rect", rect(&grid.cell_rect(col, row))),
                ("cell_center", pt(grid.cell_center(col, row))),
                ("extent", rect(&grid.extent())),
                (
                    "quantize",
                    ints(&fs.iter().map(|&f| quantize(f)).collect::<Vec<_>>()),
                ),
            ]),
        ));
    }
    out
}

fn section_dt(g: &mut Gen) -> Vec<Value> {
    let mut out = Vec::new();
    for i in 0..6 {
        let grid = GridSpec {
            ox: g.coord(-5.0, 5.0),
            oy: g.coord(-5.0, 5.0),
            cell: [1.0, 2.5, 4.0, 1.5][i % 4],
            cols: g.int(1, 20) as usize,
            rows: g.int(1, 14) as usize,
        };
        let density = [0.05, 0.2, 0.0, 1.0, 0.01, 0.1][i];
        let occ: Vec<u8> = (0..grid.cells())
            .map(|_| u8::from(g.chance(density)))
            .collect();
        let dt = distance_transform(&grid, |k| occ[k] != 0);
        let min_v = [0.0, g.coord(0.0, 10.0)];
        let maxima = |mv: f64| -> Value {
            Value::Array(
                dt_maxima(&grid, &dt, mv)
                    .iter()
                    .map(|&(p, v, c, r)| {
                        Value::Array(vec![pt(p), num(v), Value::from(c), Value::from(r)])
                    })
                    .collect(),
            )
        };
        out.push(case(
            obj(vec![
                ("grid", grid_json(&grid)),
                ("occupied", Value::from(base64(&occ))),
                ("min_v", nums(&min_v)),
            ]),
            obj(vec![
                ("dt", nums(&dt)),
                (
                    "maxima",
                    Value::Array(vec![maxima(min_v[0]), maxima(min_v[1])]),
                ),
            ]),
        ));
    }
    out
}

fn section_index(g: &mut Gen) -> Vec<Value> {
    let mut out = Vec::new();
    for i in 0..4 {
        let extent = Rect::xywh(
            g.coord(-20.0, 20.0),
            g.coord(-20.0, 20.0),
            g.coord(100.0, 600.0),
            g.coord(100.0, 400.0),
        );
        let cell = [16.0, 0.0, 37.5, 5.0][i];
        let n = g.int(20, 60);
        let boxes: Vec<Rect> = (0..n)
            .map(|k| match k % 13 {
                0 => Rect::EMPTY,
                1 => extent.inflate(10.0), // spans everything
                2 => {
                    let p = g.point(extent.x0, extent.x1);
                    Rect::from_center(p, 0.0, 0.0) // a point
                }
                3 => Rect::xywh(extent.x1 + 50.0, extent.y0 - 80.0, 5.0, 5.0), // outside
                _ => {
                    let x = g.coord(extent.x0 - 10.0, extent.x1);
                    let y = g.coord(extent.y0 - 10.0, extent.y1);
                    Rect::xywh(x, y, g.coord(0.0, 40.0), g.coord(0.0, 25.0))
                }
            })
            .collect();
        let ix = StaticIndex::new(boxes.clone(), &extent, cell);
        let queries: Vec<Rect> = (0..20)
            .map(|k| {
                if k == 0 {
                    extent
                } else {
                    let x = g.coord(extent.x0 - 20.0, extent.x1);
                    let y = g.coord(extent.y0 - 20.0, extent.y1);
                    Rect::xywh(x, y, g.coord(0.0, 60.0), g.coord(0.0, 30.0))
                }
            })
            .chain([
                Rect::new(f64::NAN, 0.0, 50.0, 50.0),
                Rect::new(-1e300, -1e300, 1e300, 1e300),
                Rect::new(1e20, 1e20, 2e20, 2e20),
            ])
            .collect();
        let mut buf = Vec::new();
        let results: Vec<Value> = queries
            .iter()
            .map(|q| {
                ix.query(q, &mut buf);
                ints(&buf)
            })
            .collect();
        out.push(case(
            obj(vec![
                ("type", "static".into()),
                ("extent", rect(&extent)),
                ("cell", num(cell)),
                ("boxes", Value::Array(boxes.iter().map(rect).collect())),
                ("queries", Value::Array(queries.iter().map(rect).collect())),
            ]),
            obj(vec![
                ("len", Value::from(ix.len())),
                ("results", Value::Array(results)),
            ]),
        ));
    }
    for i in 0..3 {
        let extent = Rect::xywh(0.0, 0.0, g.coord(100.0, 500.0), g.coord(100.0, 300.0));
        let cell = [10.0, 0.0, 7.5][i];
        let mut ix = DynIndex::new(&extent, cell);
        let mut ops = Vec::new();
        let mut results = Vec::new();
        let mut buf = Vec::new();
        for _ in 0..100 {
            match g.below(5) {
                0 | 1 => {
                    let id = g.below(40);
                    let x = g.coord(-10.0, extent.x1);
                    let y = g.coord(-10.0, extent.y1);
                    let r = Rect::xywh(x, y, g.coord(0.0, 50.0), g.coord(0.0, 20.0));
                    ix.insert(id, r);
                    ops.push(Value::Array(vec![
                        "insert".into(),
                        Value::from(id),
                        rect(&r),
                    ]));
                }
                2 => {
                    let id = g.below(45);
                    ix.remove(id);
                    ops.push(Value::Array(vec!["remove".into(), Value::from(id)]));
                }
                3 => {
                    let id = g.below(45);
                    ops.push(Value::Array(vec!["get".into(), Value::from(id)]));
                    results.push(match ix.get(id) {
                        Some(r) => rect(r),
                        None => Value::Null,
                    });
                }
                _ => {
                    let x = g.coord(-20.0, extent.x1);
                    let y = g.coord(-20.0, extent.y1);
                    let q = Rect::xywh(x, y, g.coord(0.0, 120.0), g.coord(0.0, 60.0));
                    ix.query(&q, &mut buf);
                    ops.push(Value::Array(vec!["query".into(), rect(&q)]));
                    results.push(ints(&buf));
                }
            }
        }
        // non-finite and huge boxes and queries
        let odd = Rect::new(f64::NAN, 5.0, 20.0, f64::NAN);
        ix.insert(41, odd);
        ops.push(Value::Array(vec![
            "insert".into(),
            Value::from(41),
            rect(&odd),
        ]));
        let huge = Rect::new(-1e300, -1e300, 1e300, 1e300);
        ix.insert(42, huge);
        ops.push(Value::Array(vec![
            "insert".into(),
            Value::from(42),
            rect(&huge),
        ]));
        for q in [odd, huge, Rect::new(0.0, 0.0, 15.0, 15.0)] {
            ix.query(&q, &mut buf);
            ops.push(Value::Array(vec!["query".into(), rect(&q)]));
            results.push(ints(&buf));
        }
        out.push(case(
            obj(vec![
                ("type", "dynamic".into()),
                ("extent", rect(&extent)),
                ("cell", num(cell)),
                ("ops", Value::Array(ops)),
            ]),
            obj(vec![("results", Value::Array(results))]),
        ));
    }
    out
}

/// The fixture text (deterministic).
pub fn generate() -> String {
    let mut g = Gen(Pcg32::new(SEED));
    let (shapes, pairs) = {
        // separate stream so that adding cases elsewhere keeps the shapes stable
        let mut gs = Gen(Pcg32::new(SEED + 1));
        section_shape(&mut gs)
    };
    let sections: Vec<(&str, Vec<Value>)> = vec![
        ("math", section_math()),
        ("point", section_point(&mut g)),
        ("rect", section_rect(&mut g)),
        ("affine", section_affine(&mut g)),
        ("segment", section_segment(&mut g)),
        ("polygon", section_polygon(&mut g)),
        ("shape", shapes),
        ("shape_pairs", pairs),
        ("path", section_path(&mut g)),
        ("grid", section_grid(&mut g)),
        ("raster", section_raster(&mut g)),
        ("sat", section_sat(&mut g)),
        ("dt", section_dt(&mut g)),
        ("index", section_index(&mut g)),
    ];
    let header = obj(vec![
        ("kind", "geometry".into()),
        (
            "about",
            "Inputs and outputs of the Rust geometry kernel (label-anything-core: geom, grid, \
             index) for the TypeScript port, which must reproduce every value bit for bit."
                .into(),
        ),
        (
            "regenerate",
            "cd rust && cargo run -p label-anything-core --example geom_oracle \
             (--check: fail if this file is stale; also run by \
             cargo test -p label-anything-core --test geom_oracle)"
                .into(),
        ),
        (
            "format",
            "sections: {name: [{in, out}]}; floats are shortest round-trip JSON numbers, \
             non-finite values the strings inf, -inf, nan; coverage and occupancy grids are \
             base64 of the row-major u8 cells"
                .into(),
        ),
        ("seed", Value::from(SEED)),
    ]);
    let mut text = String::from("{\n");
    if let Value::Object(m) = &header {
        for (k, v) in m {
            text.push_str(&format!("{}: {},\n", Value::from(k.as_str()), v));
        }
    }
    text.push_str("\"sections\": {\n");
    let mut sizes = Vec::new();
    for (si, (name, cases)) in sections.iter().enumerate() {
        let start = text.len();
        text.push_str(&format!("{}: [\n", Value::from(*name)));
        for (ci, c) in cases.iter().enumerate() {
            text.push_str(&c.to_string());
            text.push_str(if ci + 1 < cases.len() { ",\n" } else { "\n" });
        }
        text.push_str(if si + 1 < sections.len() {
            "],\n"
        } else {
            "]\n"
        });
        sizes.push(format!("{name} {}", text.len() - start));
    }
    text.push_str("}\n}\n");
    assert!(
        text.len() <= MAX_BYTES,
        "fixture too large: {} bytes ({})",
        text.len(),
        sizes.join(", ")
    );
    text
}
