//! Malformed input never panics: deterministic mutation fuzzing of the decoders and of
//! `process` on odd geometry.
#![cfg(feature = "decode")]

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use label_anything_raster::{
    decode, decode_source, process, GridSpec, Mode, RasterPlacement, Rgba,
};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 11
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut c = !0u32;
    for &b in bytes {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
    }
    !c
}

/// Byte ranges `(start of length field, data start, data end)` of the PNG chunks.
fn chunks(png: &[u8]) -> Vec<(usize, usize, usize)> {
    let mut out = Vec::new();
    let mut pos = 8;
    while pos + 12 <= png.len() {
        let len = u32::from_be_bytes(png[pos..pos + 4].try_into().unwrap()) as usize;
        let end = pos + 8 + len;
        if end + 4 > png.len() {
            break;
        }
        out.push((pos, pos + 8, end));
        pos = end + 4;
    }
    out
}

fn fix_crc(png: &mut [u8], chunk: (usize, usize, usize)) {
    let crc = crc32(&png[chunk.0 + 4..chunk.2]);
    png[chunk.2..chunk.2 + 4].copy_from_slice(&crc.to_be_bytes());
}

fn mutate(rng: &mut Rng, src: &[u8]) -> Vec<u8> {
    let mut b = src.to_vec();
    let cs = chunks(&b);
    match rng.below(8) {
        0 => {
            let i = rng.below(b.len());
            b[i] ^= 1 << rng.below(8);
        }
        1 => {
            let i = rng.below(b.len());
            b[i] = rng.next() as u8;
        }
        2 => b.truncate(rng.below(b.len())),
        3 => {
            let i = rng.below(b.len());
            b.insert(i, rng.next() as u8);
        }
        4 if !cs.is_empty() => {
            // Mutate chunk data and repair the CRC, to get past the checksum.
            let c = cs[rng.below(cs.len())];
            if c.2 > c.1 {
                let i = c.1 + rng.below(c.2 - c.1);
                b[i] = rng.next() as u8;
                fix_crc(&mut b, c);
            }
        }
        5 if !cs.is_empty() => {
            // Corrupt a length field.
            let c = cs[rng.below(cs.len())];
            b[c.0 + rng.below(4)] = rng.next() as u8;
        }
        6 if cs.len() > 1 => {
            // Duplicate or drop a chunk.
            let c = cs[rng.below(cs.len())];
            let chunk = b[c.0..c.2 + 4].to_vec();
            if rng.below(2) == 0 {
                b.splice(c.0..c.0, chunk);
            } else {
                b.drain(c.0..c.2 + 4);
            }
        }
        _ => {
            // Several flips at once inside the image data, CRC repaired.
            if let Some(&c) = cs.iter().find(|c| &b[c.0 + 4..c.0 + 8] == b"IDAT") {
                for _ in 0..1 + rng.below(4) {
                    if c.2 > c.1 {
                        let i = c.1 + rng.below(c.2 - c.1);
                        b[i] ^= 1 << rng.below(8);
                    }
                }
                fix_crc(&mut b, c);
            }
        }
    }
    b
}

/// Mutations per image; `LA_FUZZ_ITERATIONS` overrides it for longer runs.
fn iterations() -> usize {
    std::env::var("LA_FUZZ_ITERATIONS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(150)
}

#[test]
fn mutated_pngs_never_panic() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../conformance/raster/images");
    let n = iterations();
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    files.sort();
    let mut rng = Rng(0x5eed);
    let (mut ok, mut errors) = (0usize, 0usize);
    for path in &files {
        let original = std::fs::read(path).unwrap();
        for i in 0..n {
            let bytes = mutate(&mut rng, &original);
            match catch_unwind(AssertUnwindSafe(|| decode(&bytes))) {
                Ok(Ok(_)) => ok += 1,
                Ok(Err(_)) => errors += 1,
                Err(_) => panic!("decode panicked on mutation {i} of {}", path.display()),
            }
        }
    }
    assert!(ok > 0 && errors > 0, "ok {ok}, errors {errors}");
}

#[test]
fn hostile_sources_never_panic() {
    let inputs = [
        "",
        " ",
        "data:",
        "data:,",
        "data:;base64,",
        "data:image/png;base64,====",
        "data:%",
        "data:,%zz",
        "\u{1F600}",
        "data:\u{e9},x",
        "iVBORw0KGgo=",
        "/9j/",
        "UklGRgAAAABXRUJQ",
        "data:image/webp;base64,UklGRgAAAABXRUJQVlA4IA==",
    ];
    for s in inputs {
        assert!(catch_unwind(|| decode_source(s)).is_ok(), "{s:?}");
    }
    let mut rng = Rng(7);
    for _ in 0..2000 {
        let len = rng.below(40);
        let prefix: &[u8] = match rng.below(3) {
            0 => b"\x89PNG\r\n\x1a\n",
            1 => &[0xff, 0xd8, 0xff],
            _ => b"RIFF\0\0\0\0WEBP",
        };
        let mut bytes = prefix.to_vec();
        bytes.extend((0..len).map(|_| rng.next() as u8));
        assert!(catch_unwind(|| decode(&bytes)).is_ok());
    }
}

#[test]
fn odd_geometry_never_panics() {
    let img = Rgba::new(3, 2, (0..24).map(|i| (i * 37) as u8).collect()).unwrap();
    let values = [
        0.0,
        -0.0,
        1e-300,
        1e-12,
        0.3,
        1.0,
        7.0,
        1e12,
        1e300,
        f64::MAX,
        f64::MIN_POSITIVE,
        -5.0,
        f64::NAN,
        f64::INFINITY,
    ];
    let modes = [
        Mode::Ink {
            background: None,
            threshold: 0.12,
            dilate: 3,
        },
        Mode::Alpha {
            threshold: f64::NAN,
        },
        Mode::Cost { invert: true },
        Mode::ClassMap {
            palette: vec![([1, 2, 3], "a".into())],
            tolerance: f64::INFINITY,
            unmatched_ink: true,
            background: None,
            ink_threshold: f64::NAN,
        },
        Mode::Saliency,
    ];
    for &scale in &values {
        for &offset in &values {
            for &cell in &values {
                for mode in &modes {
                    let place = RasterPlacement {
                        scale,
                        offset: [offset, -offset],
                    };
                    let grid = GridSpec {
                        origin_x: offset,
                        origin_y: 0.5,
                        cell,
                        cols: 3,
                        rows: 2,
                    };
                    let out = process(&img, mode, "c", &place, &grid);
                    assert!(out.iter().all(|c| c.coverage.len() == 6));
                }
            }
        }
    }
}
