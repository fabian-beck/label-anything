// Differential test of the two implementations: every conformance case and a stream of
// random SVG documents (valid, invalid and truncated markup; DTD entities, namespaces,
// CSS, <use>, text, ...) must produce identical scenes, classifications and selections in
// the Rust crate `label-anything-svg` and in this package (numbers to 1e-9 relative,
// warning and error codes exactly; messages are not compared).
//
// From ts/, after building this package:
//
//   npx tsc -b packages/svg
//   node packages/svg/scripts/parity.mjs [count=2000] [seed=1]
//
// The script builds the Rust example `dump` with cargo (in ../rust). Failing documents are
// written to a temporary directory, which is printed. Exit status: 0 identical, 1 differences,
// 2 setup failure.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const rustDir = join(repo, "rust");
const conformanceDir = join(repo, "conformance/svg");
const presetDir = join(repo, "spec/presets");

const count = Number(process.argv[2] ?? 2000);
const seed = Number(process.argv[3] ?? 1);
const REL = 1e-9;

function die(message) {
  console.error(message);
  process.exit(2);
}

let api;
try {
  api = await import(pathToFileURL(join(here, "../dist/index.js")).href);
} catch (e) {
  die(`cannot load ../dist/index.js (run \`npx tsc -b packages/svg\` from ts/ first): ${e}`);
}

// ---------------------------------------------------------------------------------------
// Random documents

/** Seeded PRNG (mulberry32) with Python-style helpers. */
function rng(s) {
  let state = s >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    random,
    chance: (p) => random() < p,
    int: (a, b) => a + Math.floor(random() * (b - a + 1)),
    uniform: (a, b) => a + (b - a) * random(),
    choice: (xs) => xs[Math.floor(random() * xs.length)],
  };
}

function generator(R) {
  // Document-level features that markup generated later may rely on.
  let dtd = false;
  let xlink = true;
  let inkscape = false;

  const num = () => {
    const c = R.random();
    if (c < 0.5) return String(R.int(-50, 300));
    if (c < 0.8) return R.uniform(-100, 400).toFixed(3);
    return R.choice(["0", "-0", ".5", "1.", "1e2", "2E-1", "+3", "-.25", "1e", "007", "1.5.5", "3e+1", "-0.0", "1e-3", ".5.5"]);
  };

  const length = () => {
    if (R.chance(0.03)) return R.choice(["auto", "", "  12  ", "-5", "1e400", "inherit"]);
    const v = R.chance(0.7) ? String(R.int(1, 120)) : num().replace(/^\+/, "");
    const u = R.choice(["", "", "", "px", "pt", "em", "%", "mm", "in", "ex", "rem", "pc", "cm", "PX", "foo"]);
    return v + (R.chance(0.3) ? u : "");
  };

  const color = () =>
    R.choice([
      "red", "none", "transparent", "#123", "#1234", "#123456", "#12345678", "#12", "rgb(1,2,3)",
      "rgba(1,2,3,0)", "rgba(1,2,3,0.5)", "rgb(1 2 3 / 0%)", "hsl(10 20% 30% / .4)", "hsla(10,20%,30%,0)",
      "currentColor", "url(#g1)", "url(#nope)", "url(#nope) blue", "url('#g1') none", "bogus", "inherit",
      "initial", "unset", "context-fill", "RED", "  blue  ", "rgb(10%, 20%, 300%)", "#ABCDEF00",
    ]);

  const transform = () => {
    const parts = [];
    for (let i = R.int(1, 3); i > 0; i--) {
      const k = R.choice(["translate", "scale", "rotate", "skewX", "skewY", "matrix", "bogus"]);
      let n = { translate: R.int(1, 2), scale: R.int(1, 2), rotate: R.choice([1, 3]), skewX: 1, skewY: 1, matrix: 6, bogus: 2 }[k];
      if (R.chance(0.05)) n += 1;
      const args = [];
      for (let j = 0; j < n; j++) {
        const v = k === "scale" || k === "matrix" ? R.uniform(-2, 2) : R.uniform(-60, 60);
        args.push(String(Math.round(v * 1000) / 1000));
      }
      parts.push(`${k}(${R.choice(["", " ", ", "])}${args.join(R.choice([",", " ", " , "]))})`);
    }
    return parts.join(R.choice([" ", ",", " , ", ""]));
  };

  const pathData = () => {
    const cmds = [];
    if (R.chance(0.95)) cmds.push(`${R.choice("Mm")} ${num()} ${num()}`);
    for (let i = R.int(1, 8); i > 0; i--) {
      const c = R.choice("MmLlHhVvCcSsQqTtAaZz");
      const C = c.toUpperCase();
      const n = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }[C];
      const args = [];
      for (let k = 0; k < n; k++) {
        if (C === "A" && (k === 3 || k === 4)) args.push(R.choice(["0", "1", "1", "0", "2"]));
        else if (C === "A" && k < 2) args.push(String(R.int(0, 80)));
        else args.push(num());
      }
      const sep = R.choice([" ", ",", ""]);
      let s = sep === "" ? c + args.join(" ") : `${c} ${args.join(sep)}`;
      if (n && R.chance(0.2)) s += " " + Array.from({ length: n }, () => num()).join(" ");
      cmds.push(s);
    }
    return cmds.join(R.choice([" ", "", "\n"]));
  };

  const PROPS = [
    ["fill", color],
    ["stroke", color],
    ["stroke-width", length],
    ["opacity", () => R.choice(["0", "0.5", "1", "50%", "2", "-1"])],
    ["fill-opacity", () => R.choice(["0", "0.3", "1", "0%"])],
    ["stroke-opacity", () => R.choice(["0", "1"])],
    ["display", () => R.choice(["none", "inline", "block", "bogus!", "inherit"])],
    ["visibility", () => R.choice(["hidden", "visible", "collapse", "x", "inherit"])],
    ["fill-rule", () => R.choice(["evenodd", "nonzero", "x"])],
    ["font-size", () => R.choice([length(), "small", "x-large", "larger", "smaller", "150%"])],
    ["font-family", () => R.choice(["Arial", "'Open Sans', arial", "DejaVu Sans, sans-serif", "serif"])],
    ["font-weight", () => R.choice(["bold", "normal", "bolder", "lighter", "300", "950", "x"])],
    ["text-anchor", () => R.choice(["start", "middle", "end", "x"])],
    ["dominant-baseline", () => R.choice(["middle", "hanging", "central", "text-bottom", "text-top", "auto", "x"])],
    ["vector-effect", () => R.choice(["non-scaling-stroke", "none"])],
    ["font", () => R.choice(["bold 12px Arial", "10px/1.2 'DejaVu Sans'", "italic 2em sans-serif", "x", "caption", "900 8pt serif"])],
    ["transform", transform],
  ];

  const styleDecls = () => {
    const out = [];
    for (let i = R.int(1, 4); i > 0; i--) {
      const [p, f] = R.choice(PROPS);
      out.push(`${p}: ${f()}${R.chance(0.1) ? " !important" : ""}`);
    }
    return out.join(R.choice(["; ", ";", " ; "])) + (R.chance(0.2) ? ";" : "");
  };

  // Escapes text for a double-quoted attribute value.
  const attrText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  const GEOMETRY = {
    rect: ["x", "y", "width", "height", "rx", "ry"],
    circle: ["cx", "cy", "r"],
    ellipse: ["cx", "cy", "rx", "ry"],
    line: ["x1", "y1", "x2", "y2"],
    image: ["x", "y", "width", "height"],
    use: ["x", "y", "width", "height"],
    svg: ["x", "y", "width", "height"],
    symbol: ["x", "y", "width", "height"],
    foreignObject: ["x", "y", "width", "height"],
    text: ["x", "y", "dx", "dy"],
    tspan: ["x", "y", "dx", "dy"],
  };

  const attrs = (tag) => {
    const a = new Map(); // name -> value (as written, i.e. already escaped)
    const set = (name, value) => a.set(name, value);
    for (const g of GEOMETRY[tag] ?? []) {
      if (R.chance(0.8)) set(g, length());
    }
    if (tag === "polyline" || tag === "polygon") {
      const pts = Array.from({ length: R.int(0, 6) }, () => num() + R.choice([",", " ", " , "]) + num());
      set("points", pts.join(R.choice([" ", ",", "\n"])));
    }
    if (tag === "path") set("d", pathData());
    if ((tag === "svg" || tag === "symbol") && R.chance(0.6)) {
      set("viewBox", `${R.int(-20, 20)}${R.choice([" ", ","])}${R.int(-20, 20)} ${R.int(0, 200)} ${R.int(1, 200)}`);
      if (R.chance(0.5)) {
        set("preserveAspectRatio", R.choice(["none", "xMinYMin", "xMaxYMax slice", "xMidYMid meet", "defer xMinYMax", "bogus", "xMinYMid  slice"]));
      }
    }
    if (tag === "text" || tag === "tspan") {
      if (R.chance(0.2)) set("text-anchor", R.choice(["middle", "end", "start"]));
      if (R.chance(0.1)) set("font-size", length());
      if (R.chance(0.1)) set(R.choice(["x", "y", "dx", "dy"]), `${num()} ${num()}`);
    }
    if (R.chance(0.4)) set("transform", transform());
    for (const [p, f] of [["fill", color], ["stroke", color], ["stroke-width", length]]) {
      if (R.chance(0.3)) set(p, f());
    }
    if (R.chance(0.3)) set("style", attrText(styleDecls()));
    if (R.chance(0.3)) set("class", R.choice(["a", "b", "a b", "point", "c", " a\tb ", "a&#x20;c", "A", dtd ? "&e1;" : "a"]));
    if (R.chance(0.3)) set("id", `e${R.int(0, 30)}`);
    if (R.chance(0.1)) set("data-k", R.choice(["1", "2", "", "1 2"]));
    if (R.chance(0.05)) set("xml:space", R.choice(["preserve", "default"]));
    if (R.chance(0.05)) set(...R.choice([["display", "none"], ["visibility", "hidden"], ["opacity", "0"], ["fill-opacity", "0"]]));
    if (R.chance(0.05)) {
      set(...R.choice([["systemLanguage", "en"], ["systemLanguage", "fr, de"], ["systemLanguage", "en-US"], ["requiredExtensions", "urn:x"], ["requiredFeatures", "http://www.w3.org/TR/SVG11/feature#Extensibility"]]));
    }
    if (R.chance(0.03)) set(...R.choice([[inkscape ? "inkscape:label" : "label", "L"], ["xml:lang", "en"], ["xmlns:x", "urn:x"]]));
    return Array.from(a, ([k, v]) => `${k}="${v}"`).join(R.choice([" ", "\n  ", "\t"]));
  };

  const SHAPES = ["rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "image"];
  const TEXTS = ["Hello", " a  b ", "x\ny", "&amp;", "&#x41;", "  ", "Ünïcødé", "😀z", "\t", "&lt;&gt;", "&#128512;", "a\r\nb", "c\rd", "Ab12"];

  const text = (depth) => {
    const parts = [`<text ${attrs("text")}>`];
    for (let i = R.int(1, 4); i > 0; i--) {
      const c = R.random();
      if (c < 0.5) parts.push(dtd && R.chance(0.1) ? "&e1;" : R.choice(TEXTS));
      else if (c < 0.85 && depth < 4) parts.push(`<tspan ${attrs("tspan")}>${R.choice(["ab", " c ", "", "dd", "&#x20;e"])}</tspan>`);
      else if (c < 0.92) parts.push("<![CDATA[<x>]]>");
      else parts.push(R.choice(["<!-- c -->", "<?pi data?>", "<title>t</title>"]));
    }
    parts.push("</text>");
    return parts.join("");
  };

  const element = (depth) => {
    const c = R.random();
    if (depth > 5 || c < 0.55) {
      const t = R.choice(SHAPES);
      return `<${t} ${attrs(t)}/>`;
    }
    if (c < 0.65) return text(depth);
    if (c < 0.75) {
      const href = xlink && R.chance(0.5) ? "xlink:href" : "href";
      return `<use ${attrs("use")} ${href}="${R.choice(["#", "#", "#", "", "other.svg#", " #"])}e${R.int(0, 30)}"/>`;
    }
    if (c < 0.8) {
      return R.choice([
        "<!-- comment -->",
        "<?pi x?>",
        "<title>T</title>",
        "<desc>D <b>x</b></desc>",
        '<svg:rect xmlns:svg="http://www.w3.org/2000/svg" width="5" height="6"/>',
        '<x:g xmlns:x="urn:x"><rect width="3" height="3"/></x:g>',
        '<g xmlns="urn:other"><rect width="4" height="4"/></g>',
        `<foreignObject ${attrs("foreignObject")}><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>`,
        dtd ? "&e2;" : "&amp;",
        dtd ? "<g>&e3;</g>" : "<g/>",
        "<marker><rect width='9' height='9'/></marker>",
        "<clipPath id='c1'><rect width='9' height='9'/></clipPath>",
        "<pattern id='p'><rect width='9' height='9'/></pattern>",
      ]);
    }
    const tag = R.choice(["g", "g", "g", "svg", "a", "switch", "switch", "defs", "symbol", "clipPath", "mask", "foo", "linearGradient"]);
    const kids = Array.from({ length: R.int(0, 4) }, () => element(depth + 1)).join(R.choice(["", "\n", " "]));
    return `<${tag} ${attrs(tag)}>${kids}</${tag}>`;
  };

  const css = () => {
    const sels = [
      "rect", ".a", "#e1", "g > circle", "g .b", "[data-k=1]", "[data-k]", "*", "circle.a", "text", "a:hover", "x + y",
      "path, line", "svg|rect", "[data-k='2']", "g>*", "tspan", "use", ".a.b", "#e2 rect", "::before", "rect:first-child",
    ];
    const rules = [];
    for (let i = R.int(0, 4); i > 0; i--) rules.push(`${R.choice(sels)} { ${styleDecls()} }`);
    if (R.chance(0.3)) rules.unshift(R.choice(["@media print { rect { fill: none } }", "@import url(x.css);", "@font-face { font-family: x }", "@charset 'utf-8';"]));
    if (R.chance(0.3)) rules.push("/* c */");
    if (R.chance(0.1)) rules.push("rect { fill: red"); // unterminated block
    const body = rules.join(" ");
    const type = R.choice(["", "", ' type="text/css"', ' type="text/x"', ' media="print"']);
    return R.chance(0.5) ? `<style${type}><![CDATA[${body}]]></style>` : `<style${type}>${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</style>`;
  };

  const document = () => {
    dtd = R.chance(0.15);
    const w = R.choice(["", `width="${length()}"`, 'width="200"']);
    const h = R.choice(["", `height="${length()}"`, 'height="100"']);
    const vb = R.choice(["", 'viewBox="0 0 100 100"', 'viewBox="-10 -10 50 30"', 'viewBox="0 0 0 10"', 'viewBox="0,0,80,40"']);
    const par = R.choice(["", "", 'preserveAspectRatio="xMinYMax slice"', 'preserveAspectRatio="none"']);
    const ns = R.chance(0.9) ? 'xmlns="http://www.w3.org/2000/svg" ' : "";
    xlink = R.chance(0.9);
    inkscape = R.chance(0.1);
    const decls = (xlink ? 'xmlns:xlink="http://www.w3.org/1999/xlink" ' : "") + (inkscape ? 'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ' : "");
    let prolog = R.chance(0.2) ? '<?xml version="1.0" encoding="UTF-8"?>\n' : "";
    if (dtd) {
      prolog +=
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n' +
        '  <!ENTITY e1 "ent a">\n' +
        "  <!ENTITY e2 \"<rect width='4' height='4' class='a'/>\">\n" +
        '  <!ENTITY e3 "&e2;&e2;">\n' +
        "]>\n";
    }
    if (R.chance(0.1)) prolog += "<!-- before -->\n";
    const head = `<svg ${ns}${decls}${w} ${h} ${vb} ${par}>`;
    const body = R.chance(0.5) ? [css()] : [];
    body.push('<defs><linearGradient id="g1"/></defs>');
    for (let i = R.int(3, 25); i > 0; i--) body.push(element(0));
    let doc = prolog + head + body.join(R.choice(["", "\n"])) + "</svg>" + (R.chance(0.1) ? "\n<!-- after -->\n" : "");
    if (R.chance(0.15)) {
      // Mutate (on code points, so that the document stays valid UTF-16).
      const cps = Array.from(doc);
      const k = R.int(0, cps.length - 1);
      const op = R.random();
      if (op < 0.4) cps.length = k;
      else if (op < 0.7) cps.splice(k, 0, R.choice(["<", ">", "&", '"', "'", "]]>", "<!--", "\u0001", "/", "&#0;", "\uFFFE"]));
      else cps.splice(k, R.int(1, 10));
      doc = cps.join("");
    }
    return doc;
  };

  const SELECTORS = [
    "rect", "g > *", ".a", "#e1", "[data-k=1]", "[data-k]", ":small", ":background", ":filled", ":unfilled", "svg rect",
    "g circle, path", "use", "text", "*", "a:hover", "[x~=y]", "#e3 > .b", "symbol *", "switch > *", "defs *", "tspan",
    "use:small", "path:small", "rect:filled:small", "g g", ".a.b", "svg > svg", "image", "line, polyline", "", "a >",
  ];

  const classes = () => {
    const out = [];
    for (let i = R.int(0, 4); i > 0; i--) out.push({ selector: R.choice(SELECTORS), class: R.choice(["points", "lines", "ink", "ignore", "x"]) });
    return out;
  };

  return {
    document,
    options: () => ({
      canvas: R.chance(0.3) ? [R.int(50, 400), R.int(50, 400)] : null,
      tolerance: R.chance(0.3) ? R.choice([0.1, 1, 0.05, 2]) : null,
    }),
    rules: (presets) => (R.chance(0.5) ? R.choice(presets) : classes()),
    defaultClass: () => R.choice(["ink", "ink", "ignore", "other"]),
    selectors: () => Array.from({ length: R.int(0, 3) }, () => R.choice(SELECTORS)),
  };
}

// ---------------------------------------------------------------------------------------
// Cases

const presetRules = new Map();
for (const f of readdirSync(presetDir).filter((f) => f.endsWith(".json")).sort()) {
  const rules = JSON.parse(readFileSync(join(presetDir, f), "utf8")).svg_classes;
  if (Array.isArray(rules)) presetRules.set(f.replace(/\.json$/, ""), rules);
}
const presets = [...presetRules.values()];

const cases = [];
for (const f of readdirSync(conformanceDir).filter((f) => f.endsWith(".json")).sort()) {
  const c = JSON.parse(readFileSync(join(conformanceDir, f), "utf8"));
  if (c.kind !== "svg") continue;
  cases.push({
    label: f,
    svg: Array.isArray(c.svg) ? c.svg.join("\n") : c.svg,
    canvas: c.canvas ? [c.canvas.width, c.canvas.height] : null,
    tolerance: c.tolerance ?? null,
    rules: c.classes ?? presetRules.get(c.preset) ?? presetRules.get("auto") ?? [],
    default_class: c.default_class ?? "ink",
    select: (c.expect?.select ?? []).map((s) => s.selector),
  });
}
const conformanceCount = cases.length;
const gen = generator(rng(seed));
for (let i = 0; i < count; i++) {
  const svg = gen.document();
  const { canvas, tolerance } = gen.options();
  cases.push({ label: `random ${seed}/${i}`, svg, canvas, tolerance, rules: gen.rules(presets), default_class: gen.defaultClass(), select: gen.selectors() });
}

// ---------------------------------------------------------------------------------------
// Rust

const build = spawnSync("cargo", ["build", "-q", "-p", "label-anything-svg", "--features", "serde", "--example", "dump"], { cwd: rustDir, stdio: "inherit" });
if (build.status !== 0) die("cargo build of the `dump` example failed");
const meta = spawnSync("cargo", ["metadata", "-q", "--format-version", "1", "--no-deps"], { cwd: rustDir, encoding: "utf8", maxBuffer: 1 << 28 });
if (meta.status !== 0) die("cargo metadata failed");
const exe = join(JSON.parse(meta.stdout).target_directory, "debug", "examples", process.platform === "win32" ? "dump.exe" : "dump");

const rust = [];
const CHUNK = 200;
for (let i = 0; i < cases.length; i += CHUNK) {
  const input = cases
    .slice(i, i + CHUNK)
    .map(({ label, ...c }) => JSON.stringify(c))
    .join("\n");
  const run = spawnSync(exe, ["--jsonl"], { input, encoding: "utf8", maxBuffer: 1 << 29 });
  if (run.status !== 0) die(`dump --jsonl failed (status ${run.status}, signal ${run.signal}):\n${run.stderr}`);
  const lines = run.stdout.split("\n").filter((l) => l.length > 0);
  if (lines.length !== Math.min(CHUNK, cases.length - i)) die(`dump --jsonl returned ${lines.length} lines for ${Math.min(CHUNK, cases.length - i)} cases`);
  for (const l of lines) rust.push(JSON.parse(l));
}

// ---------------------------------------------------------------------------------------
// TypeScript

function runTs(c) {
  const options = {};
  if (c.canvas) options.canvas = { width: c.canvas[0], height: c.canvas[1] };
  if (c.tolerance !== null) options.tolerance = c.tolerance;
  const parsed = api.parseSvg(c.svg, options);
  if (!parsed.ok) return { error: parsed.error };
  const scene = parsed.value;
  const out = {};
  if (c.rules) {
    const cl = api.classify(scene, c.rules, c.default_class);
    out.classified = cl.ok ? cl.value.map((x) => ({ class: x.class, index: x.index })) : { error: cl.error };
  }
  if (c.select) {
    out.selected = c.select.map((s) => {
      const r = api.select(scene, s);
      return r.ok ? r.value : { error: r.error };
    });
  }
  out.scene = scene;
  // Through JSON, like the Rust output.
  return JSON.parse(JSON.stringify(out));
}

// ---------------------------------------------------------------------------------------
// Comparison

/** Replaces error and warning objects by their codes (messages are not part of the contract). */
function codes(v) {
  if (Array.isArray(v)) return v.map(codes);
  if (v === null || typeof v !== "object") return v;
  const out = {};
  for (const k of Object.keys(v)) {
    if (k === "error" && v[k] && typeof v[k] === "object") out[k] = v[k].code;
    else if (k === "warnings" && Array.isArray(v[k])) out[k] = v[k].map((w) => w.code);
    else if (k === "attributes") out[k] = v[k];
    else out[k] = codes(v[k]);
  }
  return out;
}

function diff(a, b, path, out) {
  if (out.length >= 10) return;
  if (typeof a === "number" && typeof b === "number") {
    if (!(Math.abs(a - b) <= REL * Math.max(1, Math.abs(a), Math.abs(b)))) out.push(`${path}: ${a} (rust) != ${b} (ts)`);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} (rust) != ${b.length} (ts)`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
  } else if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    const only = [...ka.filter((k) => !Object.hasOwn(b, k)).map((k) => `-${k}`), ...kb.filter((k) => !Object.hasOwn(a, k)).map((k) => `+${k}`)];
    if (only.length) out.push(`${path}: keys ${only.join(" ")} (- rust only, + ts only)`);
    for (const k of ka) if (Object.hasOwn(b, k)) diff(a[k], b[k], `${path}.${k}`, out);
  } else if (a !== b) {
    out.push(`${path}: ${JSON.stringify(a)} (rust) != ${JSON.stringify(b)} (ts)`);
  }
}

const stats = { errors: 0, primitives: 0, classified: 0, selected: 0 };
let failures = 0;
let failDir;
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const r = codes(rust[i]);
  let t;
  try {
    t = codes(runTs(c));
  } catch (e) {
    t = { thrown: String(e) };
  }
  if (r.error) stats.errors++;
  else {
    stats.primitives += r.scene.primitives.length;
    if (Array.isArray(r.classified)) stats.classified += r.classified.length;
    for (const s of r.selected ?? []) if (Array.isArray(s)) stats.selected += s.length;
  }
  const out = [];
  diff(r, t, "", out);
  if (out.length === 0) continue;
  failures++;
  failDir ??= mkdtempSync(join(tmpdir(), "la-svg-parity-"));
  const name = `case-${i}`;
  writeFileSync(join(failDir, `${name}.svg`), c.svg);
  const { svg, ...rest } = c;
  writeFileSync(join(failDir, `${name}.json`), JSON.stringify(rest, null, 2));
  if (failures <= 20) {
    console.log(`DIFF ${c.label} (${join(failDir, name)}.svg)`);
    for (const line of out) console.log(`    ${line}`);
  }
}

console.log(
  `${cases.length - failures}/${cases.length} identical (${conformanceCount} conformance cases, ${count} random documents with seed ${seed}; ` +
    `${stats.errors} parse errors, ${stats.primitives} primitives, ${stats.classified} classified, ${stats.selected} selected)`,
);
if (failDir) console.log(`failing documents: ${failDir}`);
process.exit(failures ? 1 : 0);
