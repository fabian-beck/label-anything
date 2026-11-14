// prepack: the tarball is useless without the WebAssembly module and its glue, which
// `npm run build:wasm` writes to wasm/ (git-ignored). Fail instead of packing without them.
import { accessSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const missing = ["wasm/label_anything.js", "wasm/label_anything_bg.wasm", "dist/index.js", "dist/node.js"].filter((f) => {
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
