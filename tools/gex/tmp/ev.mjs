import fs from "node:fs";
const buf = fs.readFileSync("/home/user/fixtures/data.win");
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
let off = 8; const chunks = {};
while (off + 8 <= buf.length) {
  const id = String.fromCharCode(buf[off], buf[off+1], buf[off+2], buf[off+3]);
  const len = dv.getUint32(off + 4, true);
  chunks[id] = { off: off + 8, len };
  off += 8 + len; if (off % 4) off += 4 - off % 4;
}
const strPtrs = [];
const sc = dv.getUint32(chunks.STRG.off, true);
for (let i = 0; i < sc; i++) strPtrs.push(dv.getUint32(chunks.STRG.off + 4 + 4 * i, true));
const strSet = new Set(strPtrs);
const readStr = (p) => { if (!p || !strSet.has(p - 4)) return ""; const n = Math.min(dv.getUint32(p - 4, true), 4096); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(buf[p + i]); return s; };
const OBJT = chunks.OBJT.off;
const objCount = dv.getUint32(OBJT, true);
const names = [];
for (let i = 0; i < objCount; i++) names.push(readStr(dv.getUint32(dv.getUint32(OBJT + 4 + 4 * i, true), true)));
console.log("objects in data.win:", objCount, "named:", names.filter(Boolean).length);

const meta = JSON.parse(fs.readFileSync("/home/user/ichoruous-alt/gex/meta.json", "utf8"));
const objFns = meta.fns.filter((f) => f.n.startsWith("gml_Object_"));
console.log("gml_Object_* fns:", objFns.length);
// match by prefix against the real object names (longest name first so
// oFoo_bar beats oFoo when both exist)
const sorted = [...names].filter(Boolean).sort((a, b) => b.length - a.length);
const kinds = new Map(); let unmatched = [];
for (const f of objFns) {
  const hit = sorted.find((nm) => f.n.startsWith("gml_Object_" + nm + "_"));
  if (!hit) { unmatched.push(f.n); continue; }
  const rest = f.n.slice(("gml_Object_" + hit + "_").length);
  const m = /^([A-Za-z]+)(?:_(\d+))?$/.exec(rest);
  const key = m ? m[1] + (m[2] !== undefined ? "/" + m[2] : "/-") : "ODD:" + rest;
  const k = m ? m[1] : "ODD";
  if (!kinds.has(k)) kinds.set(k, new Map());
  const sub = m && m[2] !== undefined ? m[2] : "-";
  kinds.get(k).set(sub, (kinds.get(k).get(sub) ?? 0) + 1);
}
console.log("\nkind -> sub -> count");
for (const [k, subs] of [...kinds].sort((a, b) => b[1].size - a[1].size)) {
  const tot = [...subs.values()].reduce((a, b) => a + b, 0);
  console.log("  " + k.padEnd(12), String(tot).padStart(4), " subs:", [...subs].sort((a,b)=>a[0]-b[0]).map(([s, n]) => s + "x" + n).join(" "));
}
console.log("\nunmatched (object name not in data.win):", unmatched.length, unmatched.slice(0, 5));
