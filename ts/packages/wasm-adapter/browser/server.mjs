// A tiny static server for the browser smoke test and the web example:
//   /             -> browser/index.html (the smoke test page)
//   /dist/, /wasm/ -> this package (the compiled entry and the wasm-bindgen output)
//   /problems/    -> conformance/problems
//   /examples/web/ -> examples/web (the example page)
// Run directly: node browser/server.mjs [port]   (default 8080)
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(fileURLToPath(new URL("../", import.meta.url)));
const REPO = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".css": "text/css",
  ".map": "application/json",
};
const ROUTES = [
  ["/problems/", resolve(REPO, "conformance/problems")],
  ["/examples/web/", resolve(REPO, "examples/web")],
  // the example imports the package the way an application would
  ["/node_modules/@label-anything/wasm/", PKG],
  ["/", PKG],
];

function fileFor(urlPath) {
  const path = decodeURIComponent(urlPath.split("?")[0]);
  if (path === "/") return resolve(PKG, "browser/index.html");
  for (const [prefix, root] of ROUTES) {
    if (!path.startsWith(prefix)) continue;
    const file = normalize(resolve(root, `.${path.slice(prefix.length - 1)}`));
    if (file !== root && !file.startsWith(root + sep)) return undefined; // no escaping the root
    try {
      const st = statSync(file);
      return st.isDirectory() ? resolve(file, "index.html") : file;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Start the server; resolves with the server and its base URL. */
export function startServer(port = 0, host = "127.0.0.1") {
  const server = createServer((req, res) => {
    const file = fileFor(req.url ?? "/");
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => {
      const addr = server.address();
      ok({ server, url: `http://${host}:${typeof addr === "object" && addr ? addr.port : port}` });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.argv[2] ?? 8080));
  console.log(`serving ${url}/ (smoke test) and ${url}/examples/web/ (example)`);
}
