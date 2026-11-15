// prepack: the tarball is useless without the WebAssembly module and its glue, which
// `npm run build:wasm` writes to wasm/ (git-ignored). Fail instead of packing without them.
// It must also install on its own: nothing in dist/ may import another package of the
// workspace (`scripts/bundle-types.mjs` brings the type declarations of core along).
import { accessSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const missing = ["wasm/label_anything.js", "wasm/label_anything_bg.wasm", "dist/index.js", "dist/node.js", "dist/core-types/api.d.ts"].filter((f) => {
  try {
    accessSync(join(root, f));
    return false;
  } catch {
    return true;
  }
});
if (missing.length > 0) {
  console.error(`@label-anything/wasm: not built, missing ${missing.join(", ")} (npm run build)`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const runtime = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
if (runtime.length > 0) {
  console.error(`@label-anything/wasm: must install on its own, but depends on ${runtime.join(", ")}`);
  process.exit(1);
}
const importing = readdirSync(join(root, "dist"), { recursive: true })
  .filter((f) => /\.(js|d\.ts)$/.test(f))
  .filter((f) => /\b(?:from|import)\s*\(?\s*["']@label-anything\//.test(readFileSync(join(root, "dist", f), "utf8")));
if (importing.length > 0) {
  console.error(`@label-anything/wasm: dist/${importing.join(", dist/")} import a package that is not a dependency (node scripts/bundle-types.mjs)`);
  process.exit(1);
}
