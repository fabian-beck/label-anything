#!/usr/bin/env node
// Rust/TypeScript parity of validate(): reference reports and differential fuzzing.
//
//   node tools/validate/parity.mjs reports [--check]   Rust reports of the sample problems and
//                                                      the validate cases -> conformance/validate/reports/rust.json
//   node tools/validate/parity.mjs mutants [--check]   a fixed sample of mutated problems (seeded) with
//                                                      their Rust reports -> conformance/validate/reports/mutants.json
//   node tools/validate/parity.mjs fuzz [--count N] [--text-count M] [--seed S] [--keep DIR]
//                                                      differential fuzzing: N mutated problems (validate)
//                                                      and M mutated JSON texts (validateStr), TS vs Rust
//   node tools/validate/parity.mjs patterns [--count N] [--seed S]
//                                                      N random strings in each place the schema checks
//                                                      with a pattern (regex_lite vs RegExp "u"), TS vs Rust
//   node tools/validate/parity.mjs bench [--runs N]    time both validators on a generated problem with
//                                                      2,000 items and 100k obstacle points (Rust: release)
//
// --check compares instead of writing (exit 1 if stale). `cargo test -p label-anything-core
// --test validate_reports` also checks that both fixtures match the Rust validator.
// Rust side: the `validate_oracle` example of label-anything-core (built with cargo; set
// LA_ORACLE to use a prebuilt binary). TypeScript side (fuzz, patterns, bench): the
// compiled package, `cd ts && npx tsc -b packages/core`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const conf = join(root, "conformance");
const REPORTS = join(conf, "validate/reports/rust.json");
const MUTANTS = join(conf, "validate/reports/mutants.json");
const MUTANT_SEED = 20261016;

// ---------------------------------------------------------------------------------------
// Rust oracle and TypeScript validator
// ---------------------------------------------------------------------------------------

let oracleBin = process.env.LA_ORACLE ?? null;

function oraclePath(release = false) {
  if (oracleBin !== null) return oracleBin;
  const r = spawnSync(
    "cargo",
    [
      "build",
      ...(release ? ["--release"] : []),
      "--manifest-path",
      join(root, "rust/Cargo.toml"),
      "-p",
      "label-anything-core",
      "--example",
      "validate_oracle",
      "--message-format=json",
    ],
    { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] },
  );
  if (r.status !== 0) throw new Error("cargo build of validate_oracle failed");
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const m = JSON.parse(line);
    if (m.reason === "compiler-artifact" && m.target?.name === "validate_oracle" && m.executable) oracleBin = m.executable;
  }
  if (oracleBin === null) throw new Error("validate_oracle executable not found in cargo output");
  return oracleBin;
}

function runOracle(args, input) {
  const r = spawnSync(oraclePath(), args, { input, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`validate_oracle ${args.join(" ")}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** Rust reports of JSON values (`validate`) or JSON texts (`validate_str`), in chunks. */
function rustReports(inputs, { text = false } = {}) {
  const out = [];
  let chunk = [];
  let size = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    out.push(...runOracle(text ? ["--batch", "--text"] : ["--batch"], `[${chunk.join(",")}]`));
    chunk = [];
    size = 0;
  };
  for (const v of inputs) {
    const s = JSON.stringify(v);
    chunk.push(s);
    size += s.length;
    if (size > 4_000_000) flush();
  }
  flush();
  if (out.length !== inputs.length) throw new Error("oracle returned the wrong number of reports");
  return out;
}

/** serde_json's reading of JSON texts: `{ value }` or `{ error }` (validate_oracle --values). */
function rustValues(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 500) {
    out.push(...runOracle(["--batch", "--text", "--values"], JSON.stringify(texts.slice(i, i + 500))));
  }
  return out;
}

/** Structural equality with numbers compared by Object.is (-0 differs from 0). */
function sameJson(a, b) {
  if (typeof a === "number" || typeof b === "number") return Object.is(a, b);
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJson(a[k], b[k]));
  }
  return a === b;
}

/** JSON arrays of random number literals (correct rounding, overflow, signed zeros). */
function numberTexts(seed, count) {
  const r = makeRng(seed ^ 0x51ed270b);
  const digits = (n) => {
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(0x30 + r.int(10));
    return s;
  };
  const literal = () => {
    let s = r.chance(0.3) ? "-" : "";
    s += r.chance(0.2) ? "0" : String(1 + r.int(9)) + digits(r.int(r.chance(0.2) ? 40 : 18));
    if (r.chance(0.6)) s += "." + digits(1 + r.int(r.chance(0.2) ? 40 : 18));
    if (r.chance(0.5)) s += r.pick(["e", "E"]) + r.pick(["", "+", "-"]) + String(r.int(r.chance(0.1) ? 100000 : 330));
    return s;
  };
  const out = [];
  for (let i = 0; i < count; i++) {
    const n = 1 + r.int(40);
    const lits = [];
    for (let k = 0; k < n; k++) lits.push(literal());
    out.push(`[${lits.join(",")}]`);
  }
  return out;
}

async function tsValidator() {
  const file = join(root, "ts/packages/core/dist/validate.js");
  if (!existsSync(file)) throw new Error("compile the TypeScript package first: cd ts && npx tsc -b packages/core");
  return import(pathToFileURL(file).href);
}

/** A report as plain JSON (TS issues are class instances). */
const plain = (r) => JSON.parse(JSON.stringify(r));

// ---------------------------------------------------------------------------------------
// Inputs: sample problems and validate cases
// ---------------------------------------------------------------------------------------

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const jsonFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();

/** [key, kind, input]: sample files as text, inline case problems as values. */
function referenceInputs() {
  const out = [];
  for (const f of jsonFiles(join(conf, "problems"))) out.push([`problems/${f}`, "text", readFileSync(join(conf, "problems", f), "utf8")]);
  for (const f of jsonFiles(join(conf, "validate"))) {
    const c = readJson(join(conf, "validate", f));
    if (c.kind === "validate" && "problem" in c) out.push([`validate/${f}`, "value", c.problem]);
  }
  return out;
}

function stable(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

function writeOrCheck(path, content, check) {
  const rel = path.slice(root.length + 1);
  const old = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (old === content) {
    console.log(`${rel}: up to date`);
    return true;
  }
  if (check) {
    console.error(`${rel}: stale (run: node tools/validate/parity.mjs ${path === REPORTS ? "reports" : "mutants"})`);
    return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote ${rel}`);
  return true;
}

function cmdReports(check) {
  const inputs = referenceInputs();
  const texts = inputs.filter((i) => i[1] === "text");
  const values = inputs.filter((i) => i[1] === "value");
  const rt = rustReports(texts.map((i) => i[2]), { text: true });
  const rv = rustReports(values.map((i) => i[2]));
  const reports = {};
  texts.forEach((i, k) => (reports[i[0]] = rt[k]));
  values.forEach((i, k) => (reports[i[0]] = rv[k]));
  const doc = {
    about:
      "Reports of the Rust validator (rust/crates/la-core/src/validate.rs) for every sample problem (its JSON text, validate_str) " +
      "and every inline problem of a validate case. The TypeScript validator must reproduce them exactly. " +
      "Regenerate: node tools/validate/parity.mjs reports. Checked by cargo test -p label-anything-core --test validate_reports " +
      "and ts/packages/core/test/conformance-validate.test.ts.",
    reports,
  };
  return writeOrCheck(REPORTS, stable(doc), check);
}

// ---------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------

/** mulberry32 */
function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
  };
}

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function setKey(o, k, v) {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  else o[k] = v;
}

/** No lone surrogates in any string or key. */
function wellFormed(v) {
  const stack = [v];
  while (stack.length) {
    const x = stack.pop();
    if (typeof x === "string") {
      if (!x.isWellFormed()) return false;
    } else if (Array.isArray(x)) {
      stack.push(...x);
    } else if (isObj(x)) {
      for (const k of Object.keys(x)) {
        if (!k.isWellFormed()) return false;
        stack.push(x[k]);
      }
    }
  }
  return true;
}

function depth(v) {
  // iterative max depth (arrays and objects count one level each)
  let max = 0;
  const stack = [[v, 0]];
  while (stack.length) {
    const [x, d] = stack.pop();
    if (Array.isArray(x)) {
      max = Math.max(max, d + 1);
      for (const y of x) stack.push([y, d + 1]);
    } else if (isObj(x)) {
      max = Math.max(max, d + 1);
      for (const k of Object.keys(x)) stack.push([x[k], d + 1]);
    }
  }
  return max;
}

const schema = readJson(join(root, "spec/schema/problem.v1.json"));
const SCHEMA_KEYS = new Set();
const SCHEMA_ENUMS = new Set();
(function walk(x) {
  if (Array.isArray(x)) return x.forEach(walk);
  if (!isObj(x)) return;
  for (const [k, v] of Object.entries(x)) {
    if (k === "properties" && isObj(v)) Object.keys(v).forEach((p) => SCHEMA_KEYS.add(p));
    if (k === "enum" && Array.isArray(v)) v.forEach((e) => SCHEMA_ENUMS.add(e));
    if (k === "const") SCHEMA_ENUMS.add(v);
    walk(v);
  }
})(schema);
const KEYS = [
  ...[...SCHEMA_KEYS].sort(),
  ...["Type", "types", "x ", "shapee", "colour", "frobnicate", "extra", "id2", "items_", "Canvas"],
  ...["__proto__", "constructor", "toString", "hasOwnProperty", "", "~", "/", "a/b", "~0", "~1", "0", "10", "2", "😀", "é", "*"],
];
const ENUMS = [...SCHEMA_ENUMS].sort().concat(["line", "square", "zigzag", "Point", "TEXT", "random", "random(3)", "random()"]);
const NUMBERS = [0, -0, 1, -1, 2, 3, 4, 5, 7, 10, 12, 90, 91, 100, 127, 255, 256, 360, 1000, 1001, 0.5, 1.5, -2.5, 0.1, 0.25, 0.3,
  2.0001, 1e-7, 1e21, 1e300, -1e300, 4294967295, 4294967296, 9007199254740993, 123456.789];
const UNITS = ["3px", "3 px", "3PX", "-2em", ".5em", "5.", "5.px", "1e3px", "+3px", " 3px", "3px ", "３px", "3pt", "0.5em", "-0px",
  "em", "", "1.2.3px", "12", "-.5pt", "10em", "0.15em", "2pt", "1px", "-3px", ".px", "- 1px", "1 em", "1emx", "1 px"];
const STRINGS = ["", " ", "a", "A", "_x", "9lives", "a.b:c-d", "a b", "x".repeat(70), "é".repeat(40), "😀".repeat(30), "é", "😀",
  "\u0000", "\n", "\t", "\u001f", "\u007f", " ", "line\nbreak", 'quote"', "back\\slash", "#fff", "#ffffff", "#ffff", "#GGG",
  "#FfA", "partial:0.5", "partial:1.0", "partial:1.5", "partial:.5", "partial:", "rounded:2", "rounded:.5", "rounded:", "rounded:2.",
  "shrink:0.5", "shrink:1", "shrink:1.5", "shrink:.25", "shrink:", "random(10)", "random(x)", "hard", "ignore", "points", "lines",
  "ink", "text", "items", "labels", "leaders", "canvas_edge", "own_mark", "*", "<svg/>", "x.svg", "data:image/png;base64,AAAA",
  "AAAAAA==", "a", "b", "c", "set", "g1", "dot1", "#dot", "circle, rect", "attrs.a > 1"];
const EXPRS = ["attrs.a > 1", "attrs.category == 'core'", "attrs.region", "index < 5", "id == 'a'", "x > 100 && y < 50",
  "text != ''", "attrs.c.d", "min(1, 2)", "len(text) > 3", "attrs.x +", "foo(1)", "", "  ", "attrs.a > 1 &&", "min()", "'unterminated",
  "1 +* 2", "((((", "(".repeat(300) + "1" + ")".repeat(300), "nope", "attrs[", "attrs.a in [1, 2", "lower(1, 2, 3)", "😀 == 1",
  "attrs.é", "\"x\" + 'y'", "1e400 > 1", "!attrs.a", "priority * 2 + tier"];
const PATTERN_TOKENS = ["0", "1", "2", "9", "00", "05", ".", "..", "-", "+", ":", "#", "a", "f", "F", "g", "G", "x", "px", "pt", "em",
  "PX", "Em", " ", "partial", "partial:", "rounded:", "shrink:", "random", "random(", "(", ")", "input_order", "id", "anchor_x",
  "rect", "circle", "polygon", "rounded", "_", "é", "😀", "\n", "e", "E", "alternatives", "wrap", "omit", "evict_lower",
  "soft_overlap", "boundary", "distant", "truncate", "fff", "abc", "ABCDEF", "123", "1.0", "0.5", ".5", "1.", "ink", "*", "Z", "z9_"];
/** A random string from the patterns' alphabets. */
function patternString(r) {
  let s = "";
  for (let i = 0, n = 1 + r.int(5); i < n; i++) s += r.chance(0.1) ? String.fromCodePoint(r.int(0x80)) : r.pick(PATTERN_TOKENS);
  return s;
}

/**
 * The places whose strings the schema checks with a `pattern`: degrade steps,
 * nonNegLength (3 places), className (vector, avoid keys, relaxable), color (ink background,
 * classmap keys), own_mark, ties, icon shape. Covers every pattern of the schema.
 */
const PATTERN_SLOTS = 12;

function placePattern(r, p, slot, s) {
  const obj = (o, k) => (isObj(o[k]) ? o[k] : (o[k] = {}));
  switch (slot) {
    case 0:
      p.degrade = [s];
      break;
    case 1:
      obj(p, "placement").offset = s;
      break;
    case 2:
      obj(p, "canvas").padding = s;
      break;
    case 3:
      obj(obj(p, "leaders"), "x").clearance = s; // also an unknown property
      obj(p, "leaders").clearance = s;
      break;
    case 4:
      obj(p, "obstacles").vector = [{ class: s }];
      break;
    case 5:
      obj(p, "obstacles").raster = { source: "a.png", ink: { background: s } };
      break;
    case 6:
      obj(p, "obstacles").raster = { source: "a.png", classmap: { [s]: r.pick(["ink", "ignore", s]) } };
      break;
    case 7:
      obj(obj(p, "avoid"), "label").own_mark = s;
      break;
    case 8:
      setKey(obj(obj(p, "avoid"), r.pick(["label", "leader", "buffer"])), s, r.pick([1, "hard", "ignore", 0.5]));
      break;
    case 9:
      obj(p, "avoid").relaxable = [s];
      break;
    case 10:
      obj(p, "priority").ties = s;
      break;
    default:
      p.items = [{ anchor: { type: "point", x: 1, y: 1 }, label: { type: r.pick(["icon", "box"]), width: 1, height: 1, shape: s } }];
  }
}

const DISCRIMINATORS = ["point", "area", "line", "text", "icon", "box", "composite", "circle", "ellipse", "rect", "polygon", "path",
  "from_svg", "square", "", 1, null, true];

function randomValue(r, d = 0) {
  switch (r.int(d > 2 ? 6 : 9)) {
    case 0:
      return null;
    case 1:
      return r.chance(0.5);
    case 2:
      return r.pick(NUMBERS);
    case 3:
      return r.pick(STRINGS);
    case 4:
      return r.pick(UNITS);
    case 5:
      return r.pick(ENUMS);
    case 6: {
      const n = r.int(4);
      const a = [];
      for (let i = 0; i < n; i++) a.push(randomValue(r, d + 1));
      return a;
    }
    case 7: {
      const o = {};
      const n = r.int(4);
      for (let i = 0; i < n; i++) setKey(o, r.pick(KEYS), randomValue(r, d + 1));
      return o;
    }
    default:
      return [r.pick(NUMBERS), r.pick(NUMBERS)];
  }
}

/** A random slot { parent, key, path } of `v` (not the root): a random walk that stops early. */
function randomSlot(r, v, filter = null) {
  for (let attempt = 0; attempt < 20; attempt++) {
    let cur = v;
    const path = [];
    let slot = null;
    for (;;) {
      let keys;
      if (Array.isArray(cur)) keys = cur.length;
      else if (isObj(cur)) keys = Object.keys(cur);
      else break;
      const n = typeof keys === "number" ? keys : keys.length;
      if (n === 0) break;
      const key = typeof keys === "number" ? r.int(n) : keys[r.int(n)];
      path.push(key);
      slot = { parent: cur, key, path: [...path] };
      const child = cur[key];
      if (r.chance(0.3) || !(Array.isArray(child) || isObj(child))) break;
      cur = child;
    }
    if (slot !== null && (filter === null || filter(slot))) return slot;
  }
  return null;
}

/** All containers of `v` that satisfy `pred` (depth first). */
function findAll(v, pred, out = [], path = []) {
  if (pred(v, path)) out.push({ value: v, path });
  if (Array.isArray(v)) v.forEach((x, i) => findAll(x, pred, out, [...path, i]));
  else if (isObj(v)) for (const k of Object.keys(v)) findAll(v[k], pred, out, [...path, k]);
  return out;
}

const fmtPath = (p) => "/" + p.join("/");

function replace(slot, value) {
  if (Array.isArray(slot.parent)) slot.parent[slot.key] = value;
  else setKey(slot.parent, slot.key, value);
}

const OPS = {
  drop(r, p) {
    const s = randomSlot(r, p);
    if (!s) return null;
    if (Array.isArray(s.parent)) s.parent.splice(s.key, 1);
    else delete s.parent[s.key];
    return `drop ${fmtPath(s.path)}`;
  },
  duplicate(r, p) {
    const arrays = findAll(p, (v) => Array.isArray(v) && v.length > 0);
    if (arrays.length === 0) return null;
    const { value: a, path } = r.pick(arrays);
    const i = r.int(a.length);
    a.splice(r.int(a.length + 1), 0, clone(a[i]));
    return `duplicate ${fmtPath([...path, i])}`;
  },
  copyProp(r, p) {
    const objs = findAll(p, (v) => isObj(v) && Object.keys(v).length > 0);
    if (objs.length === 0) return null;
    const from = r.pick(objs);
    const k = r.pick(Object.keys(from.value));
    const to = r.pick(findAll(p, isObj));
    setKey(to.value, k, clone(from.value[k]));
    return `copy ${fmtPath([...from.path, k])} to ${fmtPath(to.path)}`;
  },
  retype(r, p) {
    const s = randomSlot(r, p);
    if (!s) return null;
    const v = s.parent[s.key];
    let nv;
    if (typeof v === "number") nv = r.pick([String(v), `${v}px`, v !== 0, null, [v], { v }]);
    else if (typeof v === "string") nv = r.pick([Number(v) || 1, [v], null, true, { [v]: v }]);
    else if (typeof v === "boolean") nv = r.pick([String(v), v ? 1 : 0, null, [v]]);
    else if (v === null) nv = r.pick([0, "", false, [], {}]);
    else if (Array.isArray(v)) nv = r.pick([Object.fromEntries(v.map((x, i) => [String(i), x])), v[0] ?? null, null, "[]", v.length]);
    else nv = r.pick([Object.values(v), null, "{}", Object.keys(v).length, Object.keys(v)]);
    replace(s, nv);
    return `retype ${fmtPath(s.path)}`;
  },
  randomValue(r, p) {
    const s = randomSlot(r, p);
    if (!s) return null;
    replace(s, randomValue(r));
    return `random ${fmtPath(s.path)}`;
  },
  insert(r, p) {
    const containers = findAll(p, (v) => isObj(v) || Array.isArray(v));
    const { value: c, path } = r.pick(containers);
    const v = randomValue(r);
    if (Array.isArray(c)) {
      const i = r.int(c.length + 1);
      c.splice(i, 0, v);
      return `insert ${fmtPath([...path, i])}`;
    }
    const k = r.pick(KEYS);
    setKey(c, k, v);
    return `insert ${fmtPath([...path, k])}`;
  },
  rename(r, p) {
    const objs = findAll(p, (v) => isObj(v) && Object.keys(v).length > 0);
    if (objs.length === 0) return null;
    const { value: o, path } = r.pick(objs);
    const k = r.pick(Object.keys(o));
    const nk = r.pick([k + "s", k.toUpperCase(), k.slice(1), k.slice(0, -1), ` ${k}`, r.pick(KEYS)]);
    const v = o[k];
    delete o[k];
    setKey(o, nk, v);
    return `rename ${fmtPath([...path, k])} to ${nk}`;
  },
  units(r, p) {
    const s = randomSlot(r, p, (s) => typeof s.parent[s.key] === "number" || typeof s.parent[s.key] === "string");
    if (!s) return null;
    replace(s, r.pick(UNITS));
    return `unit ${fmtPath(s.path)}`;
  },
  numbers(r, p) {
    const s = randomSlot(r, p, (s) => typeof s.parent[s.key] === "number");
    if (!s) return null;
    replace(s, r.pick(NUMBERS));
    return `number ${fmtPath(s.path)}`;
  },
  strings(r, p) {
    const s = randomSlot(r, p, (s) => typeof s.parent[s.key] === "string");
    if (!s) return null;
    replace(s, r.chance(0.5) ? r.pick(STRINGS) : r.pick(ENUMS));
    return `string ${fmtPath(s.path)}`;
  },
  deep(r, p) {
    const s = randomSlot(r, p);
    if (!s) return null;
    let v = s.parent[s.key];
    const n = 1 + r.int(r.chance(0.2) ? 80 : 12);
    for (let i = 0; i < n; i++) v = r.chance(0.5) ? [v] : { [r.pick(["x", "a", "items", "type", "shape"])]: v };
    replace(s, v);
    return `nest ${fmtPath(s.path)} ${n}x`;
  },
  discriminator(r, p) {
    const objs = findAll(p, (v) => isObj(v) && ("type" in v || "shape" in v));
    if (objs.length === 0) return null;
    const { value: o, path } = r.pick(objs);
    const k = "type" in o && (!("shape" in o) || r.chance(0.5)) ? "type" : "shape";
    o[k] = r.pick(DISCRIMINATORS);
    return `discriminator ${fmtPath([...path, k])}`;
  },
  arrayLength(r, p) {
    const arrays = findAll(p, (v) => Array.isArray(v) && v.length > 0);
    if (arrays.length === 0) return null;
    const { value: a, path } = r.pick(arrays);
    if (r.chance(0.6)) a.length = r.int(a.length);
    else for (let i = 0, n = 1 + r.int(3); i < n; i++) a.push(clone(a[r.int(a.length)]));
    return `length ${fmtPath(path)} ${a.length}`;
  },
  pattern(r, p) {
    // a string from the patterns' alphabets in a field (or key) the schema checks with a pattern
    if (!isObj(p)) return null;
    const slot = r.int(PATTERN_SLOTS);
    const s = patternString(r);
    placePattern(r, p, slot, s);
    return `pattern ${slot} ${JSON.stringify(s)}`;
  },
  semantic(r, p) {
    // inputs for the semantic checks: ids, keep_with, polygons, line anchors, y_axis, classes
    if (!isObj(p)) return null;
    if (!Array.isArray(p.items)) p.items = [];
    const items = p.items;
    const label = { type: "text", text: "A" };
    const anchor = { type: "point", x: 1, y: 2 };
    const id = () => r.pick(["a", "b", "z", "0", "1", "2", "w0", "", "😀"]);
    const kind = r.int(7);
    switch (kind) {
      case 0:
        items.push({
          id: id(),
          anchor: {
            type: "area",
            polygon: r.pick([
              [[0, 0], [1, 1], [2, 2]],
              [[0, 0], [0, 0], [0, 0]],
              [[0, 0], [1, 0], [1, 1e-13]],
              [[0, 0], [1, 0], [0, 1]],
              [[0, 0], ["x", 1], [1, 1], [2, 2]],
              [[0, 0], [1e308, 1e308], [-1e308, 1e308]],
              [[1, 1], [2, 2], [3, 3], [4, 4]],
              [[0, 0], [1, 0]],
              [[0, 0, 5], [1, 0], {}, [1, 1]],
            ]),
          },
          label,
        });
        break;
      case 1:
        items.push({ id: id(), keep_with: r.pick([[id(), id()], id(), [1, id()], null]), anchor, label });
        break;
      case 2: {
        const sized = { type: r.pick(["icon", "box"]), width: 2, height: 2, shape: r.pick(["polygon", "rect", "rounded:1"]) };
        if (r.chance(0.3)) sized.polygon = r.pick([[[0, 0], [1, 0], [0, 1]], null]);
        items.push({ anchor, label: r.chance(0.5) ? sized : { type: "composite", parts: [label, sized, sized] } });
        break;
      }
      case 3:
        p.y_axis = r.pick(["up", "down", "UP"]);
        if (r.chance(0.5)) delete p.canvas;
        else if (r.chance(0.5)) p.canvas = null;
        if (r.chance(0.3)) p.obstacles = { [r.pick(["svg", "raster", "vector"])]: r.pick([null, {}, []]) };
        break;
      case 4:
        items.push({ anchor: { type: "line", x: "1", mark: { shape: "nope" }, points: [[0, 0]] }, label: r.pick([label, {}]) });
        break;
      case 5:
        for (let i = 0, n = 1 + r.int(4); i < n; i++) items.splice(r.int(items.length + 1), 0, r.chance(0.5) ? { anchor, label } : { id: id(), anchor, label });
        break;
      default: {
        const cls = () => r.pick(["points", "lines", "areas", "axes", "text", "ink", "foo", "Foo", "a.b", "ignore", "*", "own_mark", "busy"]);
        p.avoid = { label: { [cls()]: 1, [cls()]: "hard" }, leader: { [cls()]: 0.5 }, buffer: { [cls()]: 1 }, relaxable: [cls(), cls()] };
        if (r.chance(0.5)) p.preset = r.pick(["map", "graph", "illustration", "none", "scatter", "bogus"]);
        if (r.chance(0.5)) p.obstacles = { svg: r.pick([{ source: "<svg/>" }, [{ source: "<svg/>", classes: [{ selector: "a", class: cls() }] }], [1]]) };
      }
    }
    return `semantic ${kind}`;
  },
  expr(r, p) {
    if (!isObj(p)) return null;
    if (!isObj(p.priority)) p.priority = {};
    const pr = p.priority;
    const which = r.int(3);
    const e = r.pick(EXPRS);
    if (which === 0) {
      if (!Array.isArray(pr.tiers)) pr.tiers = [];
      pr.tiers.push({ where: e, tier: r.int(3) });
      return `expr /priority/tiers/${pr.tiers.length - 1}/where`;
    }
    if (which === 1) {
      if (!Array.isArray(pr.terms)) pr.terms = [];
      pr.terms.push({ expr: e });
      return `expr /priority/terms/${pr.terms.length - 1}/expr`;
    }
    pr.coverage = { by: e };
    return "expr /priority/coverage/by";
  },
};
const OP_NAMES = Object.keys(OPS);

const KITCHEN_SINK = {
  $schema: "https://label-anything.dev/schema/problem.v1.json",
  version: "1",
  canvas: { width: 400, height: 300, padding: "2pt", allow_outside: false, device_pixel_ratio: 2, region: [10, 10, 380, 280] },
  y_axis: "down",
  transform: [1, 0, 0, 1, 0, 0],
  preset: "scatter",
  defaults: {
    font: { family: "default", size: 11, weight: "normal", style: "italic", line_height: 1.25, file: null },
    padding: "0.2em",
    buffer: 2,
    mark: { shape: "rect", w: 4, h: 4, corner_radius: 1, rotation: 15 },
    wrap: { max_width: "10em", max_lines: 2, balance: true },
    truncate: "end",
  },
  text: { shaping: "simple" },
  items: [
    {
      id: "p",
      anchor: { type: "point", x: 10, y: 20, mark: { shape: "ellipse", rx: 3, ry: 2, rotation: 10 } },
      label: { type: "text", text: "Pea", alternatives: ["P"], wrap: null, truncate: "middle", font: { size: 10, weight: 700 }, padding: 1, align: "center" },
      attrs: { a: 1, b: [1, 2], c: { d: "e" } },
      priority: 3,
      tier: 1,
      required: true,
      group: null,
      keep_with: ["q"],
      svg_id: "dot1",
      placement: { models: ["adjacent", "distant"], offset: "1px", internal: "never", position_order: ["top", "right"] },
    },
    {
      id: "q",
      anchor: { type: "point", x: 30, y: 40, mark: { shape: "polygon", points: [[0, 0], [4, 0], [2, 3]], holes: [], relative: true } },
      label: { type: "text", width: 20, height: 10, lines: ["a", "b"] },
      group: "g1",
      keep_with: "set",
    },
    {
      id: "r",
      anchor: { type: "point", x: 50, y: 60, mark: { shape: "path", d: "M0 0 L 4 4", relative: true } },
      label: { type: "icon", width: 8, height: 8, shape: "rounded:2", padding: "1px", font: { size: 9 } },
    },
    {
      id: "s",
      anchor: { type: "point", x: 70, y: 80, mark: { shape: "icon", w: 8, h: 10, tip: [4, 10], silhouette: [[0, 0], [8, 0], [4, 10]] } },
      label: { type: "box", width: 6, height: 6, shape: "polygon", polygon: [[0, 0], [6, 0], [3, 6]] },
    },
    {
      id: "t",
      anchor: { type: "point", x: 90, y: 100, mark: { shape: "from_svg", selector: "#dot" } },
      label: {
        type: "composite",
        direction: "row",
        gap: "2px",
        align: "end",
        padding: 1,
        font: { size: 10 },
        parts: [{ type: "text", text: "A" }, { type: "icon", width: 4, height: 4, shape: "circle" }],
      },
    },
    {
      id: "u",
      anchor: { type: "area", polygon: [[100, 100], [140, 100], [140, 140], [100, 140]], holes: [[[110, 110], [120, 110], [120, 120]]], dot: { shape: "circle", r: 2 } },
      label: { type: "text", text: "Area" },
    },
    { id: "v", anchor: { type: "point", x: 5, y: 5, mark: { shape: "from_svg", svg_id: "dot2" } }, label: { type: "text", text: "V" } },
  ],
  obstacles: {
    vector: [
      { class: "points", points: [[1, 2], [3, 4]], r: 1.5 },
      { class: "lines", polylines: [[[0, 0], [10, 10]]], width: 2 },
      { class: "areas", polygons: [[[0, 0], [5, 0], [5, 5]]], fill_rule: "evenodd" },
      { class: "boxes", rects: [[1, 1, 2, 2]], circles: [[5, 5, 1]] },
      { class: "shapes", shapes: [{ shape: "circle", r: 2, x: 3, y: 4 }, { shape: "rect", w: 2, h: 3, x: 10, y: 10 }] },
    ],
    svg: [
      {
        source: "<svg xmlns='http://www.w3.org/2000/svg'/>",
        classes: [{ selector: "circle", class: "points" }, { selector: "text", class: "ignore" }],
        default_class: "ink",
        auto_mark_items: true,
        tolerance: 0.5,
      },
      { path: "bg.svg", default_class: "ignore" },
    ],
    raster: [
      { rgba: { width: 1, height: 1, data: "AAAAAA==" }, mode: "ink", class: "ink", ink: { background: "#ffffff", threshold: 0.2, dilate: 2 }, scale: 1, offset: [0, 0] },
      { source: "data:image/png;base64,AAAA", mode: "classmap", classmap: { "#000": "lines", "#ff0000": "water" }, classmap_tolerance: 0.1, unmatched: "ignore" },
      { source: "x.png", mode: "alpha", alpha: { threshold: 0.5 } },
      { source: "y.png", mode: "cost", cost: { invert: true } },
      { source: "z.png", mode: "saliency", class: "busy" },
    ],
  },
  avoid: {
    label: { points: 0.5, lines: "hard", ink: "ignore", own_mark: "partial:0.25", "*": 1, water: 2, busy: 0.1 },
    leader: { leaders: "hard", "*": 0.3, areas: 1 },
    buffer: { items: 1, boxes: 0.5 },
    relaxable: ["points", "ink"],
  },
  placement: {
    models: ["adjacent", "slider", "internal", "distant", "boundary"],
    position_order: "cartographic",
    offset: 2,
    max_distance: "8em",
    min_distance: "1em",
    slider_per_quadrant: 3,
    k_distant: 10,
    distant_rings: 2,
    distant_directions: 8,
    free_space_seeds: false,
    internal: "allow",
    inner_padding: "1px",
    internal_circle_ratio: 1.2,
    prune_factor: 2,
    boundary: { sides: ["left", "top"], align: "spread", gap: 1, margin: "2px" },
  },
  leaders: { style: "orthogonal", angles: [0, 90], port: "baseline", attach: "center", min_length: 4, max_length: "6em", anchor_gap: 1, clearance: 2, min_angle_between: 15, width: 1.5 },
  priority: {
    terms: [
      { builtin: "outlierness", k: 3, weight: 2, normalize: "minmax", transform: "log1p" },
      { attr: "a", normalize: "none", transform: "neg" },
      { expr: "attrs.a * 2", weight: 0.5 },
    ],
    tiers: [{ where: "attrs.a > 0", tier: 2 }],
    omission: "weighted",
    coverage: { by: "attrs.c.d", min_per_group: 1 },
    ties: "random(7)",
    band: 0.5,
    budget: { max_labels: 5, max_ink_fraction: 0.4 },
    focus: [100, 100],
  },
  solver: { strategy: "local", time_budget_ms: 50, max_iterations: 1000, seed: 42, grid_cell: 4 },
  degrade: ["alternatives", "wrap", "truncate", "shrink:0.8", "distant", "boundary", "evict_lower", "soft_overlap", "omit"],
  degrade_options: { min_scale: 0.5, wrap_max_lines: 3, soft_overlap_weight: 5 },
  weights: { position: 1, distance: 1, leader: 1, leader_length: 1, bends: 1, shape: 1, edge: 1, ambiguity: 1, lookahead: 1, starve: 1, stability: 1 },
  warm_start: { placements: [{ id: "p", placed: true, box: { x: 1, y: 2, w: 3, h: 4 } }] },
  output: { debug_svg: true, cost_breakdown: true, candidates: true, item_shape: true },
};

const ILLUSTRATION = {
  preset: "illustration",
  y_axis: "up",
  items: [{ anchor: { type: "point", x: 1, y: 2, mark: { shape: "circle", r: 3 } }, label: { type: "text", text: "x" } }],
  obstacles: { svg: { source: "<svg/>" }, raster: { source: "a.png", mode: "ink" } },
  avoid: { label: { text: "hard", ink: 2, "*": 1 }, leader: { ink: 0.1 }, relaxable: ["ink"] },
  priority: { coverage: null, budget: { max_labels: null, max_ink_fraction: null }, focus: null },
  canvas: { width: 10, height: 10, region: null },
  warm_start: null,
};

/**
 * Base problems: the sample problems (long arrays cut to 12 entries), synthetic ones and,
 * with `withCases`, the (mostly invalid) inline problems of the validate cases.
 */
function baseProblems(withCases = true) {
  const cut = (v) => {
    if (Array.isArray(v)) return v.slice(0, 12).map(cut);
    if (isObj(v)) {
      const o = {};
      for (const k of Object.keys(v)) setKey(o, k, cut(v[k]));
      return o;
    }
    return v;
  };
  const out = [];
  for (const f of jsonFiles(join(conf, "problems"))) out.push([f, cut(readJson(join(conf, "problems", f)))]);
  out.push(["kitchen-sink", KITCHEN_SINK], ["illustration-up", ILLUSTRATION]);
  if (!withCases) return out;
  for (const f of jsonFiles(join(conf, "validate"))) {
    const c = readJson(join(conf, "validate", f));
    if (c.kind === "validate" && "problem" in c) out.push([`case:${f}`, c.problem]);
  }
  return out;
}

/** Deterministic value mutants: [{ name, problem }]. */
function valueMutants(seed, count, withCases = true) {
  const r = makeRng(seed);
  const bases = baseProblems(withCases);
  const out = [];
  while (out.length < count) {
    const [name, base] = r.pick(bases);
    const p = clone(base);
    const steps = [];
    for (let i = 0, n = 1 + r.int(r.chance(0.3) ? 6 : 3); i < n; i++) {
      const d = OPS[r.pick(OP_NAMES)](r, p);
      if (d !== null) steps.push(d);
    }
    // serde_json's recursion limit is 128 levels (the oracle's batch array adds one); Rust
    // strings cannot hold lone surrogates
    if (steps.length === 0 || depth(p) > 100 || !wellFormed(p)) continue;
    out.push({ name: `${name} #${out.length}: ${steps.join("; ")}`, problem: p });
  }
  return out;
}

const TEXT_SNIPPETS = ["{", "}", "[", "]", ",", ":", '"', "\\", "u", "e", "E", "-", "+", ".", "0", "9", " ", "\n", "\t", "\r",
  "\u0001", "\u001f", "é", "😀", "\\u12", "\\ud800", "\\udc00", "\\ud83d\\ude00", "\\uD83D", "\\x", "tru", "nul", "fals", "true",
  "1e400", "1e9999999999", "-0", "01", "1.", ".5", "1e", "1e+", "18446744073709551616", "1" + "0".repeat(400), "0.0e99999999999",
  "﻿", "/*", "NaN", "Infinity", "'", "}{", ",,", " ", "[".repeat(130), "{\"a\":".repeat(130)];

/** Deterministic text mutants: [{ name, text }] (JSON texts for validate_str). */
function textMutants(seed, count, valueMuts) {
  const r = makeRng(seed ^ 0x9e3779b9);
  const out = [];
  while (out.length < count) {
    const m = r.pick(valueMuts);
    let t = r.chance(0.5) ? JSON.stringify(m.problem) : JSON.stringify(m.problem, null, r.chance(0.5) ? 2 : "\t");
    if (t.length > 20000) continue;
    const steps = [];
    for (let i = 0, n = r.int(4); i < n; i++) {
      const at = r.int(t.length + 1);
      switch (r.int(6)) {
        case 0:
          t = t.slice(0, at);
          steps.push(`cut ${at}`);
          break;
        case 1:
          t = t.slice(0, at) + t.slice(at + 1 + r.int(3));
          steps.push(`delete ${at}`);
          break;
        case 2:
        case 3: {
          const s = r.pick(TEXT_SNIPPETS);
          t = t.slice(0, at) + s + t.slice(at);
          steps.push(`insert ${JSON.stringify(s.length > 12 ? s.slice(0, 12) + "…" : s)} at ${at}`);
          break;
        }
        case 4: {
          // replace a number literal
          const nums = [...t.matchAll(/-?\d+(\.\d+)?([eE][+-]?\d+)?/g)];
          if (nums.length === 0) break;
          const n = r.pick(nums);
          const s = r.pick(["1e400", "-1e400", "1e-400", "1e9999999999", "1.5e-99999999999", "18446744073709551616", "-9223372036854775809",
            "0.1e1", "1E+2", "123456789012345678901234567890", "0.30000000000000004", "-0.0", "2.0000000000000001", "4294967295.0000001"]);
          t = t.slice(0, n.index) + s + t.slice(n.index + n[0].length);
          steps.push(`number ${s}`);
          break;
        }
        default:
          t = r.chance(0.5) ? `${t} ${r.pick(["x", "{}", "1", "//"])}` : `\n\n ${t}`;
          steps.push("frame");
      }
    }
    if (!t.isWellFormed()) continue;
    out.push({ name: `text #${out.length} of ${m.name.split(":")[0]}: ${steps.join("; ") || "unchanged"}`, text: t });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/** The committed regression sample: small value and text mutants (fixed seed). */
/**
 * The committed regression sample: small value and text mutants (fixed seed) with their
 * Rust reports; the first small mutant with each issue code, then every k-th one.
 */
function mutantSample() {
  // valid bases only, so that new validate cases do not change the sample
  const allValues = valueMutants(MUTANT_SEED, 3000, false);
  const allTexts = textMutants(MUTANT_SEED, 1500, allValues);
  const choose = (list, reports, n) => {
    const chosen = new Set();
    const codes = [...new Set(reports.flatMap((r) => [...r.errors, ...r.warnings].map((e) => e.code)))].sort();
    for (const code of codes) {
      const k = reports.findIndex((r) => [...r.errors, ...r.warnings].some((e) => e.code === code));
      chosen.add(k);
    }
    const step = Math.max(1, Math.floor(list.length / n));
    for (let k = 0; k < list.length && chosen.size < n; k += step) chosen.add(k);
    return [...chosen].sort((a, b) => a - b).map((k) => [list[k], reports[k]]);
  };
  const values = allValues.filter((m) => JSON.stringify(m).length <= 800);
  const texts = allTexts.filter((m) => JSON.stringify(m).length <= 600);
  return {
    values: choose(values, rustReports(values.map((m) => m.problem)), 200),
    texts: choose(texts, rustReports(texts.map((m) => m.text), { text: true }), 60),
  };
}

function cmdMutants(check) {
  const { values, texts } = mutantSample();
  const doc = {
    about:
      "Regression sample of the differential fuzzing (tools/validate/parity.mjs, seed " +
      MUTANT_SEED +
      "): mutated problems (validate) and mutated JSON texts (validate_str) with the Rust reports. " +
      "The TypeScript validator must reproduce them exactly. Regenerate: node tools/validate/parity.mjs mutants. " +
      "Checked by cargo test -p label-anything-core --test validate_reports and ts/packages/core/test/validate-fuzz.test.ts.",
  };
  const cases = [
    ...values.map(([m, report]) => ({ name: m.name, problem: m.problem, report })),
    ...texts.map(([m, report]) => ({ name: m.name, text: m.text, report })),
  ];
  // one compact case per line (deeply nested mutants would make indented JSON huge)
  const content = `{\n  "about": ${JSON.stringify(doc.about)},\n  "cases": [\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n  ]\n}\n`;
  return writeOrCheck(MUTANTS, content, check);
}

function diffReports(a, b) {
  const lines = [];
  if (a.valid !== b.valid) lines.push(`  valid: rust ${a.valid}, ts ${b.valid}`);
  for (const kind of ["errors", "warnings"]) {
    const fa = a[kind].map((e) => JSON.stringify(e));
    const fb = b[kind].map((e) => JSON.stringify(e));
    for (const e of fa) if (!fb.includes(e)) lines.push(`  ${kind} only in rust: ${e}`);
    for (const e of fb) if (!fa.includes(e)) lines.push(`  ${kind} only in ts:   ${e}`);
    if (lines.length === 0 && !isDeepStrictEqual(fa, fb)) lines.push(`  ${kind}: different order`);
  }
  return lines.join("\n");
}

async function cmdFuzz(count, textCount, seed, keep) {
  const ts = await tsValidator();
  const t0 = Date.now();
  const values = valueMutants(seed, count);
  const texts = textMutants(seed, textCount, values);
  console.log(`generated ${values.length} value mutants and ${texts.length} text mutants in ${Date.now() - t0} ms`);
  const t1 = Date.now();
  const rv = rustReports(values.map((m) => m.problem));
  const rt = rustReports(texts.map((m) => m.text), { text: true });
  console.log(`rust: ${Date.now() - t1} ms`);
  const t2 = Date.now();
  const mismatches = [];
  const stats = { valid: 0, invalid: 0, parse: 0, codes: {} };
  values.forEach((m, k) => {
    // the same data the oracle sees: the problem as JSON text, parsed again
    const tv = plain(ts.validate(JSON.parse(JSON.stringify(m.problem))));
    if (!isDeepStrictEqual(tv, rv[k])) mismatches.push({ ...m, rust: rv[k], ts: tv });
  });
  texts.forEach((m, k) => {
    const tv = plain(ts.validateStr(m.text));
    if (!isDeepStrictEqual(tv, rt[k])) mismatches.push({ ...m, rust: rt[k], ts: tv });
  });
  console.log(`ts: ${Date.now() - t2} ms`);
  // the parsed values of every text mutant and of random number literals, bit for bit
  const literals = numberTexts(seed, Math.max(1, Math.floor(textCount / 4)));
  const parsed = [...texts.map((m) => m.text), ...literals];
  const rp = rustValues(parsed);
  let valueMismatches = 0;
  parsed.forEach((t, k) => {
    let mine;
    try {
      mine = { value: ts.parseJson(t) };
    } catch (e) {
      mine = { error: e.message };
    }
    if (!sameJson(mine, rp[k])) {
      valueMismatches++;
      mismatches.push({ name: `parsed value of text ${k}`, text: t, rust: rp[k], ts: mine });
    }
  });
  console.log(`parsed values: ${parsed.length} texts (${literals.length} with random number literals), ${valueMismatches} mismatch(es)`);
  for (const r of [...rv, ...rt]) {
    if (r.valid) stats.valid++;
    else stats.invalid++;
    for (const e of [...r.errors, ...r.warnings]) stats.codes[e.code] = (stats.codes[e.code] ?? 0) + 1;
    if (r.errors[0]?.code === "parse") stats.parse++;
  }
  console.log(`reports: ${stats.valid} valid, ${stats.invalid} invalid (${stats.parse} parse errors)`);
  console.log("issue codes:", JSON.stringify(Object.fromEntries(Object.entries(stats.codes).sort())));
  if (keep) {
    // mismatches, and every value mutant with its Rust report (one JSON object per line)
    mkdirSync(keep, { recursive: true });
    writeFileSync(join(keep, "mismatches.json"), JSON.stringify(mismatches, null, 2));
    writeFileSync(join(keep, "values.jsonl"), values.map((m, k) => JSON.stringify({ name: m.name, problem: m.problem, rust: rv[k] })).join("\n") + "\n");
  }
  if (mismatches.length === 0) {
    console.log(`all ${values.length + texts.length} reports agree`);
    return true;
  }
  console.error(`${mismatches.length} mismatch(es)`);
  for (const m of mismatches.slice(0, 10)) console.error(`${m.name}\n${diffReports(m.rust, m.ts)}`);
  return false;
}

/** A problem with `items` point items and `points` obstacle points (deterministic). */
function largeProblem(items, points) {
  const r = makeRng(7);
  const w = 4000;
  const h = 3000;
  const coord = (n) => Math.round(r.next() * n * 10) / 10;
  const its = [];
  for (let i = 0; i < items; i++) {
    const it = {
      id: `item-${i}`,
      anchor: { type: "point", x: coord(w), y: coord(h) },
      label: { type: "text", text: `Label ${i}` },
      attrs: { value: r.int(1000), group: `g${i % 17}` },
    };
    if (i % 3 === 0) it.anchor.mark = { shape: "circle", r: 1 + r.int(4) };
    if (i % 5 === 0) it.priority = r.int(100);
    if (i % 7 === 0) it.label.font = { size: 10 + r.int(4), weight: "bold" };
    its.push(it);
  }
  const pts = [];
  for (let i = 0; i < points; i++) pts.push([coord(w), coord(h)]);
  return {
    canvas: { width: w, height: h, padding: "0.5em" },
    preset: "scatter",
    items: its,
    obstacles: {
      vector: [
        { class: "points", points: pts.slice(0, points / 2), r: 1.5 },
        { class: "points", points: pts.slice(points / 2) },
        { class: "lines", polylines: [[[0, 0], [w, h]], [[0, h], [w, 0]]], width: 1 },
      ],
    },
    avoid: { label: { points: 0.3, lines: 1 } },
    priority: { terms: [{ attr: "value" }], tiers: [{ where: "attrs.value > 900", tier: 1 }], coverage: { by: "attrs.group" } },
  };
}

/** Every pattern slot with `count` random strings: TS and Rust must agree on every report. */
async function cmdPatterns(count, seed) {
  const ts = await tsValidator();
  const r = makeRng(seed ^ 0x2545f491);
  const problems = [];
  const names = [];
  for (let slot = 0; slot < PATTERN_SLOTS; slot++) {
    for (let i = 0; i < count; i++) {
      const p = { items: [] };
      const s = patternString(r);
      placePattern(r, p, slot, s);
      problems.push(p);
      names.push(`slot ${slot}: ${JSON.stringify(s)}`);
    }
  }
  const rust = rustReports(problems);
  let bad = 0;
  let matches = 0;
  problems.forEach((p, k) => {
    const mine = plain(ts.validate(JSON.parse(JSON.stringify(p))));
    if (!isDeepStrictEqual(mine, rust[k])) {
      bad++;
      if (bad <= 10) console.error(`${names[k]}\n${diffReports(rust[k], mine)}`);
    }
    if (!rust[k].errors.some((e) => e.code === "pattern" || e.code === "unit")) matches++;
  });
  console.log(`${problems.length} strings in ${PATTERN_SLOTS} pattern slots (${matches} accepted): ${bad} mismatch(es)`);
  return bad === 0;
}

async function cmdBench(runs) {
  const ts = await tsValidator();
  const problem = largeProblem(2000, 100000);
  const text = JSON.stringify(problem);
  const median = (f) => {
    const t = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      f();
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    return t[Math.floor(t.length / 2)];
  };
  for (let i = 0; i < 5; i++) ts.validate(problem); // warm-up
  const tsValue = median(() => ts.validate(problem));
  for (let i = 0; i < 3; i++) ts.validateStr(text);
  const tsText = median(() => ts.validateStr(text));
  const report = plain(ts.validate(problem));
  oraclePath(true);
  const rs = spawnSync(oracleBin, ["--batch", "--repeat", String(runs)], { input: `[${text}]`, encoding: "utf8", maxBuffer: 1 << 30 });
  const rsText = spawnSync(oracleBin, ["--batch", "--text", "--repeat", String(runs)], {
    input: JSON.stringify([text]),
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  const ms = (out) => Number(/median ([0-9.]+) ms/.exec(out.stderr)?.[1]);
  const rustValue = ms(rs);
  const rustText = ms(rsText);
  if (!isDeepStrictEqual(JSON.parse(rs.stdout)[0], report)) throw new Error("the reports differ");
  console.log(`problem: 2000 items, 100000 obstacle points, ${(text.length / 1e6).toFixed(1)} MB of JSON; valid: ${report.valid}`);
  console.log(`validate(value):    rust ${rustValue.toFixed(2)} ms, ts ${tsValue.toFixed(2)} ms (${(tsValue / rustValue).toFixed(2)}x)`);
  console.log(`validateStr(text):  rust ${rustText.toFixed(2)} ms, ts ${tsText.toFixed(2)} ms (${(tsText / rustText).toFixed(2)}x)`);
  console.log(`(medians of ${runs} runs; rust: release build of validate_oracle; ts: node ${process.version})`);
  return true;
}

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const check = args.includes("--check");
let ok;
switch (args[0]) {
  case "reports":
    ok = cmdReports(check);
    break;
  case "mutants":
    ok = cmdMutants(check);
    break;
  case "bases": {
    // the base problems of the mutations and their Rust reports (all should be valid)
    const bases = baseProblems();
    const rs = rustReports(bases.map((b) => b[1]));
    bases.forEach(([name], k) => console.log(`${rs[k].valid ? "valid  " : "INVALID"} ${name} ${JSON.stringify(rs[k].errors)}`));
    ok = bases.every(([name], k) => name.startsWith("case:") || rs[k].valid);
    break;
  }
  case "patterns":
    ok = await cmdPatterns(Number(flag("--count", 2000)), Number(flag("--seed", 1)));
    break;
  case "bench":
    ok = await cmdBench(Number(flag("--runs", 21)));
    break;
  case "fuzz":
    ok = await cmdFuzz(Number(flag("--count", 5000)), Number(flag("--text-count", 2000)), Number(flag("--seed", 1)), flag("--keep", null));
    break;
  default:
    console.error("usage: node tools/validate/parity.mjs reports|mutants [--check] | fuzz [--count N] [--text-count M] [--seed S] [--keep DIR] | patterns [--count N] | bench [--runs N]");
    ok = false;
}
process.exit(ok ? 0 : 1);
