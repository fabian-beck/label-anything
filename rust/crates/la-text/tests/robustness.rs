//! Corrupted fonts are rejected with an error or measured, but never panic.

use std::path::Path;

use label_anything_text::Font;

#[test]
fn corrupted_fonts_never_panic() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/NotoSans-Regular.metrics.ttf");
    let original = std::fs::read(path).expect("bundled font");
    let be32 = |at: usize| u32::from_be_bytes(original[at..at + 4].try_into().unwrap()) as usize;
    let count = usize::from(u16::from_be_bytes([original[4], original[5]]));
    let tables: Vec<(usize, usize)> = (0..count)
        .map(|i| (be32(12 + 16 * i + 8), be32(12 + 16 * i + 12)))
        .filter(|&(_, length)| length > 0)
        .collect();
    let mut state = 0x9E37_79B9_7F4A_7C15u64; // xorshift64
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state as usize
    };
    let (mut loaded, mut rejected) = (0, 0);
    for round in 0..400 {
        let mut data = original.clone();
        let (offset, length) = tables[next() % tables.len()];
        for _ in 0..1 + next() % 8 {
            data[offset + next() % length] = next() as u8;
        }
        if round % 10 == 0 {
            data.truncate(next() % original.len());
        }
        match Font::from_bytes(data) {
            Ok(font) => {
                loaded += 1;
                for text in ["AV", "Hello, World", "Αθήνα", "e\u{301}x", "中文\u{1F600}"] {
                    assert!(font.width(text, 12.0).is_finite());
                }
            }
            Err(_) => rejected += 1,
        }
    }
    assert!(
        loaded > 0 && rejected > 0,
        "loaded {loaded}, rejected {rejected}"
    );
}
