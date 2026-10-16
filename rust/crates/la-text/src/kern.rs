//! Pair kerning for simple shaping (spec §5.2): GPOS `kern` lookups or a legacy `kern`
//! table, flattened at load time into per-glyph tables.
//!
//! Semantics shared with the TypeScript implementation:
//! * Kern lookups: the union of the lookup indices of every `kern` feature referenced by
//!   any script's default or language system (feature indices and the required feature
//!   index), applied in ascending order. Only PairPos (type 2, or type 9 extensions of
//!   type 2) subtables take part.
//! * A lookup is applied to the whole glyph sequence. At position `i` (skipped if the glyph
//!   is a mark and the lookup flag has IgnoreMarks), `j` is the next glyph, skipping marks
//!   under IgnoreMarks. The first subtable that matches `(g[i], g[j])` adds the XAdvance of
//!   both value records; the walk continues at `j + 1` if ValueFormat2 ≠ 0, else at `j`.
//!   Without a match it continues at `i + 1`.
//! * Coverage, ClassDef and PairSet entries are normalised like the character map: ranges
//!   are stably sorted by start and the first one containing a glyph wins; duplicate
//!   glyphs keep their first record.
//! * Without a GPOS `kern` feature, a legacy `kern` table (Microsoft or Apple header) acts
//!   as one IgnoreMarks lookup whose pairs never skip their second glyph; pair values are
//!   summed over its format 0 subtables that are horizontal, not cross-stream and not
//!   minimum values (Apple: not vertical, not cross-stream, no variation).
//! * A malformed GDEF, GPOS or `kern` table is treated as absent.

use crate::reader::{Malformed, Parsed, Reader};

const KERN: u32 = u32::from_be_bytes(*b"kern");
const IGNORE_MARKS: u16 = 0x0008;

/// Marks (GDEF glyph class 3) and the kern lookups of a font.
pub(crate) struct Kerning {
    marks: Vec<bool>,
    lookups: Vec<PairLookup>,
}

impl Kerning {
    pub(crate) fn parse(
        gdef: Option<Reader>,
        gpos: Option<Reader>,
        kern: Option<Reader>,
        num_glyphs: u16,
    ) -> Kerning {
        let marks = gdef
            .and_then(|table| parse_marks(table, num_glyphs).ok())
            .unwrap_or_else(|| vec![false; usize::from(num_glyphs)]);
        let lookups = match gpos.and_then(|table| parse_gpos(table, num_glyphs).ok().flatten()) {
            Some(lookups) => lookups,
            None => kern
                .and_then(|table| parse_kern_table(table, num_glyphs).ok().flatten())
                .into_iter()
                .collect(),
        };
        Kerning { marks, lookups }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.lookups.is_empty()
    }

    /// Sum of all kerning adjustments of a glyph sequence, in font units.
    pub(crate) fn adjustment(&self, glyphs: &[u16]) -> i64 {
        self.lookups
            .iter()
            .map(|lookup| lookup.apply(glyphs, &self.marks))
            .sum()
    }
}

/// One subtable of a pair lookup, in matching form.
enum PairSubtable {
    /// PairPos format 1 (and the legacy `kern` table): explicit glyph pairs.
    Glyphs {
        skip_second: bool,
        /// Per pair set: range in `records`.
        sets: Vec<(u32, u32)>,
        /// (second glyph, XAdvance sum), sorted by second glyph within each set.
        records: Vec<(u16, i32)>,
    },
    /// PairPos format 2: class pairs.
    Classes {
        skip_second: bool,
        /// Index into `PairLookup::class_tables` (ClassDef2 per glyph).
        class2: usize,
        class2_count: u16,
        /// XAdvance sums, `class1 * class2_count + class2`; empty when all are zero.
        deltas: Vec<i32>,
    },
}

impl PairSubtable {
    /// `(adjustment, skip second glyph)` if this subtable matches `(first, second)`;
    /// `key` is the first glyph's pair set index or class.
    #[inline]
    fn find(&self, key: u16, second: u16, class_tables: &[Vec<u16>]) -> Option<(i32, bool)> {
        match self {
            PairSubtable::Glyphs {
                skip_second,
                sets,
                records,
            } => {
                let (lo, hi) = sets[usize::from(key)];
                let set = &records[lo as usize..hi as usize];
                let index = set.binary_search_by_key(&second, |record| record.0).ok()?;
                Some((set[index].1, *skip_second))
            }
            PairSubtable::Classes {
                skip_second,
                class2,
                class2_count,
                deltas,
            } => {
                let class2 = class_tables[*class2][usize::from(second)];
                if class2 >= *class2_count {
                    return None;
                }
                let index = usize::from(key) * usize::from(*class2_count) + usize::from(class2);
                Some((deltas.get(index).copied().unwrap_or(0), *skip_second))
            }
        }
    }
}

/// A pair-positioning lookup with its subtables indexed by first glyph.
struct PairLookup {
    ignore_marks: bool,
    /// CSR index: the slots of glyph `g` are `slots[offsets[g]..offsets[g + 1]]`.
    offsets: Vec<u32>,
    /// (subtable, key) in subtable order.
    slots: Vec<(u16, u16)>,
    subtables: Vec<PairSubtable>,
    class_tables: Vec<Vec<u16>>,
}

impl PairLookup {
    fn apply(&self, glyphs: &[u16], marks: &[bool]) -> i64 {
        let n = glyphs.len();
        let mut total = 0i64;
        let mut i = 0;
        while i < n {
            let first = usize::from(glyphs[i]);
            if self.ignore_marks && marks[first] {
                i += 1;
                continue;
            }
            let slots = &self.slots[self.offsets[first] as usize..self.offsets[first + 1] as usize];
            if slots.is_empty() {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            while self.ignore_marks && j < n && marks[usize::from(glyphs[j])] {
                j += 1;
            }
            if j >= n {
                break;
            }
            let mut next = i + 1;
            for &(subtable, key) in slots {
                let subtable = &self.subtables[usize::from(subtable)];
                if let Some((delta, skip)) = subtable.find(key, glyphs[j], &self.class_tables) {
                    total += i64::from(delta);
                    next = if skip { j + 1 } else { j };
                    break;
                }
            }
            i = next;
        }
        total
    }
}

/// Collects subtables and their first-glyph slots, then builds the CSR index.
struct LookupBuilder {
    num_glyphs: usize,
    /// (first glyph, subtable, key)
    slots: Vec<(u16, u16, u16)>,
    subtables: Vec<PairSubtable>,
    class_tables: Vec<Vec<u16>>,
    class_table_addresses: Vec<usize>,
}

impl LookupBuilder {
    fn new(num_glyphs: u16) -> Self {
        LookupBuilder {
            num_glyphs: usize::from(num_glyphs),
            slots: Vec::new(),
            subtables: Vec::new(),
            class_tables: Vec::new(),
            class_table_addresses: Vec::new(),
        }
    }

    fn push_subtable(&mut self, subtable: PairSubtable, slots: impl Iterator<Item = (u16, u16)>) {
        // A lookup has at most 0xFFFF subtables (its count is a uint16).
        let index = self.subtables.len() as u16;
        self.subtables.push(subtable);
        self.slots
            .extend(slots.map(|(glyph, key)| (glyph, index, key)));
    }

    /// Adds a PairPos subtable (formats 1 and 2; other formats never match).
    fn add_pair_pos(&mut self, st: Reader) -> Parsed<()> {
        let format = st.u16(0)?;
        let Some(coverage_table) = st.offset16(2)? else {
            return Ok(());
        };
        let (format1, format2) = (st.u16(4)?, st.u16(6)?);
        let first = ValueReader::new(format1, 0);
        let second = ValueReader::new(format2, first.size);
        let record_size = first.size + second.size;
        let skip_second = format2 != 0;
        let num_glyphs = self.num_glyphs as u16;
        match format {
            1 => {
                let covered = coverage(coverage_table, num_glyphs)?;
                let set_count = usize::from(st.u16(8)?);
                let mut sets = Vec::with_capacity(set_count);
                let mut records = Vec::new();
                for set in 0..set_count {
                    let start = records.len() as u32;
                    if let Some(set) = st.offset16(10 + 2 * set)? {
                        let count = usize::from(set.u16(0)?);
                        set.check_array(2, count, 2 + record_size)?;
                        let mut pairs = (0..count)
                            .map(|r| {
                                let at = 2 + r * (2 + record_size);
                                Ok((
                                    set.u16(at)?,
                                    first.x_advance(set, at + 2)?
                                        + second.x_advance(set, at + 2)?,
                                ))
                            })
                            .collect::<Parsed<Vec<(u16, i32)>>>()?;
                        pairs.sort_by_key(|pair| pair.0);
                        pairs.dedup_by_key(|pair| pair.0);
                        records.extend(pairs);
                    }
                    sets.push((start, records.len() as u32));
                }
                let slots = covered
                    .into_iter()
                    .filter(|&(_, index)| sets.get(index as usize).is_some_and(|(lo, hi)| lo < hi))
                    .map(|(glyph, index)| (glyph, index as u16))
                    .collect::<Vec<_>>();
                self.push_subtable(
                    PairSubtable::Glyphs {
                        skip_second,
                        sets,
                        records,
                    },
                    slots.into_iter(),
                );
            }
            2 => {
                let covered = coverage(coverage_table, num_glyphs)?;
                let class1 = st
                    .offset16(8)?
                    .map(|t| class_def(t, num_glyphs))
                    .transpose()?;
                let class2_table = st.offset16(10)?;
                let (class1_count, class2_count) = (st.u16(12)?, st.u16(14)?);
                let cells = usize::from(class1_count) * usize::from(class2_count);
                st.check_array(16, cells, record_size)?;
                let deltas = if first.x_at.is_none() && second.x_at.is_none() {
                    Vec::new()
                } else {
                    (0..cells)
                        .map(|cell| {
                            let at = 16 + cell * record_size;
                            Ok(first.x_advance(st, at)? + second.x_advance(st, at)?)
                        })
                        .collect::<Parsed<Vec<i32>>>()?
                };
                let class2 = self.class_table(class2_table)?;
                let class_of = |glyph: u16| class1.as_ref().map_or(0, |c| c[usize::from(glyph)]);
                let slots = covered
                    .into_iter()
                    .map(|(glyph, _)| (glyph, class_of(glyph)))
                    .filter(|&(_, class)| class < class1_count)
                    .collect::<Vec<_>>();
                let subtable = PairSubtable::Classes {
                    skip_second,
                    class2,
                    class2_count,
                    deltas,
                };
                self.push_subtable(subtable, slots.into_iter());
            }
            _ => {}
        }
        Ok(())
    }

    /// Index of the flattened ClassDef (a null offset means class 0 for every glyph).
    fn class_table(&mut self, table: Option<Reader>) -> Parsed<usize> {
        let address = table.map_or(0, |t| t.address());
        if let Some(index) = self
            .class_table_addresses
            .iter()
            .position(|&a| a == address)
        {
            return Ok(index);
        }
        let classes = match table {
            Some(table) => class_def(table, self.num_glyphs as u16)?,
            None => vec![0; self.num_glyphs],
        };
        self.class_tables.push(classes);
        self.class_table_addresses.push(address);
        Ok(self.class_tables.len() - 1)
    }

    fn finish(mut self, ignore_marks: bool) -> Option<PairLookup> {
        if self.slots.is_empty() {
            return None;
        }
        self.slots.sort_by_key(|slot| slot.0); // stable: keeps subtable order per glyph
        let mut offsets = vec![0u32; self.num_glyphs + 1];
        for &(glyph, _, _) in &self.slots {
            offsets[usize::from(glyph) + 1] += 1;
        }
        for g in 0..self.num_glyphs {
            offsets[g + 1] += offsets[g];
        }
        Some(PairLookup {
            ignore_marks,
            offsets,
            slots: self
                .slots
                .into_iter()
                .map(|(_, subtable, key)| (subtable, key))
                .collect(),
            subtables: self.subtables,
            class_tables: self.class_tables,
        })
    }
}

/// Reads the XAdvance of one value record of a given ValueFormat.
struct ValueReader {
    /// Byte offset of XAdvance from the start of the pair record's value part.
    x_at: Option<usize>,
    size: usize,
}

impl ValueReader {
    fn new(format: u16, start: usize) -> Self {
        let x_at =
            (format & 0x0004 != 0).then(|| start + 2 * (format & 0x0003).count_ones() as usize);
        ValueReader {
            x_at,
            size: 2 * format.count_ones() as usize,
        }
    }

    fn x_advance(&self, data: Reader, values_at: usize) -> Parsed<i32> {
        self.x_at
            .map_or(Ok(0), |x| data.i16(values_at + x).map(i32::from))
    }
}

/// Parses ranges `(start, end, value)` with "stably sorted by start, first wins"
/// semantics and calls `assign(glyph, value_at_start, start)` for each glyph `< num_glyphs`.
fn sweep_ranges(
    mut ranges: Vec<(u16, u16, u32)>,
    num_glyphs: u16,
    mut assign: impl FnMut(u16, u32, u16),
) {
    ranges.sort_by_key(|range| range.0);
    let mut next_free = 0u32;
    for (start, end, value) in ranges {
        let last = u32::from(end).min(u32::from(num_glyphs).saturating_sub(1));
        for glyph in u32::from(start).max(next_free)..=last {
            assign(glyph as u16, value, start);
        }
        next_free = next_free.max(u32::from(end) + 1);
    }
}

/// Coverage table → `(glyph, coverage index)` sorted by glyph (unknown formats cover nothing).
fn coverage(table: Reader, num_glyphs: u16) -> Parsed<Vec<(u16, u32)>> {
    let count = usize::from(table.u16(2)?);
    let mut out = Vec::new();
    match table.u16(0)? {
        1 => {
            table.check_array(4, count, 2)?;
            for index in 0..count {
                let glyph = table.u16(4 + 2 * index)?;
                if glyph < num_glyphs {
                    out.push((glyph, index as u32));
                }
            }
            out.sort_by_key(|entry| entry.0);
            out.dedup_by_key(|entry| entry.0);
        }
        2 => {
            table.check_array(4, count, 6)?;
            let ranges = (0..count)
                .map(|r| {
                    let at = 4 + 6 * r;
                    Ok((
                        table.u16(at)?,
                        table.u16(at + 2)?,
                        u32::from(table.u16(at + 4)?),
                    ))
                })
                .collect::<Parsed<Vec<_>>>()?;
            sweep_ranges(ranges, num_glyphs, |glyph, first_index, start| {
                out.push((glyph, first_index + u32::from(glyph - start)));
            });
        }
        _ => {}
    }
    Ok(out)
}

/// ClassDef table → class of every glyph (0 when unlisted or for unknown formats).
fn class_def(table: Reader, num_glyphs: u16) -> Parsed<Vec<u16>> {
    let mut classes = vec![0u16; usize::from(num_glyphs)];
    match table.u16(0)? {
        1 => {
            let start = usize::from(table.u16(2)?);
            let count = usize::from(table.u16(4)?);
            table.check_array(6, count, 2)?;
            for k in 0..count {
                if let Some(class) = classes.get_mut(start + k) {
                    *class = table.u16(6 + 2 * k)?;
                }
            }
        }
        2 => {
            let count = usize::from(table.u16(2)?);
            table.check_array(4, count, 6)?;
            let ranges = (0..count)
                .map(|r| {
                    let at = 4 + 6 * r;
                    Ok((
                        table.u16(at)?,
                        table.u16(at + 2)?,
                        u32::from(table.u16(at + 4)?),
                    ))
                })
                .collect::<Parsed<Vec<_>>>()?;
            sweep_ranges(ranges, num_glyphs, |glyph, class, _| {
                classes[usize::from(glyph)] = class as u16
            });
        }
        _ => {}
    }
    Ok(classes)
}

/// GDEF → per-glyph "is a mark" (glyph class 3).
fn parse_marks(gdef: Reader, num_glyphs: u16) -> Parsed<Vec<bool>> {
    let classes = match (gdef.u16(0)?, gdef.offset16(4)?) {
        (1, Some(table)) => class_def(table, num_glyphs)?,
        _ => vec![0; usize::from(num_glyphs)],
    };
    Ok(classes.into_iter().map(|class| class == 3).collect())
}

/// GPOS → kern lookups; `Ok(None)` if no language system references a `kern` feature.
fn parse_gpos(gpos: Reader, num_glyphs: u16) -> Parsed<Option<Vec<PairLookup>>> {
    if gpos.u16(0)? != 1 {
        return Ok(None);
    }
    let (Some(scripts), Some(features), Some(lookups)) =
        (gpos.offset16(4)?, gpos.offset16(6)?, gpos.offset16(8)?)
    else {
        return Ok(None);
    };
    let feature_count = usize::from(features.u16(0)?);
    let mut referenced = vec![false; feature_count];
    for s in 0..usize::from(scripts.u16(0)?) {
        let Some(script) = scripts.offset16(2 + 6 * s + 4)? else {
            continue;
        };
        let mut lang_systems = vec![script.offset16(0)?];
        for l in 0..usize::from(script.u16(2)?) {
            lang_systems.push(script.offset16(4 + 6 * l + 4)?);
        }
        for lang_sys in lang_systems.into_iter().flatten() {
            let required = usize::from(lang_sys.u16(2)?);
            if let Some(flag) = referenced.get_mut(required) {
                *flag = true;
            }
            for f in 0..usize::from(lang_sys.u16(4)?) {
                if let Some(flag) = referenced.get_mut(usize::from(lang_sys.u16(6 + 2 * f)?)) {
                    *flag = true;
                }
            }
        }
    }
    let lookup_count = usize::from(lookups.u16(0)?);
    let mut kern_lookups = vec![false; lookup_count];
    let mut has_kern_feature = false;
    for (f, _) in referenced.iter().enumerate().filter(|(_, &used)| used) {
        if features.u32(2 + 6 * f)? != KERN {
            continue;
        }
        has_kern_feature = true;
        let Some(feature) = features.offset16(2 + 6 * f + 4)? else {
            continue;
        };
        for k in 0..usize::from(feature.u16(2)?) {
            if let Some(flag) = kern_lookups.get_mut(usize::from(feature.u16(4 + 2 * k)?)) {
                *flag = true;
            }
        }
    }
    if !has_kern_feature {
        return Ok(None);
    }
    let mut out = Vec::new();
    for (l, _) in kern_lookups.iter().enumerate().filter(|(_, &used)| used) {
        let Some(lookup) = lookups.offset16(2 + 2 * l)? else {
            continue;
        };
        let kind = lookup.u16(0)?;
        if kind != 2 && kind != 9 {
            continue;
        }
        let flag = lookup.u16(2)?;
        let mut builder = LookupBuilder::new(num_glyphs);
        for s in 0..usize::from(lookup.u16(4)?) {
            let Some(subtable) = lookup.offset16(6 + 2 * s)? else {
                continue;
            };
            if kind == 9 {
                if subtable.u16(0)? == 1 && subtable.u16(2)? == 2 {
                    builder.add_pair_pos(subtable.tail(subtable.u32(4)? as usize)?)?;
                }
            } else {
                builder.add_pair_pos(subtable)?;
            }
        }
        out.extend(builder.finish(flag & IGNORE_MARKS != 0));
    }
    Ok(Some(out))
}

/// Legacy `kern` table (format 0 subtables) → one IgnoreMarks lookup.
fn parse_kern_table(kern: Reader, num_glyphs: u16) -> Parsed<Option<PairLookup>> {
    // (offset of the pair data header, accepted) per subtable.
    let mut subtables = Vec::new();
    if kern.u16(0)? == 0 {
        let mut at = 4;
        for _ in 0..kern.u16(2)? {
            let (length, coverage) = (usize::from(kern.u16(at + 2)?), kern.u16(at + 4)?);
            // format 0, horizontal, not minimum values, not cross-stream
            subtables.push((at + 6, coverage >> 8 == 0 && coverage & 0x07 == 0x01));
            at += length.max(6);
        }
    } else if kern.u32(0)? == 0x0001_0000 {
        let mut at = 8;
        for _ in 0..kern.u32(4)? {
            let (length, coverage) = (kern.u32(at)? as usize, kern.u16(at + 4)?);
            // format 0, not vertical, not cross-stream, no variation
            subtables.push((at + 8, coverage & 0x00FF == 0 && coverage & 0xE000 == 0));
            at = at.checked_add(length.max(8)).ok_or(Malformed)?;
        }
    } else {
        return Ok(None);
    }
    let mut pairs: Vec<(u32, i32)> = Vec::new();
    for (at, accepted) in subtables {
        if !accepted {
            continue;
        }
        let count = usize::from(kern.u16(at)?);
        kern.check_array(at + 8, count, 6)?;
        let mut subtable = Vec::with_capacity(count);
        for p in 0..count {
            let record = at + 8 + 6 * p;
            let (left, right) = (kern.u16(record)?, kern.u16(record + 2)?);
            if left < num_glyphs && right < num_glyphs {
                subtable.push((
                    (u32::from(left) << 16) | u32::from(right),
                    i32::from(kern.i16(record + 4)?),
                ));
            }
        }
        subtable.sort_by_key(|pair| pair.0);
        subtable.dedup_by_key(|pair| pair.0);
        pairs.extend(subtable);
    }
    pairs.sort_by_key(|pair| pair.0);
    let mut merged: Vec<(u32, i32)> = Vec::with_capacity(pairs.len());
    for (key, value) in pairs {
        match merged.last_mut() {
            Some(last) if last.0 == key => last.1 += value,
            _ => merged.push((key, value)),
        }
    }
    let mut sets = Vec::new();
    let mut records = Vec::with_capacity(merged.len());
    let mut slots = Vec::new();
    for (index, (key, value)) in merged.iter().enumerate() {
        let left = (key >> 16) as u16;
        if index == 0 || merged[index - 1].0 >> 16 != u32::from(left) {
            slots.push((left, sets.len() as u16));
            sets.push((records.len() as u32, records.len() as u32));
        }
        records.push((*key as u16, *value));
        if let Some(set) = sets.last_mut() {
            set.1 = records.len() as u32;
        }
    }
    let mut builder = LookupBuilder::new(num_glyphs);
    builder.push_subtable(
        PairSubtable::Glyphs {
            skip_second: false,
            sets,
            records,
        },
        slots.into_iter(),
    );
    Ok(builder.finish(true))
}
