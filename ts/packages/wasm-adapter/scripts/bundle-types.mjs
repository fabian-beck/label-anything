// prepack: make the tarball independent of @label-anything/core. This package uses core
// for its type declarations only (the problem, the result, the options), so the
// declarations those types need are copied from core's build into dist/core-types/ and
// the declarations of this package import them from there. The tarball then installs on
// its own, without the TypeScript engine and its siblings.
//
// Idempotent; after it the workspace build still works (the copied declarations are the
// ones of the core it was built against).
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const coreDist = join(root, "..", "core", "dist");
const out = join(dist, "core-types");
/** The module of core that declares the shared API types (and nothing that runs). */
const ENTRY = "api.d.ts";
const CORE = "@label-anything/core";

const fail = (message) => {
  console.error(`@label-anything/wasm: ${message}`);
  process.exit(1);
};
const specifiers = (text) =>
  [...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);

// 1. the declarations the entry needs, followed through their relative imports
rmSync(out, { recursive: true, force: true });
const copied = new Set();
const queue = [ENTRY];
while (queue.length > 0) {
  const file = queue.pop();
  if (copied.has(file)) continue;
  copied.add(file);
  let text;
  try {
    text = readFileSync(join(coreDist, file), "utf8");
  } catch {
    fail(`${CORE} is not built, missing dist/${file} (npm run build at the repository root)`);
  }
  for (const spec of specifiers(text)) {
    if (!spec.startsWith(".")) fail(`${CORE}/dist/${file} imports ${spec}: the shared types must stand alone`);
    queue.push(posix.join(posix.dirname(file), spec.replace(/\.js$/, ".d.ts")));
  }
  mkdirSync(dirname(join(out, file)), { recursive: true });
  // the declaration maps point into core's sources, which are not in this tarball
  writeFileSync(join(out, file), text.replace(/^\/\/# sourceMappingURL=.*\n?/m, ""));
}

// 2. this package's declarations import them instead of the package
const entry = `./core-types/${ENTRY.replace(/\.d\.ts$/, ".js")}`;
const exported = new Set(
  [...readFileSync(join(out, ENTRY), "utf8").matchAll(/^export (?:declare )?(?:type|interface|class|const|function) (\w+)/gm)].map((m) => m[1]),
);
for (const m of readFileSync(join(out, ENTRY), "utf8").matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
  for (const name of m[1].split(",")) {
    const n = name.trim().split(/\s+as\s+/).pop();
    if (n) exported.add(n.replace(/^type\s+/, ""));
  }
}
let rewritten = 0;
for (const name of readdirSync(dist)) {
  if (!name.endsWith(".d.ts")) continue;
  const path = join(dist, name);
  const text = readFileSync(path, "utf8");
  const next = text.replace(
    /((?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*)["']@label-anything\/core["']/g,
    (_, head, names) => {
      for (const part of names.split(",")) {
        const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (n && !exported.has(n)) fail(`dist/${name} takes ${n} from ${CORE}, which its ${ENTRY} does not declare`);
      }
      return `${head}"${entry}"`;
    },
  );
  if (next !== text) {
    writeFileSync(path, next);
    rewritten++;
  }
}
console.log(
  `@label-anything/wasm: ${copied.size} declarations of ${CORE} in ${relative(root, out)}, used by ${rewritten} files`,
);
