#!/usr/bin/env node
/**
 * Builds the Rust core (rust/crates/la-wasm) to WebAssembly and generates the
 * wasm-bindgen glue into ../wasm (label_anything.js, label_anything_bg.wasm, snippets/).
 *
 *   node scripts/build-wasm.mjs [--features decode] [--opt-level s|z|1|2|3] [--keep-names]
 *
 * Needs the `wasm32-unknown-unknown` Rust target and `wasm-bindgen-cli` with exactly the
 * version of the `wasm-bindgen` crate in rust/Cargo.lock
 * (`cargo install wasm-bindgen-cli --version <that version>`).
 *
 * The build uses its own Cargo profile (`wasm-release`: fat LTO, one codegen unit, opt-level
 * "s"), passed with `--config`, so it never invalidates the native release artifacts.
 * opt-level "s" is about 13 % smaller than 3 (gzip) for a few percent of speed;
 * wasm-opt is not used because it does not reduce the gzip size of this module.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const features = option("--features", "");
const optLevel = option("--opt-level", "s");
const keepNames = args.includes("--keep-names");

const pkgDir = fileURLToPath(new URL("../", import.meta.url));
const rustDir = fileURLToPath(new URL("../../../../rust/", import.meta.url));
const outDir = fileURLToPath(new URL("../wasm/", import.meta.url));

function run(cmd, argv, opts = {}) {
  console.log(`> ${cmd} ${argv.join(" ")}`);
  execFileSync(cmd, argv, { stdio: "inherit", ...opts });
}

// wasm-bindgen-cli must match the crate version exactly
const lock = readFileSync(`${rustDir}Cargo.lock`, "utf8");
const locked = /\[\[package\]\]\nname = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)?.[1];
let cli = "";
try {
  cli = execFileSync("wasm-bindgen", ["--version"], { encoding: "utf8" }).trim().split(/\s+/)[1] ?? "";
} catch {
  cli = "";
}
if (!locked || cli !== locked) {
  console.error(
    `wasm-bindgen-cli ${cli || "(not found)"} does not match the wasm-bindgen crate ${locked ?? "?"}.\n` +
      `Install it with: cargo install wasm-bindgen-cli --version ${locked ?? "<version>"}`,
  );
  process.exit(1);
}

const profile = "wasm-release";
const cargoArgs = [
  "build",
  "-p",
  "label-anything-wasm",
  "--target",
  "wasm32-unknown-unknown",
  "--profile",
  profile,
  "--config",
  `profile.${profile}.inherits="release"`,
  "--config",
  `profile.${profile}.lto="fat"`,
  "--config",
  `profile.${profile}.codegen-units=1`,
  "--config",
  `profile.${profile}.opt-level=${/^\d$/.test(optLevel) ? optLevel : JSON.stringify(optLevel)}`,
];
if (features) cargoArgs.push("--features", features);
run("cargo", cargoArgs, { cwd: rustDir });

const targetDir = process.env.CARGO_TARGET_DIR ?? `${rustDir}target`;
const input = `${targetDir}/wasm32-unknown-unknown/${profile}/label_anything_wasm.wasm`;
if (!existsSync(input)) {
  console.error(`missing ${input}`);
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const bindgenArgs = [
  "--target",
  "web",
  "--no-typescript",
  "--experimental-reset-state-function",
  "--remove-producers-section",
  "--out-name",
  "label_anything",
  "--out-dir",
  outDir,
  input,
];
if (!keepNames) bindgenArgs.unshift("--remove-name-section");
run("wasm-bindgen", bindgenArgs, { cwd: pkgDir });

const wasm = `${outDir}label_anything_bg.wasm`;
const raw = statSync(wasm).size;
const gz = gzipSync(readFileSync(wasm), { level: 9 }).length;
console.log(
  `label_anything_bg.wasm: ${(raw / 1024).toFixed(0)} KiB raw, ${(gz / 1024).toFixed(0)} KiB gzip ` +
    `(features: ${features || "default"}, opt-level ${optLevel})`,
);
