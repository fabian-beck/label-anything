//! Behaviour of the public API on small, hand-checked inputs.

use label_anything_raster::{
    decode, decode_base64, decode_source, estimate_background, parse_hex_color, process,
    rgba_from_base64, srgb_to_oklab, ClassCoverage, GridSpec, ImageFormat, Mode, RasterError,
    RasterErrorKind, RasterPlacement, Rgba,
};

fn image(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Rgba {
    let mut data = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            data.extend_from_slice(&f(x, y));
        }
    }
    Rgba::new(w, h, data).unwrap()
}

fn grid(cols: usize, rows: usize, cell: f64) -> GridSpec {
    GridSpec {
        origin_x: 0.0,
        origin_y: 0.0,
        cell,
        cols,
        rows,
    }
}

fn ink(dilate: u32) -> Mode {
    Mode::Ink {
        background: None,
        threshold: 0.12,
        dilate,
    }
}

fn run(img: &Rgba, mode: &Mode, place: RasterPlacement, g: GridSpec) -> Vec<ClassCoverage> {
    process(img, mode, "ink", &place, &g)
}

const WHITE: [u8; 4] = [255, 255, 255, 255];
const BLACK: [u8; 4] = [0, 0, 0, 255];

#[test]
fn ink_area_fractions_and_quantization() {
    // One black pixel in each 2x2 cell -> 1/4 -> floor(63.75 + 0.5) = 64.
    let img = image(4, 2, |x, y| if (x, y) == (0, 0) { BLACK } else { WHITE });
    let out = run(&img, &ink(0), RasterPlacement::default(), grid(2, 1, 2.0));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].class, "ink");
    assert_eq!(out[0].coverage, vec![64, 0]);
    // A full cell is 255; a cell of 100x100 pixels with one ink pixel still reports 1.
    let full = image(2, 2, |_, _| BLACK);
    assert_eq!(
        run(
            &full,
            &Mode::Ink {
                background: Some([255, 255, 255]),
                threshold: 0.12,
                dilate: 0
            },
            RasterPlacement::default(),
            grid(1, 1, 2.0)
        )[0]
        .coverage,
        vec![255]
    );
    let sparse = image(
        100,
        100,
        |x, y| if x == 50 && y == 50 { BLACK } else { WHITE },
    );
    assert_eq!(
        run(
            &sparse,
            &ink(0),
            RasterPlacement::default(),
            grid(1, 1, 100.0)
        )[0]
        .coverage,
        vec![1]
    );
}

#[test]
fn placement_scale_offset_and_hidpi() {
    // HiDPI: a 4x4 raster at scale 2 covers a 2x2 canvas; each 1 px cell sees 2x2 pixels.
    let img = image(4, 4, |x, y| if x < 2 && y < 2 { BLACK } else { WHITE });
    let place = RasterPlacement {
        scale: 2.0,
        offset: [0.0, 0.0],
    };
    assert_eq!(
        run(&img, &ink(0), place, grid(2, 2, 1.0))[0].coverage,
        vec![255, 0, 0, 0]
    );
    // Offset by half a cell: the black 1x1 canvas square now covers four quarter cells.
    let place = RasterPlacement {
        scale: 2.0,
        offset: [0.5, 0.5],
    };
    assert_eq!(
        run(&img, &ink(0), place, grid(3, 3, 1.0))[0].coverage,
        vec![64, 64, 0, 64, 64, 0, 0, 0, 0]
    );
    // Scale 0.5: one raster pixel covers 2x2 canvas pixels.
    let one = image(1, 1, |_, _| BLACK);
    let place = RasterPlacement {
        scale: 0.5,
        offset: [1.0, 0.0],
    };
    assert_eq!(
        run(
            &one,
            &Mode::Ink {
                background: Some([255, 255, 255]),
                threshold: 0.12,
                dilate: 0
            },
            place,
            grid(4, 2, 1.0)
        )[0]
        .coverage,
        vec![0, 255, 255, 0, 0, 255, 255, 0]
    );
    // Raster entirely outside the grid.
    let place = RasterPlacement {
        scale: 1.0,
        offset: [10.0, 10.0],
    };
    assert_eq!(
        run(&img, &ink(0), place, grid(2, 2, 1.0))[0].coverage,
        vec![0; 4]
    );
}

#[test]
fn dilation_grows_by_whole_cells() {
    let img = image(5, 5, |x, y| if x == 2 && y == 2 { BLACK } else { WHITE });
    let out = run(&img, &ink(1), RasterPlacement::default(), grid(5, 5, 1.0));
    let expect: Vec<u8> = (0..25)
        .map(|i| {
            if (1..=3).contains(&(i % 5)) && (1..=3).contains(&(i / 5)) {
                255
            } else {
                0
            }
        })
        .collect();
    assert_eq!(out[0].coverage, expect);
    let out = run(&img, &ink(7), RasterPlacement::default(), grid(5, 5, 1.0));
    assert_eq!(out[0].coverage, vec![255; 25]);
}

#[test]
fn ink_composites_transparency_over_the_background() {
    // Half-transparent black over white composites to grey 128 (ink); alpha 10 stays near white.
    let img = image(2, 1, |x, _| {
        if x == 0 {
            [0, 0, 0, 128]
        } else {
            [0, 0, 0, 10]
        }
    });
    let mode = Mode::Ink {
        background: Some([255, 255, 255]),
        threshold: 0.12,
        dilate: 0,
    };
    assert_eq!(
        run(&img, &mode, RasterPlacement::default(), grid(2, 1, 1.0))[0].coverage,
        vec![255, 0]
    );
    // Fully transparent pixels of any colour are background.
    let img = image(1, 1, |_, _| [255, 0, 0, 0]);
    assert_eq!(
        run(&img, &mode, RasterPlacement::default(), grid(1, 1, 1.0))[0].coverage,
        vec![0]
    );
}

#[test]
fn alpha_and_cost_modes() {
    let img = image(3, 1, |x, _| [0, 0, 0, [0, 26, 255][x as usize]]);
    let alpha = Mode::Alpha { threshold: 0.1 };
    // 26/255 = 0.10196 > 0.1.
    assert_eq!(
        run(&img, &alpha, RasterPlacement::default(), grid(3, 1, 1.0))[0].coverage,
        vec![0, 255, 255]
    );
    let img = image(3, 1, |x, _| {
        let v = [0u8, 255, 128][x as usize];
        [v, v, v, 255]
    });
    let cost = run(
        &img,
        &Mode::Cost { invert: false },
        RasterPlacement::default(),
        grid(3, 1, 1.0),
    );
    assert_eq!(cost[0].coverage, vec![255, 0, 127]); // 1 − 128/255 = 0.498 -> 127
    let inv = run(
        &img,
        &Mode::Cost { invert: true },
        RasterPlacement::default(),
        grid(3, 1, 1.0),
    );
    assert_eq!(inv[0].coverage, vec![0, 255, 128]);
}

#[test]
fn classmap_order_ignore_and_unmatched() {
    let colors = [
        [255u8, 0, 0],
        [0, 0, 255],
        [0, 200, 0],
        [120, 0, 120],
        [255, 255, 255],
    ];
    let img = image(5, 1, |x, _| {
        let c = colors[x as usize];
        [c[0], c[1], c[2], 255]
    });
    let palette = vec![
        ([0, 0, 255], "water".to_owned()),
        ([255, 0, 0], "roads".to_owned()),
        ([0, 200, 0], "ignore".to_owned()),
        ([1, 0, 254], "water".to_owned()),
        ([0, 0, 0], "text".to_owned()),
    ];
    // In a one-row image every pixel is a border pixel: the estimate would be a tie, so
    // the background is given explicitly.
    let white = Some([255, 255, 255]);
    let mode = Mode::ClassMap {
        palette: palette.clone(),
        tolerance: 0.08,
        unmatched_ink: true,
        background: white,
        ink_threshold: 0.12,
    };
    let out = run(&img, &mode, RasterPlacement::default(), grid(5, 1, 1.0));
    let classes: Vec<&str> = out.iter().map(|c| c.class.as_str()).collect();
    // Palette order of first occurrence; "text" got no pixels; unmatched purple -> ink.
    assert_eq!(classes, ["water", "roads", "ink"]);
    assert_eq!(out[0].coverage, vec![0, 255, 0, 0, 0]);
    assert_eq!(out[1].coverage, vec![255, 0, 0, 0, 0]);
    assert_eq!(out[2].coverage, vec![0, 0, 0, 255, 0]);
    let mode = Mode::ClassMap {
        palette,
        tolerance: 0.08,
        unmatched_ink: false,
        background: white,
        ink_threshold: 0.12,
    };
    let classes: Vec<String> = run(&img, &mode, RasterPlacement::default(), grid(5, 1, 1.0))
        .into_iter()
        .map(|c| c.class)
        .collect();
    assert_eq!(classes, ["water", "roads"]);
    let empty = Mode::ClassMap {
        palette: vec![],
        tolerance: 0.08,
        unmatched_ink: false,
        background: None,
        ink_threshold: 0.12,
    };
    assert!(run(&img, &empty, RasterPlacement::default(), grid(5, 1, 1.0)).is_empty());
}

#[test]
fn saliency_of_flat_and_edged_images() {
    let flat = image(6, 6, |_, _| [90, 90, 90, 255]);
    assert_eq!(
        run(
            &flat,
            &Mode::Saliency,
            RasterPlacement::default(),
            grid(3, 3, 2.0)
        )[0]
        .coverage,
        vec![0; 9]
    );
    let edge = image(6, 6, |x, _| if x < 3 { BLACK } else { WHITE });
    let out = run(
        &edge,
        &Mode::Saliency,
        RasterPlacement::default(),
        grid(3, 3, 2.0),
    );
    // The edge runs through the middle column of cells; left and right columns get less.
    for row in out[0].coverage.chunks(3) {
        assert!(row[1] > row[0] && row[1] > row[2], "{row:?}");
    }
}

#[test]
fn invalid_input_gives_zero_coverage() {
    let img = image(2, 2, |_, _| BLACK);
    let g = grid(2, 2, 1.0);
    for place in [
        RasterPlacement {
            scale: 0.0,
            offset: [0.0, 0.0],
        },
        RasterPlacement {
            scale: -1.0,
            offset: [0.0, 0.0],
        },
        RasterPlacement {
            scale: f64::NAN,
            offset: [0.0, 0.0],
        },
        RasterPlacement {
            scale: f64::INFINITY,
            offset: [0.0, 0.0],
        },
        RasterPlacement {
            scale: 1.0,
            offset: [f64::NAN, 0.0],
        },
    ] {
        assert_eq!(
            run(&img, &ink(1), place, g)[0].coverage,
            vec![0; 4],
            "{place:?}"
        );
    }
    for bad in [
        GridSpec { cell: 0.0, ..g },
        GridSpec {
            cell: f64::NAN,
            ..g
        },
        GridSpec {
            origin_x: f64::INFINITY,
            ..g
        },
    ] {
        assert_eq!(
            run(&img, &ink(1), RasterPlacement::default(), bad)[0].coverage,
            vec![0; 4]
        );
    }
    let broken = Rgba {
        width: 2,
        height: 2,
        data: vec![0; 7],
    };
    assert_eq!(
        run(&broken, &ink(1), RasterPlacement::default(), g)[0].coverage,
        vec![0; 4]
    );
    let cm = Mode::ClassMap {
        palette: vec![([0, 0, 0], "a".into())],
        tolerance: 1.0,
        unmatched_ink: true,
        background: None,
        ink_threshold: 0.0,
    };
    assert!(run(&broken, &cm, RasterPlacement::default(), g).is_empty());
    assert!(
        run(&img, &ink(1), RasterPlacement::default(), grid(0, 5, 1.0))[0]
            .coverage
            .is_empty()
    );
    assert_eq!(estimate_background(&broken), [255, 255, 255]);
}

#[test]
fn colors_and_parsing() {
    assert_eq!(parse_hex_color("#ABC"), Some([0xaa, 0xbb, 0xcc]));
    assert_eq!(parse_hex_color("#a1b2c3"), Some([0xa1, 0xb2, 0xc3]));
    assert_eq!(parse_hex_color("a1b2c3"), None);
    assert_eq!(srgb_to_oklab([0, 0, 0]), [0.0, 0.0, 0.0]);
    assert_eq!(decode_base64("AQID").unwrap(), [1, 2, 3]);
    let img = rgba_from_base64(1, 1, "AQIDBA").unwrap();
    assert_eq!(img.data, [1, 2, 3, 4]);
    let e = rgba_from_base64(2, 1, "AQIDBA").unwrap_err();
    assert_eq!(
        (e.kind, e.code()),
        (RasterErrorKind::InvalidDimensions, "invalid_dimensions")
    );
    assert!(e.to_string().starts_with("invalid_dimensions: "));
}

#[test]
fn format_sniffing_and_decode_errors() {
    assert_eq!(
        ImageFormat::sniff(b"\x89PNG\r\n\x1a\nrest"),
        Some(ImageFormat::Png)
    );
    assert_eq!(
        ImageFormat::sniff(&[0xff, 0xd8, 0xff, 0xe0]),
        Some(ImageFormat::Jpeg)
    );
    assert_eq!(
        ImageFormat::sniff(b"RIFF\0\0\0\0WEBPVP8 "),
        Some(ImageFormat::WebP)
    );
    assert_eq!(ImageFormat::sniff(b"GIF89a"), None);
    assert_eq!(ImageFormat::Png.mime_type(), "image/png");
    let kind = |r: Result<Rgba, RasterError>| r.unwrap_err().kind;
    assert_eq!(
        kind(decode(b"GIF89a....")),
        RasterErrorKind::UnsupportedFormat
    );
    assert_eq!(kind(decode(b"")), RasterErrorKind::UnsupportedFormat);
    assert_eq!(
        kind(decode_source("data:image/png;base64,R0lGODlh")),
        RasterErrorKind::UnsupportedFormat
    );
    assert_eq!(
        kind(decode_source("data:image/png;base64")),
        RasterErrorKind::InvalidDataUrl
    );
    assert_eq!(kind(decode_source("@@@")), RasterErrorKind::InvalidBase64);
}

#[cfg(feature = "decode")]
mod codecs {
    use super::*;
    use std::io::Cursor;

    fn sample() -> image::RgbaImage {
        image::RgbaImage::from_fn(16, 12, |x, y| {
            image::Rgba([(x * 16) as u8, (y * 20) as u8, 128, 255])
        })
    }

    fn encode(img: &image::RgbaImage, format: image::ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img.clone())
            .to_rgb8()
            .write_to(&mut out, format)
            .unwrap();
        out.into_inner()
    }

    #[test]
    fn decodes_webp_lossless_exactly() {
        let img = sample();
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::WebP).unwrap();
        let bytes = out.into_inner();
        assert_eq!(ImageFormat::sniff(&bytes), Some(ImageFormat::WebP));
        let decoded = decode(&bytes).unwrap();
        assert_eq!((decoded.width, decoded.height), (16, 12));
        assert_eq!(decoded.data, img.into_raw());
    }

    #[test]
    fn decodes_jpeg_approximately() {
        let img = sample();
        let bytes = encode(&img, image::ImageFormat::Jpeg);
        assert_eq!(ImageFormat::sniff(&bytes), Some(ImageFormat::Jpeg));
        let decoded = decode(&bytes).unwrap();
        assert_eq!((decoded.width, decoded.height), (16, 12));
        let max_err = decoded
            .data
            .iter()
            .zip(img.as_raw())
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap();
        assert!(max_err <= 24, "JPEG error {max_err}");
        let mut broken = bytes.clone();
        broken.truncate(bytes.len() / 3);
        assert!(decode(&broken).is_err());
    }

    #[test]
    fn png_16_bit_rounds_like_the_spec() {
        // (v + 128) div 257 for every 16-bit value.
        let gray = image::ImageBuffer::<image::Luma<u16>, _>::from_fn(256, 256, |x, y| {
            image::Luma([(y * 256 + x) as u16])
        });
        let mut out = Cursor::new(Vec::new());
        gray.write_to(&mut out, image::ImageFormat::Png).unwrap();
        let decoded = decode(&out.into_inner()).unwrap();
        for (v, px) in decoded.data.as_chunks::<4>().0.iter().enumerate() {
            let want = ((v as u32 + 128) / 257) as u8;
            assert_eq!(*px, [want, want, want, 255], "v = {v}");
        }
    }
}

#[cfg(not(feature = "decode"))]
#[test]
fn decoding_needs_the_feature() {
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR";
    assert_eq!(decode(png).unwrap_err().kind, RasterErrorKind::Unsupported);
}
