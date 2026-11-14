// Helpers shared by the tests: the conformance directories, the generator of the Rust
// tests and the case counts set through the environment.
import { fileURLToPath } from "node:url";

/** `conformance/` (with a trailing slash). */
export const CONF = fileURLToPath(new URL("../../../../conformance/", import.meta.url));
/** `conformance/problems/` (with a trailing slash). */
export const PROBLEMS = fileURLToPath(new URL("../../../../conformance/problems/", import.meta.url));

const MASK = (BigInt(1) << BigInt(64)) - BigInt(1);

/** Small deterministic generator (SplitMix64), as in the Rust tests. */
export class Rng {
  private s: bigint;
  constructor(seed: number) {
    this.s = BigInt(seed);
  }
  next(): bigint {
    this.s = (this.s + BigInt("0x9E3779B97F4A7C15")) & MASK;
    let z = this.s;
    z = ((z ^ (z >> BigInt(30))) * BigInt("0xBF58476D1CE4E5B9")) & MASK;
    z = ((z ^ (z >> BigInt(27))) * BigInt("0x94D049BB133111EB")) & MASK;
    return z ^ (z >> BigInt(31));
  }
  f(): number {
    return Number(this.next() >> BigInt(11)) / 9007199254740992;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.f();
  }
  /** An integer in `[0, n)`; 0 (without consuming an output) for `n = 0`. */
  below(n: number): number {
    return n === 0 ? 0 : Number(this.next() % BigInt(n));
  }
  byte(): number {
    return Number(this.next() & BigInt(0xff));
  }
}

/** The non-negative integer in the environment variable `name`, else `d`. */
export function envInt(name: string, d: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= 0 ? n : d;
}
