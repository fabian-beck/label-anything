/**
 * Lengths with units (spec §2.1): numbers are px; strings `<n>px`, `<n>pt`, `<n>em`.
 *
 * Port of `rust/crates/la-core/src/units.rs`.
 */

/** A length before resolution against a font size (Rust `enum Length { Px(f64), Em(f64) }`). */
export class Length {
  private constructor(
    readonly kind: "Px" | "Em",
    readonly value: number,
  ) {}

  /** `Length::Px(v)`: pixels. */
  static Px(v: number): Length {
    return new Length("Px", v);
  }

  /** `Length::Em(v)`: multiples of the label's font size. */
  static Em(v: number): Length {
    return new Length("Em", v);
  }

  /** Parse a JSON value (number or unit string). Returns `null` for invalid input. */
  static fromValue(v: unknown): Length | null {
    if (typeof v === "number") return Length.Px(v);
    if (typeof v === "string") return Length.parse(v);
    return null;
  }

  /** Parse `"12px"`, `"9pt"`, `"0.3em"`. */
  static parse(str: string): Length | null {
    const s = trimRust(str);
    let unit: string | null = null;
    for (const u of UNITS) {
      if (s.endsWith(u)) {
        unit = u;
        break;
      }
    }
    if (unit === null) return null;
    const num = s.slice(0, s.length - unit.length);
    if (num.length === 0 || !NUM_CHARS.test(num)) return null;
    // Rust `str::parse::<f64>` restricted to the characters [0-9.-] accepted above
    if (!RUST_F64.test(num)) return null;
    const x = Number(num);
    if (!Number.isFinite(x)) return null;
    switch (unit) {
      case "px":
        return Length.Px(x);
      case "pt":
        return Length.Px((x * 4) / 3);
      default:
        return Length.Em(x);
    }
  }

  /** Resolve to pixels for a label with font size `em` (px). */
  px(em: number): number {
    return this.kind === "Px" ? this.value : this.value * em;
  }
}

const UNITS = ["px", "pt", "em"] as const;
/** Only ASCII digits, `.` and `-` (the character check of `units.rs`). */
const NUM_CHARS = /^[0-9.-]+$/;
/**
 * The grammar of Rust's `f64::from_str` for strings made of `[0-9.-]`: an optional sign,
 * then `digits`, `digits.` , `digits.digits` or `.digits`.
 */
const RUST_F64 = /^-?([0-9]+\.?[0-9]*|\.[0-9]+)$/;

/** Unicode `White_Space` (what Rust's `str::trim` removes; differs from JS `trim`). */
function isRustWhitespace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

/** Rust `str::trim` (all `White_Space` code points are in the BMP). */
function trimRust(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isRustWhitespace(s.charCodeAt(a))) a++;
  while (b > a && isRustWhitespace(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}
