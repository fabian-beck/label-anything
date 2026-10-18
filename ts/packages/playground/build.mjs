#!/usr/bin/env node
/**
 * Builds the playground into dist/ (published with the documentation site as /playground/):
 *
 *   node build.mjs            # dist/: app.js, engine-ts.js, engine-wasm.js, the WebAssembly
 *                             #        module, fonts, data, index.html, style.css, and
 *                             #        hero.js (the live header of the documentation's
 *                             #        home page, which solves with engine-ts.js)
 *   node build.mjs --serve    # rebuild on change and serve on http://127.0.0.1:8000/
 *
 * Needs the built packages (`npm run build` at the repository root) and, for the
 * WebAssembly engine, `npm run build:wasm -w @label-anything/wasm`; without the module the
 * playground solves with the TypeScript engine only.
 *
 * data/modules.json (the module graph of the TypeScript packages, the network scene) is
 * generated from the sources on every build.
 */
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const OUT = join(HERE, "dist");
const serve = process.argv.includes("--serve");

const WASM = join(REPO, "ts/packages/wasm-adapter/wasm/label_anything_bg.wasm");
const GLUE = join(REPO, "ts/packages/wasm-adapter/wasm/label_anything.js");
const hasWasm = existsSync(WASM) && existsSync(GLUE);

for (const pkg of ["core", "wasm-adapter"]) {
  if (!existsSync(join(REPO, `ts/packages/${pkg}/dist/index.js`))) {
    console.error(`ts/packages/${pkg}/dist is missing: run \`npm run build\` at the repository root first.`);
    process.exit(1);
  }
}
if (!existsSync(join(REPO, "bindings/js-extras/dist/index.js"))) {
  console.error("bindings/js-extras/dist is missing: run `npm run build` at the repository root first.");
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "fonts"), { recursive: true });
mkdirSync(join(OUT, "data"), { recursive: true });

// --- static files ----------------------------------------------------------------------
copyFileSync(join(HERE, "index.html"), join(OUT, "index.html"));
copyFileSync(join(HERE, "style.css"), join(OUT, "style.css"));
for (const f of ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf", "OFL.txt"]) copyFileSync(join(REPO, "fonts", f), join(OUT, "fonts", f));
copyDir(join(HERE, "data"), join(OUT, "data"));
if (hasWasm) copyFileSync(WASM, join(OUT, "label_anything_bg.wasm"));
else console.warn("warning: no WebAssembly build (npm run build:wasm -w @label-anything/wasm): the playground uses the TypeScript engine only");
writeFileSync(join(OUT, "data/modules.json"), JSON.stringify(moduleGraph()));
writeFileSync(join(OUT, "build.json"), JSON.stringify({ commit: gitCommit(), built: new Date().toISOString().slice(0, 10), wasm: hasWasm }));

// --- bundles ----------------------------------------------------------------------------
const common = {
  bundle: true,
  format: "esm",
  target: ["es2022"],
  minify: !serve,
  sourcemap: true,
  logLevel: "info",
  legalComments: "linked",
  absWorkingDir: HERE,
};
const entries = [
  { in: "src/main.ts", out: "app" },
  { in: "src/worker-ts.ts", out: "engine-ts" },
  { in: "src/hero.ts", out: "hero" },
];
if (hasWasm) entries.push({ in: "src/worker-wasm.ts", out: "engine-wasm" });
const options = { ...common, entryPoints: entries, outdir: OUT };

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: OUT, port: 8000, host: "127.0.0.1" });
  console.log(`playground: http://127.0.0.1:${port}/`);
} else {
  const result = await esbuild.build({ ...options, metafile: true });
  writeFileSync(join(OUT, "THIRD-PARTY-NOTICES.txt"), notices(result.metafile));
  const size = (f) => (existsSync(join(OUT, f)) ? `${(statSync(join(OUT, f)).size / 1024).toFixed(0)} KB` : "–");
  console.log(`dist/: app.js ${size("app.js")}, engine-ts.js ${size("engine-ts.js")}, engine-wasm.js ${size("engine-wasm.js")}, label_anything_bg.wasm ${size("label_anything_bg.wasm")}, hero.js ${size("hero.js")}`);
}

/** The licenses of the npm packages bundled into the scripts (from esbuild's metafile). */
function notices(metafile) {
  const pkgs = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (!m || m[1].startsWith("@label-anything/")) continue;
    const dir = join(REPO, "node_modules", m[1]);
    if (pkgs.has(m[1]) || !existsSync(join(dir, "package.json"))) continue;
    const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const lic = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
    pkgs.set(m[1], { version: pj.version, license: pj.license, text: lic ? readFileSync(join(dir, lic), "utf8").trim() : "" });
  }
  const parts = [
    "Label Anything playground: third-party components",
    "",
    "The scripts bundle Label Anything's own packages (MIT, https://github.com/fabian-beck/label-anything)",
    "and the npm packages below. fonts/: Noto Sans, SIL Open Font License 1.1 (fonts/OFL.txt).",
    "data/world.json: Made with Natural Earth (public domain). data/pictures/: scikit-image sample images",
    "(public domain / CC0) with annotation polygons by the Label Anything contributors (CC0 1.0).",
  ];
  for (const [name, p] of [...pkgs].sort(([a], [b]) => a.localeCompare(b))) {
    parts.push("", "-".repeat(78), `${name} ${p.version} (${p.license})`, "", p.text);
  }
  return parts.join("\n") + "\n";
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    if (statSync(src).isDirectory()) copyDir(src, join(to, name));
    else if (!name.endsWith(".md")) copyFileSync(src, join(to, name));
  }
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * The import graph of the TypeScript packages: one node per module (package, path, lines
 * of code), one edge per import (relative imports and imports of a sibling package's
 * entry). Generated and conformance code are left out.
 */
function moduleGraph() {
  const roots = {
    core: "ts/packages/core/src",
    text: "ts/packages/text/src",
    svg: "ts/packages/svg/src",
    raster: "ts/packages/raster/src",
    extras: "bindings/js-extras/src",
    wasm: "ts/packages/wasm-adapter/src",
    cli: "ts/packages/cli/src",
  };
  const pkgOf = { core: "core", text: "text", svg: "svg", raster: "raster", extras: "extras", wasm: "wasm", cli: "cli" };
  const nodes = new Map();
  const edges = [];
  const walk = (dir, out) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) {
        if (f !== "generated" && f !== "conformance") walk(p, out);
      } else if (f.endsWith(".ts") && !f.endsWith(".d.ts")) out.push(p);
    }
  };
  for (const [pkg, root] of Object.entries(roots)) {
    const dir = join(REPO, root);
    if (!existsSync(dir)) continue;
    const files = [];
    walk(dir, files);
    for (const file of files) {
      const rel = relative(dir, file).replace(/\\/g, "/").replace(/\.ts$/, "");
      const id = `${pkg}/${rel}`;
      const src = readFileSync(file, "utf8");
      nodes.set(id, { id, pkg, path: rel, lines: src.split("\n").length });
      for (const m of src.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
        const t = m[1];
        if (t.startsWith(".")) {
          const target = join(dirname(file), t).replace(/\.js$/, "");
          edges.push([id, `${pkg}/${relative(dir, target).replace(/\\/g, "/")}`]);
        } else if (t.startsWith("@label-anything/")) {
          const name = t.split("/")[1];
          if (pkgOf[name]) edges.push([id, `${pkgOf[name]}/index`]);
        }
      }
    }
  }
  const seen = new Set();
  const links = [];
  for (const [a, b] of edges) {
    const k = `${a}>${b}`;
    if (a !== b && nodes.has(b) && !seen.has(k)) {
      seen.add(k);
      links.push([a, b]);
    }
  }
  return { nodes: [...nodes.values()], links };
}
