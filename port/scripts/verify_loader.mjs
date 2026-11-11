// Verifies the browser boot path: serve ./out statically, fetch the .gz
// artifacts through DecompressionStream (exactly what boot.ts fetchBin does),
// and compare hashes against the raw files.
import { serve } from "bun";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const server = serve({ port: 8931, fetch: (req) => new Response(readFileSync("out" + new URL(req.url).pathname)) });

async function fetchBin(path) {
  const res = await fetch(`http://localhost:8931${path}.gz`);
  if (!res.ok) throw new Error(path + ".gz -> " + res.status);
  const stream = (await res.blob()).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function sha256(b) { return createHash("sha256").update(b).digest("hex"); }

for (const p of ["/gex/game.wasm", "/gex/image.bin"]) {
  const got = await fetchBin(p);
  const want = readFileSync("out" + p);
  const ok = Buffer.compare(Buffer.from(got), want) === 0;
  console.log(`${p}: ${got.length} bytes, sha256 ${sha256(got).slice(0, 16)}… ${ok ? "MATCHES raw" : "MISMATCH"}`);
  if (!ok) process.exit(1);
}
server.stop(true);
console.log("loader path verified");
