#!/usr/bin/env node
/**
 * Builds the Rust core (rust/crates/la-wasm) to WebAssembly and generates the
 * wasm-bindgen glue into ../wasm (label_anything.js, label_anything_bg.wasm, snippets/).
 *
 *   node scripts/build-wasm.mjs [--no-default-features] [--features a,b]
 *                               [--opt-level z] [--core-opt-level 3] [--keep-names]
 *
 * The default build has full shaping, SVG backgrounds and PNG/JPEG/WebP decoding
 * (cargo feature `decode`); `--no-default-features` leaves out the image decoders.
 *
 * Needs the `wasm32-unknown-unknown` Rust target and `wasm-bindgen-cli` with exactly the
 * version of the `wasm-bindgen` crate in rust/Cargo.lock
 * (`cargo install wasm-bindgen-cli --version <that version>`).
 *
 * The build uses its own Cargo profile (`wasm-release`: fat LTO, one codegen unit),
 * passed with `--config`, so it never invalidates the native release artifacts. Code is
 * optimized for size (opt-level "z") except the crates that run hot: the solver crate
 * label-anything-core and the raster pipeline label-anything-raster at opt-level 3, and
 * JSON parsing, the SVG backend, text layout and the image decoders at "s" (`HOT`). That
 * is as fast as "s" for all of them (within noise) and 17 KB (gzip) smaller; "z" for the
 * decoders made WebP decoding 1.5x slower, "z" for the JSON, SVG and text crates the
 * SVG-background and large-JSON problems 8-12 % slower. "s" everywhere is 9-16 % slower
 * (and raster backgrounds 2.3x slower with the raster crate at "s"). wasm-opt is not used:
 * it does not reduce the gzip size of this module. README.md lists the variants.
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
const noDefault = args.includes("--no-default-features");
const optLevel = option("--opt-level", "z");
const coreOptLevel = option("--core-opt-level", "3");
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

const tomlLevel = (level) => (/^\d$/.test(level) ? level : JSON.stringify(level));
// crates that run hot in common problems (JSON, SVG backgrounds, text, image decoding):
// never below "s"
const HOT = ["serde_json", "label-anything-svg", "label-anything-render", "label-anything-text"];
HOT.push("png", "fdeflate", "miniz_oxide", "image-webp", "zune-jpeg");
const hotLevel = optLevel === "z" ? "s" : optLevel;
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
  `profile.${profile}.opt-level=${tomlLevel(optLevel)}`,
  "--config",
  `profile.${profile}.package.label-anything-core.opt-level=${tomlLevel(coreOptLevel)}`,
  // the raster pipeline (base64, pixel classification) is the hot loop of raster
  // backgrounds: as fast as the solver
  "--config",
  `profile.${profile}.package.label-anything-raster.opt-level=${tomlLevel(coreOptLevel)}`,
  ...HOT.flatMap((c) => ["--config", `profile.${profile}.package.${c}.opt-level=${tomlLevel(hotLevel)}`]),
];
if (noDefault) cargoArgs.push("--no-default-features");
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
    `(features: ${[noDefault ? "no-default" : "default", features].filter(Boolean).join(" + ")}, ` +
    `opt-level ${optLevel}, core ${coreOptLevel})`,
);
