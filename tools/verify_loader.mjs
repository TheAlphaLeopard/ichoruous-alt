#!/usr/bin/env node
// Verifies the browser boot path for real: serves the site root with plain
// node:http, fetches the .gz artifacts through DecompressionStream (exactly what
// js/gex/boot.js does), and checks they inflate to the expected size.
//
//   node tools/verify_loader.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8931;

const MIME = { ".gz": "application/gzip", ".json": "application/json", ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  const buf = fs.readFileSync(file);
  // Note: no Content-Encoding. The page gunzips these itself, so a server that
  // transparently decoded them would double-decode and break the boot.
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "content-length": buf.length });
  res.end(req.method === "HEAD" ? undefined : buf);
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

async function fetchBin(p) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}.gz`);
  if (!res.ok) throw new Error(p + ".gz -> HTTP " + res.status);
  if (res.headers.get("content-encoding")) throw new Error(p + ".gz served with Content-Encoding — would double-decode");
  const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let bad = 0;
for (const p of ["/gex/game.wasm", "/gex/image.bin"]) {
  const rawPath = path.join(ROOT, p);
  const got = await fetchBin(p);
  const sha = createHash("sha256").update(got).digest("hex").slice(0, 16);
  if (fs.existsSync(rawPath)) {
    const want = fs.readFileSync(rawPath);
    const ok = Buffer.compare(Buffer.from(got), want) === 0;
    console.log(`${ok ? "  ok  " : " FAIL "} ${p}.gz inflates to ${(got.length / 1048576).toFixed(1)}MB, sha256 ${sha}… ${ok ? "matches raw" : "MISMATCH"}`);
    if (!ok) bad++;
  } else {
    console.log(`  ok   ${p}.gz inflates to ${(got.length / 1048576).toFixed(1)}MB, sha256 ${sha}… (no raw file to compare)`);
  }
}

// every artifact the page asks for must be reachable
const need = ["/index.html", "/css/style.css", "/js/main.js", "/js/game-worker.js", "/js/gex/boot.js",
  "/js/gex/runtime.js", "/gex/meta.json", "/gex/builtins.json", "/gex/objects.json", "/gex/rooms.json",
  "/cartridge/game.json", "/cartridge/tpag.json", "/cartridge/room_order.json", "/logo.svg"];
for (const p of need) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
  console.log(`${res.ok ? "  ok  " : " FAIL "} ${p} -> HTTP ${res.status}`);
  if (!res.ok) bad++;
}

server.close();
console.log(bad === 0 ? "\nloader path verified" : `\n${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
