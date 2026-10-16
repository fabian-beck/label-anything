//! Robustness: malformed input yields structured errors; limits never overflow the stack.

use label_anything_svg::{classify, parse, select, ClassRule, ParseOptions, SvgErrorCode};

fn run_in_small_stack<F: FnOnce() + Send + 'static>(f: F) {
    // 2 MiB: the default stack of test threads (and more than wasm's 1 MiB in release).
    std::thread::Builder::new()
        .stack_size(2 << 20)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn deep_nesting_within_limit_renders() {
    run_in_small_stack(|| {
        let depth = 1000;
        let svg = format!(
            "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'>{}<rect width='1' height='1'/>{}</svg>",
            "<g>".repeat(depth),
            "</g>".repeat(depth)
        );
        let scene = parse(&svg, &ParseOptions::default()).unwrap();
        // The rect lies beyond the render depth limit: skipped with a warning.
        assert!(scene.primitives.is_empty());
        assert!(scene.warnings.iter().any(|w| w.code == SvgErrorCode::Limit));
        let ok = format!(
            "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'>{}<rect width='1' height='1'/>{}</svg>",
            "<g>".repeat(300),
            "</g>".repeat(300)
        );
        let scene = parse(&ok, &ParseOptions::default()).unwrap();
        assert_eq!(scene.primitives.len(), 1);
    });
}

#[test]
fn nesting_beyond_xml_limit_is_a_structured_error() {
    run_in_small_stack(|| {
        let svg = format!("<svg>{}{}</svg>", "<g>".repeat(5000), "</g>".repeat(5000));
        let err = parse(&svg, &ParseOptions::default()).unwrap_err();
        assert_eq!(err.code, SvgErrorCode::Limit);
    });
}

#[test]
fn deep_text_and_use_chains_stay_bounded() {
    run_in_small_stack(|| {
        // A chain of 500 <use> elements, each referencing the previous group.
        let mut s = String::from("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><defs><g id='u0'><rect width='1' height='1'/></g>");
        for k in 1..500 {
            s.push_str(&format!("<g id='u{k}'><use href='#u{}'/></g>", k - 1));
        }
        s.push_str("</defs><use href='#u499'/>");
        s.push_str(&"<tspan>".repeat(200).replace("<tspan>", "<text>a<tspan>"));
        s.push_str("</svg>");
        // Not well-formed (unclosed tspans): a parse error, not a crash.
        assert_eq!(
            parse(&s, &ParseOptions::default()).unwrap_err().code,
            SvgErrorCode::Parse
        );
        let mut t = String::from("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><defs><g id='u0'><rect width='1' height='1'/></g>");
        for k in 1..500 {
            t.push_str(&format!("<g id='u{k}'><use href='#u{}'/></g>", k - 1));
        }
        t.push_str("</defs><use href='#u499'/><text>a");
        t.push_str(&"<tspan>b".repeat(250));
        t.push_str(&"</tspan>".repeat(250));
        t.push_str("</text></svg>");
        let scene = parse(&t, &ParseOptions::default()).unwrap();
        assert!(scene.warnings.iter().any(|w| w.code == SvgErrorCode::Limit));
    });
}

#[test]
fn malformed_inputs_return_structured_errors() {
    let cases: &[(&str, SvgErrorCode)] = &[
        ("", SvgErrorCode::Parse),
        ("   ", SvgErrorCode::Parse),
        ("not xml at all", SvgErrorCode::Parse),
        ("<svg", SvgErrorCode::Parse),
        ("<svg><g></svg>", SvgErrorCode::Parse),
        ("<svg width='10' height=10/>", SvgErrorCode::Parse),
        ("<svg a='1' a='2'/>", SvgErrorCode::Parse),
        ("<svg>&nbsp;</svg>", SvgErrorCode::Parse),
        ("<svg><!-- a -- b --></svg>", SvgErrorCode::Parse),
        ("<svg/><svg/>", SvgErrorCode::Parse),
        ("<svg x:a='1'/>", SvgErrorCode::Parse),
        ("<svg>\u{1}</svg>", SvgErrorCode::Parse),
        ("<html/>", SvgErrorCode::InvalidValue),
        ("<x:svg xmlns:x='urn:other'/>", SvgErrorCode::InvalidValue),
        (
            "<!DOCTYPE s [<!ENTITY a '&b;'><!ENTITY b '&a;'>]><svg>&a;</svg>",
            SvgErrorCode::Parse,
        ),
    ];
    for (svg, code) in cases {
        match parse(svg, &ParseOptions::default()) {
            Ok(_) => panic!("expected an error for {svg:?}"),
            Err(e) => assert_eq!(e.code, *code, "{svg:?}: {e}"),
        }
    }
}

#[test]
fn billion_laughs_is_rejected() {
    let mut s = String::from("<!DOCTYPE svg [<!ENTITY l0 'lol'>");
    for k in 1..10 {
        let prev = format!("&l{};", k - 1).repeat(10);
        s.push_str(&format!("<!ENTITY l{k} '{prev}'>"));
    }
    s.push_str("]><svg>&l9;</svg>");
    assert_eq!(
        parse(&s, &ParseOptions::default()).unwrap_err().code,
        SvgErrorCode::Parse
    );
}

#[test]
fn use_fan_out_is_limited() {
    let mut s = String::from("<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><defs><rect id='a0' width='1' height='1'/>");
    for k in 1..12 {
        s.push_str(&format!(
            "<g id='a{k}'>{}</g>",
            format!("<use href='#a{}'/>", k - 1).repeat(10)
        ));
    }
    s.push_str("</defs><use href='#a11'/></svg>");
    assert_eq!(
        parse(&s, &ParseOptions::default()).unwrap_err().code,
        SvgErrorCode::Limit
    );
}

#[test]
fn bad_options_and_selectors() {
    let svg = "<svg width='10' height='10'><rect width='5' height='5'/></svg>";
    let opts = ParseOptions {
        tolerance: 0.0,
        ..Default::default()
    };
    assert_eq!(
        parse(svg, &opts).unwrap_err().code,
        SvgErrorCode::InvalidValue
    );
    let opts = ParseOptions {
        canvas: Some((0.0, 10.0)),
        ..Default::default()
    };
    assert_eq!(
        parse(svg, &opts).unwrap_err().code,
        SvgErrorCode::InvalidValue
    );
    let scene = parse(svg, &ParseOptions::default()).unwrap();
    for bad in [
        "", "a[", "a >", ":hover", "a + b", "[x~=y]", "#", ".", "a,", "::before", "a]",
    ] {
        let rules = vec![ClassRule::new(bad, "x")];
        assert_eq!(
            classify(&scene, &rules, "ink").unwrap_err().code,
            SvgErrorCode::Pattern,
            "{bad:?}"
        );
        assert_eq!(
            select(&scene, bad).unwrap_err().code,
            SvgErrorCode::Pattern,
            "{bad:?}"
        );
    }
}

#[test]
fn garbage_attributes_never_panic() {
    let samples = [
        "<svg width='-5' height='abc'><rect/></svg>",
        "<svg viewBox='0 0 0 0'><circle r='-1'/></svg>",
        "<svg viewBox='a b c d' width='1e400' height='5'><path d='M'/></svg>",
        "<svg width='10' height='10'><path d='M 0 0 L 1e308 1e308 L -1e308 1e308 z'/></svg>",
        "<svg width='10' height='10'><path d='M 0 0 A 0 0 0 0 0 5 5 A 1e-300 1e300 90 1 1 1 1 Q 1 1 1 1 T 2 2 S 3 3 4 4 Z z z m 1 1'/></svg>",
        "<svg width='10' height='10'><polygon points='1,2,3'/><polyline points='1 2 x'/><line x1='a'/></svg>",
        "<svg width='10' height='10'><text x='1e309' font-size='-3'>t</text><use href='#nope'/><use/></svg>",
        "<svg width='10' height='10' style='fill: url(#)' transform='rotate(1e308)'><rect width='1e308' height='1e308' transform='scale(1e308)'/></svg>",
        "<svg width='10' height='10'><style>@media {{{ rect{fill:red</style><rect width='1' height='1' style='fill:;;;:'/></svg>",
        "<svg width='10' height='10'><ellipse rx='1' ry='0'/><image width='5'/><switch/><svg width='0'/></svg>",
    ];
    for s in samples {
        let _ = parse(s, &ParseOptions::default());
    }
}
