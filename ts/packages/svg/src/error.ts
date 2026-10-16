// Internal error plumbing: failures are thrown as `SvgFailure` inside the package and turned
// into `Result` values at the public API boundary, so callers never see an exception.

import type { Result, SvgError, SvgErrorCode } from "./types.js";

export class SvgFailure extends Error {
  readonly error: SvgError;
  constructor(code: SvgErrorCode, message: string) {
    super(message);
    this.error = { code, message };
  }
}

export function fail(code: SvgErrorCode, message: string): never {
  throw new SvgFailure(code, message);
}

/** Runs `f`, converting every exception into a structured error. */
export function guard<T>(f: () => T): Result<T> {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    if (e instanceof SvgFailure) return { ok: false, error: e.error };
    if (e instanceof RangeError) {
      return { ok: false, error: { code: "limit", message: `resource limit: ${e.message}` } };
    }
    return { ok: false, error: { code: "invalid_value", message: `internal error: ${String(e)}` } };
  }
}
