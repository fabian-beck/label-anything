// Pair kerning for simple shaping (spec §5.2): GPOS `kern` lookups or a legacy `kern`
// table, flattened at load time into per-glyph tables. The semantics are documented in the
// Rust implementation (rust/crates/la-text/src/kern.rs) and shared exactly:
// * kern lookups = union of the lookups of every `kern` feature referenced by any script's
//   default or language system (feature indices and required feature index), ascending;
//   only PairPos (type 2, or type 9 extensions of type 2) subtables take part;
// * each lookup walks the whole glyph sequence; at `i` (skipped if a mark under IgnoreMarks)
//   `j` is the next glyph (skipping marks under IgnoreMarks); the first matching subtable
//   adds both XAdvances and continues at `j + 1` if ValueFormat2 ≠ 0, else at `j`; without a
//   match the walk continues at `i + 1`;
// * Coverage/ClassDef ranges are stably sorted by start, the first containing a glyph wins;
//   duplicate glyphs keep their first record;
// * without a GPOS `kern` feature, a legacy `kern` table (Microsoft or Apple header) acts as
//   one IgnoreMarks lookup whose pairs never skip their second glyph, with pair values summed
//   over its horizontal, non-cross-stream, non-minimum format 0 subtables;
// * a malformed GDEF, GPOS or `kern` table is treated as absent.
// `Kerning.ranges` prepares the adjustments of every range of one glyph sequence, so that
// `ranges.adjustment(start, end)` equals `adjustment` of the glyphs `start..end` in constant
// time (see `Track`).
import { Malformed, type Reader } from "./reader.js";

const KERN = 0x6b65726e; // "kern"
const IGNORE_MARKS = 0x0008;
/** `Track.runs` entry of a pair that does not skip its second glyph. */
const NO_RUN = 0xffffffff;

/** One subtable of a pair lookup, in matching form. */
interface PairSubtable {
  /** Continue after the second glyph (ValueFormat2 ≠ 0). */
  readonly skipSecond: boolean;
  /** The adjustment if this subtable matches (first glyph's key, second glyph), else NaN. */
  find(key: number, second: number): number;
}

/** PairPos format 1 (and the legacy `kern` table): explicit glyph pairs. */
export class GlyphPairs implements PairSubtable {
  constructor(
    readonly skipSecond: boolean,
    /** Per pair set: [lo, hi) range in the record arrays, flattened. */
    private readonly sets: Uint32Array,
    /** Second glyphs, sorted within each set. */
    private readonly seconds: Uint16Array,
    private readonly deltas: Int32Array,
  ) {}

  find(key: number, second: number): number {
    let lo = this.sets[2 * key];
    let hi = this.sets[2 * key + 1];
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const glyph = this.seconds[mid];
      if (glyph === second) return this.deltas[mid];
      if (glyph < second) lo = mid + 1;
      else hi = mid;
    }
    return NaN;
  }
}

/** PairPos format 2: class pairs. */
export class ClassPairs implements PairSubtable {
  constructor(
    readonly skipSecond: boolean,
    private readonly class2: Uint16Array,
    private readonly class2Count: number,
    /** `class1 * class2Count + class2`; empty when all adjustments are zero. */
    private readonly deltas: Int32Array,
  ) {}

  find(key: number, second: number): number {
    const class2 = this.class2[second];
    if (class2 >= this.class2Count) return NaN;
    return this.deltas.length === 0 ? 0 : this.deltas[key * this.class2Count + class2];
  }
}

/** A pair-positioning lookup with its subtables indexed by first glyph. */
class PairLookup {
  constructor(
    readonly ignoreMarks: boolean,
    /** CSR index: the slots of glyph `g` are `offsets[g] ..< offsets[g + 1]`. */
    private readonly offsets: Uint32Array,
    private readonly slotSubtables: Uint16Array,
    private readonly slotKeys: Uint16Array,
    private readonly subtables: readonly PairSubtable[],
  ) {}

  apply(glyphs: Uint16Array, n: number, marks: Uint8Array): number {
    let total = 0;
    let i = 0;
    while (i < n) {
      const first = glyphs[i];
      if (this.ignoreMarks && marks[first] === 1) {
        i++;
        continue;
      }
      const lo = this.offsets[first];
      const hi = this.offsets[first + 1];
      if (lo === hi) {
        i++;
        continue;
      }
      let j = i + 1;
      while (this.ignoreMarks && j < n && marks[glyphs[j]] === 1) j++;
      if (j >= n) break;
      let next = i + 1;
      for (let s = lo; s < hi; s++) {
        const subtable = this.subtables[this.slotSubtables[s]];
        const delta = subtable.find(this.slotKeys[s], glyphs[j]);
        if (delta === delta) {
          total += delta;
          next = subtable.skipSecond ? j + 1 : j;
          break;
        }
      }
      i = next;
    }
    return total;
  }

  /**
   * The pairs of consecutive glyphs of `sequence[0..n)` (the glyphs this lookup's walk
   * considers): the adjustment of pair `(t, t + 1)` at index `t` (0 without a match; the last
   * entry is 0) and, if any pair skips its second glyph, which ones do (else `null`). `null` if
   * no pair adjusts the advance.
   */
  pairs(sequence: Uint16Array, n: number): { deltas: Float64Array; skips: Uint8Array | null } | null {
    const deltas = new Float64Array(n);
    let skips: Uint8Array | null = null;
    let adjusts = false;
    for (let t = 0; t + 1 < n; t++) {
      const first = sequence[t];
      const hi = this.offsets[first + 1];
      for (let s = this.offsets[first]; s < hi; s++) {
        const subtable = this.subtables[this.slotSubtables[s]];
        const delta = subtable.find(this.slotKeys[s], sequence[t + 1]);
        if (delta === delta) {
          deltas[t] = delta;
          if (delta !== 0) adjusts = true;
          if (subtable.skipSecond) {
            if (skips === null) skips = new Uint8Array(n);
            skips[t] = 1;
          }
          break;
        }
      }
    }
    return adjusts ? { deltas, skips } : null;
  }
}

/** Collects subtables and their first-glyph slots, then builds the CSR index. */
export class LookupBuilder {
  /** [glyph, subtable, key] */
  private readonly slots: [number, number, number][] = [];
  private readonly subtables: PairSubtable[] = [];
  private readonly classTables = new Map<number, Uint16Array>();

  constructor(private readonly numGlyphs: number) {}

  pushSubtable(subtable: PairSubtable, slots: Iterable<readonly [glyph: number, key: number]>): void {
    // A lookup has at most 0xFFFF subtables (its count is a uint16).
    const index = this.subtables.length;
    this.subtables.push(subtable);
    for (const [glyph, key] of slots) this.slots.push([glyph, index, key]);
  }

  /** Adds a PairPos subtable (formats 1 and 2; other formats never match). */
  addPairPos(st: Reader): void {
    const format = st.u16(0);
    const coverageTable = st.offset16(2);
    if (coverageTable === null) return;
    const format1 = st.u16(4);
    const format2 = st.u16(6);
    const first = new ValueReader(format1, 0);
    const second = new ValueReader(format2, first.size);
    const recordSize = first.size + second.size;
    const skipSecond = format2 !== 0;
    const numGlyphs = this.numGlyphs;
    if (format === 1) {
      const covered = coverage(coverageTable, numGlyphs);
      const setCount = st.u16(8);
      const sets = new Uint32Array(2 * setCount);
      const seconds: number[] = [];
      const deltas: number[] = [];
      for (let set = 0; set < setCount; set++) {
        sets[2 * set] = seconds.length;
        const pairSet = st.offset16(10 + 2 * set);
        if (pairSet !== null) {
          const count = pairSet.u16(0);
          pairSet.checkArray(2, count, 2 + recordSize);
          const pairs: [number, number][] = [];
          for (let r = 0; r < count; r++) {
            const at = 2 + r * (2 + recordSize);
            pairs.push([pairSet.u16(at), first.xAdvance(pairSet, at + 2) + second.xAdvance(pairSet, at + 2)]);
          }
          pairs.sort((a, b) => a[0] - b[0]);
          for (let r = 0; r < pairs.length; r++) {
            if (r > 0 && pairs[r][0] === pairs[r - 1][0]) continue;
            seconds.push(pairs[r][0]);
            deltas.push(pairs[r][1]);
          }
        }
        sets[2 * set + 1] = seconds.length;
      }
      const slots = covered.filter(([, index]) => index < setCount && sets[2 * index] < sets[2 * index + 1]);
      this.pushSubtable(new GlyphPairs(skipSecond, sets, Uint16Array.from(seconds), Int32Array.from(deltas)), slots);
    } else if (format === 2) {
      const covered = coverage(coverageTable, numGlyphs);
      const class1Table = st.offset16(8);
      const class1 = class1Table === null ? null : classDef(class1Table, numGlyphs);
      const class2Table = st.offset16(10);
      const class1Count = st.u16(12);
      const class2Count = st.u16(14);
      const cells = class1Count * class2Count;
      st.checkArray(16, cells, recordSize);
      let deltas = new Int32Array(0);
      if (first.xAt >= 0 || second.xAt >= 0) {
        deltas = new Int32Array(cells);
        for (let cell = 0; cell < cells; cell++) {
          const at = 16 + cell * recordSize;
          deltas[cell] = first.xAdvance(st, at) + second.xAdvance(st, at);
        }
      }
      const class2 = this.classTable(class2Table);
      const slots: [number, number][] = [];
      for (const [glyph] of covered) {
        const c = class1 === null ? 0 : class1[glyph];
        if (c < class1Count) slots.push([glyph, c]);
      }
      this.pushSubtable(new ClassPairs(skipSecond, class2, class2Count, deltas), slots);
    }
  }

  /** The flattened ClassDef (a null offset means class 0 for every glyph). */
  private classTable(table: Reader | null): Uint16Array {
    const address = table === null ? -1 : table.start;
    let classes = this.classTables.get(address);
    if (classes === undefined) {
      classes = table === null ? new Uint16Array(this.numGlyphs) : classDef(table, this.numGlyphs);
      this.classTables.set(address, classes);
    }
    return classes;
  }

  finish(ignoreMarks: boolean): PairLookup | null {
    if (this.slots.length === 0) return null;
    this.slots.sort((a, b) => a[0] - b[0]); // stable: keeps subtable order per glyph
    const offsets = new Uint32Array(this.numGlyphs + 1);
    for (const [glyph] of this.slots) offsets[glyph + 1]++;
    for (let g = 0; g < this.numGlyphs; g++) offsets[g + 1] += offsets[g];
    return new PairLookup(
      ignoreMarks,
      offsets,
      Uint16Array.from(this.slots, (slot) => slot[1]),
      Uint16Array.from(this.slots, (slot) => slot[2]),
      this.subtables,
    );
  }
}

/** Reads the XAdvance of one value record of a given ValueFormat. */
class ValueReader {
  /** Byte offset of XAdvance from the start of the pair record's value part, or -1. */
  readonly xAt: number;
  readonly size: number;

  constructor(format: number, start: number) {
    this.xAt = format & 0x0004 ? start + 2 * popcount(format & 0x0003) : -1;
    this.size = 2 * popcount(format);
  }

  xAdvance(data: Reader, valuesAt: number): number {
    return this.xAt < 0 ? 0 : data.i16(valuesAt + this.xAt);
  }
}

function popcount(v: number): number {
  let count = 0;
  for (; v !== 0; v &= v - 1) count++;
  return count;
}

/**
 * Ranges `[start, end, value]` with "stably sorted by start, first wins" semantics:
 * calls `assign(glyph, value, start)` for each glyph `< numGlyphs`.
 */
function sweepRanges(
  ranges: [number, number, number][],
  numGlyphs: number,
  assign: (glyph: number, value: number, start: number) => void,
): void {
  ranges.sort((a, b) => a[0] - b[0]);
  let nextFree = 0;
  for (const [start, end, value] of ranges) {
    const last = Math.min(end, numGlyphs - 1);
    for (let glyph = Math.max(start, nextFree); glyph <= last; glyph++) assign(glyph, value, start);
    nextFree = Math.max(nextFree, end + 1);
  }
}

function readRanges(table: Reader, count: number): [number, number, number][] {
  table.checkArray(4, count, 6);
  const ranges: [number, number, number][] = [];
  for (let r = 0; r < count; r++) {
    const at = 4 + 6 * r;
    ranges.push([table.u16(at), table.u16(at + 2), table.u16(at + 4)]);
  }
  return ranges;
}

/** Coverage table → `[glyph, coverage index]` sorted by glyph (unknown formats cover nothing). */
function coverage(table: Reader, numGlyphs: number): [number, number][] {
  const count = table.u16(2);
  const out: [number, number][] = [];
  const format = table.u16(0);
  if (format === 1) {
    table.checkArray(4, count, 2);
    for (let index = 0; index < count; index++) {
      const glyph = table.u16(4 + 2 * index);
      if (glyph < numGlyphs) out.push([glyph, index]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out.filter((entry, k) => k === 0 || entry[0] !== out[k - 1][0]);
  }
  if (format === 2) {
    sweepRanges(readRanges(table, count), numGlyphs, (glyph, firstIndex, start) => {
      out.push([glyph, firstIndex + (glyph - start)]);
    });
  }
  return out;
}

/** ClassDef table → class of every glyph (0 when unlisted or for unknown formats). */
function classDef(table: Reader, numGlyphs: number): Uint16Array {
  const classes = new Uint16Array(numGlyphs);
  const format = table.u16(0);
  if (format === 1) {
    const start = table.u16(2);
    const count = table.u16(4);
    table.checkArray(6, count, 2);
    for (let k = 0; k < count; k++) {
      if (start + k < numGlyphs) classes[start + k] = table.u16(6 + 2 * k);
    }
  } else if (format === 2) {
    sweepRanges(readRanges(table, table.u16(2)), numGlyphs, (glyph, value) => {
      classes[glyph] = value;
    });
  }
  return classes;
}

/** GDEF → per-glyph "is a mark" (glyph class 3). */
function parseMarks(gdef: Reader, numGlyphs: number): Uint8Array {
  const version = gdef.u16(0);
  const table = gdef.offset16(4);
  const marks = new Uint8Array(numGlyphs);
  if (version === 1 && table !== null) {
    const classes = classDef(table, numGlyphs);
    for (let g = 0; g < numGlyphs; g++) marks[g] = classes[g] === 3 ? 1 : 0;
  }
  return marks;
}

/** GPOS → kern lookups; `null` if no language system references a `kern` feature. */
function parseGpos(gpos: Reader, numGlyphs: number): PairLookup[] | null {
  if (gpos.u16(0) !== 1) return null;
  const scripts = gpos.offset16(4);
  const features = gpos.offset16(6);
  const lookups = gpos.offset16(8);
  if (scripts === null || features === null || lookups === null) return null;
  const featureCount = features.u16(0);
  const referenced = new Uint8Array(featureCount);
  const reference = (index: number): void => {
    if (index < featureCount) referenced[index] = 1;
  };
  const scriptCount = scripts.u16(0);
  for (let s = 0; s < scriptCount; s++) {
    const script = scripts.offset16(2 + 6 * s + 4);
    if (script === null) continue;
    const langSystems = [script.offset16(0)];
    const langCount = script.u16(2);
    for (let l = 0; l < langCount; l++) langSystems.push(script.offset16(4 + 6 * l + 4));
    for (const langSys of langSystems) {
      if (langSys === null) continue;
      reference(langSys.u16(2));
      const count = langSys.u16(4);
      for (let f = 0; f < count; f++) reference(langSys.u16(6 + 2 * f));
    }
  }
  const lookupCount = lookups.u16(0);
  const kernLookups = new Uint8Array(lookupCount);
  let hasKernFeature = false;
  for (let f = 0; f < featureCount; f++) {
    if (referenced[f] === 0 || features.u32(2 + 6 * f) !== KERN) continue;
    hasKernFeature = true;
    const feature = features.offset16(2 + 6 * f + 4);
    if (feature === null) continue;
    const count = feature.u16(2);
    for (let k = 0; k < count; k++) {
      const index = feature.u16(4 + 2 * k);
      if (index < lookupCount) kernLookups[index] = 1;
    }
  }
  if (!hasKernFeature) return null;
  const out: PairLookup[] = [];
  for (let l = 0; l < lookupCount; l++) {
    if (kernLookups[l] === 0) continue;
    const lookup = lookups.offset16(2 + 2 * l);
    if (lookup === null) continue;
    const kind = lookup.u16(0);
    if (kind !== 2 && kind !== 9) continue;
    const flag = lookup.u16(2);
    const builder = new LookupBuilder(numGlyphs);
    const count = lookup.u16(4);
    for (let s = 0; s < count; s++) {
      const subtable = lookup.offset16(6 + 2 * s);
      if (subtable === null) continue;
      if (kind === 9) {
        if (subtable.u16(0) === 1 && subtable.u16(2) === 2) builder.addPairPos(subtable.tail(subtable.u32(4)));
      } else {
        builder.addPairPos(subtable);
      }
    }
    const built = builder.finish((flag & IGNORE_MARKS) !== 0);
    if (built !== null) out.push(built);
  }
  return out;
}

/** Legacy `kern` table (format 0 subtables) → one IgnoreMarks lookup. */
function parseKernTable(kern: Reader, numGlyphs: number): PairLookup | null {
  // [offset of the pair data header, accepted] per subtable
  const subtables: [number, boolean][] = [];
  if (kern.u16(0) === 0) {
    let at = 4;
    const count = kern.u16(2);
    for (let t = 0; t < count; t++) {
      const length = kern.u16(at + 2);
      const coverage = kern.u16(at + 4);
      // format 0, horizontal, not minimum values, not cross-stream
      subtables.push([at + 6, coverage >>> 8 === 0 && (coverage & 0x07) === 0x01]);
      at += Math.max(length, 6);
    }
  } else if (kern.u32(0) === 0x00010000) {
    let at = 8;
    const count = kern.u32(4);
    for (let t = 0; t < count; t++) {
      const length = kern.u32(at);
      const coverage = kern.u16(at + 4);
      // format 0, not vertical, not cross-stream, no variation
      subtables.push([at + 8, (coverage & 0x00ff) === 0 && (coverage & 0xe000) === 0]);
      at += Math.max(length, 8);
    }
  } else {
    return null;
  }
  let pairs: [number, number][] = [];
  for (const [at, accepted] of subtables) {
    if (!accepted) continue;
    const count = kern.u16(at);
    kern.checkArray(at + 8, count, 6);
    const subtable: [number, number][] = [];
    for (let p = 0; p < count; p++) {
      const record = at + 8 + 6 * p;
      const left = kern.u16(record);
      const right = kern.u16(record + 2);
      if (left < numGlyphs && right < numGlyphs) subtable.push([left * 0x10000 + right, kern.i16(record + 4)]);
    }
    subtable.sort((a, b) => a[0] - b[0]);
    pairs = pairs.concat(subtable.filter((pair, k) => k === 0 || pair[0] !== subtable[k - 1][0]));
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [key, value] of pairs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last[0] === key) last[1] += value;
    else merged.push([key, value]);
  }
  const sets: number[] = [];
  const seconds = new Uint16Array(merged.length);
  const deltas = new Int32Array(merged.length);
  const slots: [number, number][] = [];
  merged.forEach(([key, value], index) => {
    const left = Math.floor(key / 0x10000);
    if (index === 0 || Math.floor(merged[index - 1][0] / 0x10000) !== left) {
      slots.push([left, sets.length / 2]);
      sets.push(index, index);
    }
    seconds[index] = key % 0x10000;
    deltas[index] = value;
    sets[sets.length - 1] = index + 1;
  });
  const builder = new LookupBuilder(numGlyphs);
  builder.pushSubtable(new GlyphPairs(false, Uint32Array.from(sets), seconds, deltas), slots);
  return builder.finish(true);
}

/** Marks (GDEF glyph class 3) and the kern lookups of a font. */
export class Kerning {
  /** @internal Use {@link Kerning.parse}. */
  constructor(
    private readonly marks: Uint8Array,
    private readonly lookups: readonly PairLookup[],
  ) {}

  static parse(gdef: Reader | null, gpos: Reader | null, kern: Reader | null, numGlyphs: number): Kerning {
    const marks = optional(gdef, (table) => parseMarks(table, numGlyphs)) ?? new Uint8Array(numGlyphs);
    let lookups = optional(gpos, (table) => parseGpos(table, numGlyphs));
    if (lookups === null) {
      const legacy = optional(kern, (table) => parseKernTable(table, numGlyphs));
      lookups = legacy === null ? [] : [legacy];
    }
    return new Kerning(marks, lookups);
  }

  get isEmpty(): boolean {
    return this.lookups.length === 0;
  }

  /** Sum of all kerning adjustments of the first `n` glyphs, in font units. */
  adjustment(glyphs: Uint16Array, n: number): number {
    let total = 0;
    for (const lookup of this.lookups) total += lookup.apply(glyphs, n, this.marks);
    return total;
  }

  /** Prepares the adjustments of every range of the first `n` glyphs, in time linear in `n`. */
  ranges(glyphs: Uint16Array, n: number): KerningRanges {
    let nonMarks = new Uint16Array(0);
    let eligible = new Uint32Array(0);
    let m = 0;
    if (this.lookups.some((lookup) => lookup.ignoreMarks)) {
      nonMarks = new Uint16Array(n);
      eligible = new Uint32Array(n + 1);
      for (let i = 0; i < n; i++) {
        if (this.marks[glyphs[i]] !== 1) nonMarks[m++] = glyphs[i];
        eligible[i + 1] = m;
      }
    }
    // Lookups whose walks visit every position are summed per IgnoreMarks flag; a lookup with a
    // pair that skips its second glyph gets a track of its own.
    const sums: (Float64Array | null)[] = [null, null];
    const tracks: Track[] = [];
    for (const lookup of this.lookups) {
      const pairs = lookup.ignoreMarks ? lookup.pairs(nonMarks, m) : lookup.pairs(glyphs, n);
      if (pairs === null) continue;
      if (pairs.skips === null) {
        const k = lookup.ignoreMarks ? 1 : 0;
        const sum = sums[k];
        if (sum === null) sums[k] = pairs.deltas;
        else for (let t = 0; t < sum.length; t++) sum[t] += pairs.deltas[t];
      } else {
        tracks.push(Track.skipping(lookup.ignoreMarks, pairs.deltas, pairs.skips));
      }
    }
    for (const k of [0, 1]) {
      const sum = sums[k];
      if (sum !== null) tracks.push(Track.visitingAll(k === 1, sum));
    }
    return new KerningRanges(eligible, tracks);
  }
}

/** The kerning adjustments of every range of one glyph sequence ({@link Kerning.ranges}). */
export class KerningRanges {
  constructor(
    /**
     * `eligible[i]`: the number of non-marks among the first `i` glyphs, i.e. the position of
     * glyph `i` in the sequence an IgnoreMarks walk considers (empty if no lookup ignores marks).
     */
    private readonly eligible: Uint32Array,
    private readonly tracks: readonly Track[],
  ) {}

  /** {@link Kerning.adjustment} of the glyphs `start..end` (`start <= end <= n`). */
  adjustment(start: number, end: number): number {
    let total = 0;
    for (const track of this.tracks) {
      total += track.ignoreMarks
        ? track.adjustment(this.eligible[start], this.eligible[end])
        : track.adjustment(start, end);
    }
    return total;
  }
}

/**
 * The walk of one lookup over a glyph sequence, or the summed walks of several lookups that
 * visit every position, prepared for ranges.
 *
 * Positions are the glyphs the walk considers (the non-marks under IgnoreMarks, else all
 * glyphs); pair `t` is `(t, t + 1)`. A walk adds the adjustment of the pair at each position it
 * visits and moves on to the next position, or past it when the matching subtable skips its
 * second glyph (ValueFormat2 ≠ 0). The walk over a range starts at its first position and adds
 * the pairs that lie inside the range. Without skipping pairs it visits every position, so a
 * range adds a contiguous run of pairs; with them, walks that start at different positions can
 * visit different ones (`walk` below).
 */
class Track {
  private constructor(
    readonly ignoreMarks: boolean,
    /**
     * `walk[t]`: the sum of the adjustments a walk starting at position `t` adds up to the end
     * of the sequence (`walk[len] = 0`), so the pairs it adds from `t` up to a position `u` it
     * visits are `walk[t] − walk[u]`.
     */
    private readonly walk: Float64Array,
    /**
     * For a pair that skips its second glyph: the first pair of the run of consecutive such
     * pairs that contains it; `NO_RUN` for the other pairs. Empty if no pair skips.
     */
    private readonly runs: Uint32Array,
  ) {}

  /** A walk that visits every position: suffix sums of the pair adjustments. */
  static visitingAll(ignoreMarks: boolean, deltas: Float64Array): Track {
    const walk = new Float64Array(deltas.length + 1);
    for (let t = deltas.length - 1; t >= 0; t--) walk[t] = deltas[t] + walk[t + 1];
    return new Track(ignoreMarks, walk, new Uint32Array(0));
  }

  /** A walk that moves past the second glyph of the pairs marked in `skips`. */
  static skipping(ignoreMarks: boolean, deltas: Float64Array, skips: Uint8Array): Track {
    const len = deltas.length;
    // the last position has no pair, so a skip lands at most on `len`
    const walk = new Float64Array(len + 1);
    for (let t = len - 1; t >= 0; t--) walk[t] = deltas[t] + walk[skips[t] === 1 ? t + 2 : t + 1];
    const runs = new Uint32Array(len).fill(NO_RUN);
    for (let t = 0; t < len; t++) {
      if (skips[t] === 1) runs[t] = t > 0 && skips[t - 1] === 1 ? runs[t - 1] : t;
    }
    return new Track(ignoreMarks, walk, runs);
  }

  /** The adjustments the walk over positions `first..end` adds. */
  adjustment(first: number, end: number): number {
    if (end < first + 2) return 0;
    // The walk adds the pairs of the positions it visits before `end − 1` (the pair of `end − 1`
    // crosses the end of the range). It reaches `end − 1`, unless it visits `last = end − 2` and
    // that pair skips `end − 1`: then it reaches `end`. Within a run of skipping pairs a walk
    // visits every other position, and a walk that starts before the run enters it at its first
    // pair (only the pair before a position can skip it, and that one does not skip). So the walk
    // visits `last` iff `last` has the parity of `max(first, run start)`.
    const last = end - 2;
    let stop = end - 1;
    if (last < this.runs.length) {
      const run = this.runs[last];
      if (run !== NO_RUN && ((Math.max(first, run) ^ last) & 1) === 0) stop = end;
    }
    return this.walk[first] - this.walk[stop];
  }
}

/** Parses an optional table; absent or malformed tables give `null`. */
function optional<T>(table: Reader | null, parse: (table: Reader) => T | null): T | null {
  if (table === null) return null;
  try {
    return parse(table);
  } catch (error) {
    if (error instanceof Malformed) return null;
    throw error;
  }
}
