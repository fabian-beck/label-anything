#!/usr/bin/env node
// One version for every package: the crates, the npm packages, the Python packages, the
// JAR, and the places that name it (constants, tests, commands in the docs, CITATION.cff).
//
//   node tools/version.mjs               print the version and where it is written
//   node tools/version.mjs --check       fail (exit 1) unless every place holds the same version
//   node tools/version.mjs --set 0.2.0   write a new version everywhere (and today's date
//                                        into CITATION.cff; --date YYYY-MM-DD sets another)
//
// Versions are plain `MAJOR.MINOR.PATCH`: the registries disagree on how a pre-release is
// written (SemVer `0.2.0-rc.1`, PEP 440 `0.2.0rc1`), so pre-releases are not supported.
// The version of the label-anything wheel is not listed: maturin reads it from the crate.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const V = String.raw`\d+\.\d+\.\d+`;

/** `[file, pattern, count]`: the pattern's first group is the text before the version, the
 *  second the version; `count` is how often it must match (`null`: at least once). */
const PLACES = [
  // Rust: the workspace version and the versions of the path dependencies; the lock file
  ["rust/Cargo.toml", String.raw`(\[workspace\.package\]\nversion = ")(${V})`, 1],
  ["rust/Cargo.toml", String.raw`(path = "crates/[a-z-]+", version = ")(${V})`, 7],
  ["rust/crates/la-wasm/Cargo.toml", String.raw`(path = "\.\./label-anything", version = ")(${V})`, 1],
  ["rust/Cargo.lock", String.raw`(name = "label-anything(?:-[a-z]+)?"\nversion = ")(${V})`, 11],
  // npm: the packages, their dependencies on each other, the lock file, the constants
  ...["core", "text", "svg", "raster", "cli", "wasm-adapter", "playground"].map((p) => [
    `ts/packages/${p}/package.json`, String.raw`(^\s*"version": ")(${V})`, 1]),
  ["bindings/js-extras/package.json", String.raw`(^\s*"version": ")(${V})`, 1],
  ...["core", "cli", "wasm-adapter", "playground"].map((p) => [
    `ts/packages/${p}/package.json`, String.raw`("@label-anything/[a-z-]+": ")(${V})`, null]),
  ["bindings/js-extras/package.json", String.raw`("@label-anything/[a-z-]+": ")(${V})`, null],
  ["package-lock.json", String.raw`("name": "@label-anything/[a-z-]+",\s*"version": ")(${V})`, null],
  ["package-lock.json", String.raw`("@label-anything/[a-z-]+": ")(${V})`, null],
  ["ts/packages/core/src/version.ts", String.raw`(VERSION = ")(${V})`, 1],
  ["ts/packages/wasm-adapter/src/api.ts", String.raw`(VERSION = ")(${V})`, 1],
  ["ts/packages/wasm-adapter/test/init-browser.test.ts", String.raw`(VERSION\)\.toBe\(")(${V})`, 1],
  ["ts/packages/wasm-adapter/browser/smoke.pw.mjs", String.raw`(version\)\.toBe\(")(${V})`, 1],
  // Python helpers (the wheel takes its version from the crate); each package needs the
  // other at its own version
  ["bindings/python-extras/pyproject.toml", String.raw`(^version = ")(${V})`, 1],
  ["bindings/python-extras/src/label_anything_extras/__init__.py", String.raw`(^__version__ = ")(${V})`, 1],
  ["bindings/python-extras/pyproject.toml", String.raw`("label-anything==)(${V})`, 1],
  ["rust/crates/la-py/pyproject.toml", String.raw`("label-anything-extras==)(${V})`, 4],
  // Java: the artifact, and the JAR's file name wherever a command names it
  ["bindings/java/pom.xml", String.raw`(<artifactId>label-anything</artifactId>\s*<version>)(${V})`, 1],
  ...[".github/workflows/ci.yml", "docs/getting-started/java.md", "examples/java/README.md",
    "examples/java/Main.java", "examples/tutorials/java/GettingStarted.java",
    "examples/tutorials/java/Outliers.java", "examples/tutorials/run.py",
    "examples/brief/java/run.sh", "examples/brief/java/Brief63.java"].map((f) => [
    f, String.raw`(label-anything-)(${V})(?=(?:-jni)?\.jar)`, null]),
  ["docs/getting-started/java.md", String.raw`(<version>)(${V})`, 1],
  ["docs/getting-started/java.md", String.raw`(-Dversion=)(${V})`, 1],
  // Citation
  ["CITATION.cff", String.raw`(^version: )(${V})`, 1],
];

const args = process.argv.slice(2);
const flag = (name) => {
  const k = args.indexOf(name);
  return k < 0 ? null : args[k + 1] ?? "";
};
const check = args.includes("--check");
const next = flag("--set");
const date = flag("--date") ?? new Date().toISOString().slice(0, 10);
if (next !== null && !new RegExp(`^${V}$`).test(next)) {
  console.error(`--set needs a version MAJOR.MINOR.PATCH, not "${next}"`);
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`--date needs YYYY-MM-DD, not "${date}"`);
  process.exit(2);
}

const texts = new Map();
const read = (file) => {
  if (!texts.has(file)) texts.set(file, readFileSync(join(root, file), "utf8"));
  return texts.get(file);
};

const current = read("rust/Cargo.toml").match(new RegExp(String.raw`\[workspace\.package\]\nversion = "(${V})`))?.[1];
const found = []; // { file, version }
const problems = [];
for (const [file, pattern, count] of PLACES) {
  const re = new RegExp(pattern, "gm");
  const matches = [...read(file).matchAll(re)];
  if (count === null ? matches.length === 0 : matches.length !== count) {
    problems.push(`${file}: /${pattern}/ matches ${matches.length} times, expected ${count ?? "at least 1"}`);
    continue;
  }
  for (const m of matches) found.push({ file, version: m[2] });
  if (next !== null) texts.set(file, read(file).replace(re, (_, before) => before + next));
}

const versions = [...new Set(found.map((f) => f.version))];
if (versions.length > 1) {
  for (const f of found.filter((f) => f.version !== current)) {
    problems.push(`${f.file}: version ${f.version}, the workspace has ${current}`);
  }
}
if (problems.length > 0) {
  for (const p of [...new Set(problems)]) console.error(p);
  console.error("The version is not written the same way everywhere (see tools/version.mjs).");
  process.exit(1);
}

if (next !== null) {
  texts.set("CITATION.cff", read("CITATION.cff").replace(/^date-released: .*$/m, `date-released: ${date}`));
  let changed = 0;
  for (const [file, text] of texts) {
    if (text === readFileSync(join(root, file), "utf8")) continue;
    writeFileSync(join(root, file), text);
    console.log(`wrote ${file}`);
    changed++;
  }
  console.log(changed === 0 ? `version: already ${next}` : `version: ${current} -> ${next}; add its section to CHANGELOG.md`);
} else if (check) {
  console.log(`version: ${current} in ${found.length} places of ${texts.size} files`);
} else {
  console.log(current);
  for (const file of texts.keys()) console.log(`  ${file}`);
}
