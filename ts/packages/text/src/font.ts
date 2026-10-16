import { CharMap } from "./cmap.js";
import { TextError } from "./errors.js";
import { Kerning } from "./kern.js";
import { Malformed, Reader } from "./reader.js";

const tag = (name: string): number =>
  ((name.charCodeAt(0) << 24) | (name.charCodeAt(1) << 16) | (name.charCodeAt(2) << 8) | name.charCodeAt(3)) >>> 0;

const invalid = (message: string): TextError => new TextError("invalid_font", message);

/** Runs `read`, turning a malformed read into an `invalid_font` error for table `name`. */
function readTable<T>(name: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof Malformed) throw invalid(`malformed '${name}' table`);
    throw error;
  }
}

/** The table directory of an sfnt (TrueType, OpenType/CFF, or the first font of a collection). */
class Tables {
  private constructor(
    private readonly data: Reader,
    /** [tag, offset, length] */
    private readonly records: [number, number, number][],
  ) {}

  static parse(data: Reader): Tables {
    const tooShort = (): TextError => invalid("the data is too short to be a font");
    try {
      let start = 0;
      if (data.u32(0) === tag("ttcf")) {
        if (data.u32(8) === 0) throw invalid("the font collection is empty");
        start = data.u32(12);
      }
      const flavor = data.u32(start);
      if (flavor !== 0x00010000 && flavor !== tag("true") && flavor !== tag("OTTO")) {
        throw invalid("not a TrueType/OpenType font");
      }
      const count = data.u16(start + 4);
      data.checkArray(start + 12, count, 16);
      const records: [number, number, number][] = [];
      for (let i = 0; i < count; i++) {
        const at = start + 12 + 16 * i;
        records.push([data.u32(at), data.u32(at + 8), data.u32(at + 12)]);
      }
      return new Tables(data, records);
    } catch (error) {
      throw error instanceof Malformed ? tooShort() : error;
    }
  }

  /** The first table with this tag; `null` if absent or outside the data. */
  get(name: string): Reader | null {
    const record = this.records.find((r) => r[0] === tag(name));
    if (record === undefined) return null;
    try {
      return this.data.slice(record[1], record[2]);
    } catch {
      return null;
    }
  }

  required(name: string): Reader {
    const table = this.get(name);
    if (table === null) throw invalid(`missing '${name}' table`);
    return table;
  }
}

/**
 * A parsed font, holding everything simple shaping needs (spec §5.2).
 *
 * Parsing happens once in {@link Font.fromBytes}: advances, the character map and the
 * pair-kerning lookups are flattened into lookup tables, so measuring does not allocate.
 * Widths are bit-identical to the Rust crate `label-anything-text`. Full OpenType shaping
 * is not implemented (see {@link needsComplexShaping}).
 */
export class Font {
  /** Font design units per em (`head.unitsPerEm`). */
  readonly unitsPerEm: number;
  /** Ascender in font units: `hhea.ascender`, or `OS/2.sTypoAscender` with USE_TYPO_METRICS. */
  readonly ascender: number;
  /** Descender in font units, negative below the baseline (`hhea` or `OS/2` typo metrics). */
  readonly descender: number;
  /** Line gap in font units (`hhea.lineGap` or `OS/2.sTypoLineGap`). */
  readonly lineGap: number;
  private readonly advances: Uint16Array;
  private readonly cmap: CharMap;
  private readonly kerning: Kerning;
  private glyphs = new Uint16Array(64);

  private constructor(data: Uint8Array) {
    const tables = Tables.parse(Reader.of(data));
    const head = tables.required("head");
    const unitsPerEm = readTable("head", () => head.u16(18));
    if (unitsPerEm < 16 || unitsPerEm > 16384) throw invalid(`unitsPerEm ${unitsPerEm} is outside 16..=16384`);
    const maxp = tables.required("maxp");
    const numGlyphs = readTable("maxp", () => maxp.u16(4));
    if (numGlyphs === 0) throw invalid("the font has no glyphs");
    const hhea = tables.required("hhea");
    let [ascender, descender, lineGap, longMetrics] = readTable("hhea", () => [
      hhea.i16(4),
      hhea.i16(6),
      hhea.i16(8),
      hhea.u16(34),
    ]);
    // OS/2 typo metrics replace hhea when fsSelection bit 7 (USE_TYPO_METRICS) is set.
    const os2 = tables.get("OS/2");
    if (os2 !== null) {
      try {
        const selection = os2.u16(62);
        const typo = [os2.i16(68), os2.i16(70), os2.i16(72)];
        if (selection & 0x0080) [ascender, descender, lineGap] = typo;
      } catch (error) {
        if (!(error instanceof Malformed)) throw error;
      }
    }
    this.unitsPerEm = unitsPerEm;
    this.ascender = ascender;
    this.descender = descender;
    this.lineGap = lineGap;
    this.advances = Font.parseAdvances(tables.required("hmtx"), longMetrics, numGlyphs);
    const cmapTable = tables.required("cmap");
    const cmap = readTable("cmap", () => CharMap.parse(cmapTable, numGlyphs));
    if (cmap === null) throw invalid("no Unicode 'cmap' subtable of format 4 or 12");
    this.cmap = cmap;
    this.kerning = Kerning.parse(tables.get("GDEF"), tables.get("GPOS"), tables.get("kern"), numGlyphs);
  }

  /** Advance of every glyph; glyphs past `numberOfHMetrics` repeat the last advance. */
  private static parseAdvances(hmtx: Reader, longMetrics: number, numGlyphs: number): Uint16Array {
    if (longMetrics === 0) throw invalid("numberOfHMetrics is 0");
    const count = Math.min(longMetrics, numGlyphs);
    const advances = new Uint16Array(numGlyphs);
    readTable("hmtx", () => {
      for (let g = 0; g < count; g++) advances[g] = hmtx.u16(4 * g);
    });
    advances.fill(advances[count - 1], count);
    return advances;
  }

  /**
   * Loads a TrueType or OpenType (CFF) font, or the first font of a TrueType collection.
   * WOFF and WOFF2 are not supported (`TextError` with code `unsupported`).
   */
  static fromBytes(data: Uint8Array): Font {
    const signature = String.fromCharCode(...data.subarray(0, 4));
    if (signature === "wOF2") {
      throw new TextError("unsupported", "WOFF2 fonts are not supported by @label-anything/text; use TTF or OTF");
    }
    if (signature === "wOFF") {
      throw new TextError("unsupported", "WOFF 1.0 fonts are not supported; use TTF or OTF");
    }
    return new Font(data);
  }

  /**
   * Simple shaping (spec §5.2): the sum of the `hmtx` advances of the glyphs the code points
   * map to (unmapped → glyph 0) plus all pair-kerning adjustments, in font units.
   */
  advanceUnits(text: string): number {
    if (this.glyphs.length < text.length) this.glyphs = new Uint16Array(2 * text.length);
    const glyphs = this.glyphs;
    let total = 0;
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      let cp = text.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
          i++;
        }
      }
      const glyph = this.cmap.glyph(cp);
      glyphs[n++] = glyph;
      total += this.advances[glyph];
    }
    return this.kerning.isEmpty ? total : total + this.kerning.adjustment(glyphs, n);
  }

  /**
   * Width of `text` at `size` px with simple shaping:
   * `advanceUnits(text) * size / unitsPerEm`, in exactly this order, so the result is
   * bit-identical to the Rust implementation.
   */
  width(text: string, size: number): number {
    return (this.advanceUnits(text) * size) / this.unitsPerEm;
  }
}
