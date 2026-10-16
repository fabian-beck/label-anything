// Helpers of the parity tests: exact comparison of results with the Rust ones.

/** Result fields that depend on the clock or name the implementation. */
export function withoutTiming(r: unknown): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "number" && Object.is(v, -0) ? NEG_ZERO : v)), (_k, v) =>
    v === NEG_ZERO ? -0 : v,
  ) as Record<string, unknown>;
  const st = out.stats as Record<string, unknown> | undefined;
  if (st !== undefined) {
    delete st.runtime_ms;
    delete st.phases_ms;
    delete st.implementation;
  }
  return out;
}

const NEG_ZERO = "\u0000-0";

/**
 * Differences between two JSON values, as `path: a vs b` lines (at most `max`). Numbers
 * must be identical bit for bit (`-0` differs from `0`); key order is not compared.
 */
export function jsonDiff(a: unknown, b: unknown, max = 10, path = "", out: string[] = []): string[] {
  if (out.length >= max) return out;
  if (typeof a === "number" && typeof b === "number") {
    if (!Object.is(a, b)) out.push(`${path}: ${a} vs ${b}`);
    return out;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b) out.push(`${path}: ${short(a)} vs ${short(b)}`);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: ${short(a)} vs ${short(b)}`);
    return out;
  }
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) out.push(`${path}: length ${a.length} vs ${bb.length}`);
    for (let i = 0; i < Math.min(a.length, bb.length); i++) jsonDiff(a[i], bb[i], max, `${path}[${i}]`, out);
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k of Object.keys(bo)) if (!(k in ao)) out.push(`${path}.${k}: missing vs ${short(bo[k])}`);
  for (const k of Object.keys(ao)) {
    if (!(k in bo)) out.push(`${path}.${k}: ${short(ao[k])} vs missing`);
    else jsonDiff(ao[k], bo[k], max, `${path}.${k}`, out);
  }
  return out;
}

function short(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}
