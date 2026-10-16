//! Unit tests of the internal modules (the conformance suite covers the public behaviour).

use crate::color::{parse_color_alpha, parse_paint, PaintSpec};
use crate::css::{parse_declarations, parse_stylesheet};
use crate::flatten::{arc_segments, Flattener};
use crate::geom::Affine;
use crate::num::{parse_first_length, parse_length, parse_number_list, scan_number, Unit};
use crate::path::{parse_path, Seg};
use crate::selector::{parse_selector_list, SelectorMode};
use crate::style::{apply, compute, first_family, Anchor, Baseline, Computed, Specified};
use crate::transform::{
    parse_aspect_ratio, parse_transform, parse_view_box, view_box_transform, AspectRatio,
};
use crate::{classify, outline, parse, select, ClassRule, Geometry, ParseOptions, Selector};

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn numbers() {
    let b = b"1.5.5";
    assert_eq!(scan_number(b, 0), Some((1.5, 3)));
    assert_eq!(scan_number(b, 3), Some((0.5, 5)));
    assert_eq!(scan_number(b"-1-2", 0), Some((-1.0, 2)));
    assert_eq!(scan_number(b"1e5x", 0), Some((1e5, 3)));
    assert_eq!(scan_number(b"1e", 0), Some((1.0, 1)));
    assert_eq!(scan_number(b"1em", 0), Some((1.0, 1)));
    assert_eq!(scan_number(b"+.5", 0), Some((0.5, 3)));
    assert_eq!(scan_number(b"1.", 0), Some((1.0, 2)));
    assert_eq!(scan_number(b"2E-1", 0), Some((0.2, 4)));
    for bad in [&b"."[..], b"-", b"e5", b"", b"+e", b"1e400"] {
        assert_eq!(scan_number(bad, 0), None, "{bad:?}");
    }
    assert_eq!(
        parse_number_list("1,2 3 , 4"),
        (vec![1.0, 2.0, 3.0, 4.0], true)
    );
    assert_eq!(parse_number_list("1 2 x 3"), (vec![1.0, 2.0], false));
}

#[test]
fn lengths() {
    let l = parse_length(" 12.5PX ").unwrap();
    assert_eq!((l.v, l.unit), (12.5, Unit::Px));
    assert_eq!(parse_length("50%").unwrap().unit, Unit::Percent);
    assert!(parse_length("10 px").is_none());
    assert!(parse_length("auto").is_none());
    assert!(parse_length("1furlong").is_none());
    assert!(close(parse_length("1in").unwrap().resolve(16.0, 0.0), 96.0));
    assert!(close(parse_length("3pt").unwrap().resolve(16.0, 0.0), 4.0));
    assert!(close(parse_length("2em").unwrap().resolve(10.0, 0.0), 20.0));
    assert!(close(parse_length("1ex").unwrap().resolve(10.0, 0.0), 5.0));
    assert!(close(
        parse_length("25.4mm").unwrap().resolve(16.0, 0.0),
        96.0
    ));
    assert!(close(
        parse_length("50%").unwrap().resolve(16.0, 300.0),
        150.0
    ));
    assert_eq!(parse_first_length("10 20 30").unwrap().v, 10.0);
    assert_eq!(parse_first_length("5em,6").unwrap().unit, Unit::Em);
}

#[test]
fn path_data() {
    use Seg::*;
    assert_eq!(
        parse_path("M 0 0 10 10 L 20 0"),
        vec![Move(0.0, 0.0), Line(10.0, 10.0), Line(20.0, 0.0)]
    );
    assert_eq!(
        parse_path("m 1 1 2 2 z m 3 3 h 1 v 1"),
        vec![
            Move(1.0, 1.0),
            Line(3.0, 3.0),
            Close,
            Move(4.0, 4.0),
            Line(5.0, 4.0),
            Line(5.0, 5.0)
        ]
    );
    // Smooth curves reflect the previous control point.
    assert_eq!(
        parse_path("M0 0 C 0 10 10 10 10 0 S 20 -10 20 0"),
        vec![
            Move(0.0, 0.0),
            Cubic(0.0, 10.0, 10.0, 10.0, 10.0, 0.0),
            Cubic(10.0, -10.0, 20.0, -10.0, 20.0, 0.0)
        ]
    );
    assert_eq!(
        parse_path("M0 0 Q 5 10 10 0 T 20 0 T 30 0")[3],
        Quad(25.0, 10.0, 30.0, 0.0)
    );
    assert_eq!(parse_path("M0 0 L 1 1 T 5 5")[2], Quad(1.0, 1.0, 5.0, 5.0));
    // Compact arc flags.
    assert_eq!(
        parse_path("M0 0 a1 1 0 0110 10")[1],
        Arc {
            rx: 1.0,
            ry: 1.0,
            rot: 0.0,
            large: false,
            sweep: true,
            x: 10.0,
            y: 10.0
        }
    );
    // Errors keep the valid prefix; data must start with a moveto.
    assert_eq!(
        parse_path("M 0 0 L 10 10 L 5"),
        vec![Move(0.0, 0.0), Line(10.0, 10.0)]
    );
    assert_eq!(parse_path("M 0 0 L 10 10 X 5 5").len(), 2);
    assert!(parse_path("L 10 10").is_empty());
    assert!(parse_path("M 0 0 z 1 1").len() == 2);
    assert!(parse_path("").is_empty());
}

#[test]
fn transforms() {
    let m = parse_transform("translate(10, 20) scale(2)").unwrap();
    assert_eq!(m.apply(1.0, 1.0), [12.0, 22.0]);
    let r = parse_transform("rotate(90 10 10)").unwrap();
    let p = r.apply(20.0, 10.0);
    assert!(close(p[0], 10.0) && close(p[1], 20.0));
    let k = parse_transform("skewX(45)").unwrap();
    let q = k.apply(0.0, 10.0);
    assert!(close(q[0], 10.0) && close(q[1], 10.0));
    assert_eq!(
        parse_transform("matrix(1,2,3,4,5,6)").unwrap(),
        Affine::new(1.0, 2.0, 3.0, 4.0, 5.0, 6.0)
    );
    for bad in [
        "translate(1,2,3)",
        "rotate(1 2)",
        "foo(1)",
        "translate(1",
        "scale()",
        "matrix(1 2 3 4 5)",
        "translate 1 2",
    ] {
        assert!(parse_transform(bad).is_none(), "{bad}");
    }
    assert_eq!(parse_transform("").unwrap(), Affine::IDENTITY);
}

#[test]
fn view_boxes() {
    assert_eq!(parse_view_box("0 0 100 50"), Some([0.0, 0.0, 100.0, 50.0]));
    assert_eq!(parse_view_box("-1,-2,3,4"), Some([-1.0, -2.0, 3.0, 4.0]));
    assert_eq!(parse_view_box("0 0 0 10"), None);
    assert_eq!(parse_view_box("0 0 10"), None);
    assert_eq!(parse_view_box("0 0 10 10 5"), None);
    assert_eq!(parse_aspect_ratio("none").align, None);
    assert_eq!(
        parse_aspect_ratio("xMaxYMin slice"),
        AspectRatio {
            align: Some((1.0, 0.0)),
            slice: true
        }
    );
    assert_eq!(
        parse_aspect_ratio("defer xMinYMax"),
        AspectRatio {
            align: Some((0.0, 1.0)),
            slice: false
        }
    );
    assert_eq!(parse_aspect_ratio("bogus"), AspectRatio::DEFAULT);
    assert_eq!(
        parse_aspect_ratio("xMinYMin meet extra"),
        AspectRatio::DEFAULT
    );
    assert_eq!(parse_aspect_ratio("xMi€YMin"), AspectRatio::DEFAULT);
    let t = view_box_transform(
        Some([0.0, 0.0, 10.0, 10.0]),
        AspectRatio::DEFAULT,
        100.0,
        50.0,
    );
    assert_eq!(t.apply(10.0, 10.0), [75.0, 50.0]);
}

#[test]
fn colors() {
    let mut sorted = crate::color::NAMED.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(
        sorted,
        crate::color::NAMED.to_vec(),
        "named colours must be sorted and unique"
    );
    assert_eq!(parse_color_alpha("SteelBlue"), Some(1.0));
    assert_eq!(parse_color_alpha("transparent"), Some(0.0));
    assert_eq!(parse_color_alpha("#abc"), Some(1.0));
    assert_eq!(parse_color_alpha("#abc0"), Some(0.0));
    assert_eq!(parse_color_alpha("#00000080"), Some(128.0 / 255.0));
    assert_eq!(parse_color_alpha("#abcde"), None);
    assert_eq!(parse_color_alpha("rgba(1, 2, 3, 0.25)"), Some(0.25));
    assert_eq!(parse_color_alpha("rgb(1 2 3 / 50%)"), Some(0.5));
    assert_eq!(parse_color_alpha("hsl(1, 2%, 3%)"), Some(1.0));
    assert_eq!(parse_color_alpha("rgba(1, 2, 3, 7)"), Some(1.0));
    assert_eq!(parse_color_alpha("rgb(1,2,3"), None);
    assert_eq!(parse_color_alpha("notacolor"), None);
    assert_eq!(parse_paint("none"), Some(PaintSpec::None));
    assert_eq!(
        parse_paint("url(#g) red"),
        Some(PaintSpec::Url(
            Some("g".into()),
            Some(Box::new(PaintSpec::Color(1.0)))
        ))
    );
    assert_eq!(
        parse_paint("url('#g')"),
        Some(PaintSpec::Url(Some("g".into()), None))
    );
    assert_eq!(
        parse_paint("url(x.svg#g)"),
        Some(PaintSpec::Url(None, None))
    );
    assert_eq!(parse_paint("url(#g) url(#h)"), None);
    assert_eq!(parse_paint("ab€x"), None);
}

#[test]
fn css_parsing() {
    let rules = parse_stylesheet(
        "/* x { fill: red } */ @import url(a.css); @media print { rect { fill: none } } \
         rect, .a > circle { fill: red; stroke: blue !important } a:hover { fill: none } \
         text { content: \"}\"; font: 12px sans-serif } <!-- --> g{}",
    );
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0].selectors.len(), 2);
    assert_eq!(rules[0].decls[1].name, "stroke");
    assert!(rules[0].decls[1].important);
    assert_eq!(rules[1].decls.len(), 2);
    let d = parse_declarations(
        "FILL: Red ; stroke:url(data:a;b) ; ;bogus; :x; font-size: 12px!IMPORTANT",
    );
    assert_eq!(d.len(), 3);
    assert_eq!((d[0].name.as_str(), d[0].value.as_str()), ("fill", "Red"));
    assert_eq!(d[1].value, "url(data:a;b)");
    assert!(d[2].important && d[2].value == "12px");
}

#[test]
fn selector_parsing() {
    let ok = [
        ("rect", (0, 0, 1)),
        ("*", (0, 0, 0)),
        ("circle.outlier[data-k=1]", (0, 2, 1)),
        ("#a.b:small", (1, 2, 0)),
        ("g > .c [x='y']", (0, 2, 1)),
        ("svg|rect", (0, 0, 0)),
    ];
    for (s, spec) in ok {
        match parse_selector_list(s, SelectorMode::Rules) {
            Ok(sel) => assert_eq!(sel.selectors[0].specificity, spec, "{s}"),
            Err(e) => assert!(s == "svg|rect", "{s}: {e}"),
        }
    }
    assert!(parse_selector_list(":small", SelectorMode::Css).is_err());
    assert!(parse_selector_list("rect", SelectorMode::Css).is_ok());
    let e = Selector::parse("a[").unwrap_err();
    assert_eq!(e.code, crate::SvgErrorCode::Pattern);
    assert!(e.message.contains("position"));
    let esc = Selector::parse("#\\31 23, .a\\.b").unwrap();
    assert_eq!(esc.selectors[0].compounds[0].ids, vec!["123".to_string()]);
    assert_eq!(
        esc.selectors[1].compounds[0].classes,
        vec!["a.b".to_string()]
    );
}

#[test]
fn selector_matching_combinators() {
    let svg = "<svg width='100' height='100'><g class='a'><g class='b'><rect id='r' class='c' width='1' height='1'/></g></g></svg>";
    let scene = parse(svg, &ParseOptions::default()).unwrap();
    let r = scene.element_by_id("r").unwrap();
    let yes = [
        "rect",
        ".a rect",
        ".a .b > rect",
        "g > g > .c",
        "svg .a > .b .c",
        ".a > .b > #r",
        "svg g g rect",
        "* > rect",
    ];
    let no = [
        ".b > .a rect",
        ".a > rect",
        "g > g > g > rect",
        ".c rect",
        "svg > rect",
        ".a > .c",
    ];
    for s in yes {
        assert!(scene.matches(r, &Selector::parse(s).unwrap()), "{s}");
    }
    for s in no {
        assert!(!scene.matches(r, &Selector::parse(s).unwrap()), "{s}");
    }
    // Long descendant chains stay linear (would be exponential with naive backtracking).
    let deep = format!(
        "<svg>{}<rect id='x'/>{}</svg>",
        "<g>".repeat(200),
        "</g>".repeat(200)
    );
    let scene = parse(&deep, &ParseOptions::default()).unwrap();
    let x = scene.element_by_id("x").unwrap();
    let sel = Selector::parse(&format!("{} circle", "g ".repeat(60))).unwrap();
    assert!(!scene.matches(x, &sel));
    let sel = Selector::parse(&format!("svg {}rect", "g ".repeat(60))).unwrap();
    assert!(scene.matches(x, &sel));
}

fn style_of(decls: &[(&str, &str)], parent: &Computed) -> Computed {
    let mut s = Specified::default();
    for (n, v) in decls {
        apply(&mut s, n, v, true, &|id| id == "g");
    }
    compute(&s, parent, None)
}

#[test]
fn styles() {
    let root = Computed::initial();
    let p = style_of(
        &[("font", "italic bold 12px/1.5 'Open Sans', arial")],
        &root,
    );
    assert_eq!(
        (p.font_size, p.font_weight, &*p.font_family),
        (12.0, 700, "'Open Sans', arial")
    );
    assert_eq!(first_family(&p.font_family), "Open Sans");
    assert_eq!(first_family(" a , b"), "a");
    assert_eq!(first_family(""), "sans-serif");
    let c = style_of(&[("font-size", "150%"), ("font-weight", "bolder")], &p);
    assert_eq!((c.font_size, c.font_weight), (18.0, 900));
    let c = style_of(&[("font-size", "larger"), ("font-weight", "lighter")], &p);
    // CSS Fonts 4: lighter maps 550–749 to 400.
    assert!(close(c.font_size, 14.4) && c.font_weight == 400);
    let c = style_of(&[("font-size", "-1px"), ("font-size", "x-large")], &root);
    assert_eq!(c.font_size, 24.0);
    // Invalid values are dropped, keywords handled.
    let c = style_of(
        &[
            ("fill", "red"),
            ("fill", "bogus"),
            ("opacity", "50%"),
            ("text-anchor", "middle"),
        ],
        &root,
    );
    assert_eq!(
        (c.fill, c.opacity, c.anchor),
        (Some(1.0), 0.5, Anchor::Middle)
    );
    let c = style_of(&[("fill", "url(#nope)")], &root);
    assert_eq!(c.fill, None);
    let c = style_of(
        &[("fill", "url(#g)"), ("dominant-baseline", "central")],
        &root,
    );
    assert_eq!((c.fill, c.baseline), (Some(1.0), Baseline::Middle));
    // opacity and display are not inherited; fill is.
    let parent = style_of(
        &[("opacity", "0.5"), ("display", "none"), ("fill", "none")],
        &root,
    );
    let child = style_of(&[], &parent);
    assert_eq!(
        (child.opacity, child.display_none, child.fill),
        (1.0, false, None)
    );
    let child = style_of(&[("opacity", "inherit"), ("fill", "initial")], &parent);
    assert_eq!((child.opacity, child.fill), (0.5, Some(1.0)));
}

/// Distance from p to segment ab.
fn seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 {
        (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    ((p[0] - a[0] - t * dx).powi(2) + (p[1] - a[1] - t * dy).powi(2)).sqrt()
}

fn max_deviation(curve: impl Fn(f64) -> [f64; 2], pts: &[[f64; 2]]) -> f64 {
    let mut worst: f64 = 0.0;
    for k in 0..=2000 {
        let p = curve(k as f64 / 2000.0);
        let d = pts
            .windows(2)
            .map(|w| seg_dist(p, w[0], w[1]))
            .fold(f64::INFINITY, f64::min);
        worst = worst.max(d);
    }
    worst
}

#[test]
fn flattening_respects_the_tolerance() {
    let mut seed = 12345u64;
    let mut rnd = move || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((seed >> 11) as f64 / (1u64 << 53) as f64) * 400.0 - 200.0
    };
    for tol in [0.05, 0.25, 1.0] {
        for _ in 0..50 {
            let c = [rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd(), rnd()];
            let mut f = Flattener::new(Affine::new(1.3, 0.2, -0.4, 0.9, 5.0, 7.0), tol);
            f.move_to(c[0], c[1]);
            f.cubic_to(c[2], c[3], c[4], c[5], c[6], c[7]);
            let sub = f.finish_all().unwrap();
            let m = Affine::new(1.3, 0.2, -0.4, 0.9, 5.0, 7.0);
            let curve = |t: f64| {
                let mt = 1.0 - t;
                let x = mt * mt * mt * c[0]
                    + 3.0 * mt * mt * t * c[2]
                    + 3.0 * mt * t * t * c[4]
                    + t * t * t * c[6];
                let y = mt * mt * mt * c[1]
                    + 3.0 * mt * mt * t * c[3]
                    + 3.0 * mt * t * t * c[5]
                    + t * t * t * c[7];
                m.apply(x, y)
            };
            if let Some(s) = sub.first() {
                assert!(
                    max_deviation(curve, &s.pts) <= tol * 1.0001,
                    "cubic {c:?} tol {tol}"
                );
            }
            // Elliptical arcs (rotated, transformed).
            let (rx, ry, rot) = (c[0].abs() / 4.0 + 1.0, c[1].abs() / 4.0 + 1.0, c[2]);
            let mut f = Flattener::new(m, tol);
            let (cx, cy) = (c[3], c[4]);
            let phi = rot.to_radians();
            let at = |th: f64| {
                [
                    cx + rx * th.cos() * phi.cos() - ry * th.sin() * phi.sin(),
                    cy + rx * th.cos() * phi.sin() + ry * th.sin() * phi.cos(),
                ]
            };
            let (p0, p1) = (at(0.3), at(2.9));
            f.move_to(p0[0], p0[1]);
            f.arc_to(rx, ry, rot, false, true, p1[0], p1[1]);
            let sub = f.finish_all().unwrap();
            let curve = |t: f64| {
                let q = at(0.3 + 2.6 * t);
                m.apply(q[0], q[1])
            };
            assert!(
                max_deviation(curve, &sub[0].pts) <= tol * 1.0001,
                "arc {rx} {ry} {rot} tol {tol}"
            );
        }
    }
    // Sagitta-based segment counts.
    assert_eq!(arc_segments(30.0, std::f64::consts::TAU, 0.1), 39);
    assert_eq!(arc_segments(0.01, std::f64::consts::TAU, 0.25), 4);
    assert_eq!(
        arc_segments(1e300, 1.0, 0.25),
        crate::flatten::MAX_CURVE_SEGMENTS
    );
}

#[test]
fn measure_callback_and_options() {
    let svg = "<svg width='100' height='100'><text x='0' y='20' font-family=\"'My Font', serif\" font-weight='bold' font-size='10'>abc</text></svg>";
    let calls = std::cell::RefCell::new(Vec::new());
    let measure = |t: &str, size: f64, fam: &str, w: u16| {
        calls
            .borrow_mut()
            .push((t.to_string(), size, fam.to_string(), w));
        42.0
    };
    let opts = ParseOptions {
        measure: Some(&measure),
        ascent: 0.9,
        descent: 0.3,
        ..Default::default()
    };
    let scene = parse(svg, &opts).unwrap();
    assert_eq!(
        calls.borrow().as_slice(),
        &[("abc".to_string(), 10.0, "My Font".to_string(), 700)]
    );
    match scene.primitives[0].geometry {
        Geometry::Rect { x, y, w, h } => {
            assert!(close(x, 0.0) && close(y, 11.0) && close(w, 42.0) && close(h, 12.0));
        }
        ref g => panic!("{g:?}"),
    }
    // A broken measure result is treated as zero width.
    let nan = |_: &str, _: f64, _: &str, _: u16| f64::NAN;
    let scene = parse(
        svg,
        &ParseOptions {
            measure: Some(&nan),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(matches!(scene.primitives[0].geometry, Geometry::Rect { w, .. } if w == 0.0));
}

#[test]
fn classification_and_lookup() {
    let svg = "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'>\
        <defs><circle id='m' r='2'/></defs>\
        <g id='g1' class='pts'><use id='u1' href='#m' x='10' y='10'/><use href='#m' x='20' y='10'/></g>\
        <path id='p' d='M 0 50 L 100 50' stroke='black' fill='none'/>\
        <rect id='r' x='5' y='60' width='10' height='10' stroke='red'/></svg>";
    let scene = parse(svg, &ParseOptions::default()).unwrap();
    let rules = vec![
        ClassRule::new("circle", "never"),
        ClassRule::new(".pts use", "points"),
        ClassRule::new("path", "ignore"),
    ];
    let c = classify(&scene, &rules, "ink").unwrap();
    let classes: Vec<&str> = c.iter().map(|x| x.class).collect();
    assert_eq!(classes, vec!["points", "points", "ink", "ink"]);
    // Primitives are sorted by element, so subtrees are contiguous.
    assert!(scene
        .primitives
        .windows(2)
        .all(|w| w[0].element <= w[1].element));
    let g1 = scene.element_by_id("g1").unwrap();
    assert_eq!(scene.subtree_primitives(g1).len(), 2);
    assert_eq!(scene.subtree_primitives(999).len(), 0);
    assert_eq!(crate::element_geometry(&scene, "u1").unwrap().len(), 1);
    assert!(crate::element_geometry(&scene, "missing").is_none());
    // select: each primitive once even if an ancestor and a descendant match.
    assert_eq!(select(&scene, "g, use").unwrap().len(), 2);
    // outline: filled rect with stroke → polygon only; stroke-only path → polyline.
    let out = outline(scene.subtree_primitives(0));
    let kinds: Vec<&str> = out
        .iter()
        .map(|g| match g {
            Geometry::Polygon { .. } => "polygon",
            Geometry::Polyline { .. } => "polyline",
            Geometry::Rect { .. } => "rect",
        })
        .collect();
    assert_eq!(kinds, vec!["polygon", "polygon", "polyline", "polygon"]);
    assert_eq!(
        scene
            .select_elements(&Selector::parse("use").unwrap())
            .len(),
        2
    );
}
