/**
 * The implementation behind both entry points (`index.ts` for browsers and bundlers,
 * `node.ts` for Node), on top of the raw wasm-bindgen exports.
 */
import type {
  Issue,
  LabelProblem,
  LabelResult,
  PlaceOptions,
  PriorityValue,
  ValidationReport,
} from "@label-anything/core";
import { PlaceError } from "./place-error.js";
import { raw, type InitInput, type RawGlue } from "./raw.js";

/** Version of this package and of the Rust core it contains. */
export const VERSION = "0.1.0";

let ready = false;
let loading: Promise<void> | undefined;

/** Whether the WebAssembly module is instantiated. */
export function isInitialized(): boolean {
  return ready;
}

/** Instantiate synchronously from the bytes of `label_anything_bg.wasm` or a compiled module. */
export function initSync(module: BufferSource | WebAssembly.Module): void {
  if (ready) return;
  raw.initSync({ module });
  ready = true;
}

/** Instantiate asynchronously; without `input`, fetch `label_anything_bg.wasm` next to the glue. */
export function initAsync(input?: InitInput | Promise<InitInput>): Promise<void> {
  if (ready) return Promise.resolve();
  loading ??= raw.default(input === undefined ? undefined : { module_or_path: input }).then(
    () => {
      ready = true;
    },
    (e: unknown) => {
      loading = undefined;
      throw e;
    },
  );
  return loading;
}

function glue(): RawGlue {
  if (!ready) {
    throw new Error(
      "@label-anything/wasm is not initialized: call `await init()` (or `initSync(bytes)`) " +
        "before place(), validate() or renderDebugSvg()",
    );
  }
  return raw;
}

// --- abnormal exits -------------------------------------------------------------------
// A Rust panic (the panic hook throws an Error) or a trap (out of memory, stack overflow)
// leaves the instance with leaked memory and possibly inconsistent state. The raw calls
// keep a depth counter that is only decremented on normal returns; if it is still raised
// after an exception, the instance is replaced once no raw call is active any more.

let active = 0;
let resetDue = false;

function guarded<T>(g: RawGlue, f: () => T): T {
  active++;
  try {
    return f();
  } catch (e) {
    let clean: boolean;
    try {
      clean = g.callDepth() <= active - 1;
    } catch {
      clean = false;
    }
    if (!clean || e instanceof WebAssembly.RuntimeError) resetDue = true;
    throw clean ? e : internalError(e);
  } finally {
    active--;
    if (active === 0 && resetDue) {
      resetDue = false;
      try {
        g.__wbg_reset_state();
      } catch {
        // keep the original exception; the next call reports a broken instance
      }
    }
  }
}

function internalError(e: unknown): unknown {
  if (e instanceof Error && e.message.startsWith("label-anything: internal error")) return e;
  const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return new Error(
    `label-anything: internal error (the WebAssembly instance trapped: ${what}); ` +
      "the instance is replaced by a fresh one",
    { cause: e },
  );
}

// --- priority callback ----------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function priorityValue(v: PriorityValue, index: number): [number | undefined, number] {
  if (typeof v === "number" && Number.isFinite(v)) return [undefined, v];
  if (
    Array.isArray(v) &&
    v.length === 2 &&
    Number.isInteger(v[0]) &&
    typeof v[1] === "number" &&
    Number.isFinite(v[1])
  ) {
    return [v[0] as number, v[1] as number];
  }
  throw new TypeError(
    `label-anything: the priority callback must return a finite number or [tier, score] ` +
      `with an integer tier (item ${index} got ${String(v)})`,
  );
}

/**
 * Evaluate the host priority function once per item and write the values into a copy of
 * the problem: `priority` (unless the item has one) and, for `[tier, score]`, `tier`
 * (unless the item has one). `priority.terms` is dropped, since the callback replaces it;
 * tiers, `required` and ties still apply. Exactly what the Rust core does with
 * `Env::priority`.
 */
function withPriorities(problem: unknown, priority: NonNullable<PlaceOptions["priority"]>): unknown {
  if (!isObject(problem) || !Array.isArray(problem.items)) return problem; // the validator reports it
  const items = (problem.items as unknown[]).map((item, index) => {
    if (!isObject(item)) return item;
    const [tier, score] = priorityValue(
      priority(item as unknown as LabelProblem["items"][number], index),
      index,
    );
    const copy: Json = { ...item };
    if (copy.priority === undefined) copy.priority = score;
    if (tier !== undefined && copy.tier === undefined) copy.tier = tier;
    return copy;
  });
  const out: Json = { ...problem, items };
  if (isObject(problem.priority) && "terms" in problem.priority) {
    const { terms: _terms, ...rest } = problem.priority;
    out.priority = rest;
  }
  return out;
}

function problemJson(problem: LabelProblem | string, options: PlaceOptions | undefined): string {
  const priority = options?.priority;
  if (priority === undefined || priority === null) {
    return typeof problem === "string" ? problem : JSON.stringify(problem);
  }
  if (typeof priority !== "function") {
    throw new TypeError("label-anything: options.priority must be a function");
  }
  let value: unknown = problem;
  if (typeof problem === "string") {
    try {
      value = JSON.parse(problem);
    } catch {
      return problem; // the core reports the parse error
    }
  }
  return JSON.stringify(withPriorities(value, priority));
}

// --- API ------------------------------------------------------------------------------

const LEFT_BRACKET = 0x5b; // the raw calls return errors as a JSON array

/** Solve a problem (an object or JSON text). Throws {@link PlaceError} if it is invalid. */
export function place(problem: LabelProblem | string, options?: PlaceOptions): LabelResult {
  const g = glue();
  const text = problemJson(problem, options);
  const out = guarded(g, () => g.place(text, options));
  if (out.charCodeAt(0) === LEFT_BRACKET) throw new PlaceError(JSON.parse(out) as Issue[]);
  return JSON.parse(out) as LabelResult;
}

/** Validate a problem (an object or JSON text) against the schema and the semantic rules. */
export function validate(problem: unknown): ValidationReport {
  const g = glue();
  const text = typeof problem === "string" ? problem : (JSON.stringify(problem) ?? "null");
  return JSON.parse(guarded(g, () => g.validate(text))) as ValidationReport;
}

/** Debug SVG overlay of a problem and a result (spec §11). */
export function renderDebugSvg(problem: LabelProblem | string, result: LabelResult): string {
  const g = glue();
  const p = typeof problem === "string" ? problem : JSON.stringify(problem);
  const r = typeof result === "string" ? result : JSON.stringify(result);
  const out = guarded(g, () => g.renderSvg(p, r));
  if (out.charCodeAt(0) === LEFT_BRACKET) throw new PlaceError(JSON.parse(out) as Issue[]);
  return out;
}

/** Optional parts compiled into the WebAssembly module (`shaping`, `decode`, `svg`). */
export function features(): string[] {
  return glue().features();
}

/** @internal Test hooks: a Rust panic / a trap inside a raw call. */
export const testHooks = {
  panic(message: string): void {
    const g = glue();
    guarded(g, () => g.__testPanic(message));
  },
  trap(): void {
    const g = glue();
    guarded(g, () => g.__testTrap());
  },
  callDepth(): number {
    return glue().callDepth();
  },
  coreVersion(): string {
    return glue().version();
  },
};
