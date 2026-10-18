// A static server for dist/ (the browser tests): node test/server.mjs [port]
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export function startServer(port = 0, host = "127.0.0.1") {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = normalize(resolve(ROOT, `.${path}`));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (statSync(file).isDirectory()) file = resolve(file, "index.html");
      statSync(file);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, host, () => ok({ server, url: `http://${host}:${server.address().port}/` })));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { url } = await startServer(Number(process.argv[2] ?? 8000));
  console.log(`serving ${ROOT} at ${url}`);
}
