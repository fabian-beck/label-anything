//! The character map (`cmap` formats 4 and 12), flattened for constant-time lookups.
//!
//! Semantics shared with the TypeScript implementation:
//! * One subtable is used: the first record with the best (platform, encoding) of
//!   `(3,10)`, `(0,4)`, `(3,1)`, `(0,3)` whose subtable has format 4 or 12.
//! * Segments (format 4) and groups (format 12) are stably sorted by their start code; a
//!   code point is mapped by the first one in that order that contains it.
//! * Glyph ids `>= numGlyphs` and unmapped code points map to glyph 0.

use crate::reader::{Malformed, Parsed, Reader};

/// (platform, encoding) pairs in order of preference.
const PREFERENCE: [(u16, u16); 4] = [(3, 10), (0, 4), (3, 1), (0, 3)];

/// Code points mapped to consecutive glyphs: `start ↦ glyph`, `start + 1 ↦ glyph + 1`, …
struct Run {
    start: u32,
    end: u32,
    glyph: u16,
}

/// Code point → glyph id.
pub(crate) struct CharMap {
    /// Glyph of every BMP code point.
    bmp: Vec<u16>,
    /// Sorted, disjoint runs above U+FFFF (format 12 only).
    supplementary: Vec<Run>,
}

impl CharMap {
    /// Parses the `cmap` table. `Ok(None)` means it has no usable Unicode subtable.
    pub(crate) fn parse(cmap: Reader, num_glyphs: u16) -> Parsed<Option<CharMap>> {
        let mut best: Option<(usize, Reader)> = None;
        for record in 0..usize::from(cmap.u16(2)?) {
            let at = 4 + 8 * record;
            let key = (cmap.u16(at)?, cmap.u16(at + 2)?);
            let Some(rank) = PREFERENCE.iter().position(|&p| p == key) else {
                continue;
            };
            let subtable = cmap.tail(cmap.u32(at + 4)? as usize)?;
            if matches!(subtable.u16(0)?, 4 | 12) && best.as_ref().is_none_or(|(r, _)| rank < *r) {
                best = Some((rank, subtable));
            }
        }
        let Some((_, subtable)) = best else {
            return Ok(None);
        };
        let mut map = CharMap {
            bmp: vec![0; 0x1_0000],
            supplementary: Vec::new(),
        };
        if subtable.u16(0)? == 4 {
            map.parse_format4(subtable, num_glyphs)?;
        } else {
            map.parse_format12(subtable, num_glyphs)?;
        }
        Ok(Some(map))
    }

    /// The glyph of a code point (0 if unmapped).
    #[inline]
    pub(crate) fn glyph(&self, cp: u32) -> u16 {
        if let Some(&glyph) = self.bmp.get(cp as usize) {
            return glyph;
        }
        let runs = &self.supplementary;
        let index = runs.partition_point(|run| run.end < cp);
        match runs.get(index) {
            // `glyph + (cp - start) < numGlyphs <= 0xFFFF` by construction.
            Some(run) if run.start <= cp => run.glyph + (cp - run.start) as u16,
            _ => 0,
        }
    }

    fn parse_format4(&mut self, sub: Reader, num_glyphs: u16) -> Parsed<()> {
        let length = usize::from(sub.u16(2)?).min(sub.len());
        let seg_count = usize::from(sub.u16(6)? / 2);
        let (ends, starts, deltas, range_offsets) = (
            14,
            16 + 2 * seg_count,
            16 + 4 * seg_count,
            16 + 6 * seg_count,
        );
        let glyph_ids = 16 + 8 * seg_count;
        if length < glyph_ids {
            return Err(Malformed);
        }
        let glyph_id_count = (length - glyph_ids) / 2;
        let mut segments = Vec::with_capacity(seg_count);
        for i in 0..seg_count {
            let (start, end) = (sub.u16(starts + 2 * i)?, sub.u16(ends + 2 * i)?);
            if start <= end {
                let delta = sub.u16(deltas + 2 * i)?;
                let range_offset = sub.u16(range_offsets + 2 * i)?;
                segments.push((start, end, delta, range_offset, i));
            }
        }
        segments.sort_by_key(|segment| segment.0);
        let mut next_free = 0u32; // code points below are mapped by an earlier segment
        for (start, end, delta, range_offset, i) in segments {
            for cp in u32::from(start).max(next_free)..=u32::from(end) {
                let glyph = if range_offset == 0 {
                    (cp as u16).wrapping_add(delta)
                } else {
                    // Index into glyphIdArray, as in the OpenType spec's pointer arithmetic.
                    let index = i64::from(range_offset / 2) + i as i64 + i64::from(cp)
                        - i64::from(start)
                        - seg_count as i64;
                    match usize::try_from(index) {
                        Ok(index) if index < glyph_id_count => {
                            match sub.u16(glyph_ids + 2 * index)? {
                                0 => 0,
                                id => id.wrapping_add(delta),
                            }
                        }
                        _ => 0,
                    }
                };
                self.bmp[cp as usize] = if glyph < num_glyphs { glyph } else { 0 };
            }
            next_free = next_free.max(u32::from(end) + 1);
        }
        Ok(())
    }

    fn parse_format12(&mut self, sub: Reader, num_glyphs: u16) -> Parsed<()> {
        let sub = sub.slice(0, (sub.u32(4)? as usize).min(sub.len()))?;
        let count = sub.u32(12)? as usize;
        sub.check_array(16, count, 12)?;
        let mut groups = Vec::with_capacity(count);
        for k in 0..count {
            let at = 16 + 12 * k;
            let (start, end) = (sub.u32(at)?, sub.u32(at + 4)?.min(0x10_FFFF));
            if start <= end {
                groups.push((start, end, sub.u32(at + 8)?));
            }
        }
        groups.sort_by_key(|group| group.0);
        let num_glyphs = u64::from(num_glyphs);
        let mut next_free = 0u32;
        for (start, end, start_glyph) in groups {
            let first = start.max(next_free);
            let glyph_of = |cp: u32| u64::from(start_glyph) + u64::from(cp - start);
            for cp in first..=end.min(0xFFFF) {
                let glyph = glyph_of(cp);
                self.bmp[cp as usize] = if glyph < num_glyphs { glyph as u16 } else { 0 };
            }
            let first = first.max(0x1_0000);
            if first <= end && glyph_of(first) < num_glyphs {
                let glyph = glyph_of(first);
                let last = u64::from(end).min(u64::from(first) + (num_glyphs - glyph) - 1);
                self.supplementary.push(Run {
                    start: first,
                    end: last as u32,
                    glyph: glyph as u16,
                });
            }
            next_free = next_free.max(end + 1);
        }
        Ok(())
    }
}
