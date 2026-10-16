import { decodeBase64 } from "./base64.js";
import { Font } from "./font.js";
import { NOTO_SANS_BOLD_BASE64, NOTO_SANS_REGULAR_BASE64 } from "./generated/fonts.js";

/** Identifies a font of a {@link FontBook} (its position in the book). */
export type FontId = number;

interface Entry {
  family: string;
  weight: number;
  italic: boolean;
  font: FontId;
}

let bundled: [Font, Font] | undefined;

/** The bundled Noto Sans Regular and Bold, parsed once. */
function bundledFonts(): [Font, Font] {
  bundled ??= [
    Font.fromBytes(decodeBase64(NOTO_SANS_REGULAR_BASE64)),
    Font.fromBytes(decodeBase64(NOTO_SANS_BOLD_BASE64)),
  ];
  return bundled;
}

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/**
 * Fonts by `(family, weight, italic)`.
 *
 * {@link FontBook.resolve} picks the font for a request: the family (ASCII
 * case-insensitive), else `"default"`, else the family of the first registered font; within
 * the family the requested style if available; then the nearest weight (smallest |Δ|, ties
 * → the lighter weight, identical entries → the most recently registered).
 */
export class FontBook {
  private readonly fonts: Font[] = [];
  private readonly entries: Entry[] = [];
  /** Memo of {@link resolve} (cleared by {@link register}). */
  private readonly resolved = new Map<string, FontId>();

  private constructor() {}

  /** A book without fonts. */
  static empty(): FontBook {
    return new FontBook();
  }

  /**
   * The bundled Noto Sans subset (Latin, Greek, Cyrillic; metrics only) as the families
   * `"default"` and `"Noto Sans"`, weights 400 and 700, upright.
   */
  static withBundled(): FontBook {
    const book = new FontBook();
    book.fonts.push(...bundledFonts());
    for (const family of ["default", "Noto Sans"]) {
      book.entries.push(
        { family, weight: 400, italic: false, font: 0 },
        { family, weight: 700, italic: false, font: 1 },
      );
    }
    return book;
  }

  /** Parses `data` (see {@link Font.fromBytes}) and registers it. */
  register(family: string, weight: number, italic: boolean, data: Uint8Array): FontId {
    const font = Font.fromBytes(data);
    this.resolved.clear();
    const id = this.fonts.length;
    this.fonts.push(font);
    this.entries.push({ family, weight, italic, font: id });
    return id;
  }

  /** The font for a request (see the class docs). Throws if the book is empty. */
  resolve(family: string, weight: number, italic: boolean): FontId {
    const key = `${weight}\u0000${italic ? 1 : 0}\u0000${family}`;
    const memo = this.resolved.get(key);
    if (memo !== undefined) return memo;
    const id = this.resolveUncached(family, weight, italic);
    this.resolved.set(key, id);
    return id;
  }

  private resolveUncached(family: string, weight: number, italic: boolean): FontId {
    const has = (name: string): boolean => this.entries.some((e) => asciiLower(e.family) === asciiLower(name));
    let name = family;
    if (!has(name)) {
      const first = this.entries[0];
      if (first === undefined) throw new Error("FontBook.resolve needs at least one font");
      name = has("default") ? "default" : first.family;
    }
    const inFamily = this.entries.filter((e) => asciiLower(e.family) === asciiLower(name));
    const style = inFamily.some((e) => e.italic === italic) ? italic : !italic;
    let best: Entry | undefined;
    for (const entry of inFamily) {
      if (entry.italic !== style) continue;
      const d = Math.abs(entry.weight - weight);
      const db = best === undefined ? Infinity : Math.abs(best.weight - weight);
      if (best === undefined || d < db || (d === db && entry.weight <= best.weight)) best = entry;
    }
    return best!.font;
  }

  /** The font with this id. Throws if `id` does not belong to this book. */
  font(id: FontId): Font {
    const font = this.fonts[id];
    if (font === undefined) throw new RangeError(`unknown font id ${id}`);
    return font;
  }
}
