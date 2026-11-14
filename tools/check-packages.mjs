#!/usr/bin/env node
// What `npm publish` would upload, checked before it is: every npm package of the
// workspace is packed (dry run; `prepack` builds it) and its file list is compared with
// what a package needs and must not carry.
//
//   node tools/check-packages.mjs            the pure TypeScript packages
//   node tools/check-packages.mjs --wasm     also @label-anything/wasm (needs its wasm build)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** directory → files the tarball needs beyond package.json, README.md and LICENSE */
const PACKAGES = {
  "ts/packages/text": ["dist/index.js", "dist/index.d.ts", "OFL.txt"],
  "ts/packages/svg": ["dist/index.js", "dist/index.d.ts"],
  "ts/packages/raster": ["dist/index.js", "dist/index.d.ts"],
  "ts/packages/core": ["dist/index.js", "dist/index.d.ts"],
  "ts/packages/cli": ["dist/main.js"],
  "bindings/js-extras": ["dist/index.js", "dist/index.d.ts", "dist/worker.js", "dist/leaflet.js"],
};
if (process.argv.includes("--wasm")) {
  PACKAGES["ts/packages/wasm-adapter"] = ["dist/index.js", "dist/node.js", "dist/index.d.ts",
    "wasm/label_anything.js", "wasm/label_anything_bg.wasm", "OFL.txt"];
}
const ALWAYS = ["package.json", "README.md", "LICENSE"];
/** Never in a tarball: tests, the conformance runner, build state. */
const FORBIDDEN = [/(^|\/)test\//, /\.test\.[jt]s$/, /(^|\/)conformance\//, /\.tsbuildinfo$/, /(^|\/)node_modules\//];

const problems = [];
for (const [dir, needed] of Object.entries(PACKAGES)) {
  const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: join(root, dir), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  // lifecycle scripts may print before the JSON
  const pack = JSON.parse(out.slice(out.indexOf("[\n")))[0];
  const files = new Set(pack.files.map((f) => f.path));
  for (const f of [...ALWAYS, ...needed]) {
    if (!files.has(f)) problems.push(`${manifest.name}: ${f} is not in the tarball`);
  }
  for (const f of files) {
    if (FORBIDDEN.some((re) => re.test(f))) problems.push(`${manifest.name}: ${f} should not be in the tarball`);
  }
  // every file the manifest points to is there
  const targets = [manifest.main, manifest.types, ...Object.values(manifest.bin ?? {})];
  const walk = (v) => (typeof v === "string" ? targets.push(v) : v && Object.values(v).forEach(walk));
  walk(manifest.exports);
  for (const t of targets.filter(Boolean)) {
    if (!files.has(t.replace(/^\.\//, ""))) problems.push(`${manifest.name}: package.json names ${t}, which is not in the tarball`);
  }
  if (manifest.publishConfig?.access !== "public") problems.push(`${manifest.name}: publishConfig.access is not "public"`);
  console.log(`${manifest.name}@${pack.version}: ${pack.entryCount} files, ${(pack.size / 1024).toFixed(0)} KiB packed`);
}
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
