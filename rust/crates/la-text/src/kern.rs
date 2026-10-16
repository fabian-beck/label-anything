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
//!
//! [`Kerning::ranges`] prepares the adjustments of every range of one glyph sequence, so
//! that `ranges.adjustment(start, end)` equals `adjustment(&glyphs[start..end])` in
//! constant time (see [`Track`]).

use crate::reader::{Malformed, Parsed, Reader};

const KERN: u32 = u32::from_be_bytes(*b"kern");
const IGNORE_MARKS: u16 = 0x0008;
/// [`Track::runs`] entry of a pair that does not skip its second glyph.
const NO_RUN: u32 = u32::MAX;

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

    /// Prepares the adjustments of every range of `glyphs`, in time linear in its length.
    pub(crate) fn ranges(&self, glyphs: &[u16]) -> KerningRanges {
        let mut non_marks = Vec::new();
        let mut eligible = Vec::new();
        if self.lookups.iter().any(|lookup| lookup.ignore_marks) {
            eligible.reserve(glyphs.len() + 1);
            eligible.push(0);
            for &glyph in glyphs {
                if !self.marks[usize::from(glyph)] {
                    non_marks.push(glyph);
                }
                eligible.push(non_marks.len() as u32);
            }
        }
        // Lookups whose walks visit every position are summed per IgnoreMarks flag; a lookup
        // with a pair that skips its second glyph gets a track of its own.
        let mut sums: [Vec<i64>; 2] = [Vec::new(), Vec::new()];
        let mut tracks = Vec::new();
        for lookup in &self.lookups {
            let sequence = if lookup.ignore_marks {
                &non_marks
            } else {
                glyphs
            };
            let Some((deltas, skips)) = lookup.pairs(sequence) else {
                continue;
            };
            if skips.is_empty() {
                let sum = &mut sums[usize::from(lookup.ignore_marks)];
                if sum.is_empty() {
                    *sum = deltas;
                } else {
                    sum.iter_mut().zip(deltas).for_each(|(s, d)| *s += d);
                }
            } else {
                tracks.push(Track::skipping(lookup.ignore_marks, &deltas, &skips));
            }
        }
        for (ignore_marks, deltas) in [false, true].into_iter().zip(sums) {
            if !deltas.is_empty() {
                tracks.push(Track::visiting_all(ignore_marks, deltas));
            }
        }
        KerningRanges { eligible, tracks }
    }
}

/// The kerning adjustments of every range of one glyph sequence ([`Kerning::ranges`]).
#[derive(Clone, Debug)]
pub(crate) struct KerningRanges {
    /// `eligible[i]`: the number of non-marks among the first `i` glyphs, i.e. the position
    /// of glyph `i` in the sequence an IgnoreMarks walk considers (empty if no lookup
    /// ignores marks).
    eligible: Vec<u32>,
    tracks: Vec<Track>,
}

impl KerningRanges {
    /// [`Kerning::adjustment`] of the glyphs `start..end` (`start <= end <= len`).
    #[inline]
    pub(crate) fn adjustment(&self, start: usize, end: usize) -> i64 {
        self.tracks
            .iter()
            .map(|track| {
                if track.ignore_marks {
                    let first = self.eligible[start] as usize;
                    track.adjustment(first, self.eligible[end] as usize)
                } else {
                    track.adjustment(start, end)
                }
            })
            .sum()
    }
}

/// The walk of one lookup over a glyph sequence, or the summed walks of several lookups
/// that visit every position, prepared for ranges.
///
/// Positions are the glyphs the walk considers (the non-marks under IgnoreMarks, else all
/// glyphs); pair `t` is `(t, t + 1)`. A walk adds the adjustment of the pair at each
/// position it visits and moves on to the next position, or past it when the matching
/// subtable skips its second glyph (ValueFormat2 ≠ 0). The walk over a range starts at its
/// first position and adds the pairs that lie inside the range. Without skipping pairs it
/// visits every position, so a range adds a contiguous run of pairs; with them, walks that
/// start at different positions can visit different ones (`walk` below).
#[derive(Clone, Debug)]
struct Track {
    ignore_marks: bool,
    /// `walk[t]`: the sum of the adjustments a walk starting at position `t` adds up to the
    /// end of the sequence (`walk[len] = 0`), so the pairs it adds from `t` up to a position
    /// `u` it visits are `walk[t] − walk[u]`.
    walk: Vec<i64>,
    /// For a pair that skips its second glyph: the first pair of the run of consecutive such
    /// pairs that contains it; [`NO_RUN`] for the other pairs. Empty if no pair skips.
    runs: Vec<u32>,
}

impl Track {
    /// A walk that visits every position: suffix sums of the pair adjustments.
    fn visiting_all(ignore_marks: bool, deltas: Vec<i64>) -> Track {
        let mut walk = deltas;
        walk.push(0);
        for t in (0..walk.len() - 1).rev() {
            walk[t] += walk[t + 1];
        }
        Track {
            ignore_marks,
            walk,
            runs: Vec::new(),
        }
    }

    /// A walk that moves past the second glyph of the pairs marked in `skips`.
    fn skipping(ignore_marks: bool, deltas: &[i64], skips: &[bool]) -> Track {
        let len = deltas.len();
        // the last position has no pair, so a skip lands at most on `len`
        let mut walk = vec![0; len + 1];
        for t in (0..len).rev() {
            walk[t] = deltas[t] + walk[if skips[t] { t + 2 } else { t + 1 }];
        }
        let mut runs = vec![NO_RUN; len];
        for t in 0..len {
            if skips[t] {
                runs[t] = if t > 0 && skips[t - 1] {
                    runs[t - 1]
                } else {
                    t as u32
                };
            }
        }
        Track {
            ignore_marks,
            walk,
            runs,
        }
    }

    /// The adjustments the walk over positions `first..end` adds.
    #[inline]
    fn adjustment(&self, first: usize, end: usize) -> i64 {
        if end < first + 2 {
            return 0;
        }
        // The walk adds the pairs of the positions it visits before `end − 1` (the pair of
        // `end − 1` crosses the end of the range). It reaches `end − 1`, unless it visits
        // `last = end − 2` and that pair skips `end − 1`: then it reaches `end`. Within a run
        // of skipping pairs a walk visits every other position, and a walk that starts before
        // the run enters it at its first pair (only the pair before a position can skip it,
        // and that one does not skip). So the walk visits `last` iff `last` has the parity of
        // `max(first, run start)`.
        let last = end - 2;
        let stop = match self.runs.get(last) {
            Some(&run) if run != NO_RUN && (first.max(run as usize) ^ last) & 1 == 0 => end,
            _ => end - 1,
        };
        self.walk[first] - self.walk[stop]
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

    /// The pair `(first, second)` as [`PairLookup::apply`] matches it: `(adjustment, skip
    /// second glyph)` of the first subtable that matches.
    fn find(&self, first: u16, second: u16) -> Option<(i32, bool)> {
        let first = usize::from(first);
        for &(subtable, key) in
            &self.slots[self.offsets[first] as usize..self.offsets[first + 1] as usize]
        {
            let subtable = &self.subtables[usize::from(subtable)];
            if let Some(found) = subtable.find(key, second, &self.class_tables) {
                return Some(found);
            }
        }
        None
    }

    /// The pairs of consecutive glyphs of `sequence` (the glyphs this lookup's walk
    /// considers): the adjustment of pair `(t, t + 1)` at index `t` (0 without a match; the
    /// last entry is 0) and, if any pair skips its second glyph, which ones do. `None` if
    /// no pair adjusts the advance.
    fn pairs(&self, sequence: &[u16]) -> Option<(Vec<i64>, Vec<bool>)> {
        let mut deltas = vec![0; sequence.len()];
        let mut skips = Vec::new();
        let mut adjusts = false;
        for (t, pair) in sequence.windows(2).enumerate() {
            let Some((delta, skip)) = self.find(pair[0], pair[1]) else {
                continue;
            };
            deltas[t] = i64::from(delta);
            adjusts |= delta != 0;
            if skip {
                if skips.is_empty() {
                    skips = vec![false; sequence.len()];
                }
                skips[t] = true;
            }
        }
        adjusts.then_some((deltas, skips))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// xorshift64*: deterministic pseudo-random numbers for the property tests.
    struct Rng(u64);

    impl Rng {
        fn below(&mut self, n: u64) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) % n
        }

        fn delta(&mut self) -> i32 {
            self.below(201) as i32 - 100
        }
    }

    /// Random marks and 1–4 lookups (IgnoreMarks or not) of 1–3 subtables each: explicit
    /// pairs or class pairs (including classes beyond the class count), skipping their
    /// second glyph or not. Few glyphs and dense tables give long runs of skipping pairs.
    fn random_kerning(rng: &mut Rng, num_glyphs: u16) -> Kerning {
        let marks = (0..num_glyphs).map(|_| rng.below(4) == 0).collect();
        let mut lookups = Vec::new();
        for _ in 0..1 + rng.below(4) {
            let mut builder = LookupBuilder::new(num_glyphs);
            for _ in 0..1 + rng.below(3) {
                let skip_second = rng.below(2) == 0;
                let mut slots = Vec::new();
                let subtable = if rng.below(2) == 0 {
                    let (mut sets, mut records) = (Vec::new(), Vec::new());
                    for first in 0..num_glyphs {
                        if rng.below(3) == 0 {
                            continue;
                        }
                        let start = records.len() as u32;
                        for second in 0..num_glyphs {
                            if rng.below(2) == 0 {
                                records.push((second, rng.delta()));
                            }
                        }
                        slots.push((first, sets.len() as u16));
                        sets.push((start, records.len() as u32));
                    }
                    PairSubtable::Glyphs {
                        skip_second,
                        sets,
                        records,
                    }
                } else {
                    let (class1_count, class2_count) = (1 + rng.below(3), 1 + rng.below(3));
                    let classes = (0..num_glyphs)
                        .map(|_| rng.below(class2_count + 1) as u16)
                        .collect();
                    builder.class_tables.push(classes);
                    builder.class_table_addresses.push(usize::MAX);
                    for first in 0..num_glyphs {
                        if rng.below(3) != 0 {
                            slots.push((first, rng.below(class1_count) as u16));
                        }
                    }
                    PairSubtable::Classes {
                        skip_second,
                        class2: builder.class_tables.len() - 1,
                        class2_count: class2_count as u16,
                        deltas: (0..class1_count * class2_count)
                            .map(|_| rng.delta())
                            .collect(),
                    }
                };
                builder.push_subtable(subtable, slots.into_iter());
            }
            lookups.extend(builder.finish(rng.below(2) == 0));
        }
        Kerning { marks, lookups }
    }

    #[test]
    fn ranges_equal_the_walk_over_every_range() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let (mut skipping, mut long_runs) = (0, 0);
        for _ in 0..400 {
            let num_glyphs = 2 + rng.below(6) as u16;
            let kerning = random_kerning(&mut rng, num_glyphs);
            for _ in 0..8 {
                let len = rng.below(25) as usize;
                let glyphs: Vec<u16> = (0..len)
                    .map(|_| rng.below(u64::from(num_glyphs)) as u16)
                    .collect();
                let ranges = kerning.ranges(&glyphs);
                for track in ranges.tracks.iter().filter(|t| !t.runs.is_empty()) {
                    skipping += 1;
                    let runs = &track.runs;
                    long_runs += (1..runs.len())
                        .filter(|&t| runs[t] != NO_RUN && runs[t] as usize + 1 < t)
                        .count();
                }
                for start in 0..=len {
                    for end in start..=len {
                        assert_eq!(
                            ranges.adjustment(start, end),
                            kerning.adjustment(&glyphs[start..end]),
                            "glyphs {glyphs:?}, range {start}..{end}"
                        );
                    }
                }
            }
        }
        // the cases exercise walks with skipped glyphs, including runs of 3+ skipping pairs
        assert!(skipping > 500 && long_runs > 500, "{skipping} {long_runs}");
    }

    #[test]
    fn ranges_without_kerning() {
        let kerning = Kerning {
            marks: vec![false; 4],
            lookups: Vec::new(),
        };
        let ranges = kerning.ranges(&[1, 2, 3]);
        assert!(ranges.tracks.is_empty() && ranges.eligible.is_empty());
        assert_eq!(ranges.adjustment(0, 3), 0);
    }
}
