#!/usr/bin/env node
// What `npm publish` would upload, checked before it is: every npm package of the
// workspace is packed (dry run; `prepack` builds it) and its file list is compared with
// what a package needs and must not carry.
//
//   node tools/check-packages.mjs            the pure TypeScript packages
//   node tools/check-packages.mjs --wasm     also @label-anything/wasm (needs its wasm build)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  // dist/core-types: the declarations it shares with core, so that it installs alone
  PACKAGES["ts/packages/wasm-adapter"] = ["dist/index.js", "dist/node.js", "dist/index.d.ts",
    "dist/core-types/api.d.ts", "wasm/label_anything.js", "wasm/label_anything_bg.wasm", "OFL.txt"];
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

// @label-anything/wasm installs on its own: its tarball alone in an empty project, where
// its declarations must type-check (no skipLibCheck) and its Node entry must place a label
if (process.argv.includes("--wasm")) {
  const dir = mkdtempSync(join(tmpdir(), "la-wasm-alone-"));
  try {
    const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const out = run("npm", ["pack", "--json", "--pack-destination", dir], join(root, "ts/packages/wasm-adapter"));
    const tarball = JSON.parse(out.slice(out.indexOf("[\n")))[0].filename;
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "alone", private: true, type: "module" }));
    // --offline: anything but the tarball would have to come from a registry
    run("npm", ["install", "--offline", "--no-audit", "--no-fund", join(dir, tarball)], dir);
    writeFileSync(join(dir, "use.ts"), [
      'import { place, type LabelProblem, type LabelResult } from "@label-anything/wasm";',
      'const problem: LabelProblem = { items: [{ anchor: { type: "point", x: 10, y: 10 }, label: { type: "text", text: "A" } }] };',
      "const result: LabelResult = place(problem);",
      'if (result.placements.length !== 1) throw new Error("no placement");',
      "",
    ].join("\n"));
    run(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--strict", "--target", "ES2022", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "--lib", "ES2022,DOM", "--outDir", "out", "use.ts"], dir);
    writeFileSync(join(dir, "out/package.json"), '{ "type": "module" }');
    run(process.execPath, ["out/use.js"], dir);
    console.log("@label-anything/wasm: installs, type-checks and places a label without any other package");
  } catch (e) {
    problems.push(`@label-anything/wasm does not work when installed alone: ${e.stdout ?? ""}${e.stderr ?? e.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
