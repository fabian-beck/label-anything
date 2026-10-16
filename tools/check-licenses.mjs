#!/usr/bin/env node
// Check that every third-party dependency is permissively licensed (brief §2.9).
//
//   node tools/check-licenses.mjs            # Rust (cargo metadata) + npm (ts/package-lock.json)
//
// Rust crates and npm runtime dependencies must be MIT/Apache-2.0/BSD/ISC/Zlib-like.
// npm development dependencies (never shipped) may also use a few other permissive
// licenses (Python-2.0, BlueOak, CC-BY for data). SPDX expressions are evaluated: `OR`
// needs one allowed alternative, `AND` needs all, `WITH` exceptions are accepted.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PERMISSIVE = new Set([
  "MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "0BSD",
  "Unlicense", "CC0-1.0", "BSL-1.0", "Unicode-3.0", "Unicode-DFS-2016", "OFL-1.1",
]);
const DEV_EXTRA = new Set(["Python-2.0", "BlueOak-1.0.0", "CC-BY-4.0", "CC-BY-3.0", "MPL-2.0"]);

/** Evaluate an SPDX expression (subset: OR, AND, WITH, parentheses, legacy "/"). */
function allowed(expr, ok) {
  const tokens = expr.replace(/\//g, " OR ").replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
  let i = 0;
  const primary = () => {
    if (tokens[i] === "(") {
      i++;
      const v = or();
      i++; // ")"
      return v;
    }
    const id = tokens[i++];
    if (tokens[i] === "WITH") i += 2; // exceptions only widen permissions
    return ok.has(id);
  };
  const and = () => {
    let v = primary();
    while (tokens[i] === "AND") {
      i++;
      v = primary() && v;
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (tokens[i] === "OR") {
      i++;
      v = and() || v;
    }
    return v;
  };
  return or();
}

const problems = [];

// --- Rust ---
const meta = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--manifest-path", join(ROOT, "rust/Cargo.toml")], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  }),
);
const members = new Set(meta.workspace_members);
let nRust = 0;
for (const p of meta.packages) {
  if (members.has(p.id)) continue;
  nRust++;
  if (!p.license || !allowed(p.license, PERMISSIVE)) problems.push(`crate ${p.name} ${p.version}: ${p.license ?? "no license field"}`);
}

// --- npm ---
const lock = JSON.parse(readFileSync(join(ROOT, "ts/package-lock.json"), "utf8"));
let nNpm = 0;
for (const [path, p] of Object.entries(lock.packages ?? {})) {
  if (!path.includes("node_modules/") || p.link) continue; // the workspace itself
  nNpm++;
  const ok = p.dev ? new Set([...PERMISSIVE, ...DEV_EXTRA]) : PERMISSIVE;
  if (!p.license || !allowed(String(p.license), ok)) {
    problems.push(`npm ${path.replace(/^.*node_modules\//, "")} ${p.version}${p.dev ? " (dev)" : ""}: ${p.license ?? "no license field"}`);
  }
}

if (problems.length) {
  console.error(`License check failed (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`License check passed: ${nRust} crates, ${nNpm} npm packages.`);
