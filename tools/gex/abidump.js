import fs from "node:fs";
import { parsePE, rvaToOff } from "./pe.ts.js";
import { decode } from "./isa.ts.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const buf = fs.readFileSync(`${HERE}/../../upload/Ichorous.exe`);
const img = parsePE(buf);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const offOf = (va2) => rvaToOff(img, va2 - img.imageBase);
const va = parseInt(process.argv[2], 16);
const maxIns = parseInt(process.argv[3] ?? "40", 10);
let v = va;
for (let i = 0; i < maxIns; i++) {
  const o = offOf(v);
  if (o < 0) break;
  let ins;
  try {
    ins = decode(buf, dv, v, o, 4096);
  } catch (e) {
    console.log("ERR", e.message);
    break;
  }
  const bytes = [...buf.slice(o, o + ins.len)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const ops = ins.o.map((op) => {
    if (op.k === "reg") return ["r8b", "r9b", "r10b", "r11b", "r12b", "r13b", "r14b", "r15b", "al", "cl", "dl", "bl", "spl", "bpl", "sil", "dil", "rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"][op.r + (op.size === 1 ? 8 + 8 : op.size === 8 ? 16 : op.size === 4 ? 24 : 32)] ?? "r?";
    if (op.k === "imm") return typeof op.v === "bigint" ? "0x" + op.v.toString(16) : String(op.v);
    if (op.k === "xmm") return "xmm" + op.r;
    const m = op.m;
    let s = "";
    if (m.riprel) return `[rip+0x${m.disp.toString(16)}]`;
    s = "[";
    if (m.base !== void 0) s += ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"][m.base];
    if (m.index !== void 0) s += "+" + ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"][m.index] + "*" + m.scale;
    if (m.disp) s += (m.base !== void 0 || m.index !== void 0 ? m.disp > 0 ? "+" : "" : "") + m.disp;
    return s + "]";
  }).join(", ");
  console.log(`0x${v.toString(16)} ${bytes.padEnd(24)} ${ins.op.padEnd(12)} ${ops}`);
  if (ins.op === "ret" || ins.op === "int3") break;
  v += ins.len;
}
