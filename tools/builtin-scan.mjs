#!/usr/bin/env node
// Reverse-engineering aid: recover the runner's built-in GML function table.
//
//   node tools/builtin-scan.mjs [startVA] [endVA]
//
// The runner registers every built-in with a repeated inline sequence:
//
//     xor   r9, r9
//     lea   rdx, [rip+d]     ; implementation pointer
//     lea   rcx, [rip+d]     ; name
//     lea   r8, [r9+N]       ; argument count
//     call  <register>
//
// This walks the .text looking for that shape and prints name -> impl VA. The
// implementation VAs are what `tools/disas.mjs` and `tools/jumptable.mjs` need
// in order to read the runner's own code for a given GML function.
//
// Needs the original executable at $ICHOROUS_EXE (default
// /home/user/fixtures/Ichorous.exe); it is not distributed with this repo.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode } from "./gex/isa.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.env.ICHOROUS_EXE ?? "/home/user/fixtures/Ichorous.exe";
const W = (s) => fs.writeSync(1, s + "\n");

const mining = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/gex/out-mining.json"), "utf8"));
const exe = fs.readFileSync(EXE);
const u8 = new Uint8Array(exe.buffer, exe.byteOffset, exe.byteLength);
const dv = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);

const secOf = (v) => mining.sections.find((s) => v >= s.vaAbs && v < s.vaAbs + Math.max(s.vsize, s.rawSize));
const offOf = (v) => { const s = secOf(v); return s ? s.rawOff + (v - s.vaAbs) : -1; };
const cstr = (v, max = 120) => {
  const o = offOf(v); if (o < 0) return null;
  let s = "";
  for (let i = 0; i < max; i++) { const c = u8[o + i]; if (c === 0) break; if (c < 32 || c > 126) return null; s += String.fromCharCode(c); }
  return s.length >= 1 ? s : null;
};
const text = mining.sections.find((s) => s.name === ".text");
const start = process.argv[2] ? Number(BigInt(process.argv[2])) : text.vaAbs;
const end = process.argv[3] ? Number(BigInt(process.argv[3])) : text.vaAbs + text.rawSize;

const results = [];
const seen = new Set();
for (let va = start; va < end; va++) {
  const base = offOf(va);
  if (base < 0) continue;
  let ins, cur = va;
  try { ins = decode(u8, dv, cur, base, 15); } catch { continue; }
  if (!ins || ins.op !== "xor") continue;
  cur += ins.len;
  const steps = [];
  let ok = true;
  for (let i = 0; i < 4; i++) {
    let s;
    try { s = decode(u8, dv, cur, offOf(cur), 15); } catch { ok = false; break; }
    if (!s || !s.op) { ok = false; break; }
    steps.push({ ins: s, at: cur });
    cur += s.len;
  }
  if (!ok) continue;
  const [a, b, , c] = steps;
  if (a.ins.op !== "lea" || b.ins.op !== "lea" || c.ins.op !== "call") continue;
  if (steps[2].ins.op !== "lea") continue;
  const implVA = a.at + a.ins.len + a.ins.o[1].m.disp;
  const nameVA = b.at + b.ins.len + b.ins.o[1].m.disp;
  const name = cstr(nameVA);
  if (!name || !/^[A-Za-z_@][A-Za-z0-9_@]{0,60}$/.test(name)) continue;
  if (seen.has(name)) continue;
  seen.add(name);
  results.push({ name, impl: implVA });
}
for (const r of results) W(`0x${r.impl.toString(16).padStart(9)}  ${r.name}`);
W(`\n${results.length} built-ins`);
