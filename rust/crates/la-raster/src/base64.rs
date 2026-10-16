//! Base64 and `data:` URL parsing (spec §4.6), identical to the TypeScript implementation.
//!
//! Base64 rules: the standard (`+ /`) and URL-safe (`- _`) alphabets are both accepted
//! (and may be mixed); ASCII whitespace (space, tab, LF, CR, FF) is ignored anywhere;
//! padding is optional, but if present it must complete the last 4-character quantum and
//! nothing but whitespace may follow it; a quantum of a single character is an error;
//! non-zero trailing bits are ignored.

use crate::error::{RasterError, RasterErrorKind};

const INVALID: u8 = 0xFF;
const SKIP: u8 = 0xFE;
const PAD: u8 = 0xFD;

const fn decode_table() -> [u8; 256] {
    let mut t = [INVALID; 256];
    let mut i = 0;
    while i < 26 {
        t[b'A' as usize + i] = i as u8;
        t[b'a' as usize + i] = 26 + i as u8;
        i += 1;
    }
    let mut d = 0;
    while d < 10 {
        t[b'0' as usize + d] = 52 + d as u8;
        d += 1;
    }
    t[b'+' as usize] = 62;
    t[b'-' as usize] = 62;
    t[b'/' as usize] = 63;
    t[b'_' as usize] = 63;
    t[b'=' as usize] = PAD;
    t[b' ' as usize] = SKIP;
    t[b'\t' as usize] = SKIP;
    t[b'\n' as usize] = SKIP;
    t[b'\r' as usize] = SKIP;
    t[0x0C] = SKIP;
    t
}

static TABLE: [u8; 256] = decode_table();

/// `TABLE` values shifted into place for the fast path: quantum position `k` holds the
/// sextet at bit `18 − 6k`; non-alphabet characters have bit 31 set.
const fn shifted_table(k: u32) -> [u32; 256] {
    let t = decode_table();
    let mut s = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        s[i] = if t[i] < 64 {
            (t[i] as u32) << (18 - 6 * k)
        } else {
            1 << 31
        };
        i += 1;
    }
    s
}

static SHIFTED: [[u32; 256]; 4] = [
    shifted_table(0),
    shifted_table(1),
    shifted_table(2),
    shifted_table(3),
];

fn b64_error(message: String) -> RasterError {
    RasterError::new(RasterErrorKind::InvalidBase64, message)
}

/// Decodes base64 text (standard or URL-safe alphabet, padding optional, whitespace ignored).
///
/// ```
/// assert_eq!(label_anything_raster::decode_base64("aGk=").unwrap(), b"hi");
/// assert_eq!(label_anything_raster::decode_base64("aGk").unwrap(), b"hi");
/// assert!(label_anything_raster::decode_base64("a").is_err());
/// ```
pub fn decode_base64(input: &str) -> Result<Vec<u8>, RasterError> {
    let bytes = input.as_bytes();
    // fast path: leading whole quanta of four alphabet characters (no whitespace or
    // padding), three bytes at a time; the general decoder continues from the first
    // other character
    let mut out = vec![0u8; bytes.len() / 4 * 3 + 3];
    let mut o = 0;
    let mut i = 0;
    let [t0, t1, t2, t3] = &SHIFTED;
    for (q, dst) in bytes.chunks_exact(4).zip(out.chunks_exact_mut(3)) {
        let v = t0[q[0] as usize] | t1[q[1] as usize] | t2[q[2] as usize] | t3[q[3] as usize];
        if v >> 31 != 0 {
            break;
        }
        dst.copy_from_slice(&(v << 8).to_be_bytes()[..3]);
        o += 3;
        i += 4;
    }
    out.truncate(o);
    decode_from(bytes, i, out)
}

/// The general decoder (all rules above), from byte `start` (a quantum boundary) on,
/// appending to `out`.
fn decode_from(bytes: &[u8], start: usize, mut out: Vec<u8>) -> Result<Vec<u8>, RasterError> {
    let mut acc: u32 = 0;
    let mut nbits: u32 = 0;
    let mut chars: usize = start;
    let mut pad: usize = 0;
    for (pos, &c) in bytes.iter().enumerate().skip(start) {
        let v = TABLE[c as usize];
        match v {
            SKIP => continue,
            PAD => {
                pad += 1;
                continue;
            }
            INVALID => {
                return Err(b64_error(format!(
                    "invalid base64 character at offset {pos}"
                )));
            }
            _ => {}
        }
        if pad > 0 {
            return Err(b64_error(format!(
                "base64 data after padding at offset {pos}"
            )));
        }
        acc = (acc << 6) | u32::from(v);
        nbits += 6;
        chars += 1;
        if nbits >= 8 {
            nbits -= 8;
            out.push((acc >> nbits) as u8);
            acc &= (1 << nbits) - 1;
        }
    }
    if chars % 4 == 1 {
        return Err(b64_error(
            "truncated base64 data (dangling character)".into(),
        ));
    }
    if pad > 0 && (pad > 2 || !(chars + pad).is_multiple_of(4)) {
        return Err(b64_error("invalid base64 padding".into()));
    }
    Ok(out)
}

fn is_ascii_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0C)
}

fn hex_value(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Returns the bytes of a raster `source` string: a `data:` URL (`;base64` or
/// percent-encoded) or bare base64. Surrounding ASCII whitespace is ignored and the
/// `data:` prefix and `;base64` marker are case-insensitive. The media type is not
/// interpreted (formats are recognized by their signature).
pub(crate) fn source_bytes(src: &str) -> Result<Vec<u8>, RasterError> {
    let b = src.as_bytes();
    let start = b.iter().position(|&c| !is_ascii_ws(c)).unwrap_or(b.len());
    let end = b
        .iter()
        .rposition(|&c| !is_ascii_ws(c))
        .map_or(start, |p| p + 1);
    let s = &b[start..end];
    if s.len() < 5 || !s[..5].eq_ignore_ascii_case(b"data:") {
        // `start..end` are ASCII boundaries, so this slice is valid UTF-8.
        return decode_base64(&src[start..end]);
    }
    let rest = &s[5..];
    let Some(comma) = rest.iter().position(|&c| c == b',') else {
        return Err(RasterError::new(
            RasterErrorKind::InvalidDataUrl,
            "data: URL without ','",
        ));
    };
    let meta = &rest[..comma];
    let payload = &rest[comma + 1..];
    let is_base64 = meta.len() >= 7 && meta[meta.len() - 7..].eq_ignore_ascii_case(b";base64");
    if is_base64 {
        // `payload` starts after an ASCII ',' and ends at an ASCII boundary.
        let text = &src[start + 5 + comma + 1..end];
        return decode_base64(text);
    }
    let mut out = Vec::with_capacity(payload.len());
    let mut i = 0;
    while i < payload.len() {
        let c = payload[i];
        if c == b'%' {
            let hi = payload.get(i + 1).copied().and_then(hex_value);
            let lo = payload.get(i + 2).copied().and_then(hex_value);
            match (hi, lo) {
                (Some(h), Some(l)) => out.push(h << 4 | l),
                _ => {
                    return Err(RasterError::new(
                        RasterErrorKind::InvalidDataUrl,
                        format!("invalid percent escape in data: URL at offset {i}"),
                    ))
                }
            }
            i += 3;
        } else {
            out.push(c);
            i += 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_standard_and_url_safe() {
        assert_eq!(decode_base64("").unwrap(), b"");
        assert_eq!(decode_base64("TWFu").unwrap(), b"Man");
        assert_eq!(decode_base64("TWE=").unwrap(), b"Ma");
        assert_eq!(decode_base64("TQ==").unwrap(), b"M");
        assert_eq!(decode_base64("TQ").unwrap(), b"M");
        assert_eq!(decode_base64(" T W\nF u\r\n").unwrap(), b"Man");
        assert_eq!(
            decode_base64("-_-_").unwrap(),
            decode_base64("+/+/").unwrap()
        );
        // the fast path (whole quanta) hands over to the general one mid-input
        assert_eq!(decode_base64("TWFuTWFu").unwrap(), b"ManMan");
        assert_eq!(decode_base64("TWFuTWE=").unwrap(), b"ManMa");
        assert_eq!(decode_base64("TWFuTWE").unwrap(), b"ManMa");
        assert_eq!(decode_base64("TWFuTQ").unwrap(), b"ManM");
        assert_eq!(decode_base64("TWFu TW\nFu").unwrap(), b"ManMan");
        assert_eq!(decode_base64("TWFuTWFu\n").unwrap(), b"ManMan");
    }

    #[test]
    fn fast_path_agrees_with_the_general_decoder() {
        // random data, encoded and then mutated (whitespace, padding, URL-safe and
        // invalid characters): the fast path must not change any result
        let mut x = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for _ in 0..4000 {
            let n = (next() % 40) as usize;
            let data: Vec<u8> = (0..n).map(|_| next() as u8).collect();
            let mut text = Vec::new();
            for q in data.chunks(3) {
                let v = q
                    .iter()
                    .enumerate()
                    .fold(0u32, |v, (k, &b)| v | u32::from(b) << (16 - 8 * k));
                for k in 0..4 {
                    text.push(if k <= q.len() {
                        ALPHABET[(v >> (18 - 6 * k) & 63) as usize]
                    } else {
                        b'='
                    });
                }
            }
            assert_eq!(
                decode_base64(std::str::from_utf8(&text).unwrap()).unwrap(),
                data
            );
            for _ in 0..(next() % 3) {
                if text.is_empty() {
                    break;
                }
                let at = (next() % text.len() as u64) as usize;
                text[at] = match next() % 5 {
                    0 => b'=',
                    1 => b' ',
                    2 => b'-',
                    3 => b'*',
                    _ => ALPHABET[(next() % 64) as usize],
                };
            }
            let text = std::str::from_utf8(&text).unwrap();
            let general = decode_from(text.as_bytes(), 0, Vec::new());
            assert_eq!(
                decode_base64(text).ok(),
                general.as_ref().ok().cloned(),
                "{text:?}"
            );
            if let (Err(a), Err(b)) = (decode_base64(text), general) {
                assert_eq!(a.message, b.message, "{text:?}");
            }
        }
    }

    #[test]
    fn rejects_malformed() {
        for bad in [
            "T",
            "TQ=",
            "TQ===",
            "TQ==TQ==",
            "TWFu=",
            "TW*u",
            "TWFuT",
            "é",
            "TWFuTWFuT",
            "TWFuTW*u",
            "TWFuTQ==TWFu",
        ] {
            let e = decode_base64(bad).unwrap_err();
            assert_eq!(e.kind, RasterErrorKind::InvalidBase64, "{bad}");
        }
    }

    #[test]
    fn parses_data_urls() {
        assert_eq!(source_bytes("data:image/png;base64,TWFu").unwrap(), b"Man");
        assert_eq!(source_bytes("  DATA:;BASE64,TWFu \n").unwrap(), b"Man");
        assert_eq!(source_bytes("data:,M%61n").unwrap(), b"Man");
        assert_eq!(source_bytes("TWFu").unwrap(), b"Man");
        assert_eq!(
            source_bytes("data:image/png;base64").unwrap_err().kind,
            RasterErrorKind::InvalidDataUrl
        );
        assert_eq!(
            source_bytes("data:,%6").unwrap_err().kind,
            RasterErrorKind::InvalidDataUrl
        );
        assert_eq!(
            source_bytes("data:;base64,T").unwrap_err().kind,
            RasterErrorKind::InvalidBase64
        );
    }
}
