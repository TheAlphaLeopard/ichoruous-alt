#!/usr/bin/env node
// Zero-dependency static server for the exported site — it replaces "bunx serve"
// so `npm run serve` works anywhere Node does (Codespaces, CI, a plain VPS).
//
//   node tools/serve-static.mjs [dir] [--port 8080] [--base /ichoruous-alt]
//
// --base mirrors a sub-path deploy: requests under it are served from the same
// files, so you can preview the GitHub Pages layout locally at
// http://localhost:8080/ichoruous-alt/ instead of only at /.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const baseArg = args.indexOf("--base");
const port = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT ?? 8080);
const base = (baseArg >= 0 ? args[baseArg + 1] : "").replace(/\/+$/, "");
const root = path.resolve(args.find((a) => !a.startsWith("-") && a !== args[portArg + 1] && a !== args[baseArg + 1]) ?? ".");

// .gz artifacts are decompressed by the browser with DecompressionStream, so they
// must be sent as plain bytes — setting Content-Encoding here would double-decode.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".gz": "application/gzip",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (base && (urlPath === base || urlPath.startsWith(base + "/"))) urlPath = urlPath.slice(base.length) || "/";

  let file = path.join(root, path.normalize(urlPath));
  if (!file.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found: " + urlPath);
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found: " + urlPath);
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": buf.length,
      "cache-control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`serving ${root} on http://0.0.0.0:${port}${base}/`);
});
