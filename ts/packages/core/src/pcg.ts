/**
 * PCG32 (PCG-XSH-RR 64/32), the engine's only random number generator; identical to
 * `la_expr::det_math::Pcg32` in Rust (spec §10.4, vectors in conformance/math/pcg32.json).
 *
 * The 64-bit state is kept as two unsigned 32-bit halves; the LCG step multiplies with
 * 16-bit limbs and `Math.imul`, so no `BigInt` is involved after construction.
 *
 * @module
 */

/** Multiplier 6364136223846793005 = 0x5851f42d_4c957f2d. */
const MULT_HI = 0x5851f42d;
const MULT_LO = 0x4c957f2d;
/** Increment 1442695040888963407 = 0x14057b7e_f767814f. */
const INC_HI = 0x14057b7e;
const INC_LO = 0xf767814f;
const TWO32 = 4294967296;

/** High 32 bits of the 64-bit product of two uint32 (exact, 16-bit limbs). */
function mulHi32(a: number, b: number): number {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const p00 = a0 * b0;
  const p01 = a0 * b1;
  const p10 = a1 * b0;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  return (a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
}

function seedWords(seed: number | bigint): [number, number] {
  if (typeof seed === "bigint") {
    if (seed < BigInt(0) || seed >= BigInt(2) ** BigInt(64)) {
      throw new RangeError("Pcg32 seed must be in [0, 2^64)");
    }
    return [Number(seed >> BigInt(32)), Number(seed & BigInt(0xffffffff))];
  }
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new RangeError("Pcg32 seed must be a non-negative safe integer (or a bigint)");
  }
  return [Math.floor(seed / TWO32), seed % TWO32];
}

/** PCG-XSH-RR 64/32 with the fixed increment 1442695040888963407. */
export class Pcg32 {
  private hi = 0;
  private lo = 0;

  /**
   * Seeding: `state = 0; step(); state += seed; step()`. `seed` is a 64-bit unsigned
   * integer: a non-negative safe integer number, or a bigint for the full range.
   */
  constructor(seed: number | bigint = 0) {
    const [sh, sl] = seedWords(seed);
    this.step();
    const lo = this.lo + sl;
    const carry = lo >= TWO32 ? 1 : 0;
    this.lo = lo >>> 0;
    this.hi = (this.hi + sh + carry) >>> 0;
    this.step();
  }

  /** state = state · MULT + INC (mod 2^64). */
  private step(): void {
    const lo = this.lo;
    const hi = this.hi;
    // lo · MULT_LO as a full 64-bit product (16-bit limbs, all partial products exact)
    const a0 = lo & 0xffff;
    const a1 = lo >>> 16;
    const b0 = MULT_LO & 0xffff;
    const b1 = MULT_LO >>> 16;
    const p00 = a0 * b0;
    const p01 = a0 * b1;
    const p10 = a1 * b0;
    const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
    const plo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0;
    const phi = a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16);
    // + (hi · MULT_LO + lo · MULT_HI) · 2^32, only the low 32 bits matter
    const nhi = (phi + Math.imul(hi, MULT_LO) + Math.imul(lo, MULT_HI)) >>> 0;
    const nlo = plo + INC_LO;
    const carry = nlo >= TWO32 ? 1 : 0;
    this.lo = nlo >>> 0;
    this.hi = (nhi + INC_HI + carry) >>> 0;
  }

  /** Next 32-bit output (an integer in [0, 2^32)). */
  nextU32(): number {
    const ohi = this.hi;
    const olo = this.lo;
    this.step();
    // xorshifted = u32(((old >> 18) ^ old) >> 27), rot = old >> 59
    const xhi = (ohi >>> 18) ^ ohi;
    const xlo = ((olo >>> 18) | (ohi << 14)) ^ olo;
    const xs = ((xlo >>> 27) | (xhi << 5)) >>> 0;
    const rot = ohi >>> 27;
    return ((xs >>> rot) | (xs << ((32 - rot) & 31))) >>> 0;
  }

  /** Uniform in [0, 1): nextU32() / 2^32 (exact). */
  nextF64(): number {
    return this.nextU32() / TWO32;
  }

  /**
   * Integer in [0, n) for an integer 0 ≤ n < 2^32: floor(nextU32() · n / 2^32), computed
   * exactly. Always consumes one output; nextBelow(0) = 0.
   */
  nextBelow(n: number): number {
    if (!(n >= 0 && n < TWO32 && Math.floor(n) === n)) {
      throw new RangeError("Pcg32.nextBelow: n must be an integer in [0, 2^32)");
    }
    return mulHi32(this.nextU32(), n);
  }

  /**
   * Fisher–Yates shuffle from the end, in place: for i = length−1 … 1, swap a[i] with
   * a[nextBelow(i + 1)]. Consumes length − 1 outputs.
   */
  shuffle<T>(a: T[]): void {
    for (let i = a.length - 1; i >= 1; i--) {
      const j = this.nextBelow(i + 1);
      const t = a[i] as T;
      a[i] = a[j] as T;
      a[j] = t;
    }
  }
}
