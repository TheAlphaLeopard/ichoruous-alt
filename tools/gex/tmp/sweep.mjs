// Linear-sweep a function range, restarting 1 byte later on any undecodable
// byte, so inline data (jump tables, string blobs) cannot truncate the listing.
import fs from "node:fs";
import { decode } from "/home/user/ichoruous-alt/tools/gex/isa.js";
const EXE = process.env.ICHOROUS_EXE ?? "/home/user/fixtures/Ichorous.exe";
const exe = fs.readFileSync(EXE);
const u8 = new Uint8Array(exe.buffer, exe.byteOffset, exe.byteLength);
const mining = JSON.parse(fs.readFileSync("/home/user/ichoruous-alt/tools/gex/out-mining.json", "utf8"));
const secOf = (v) => mining.sections.find((s) => v >= s.vaAbs && v < s.vaAbs + Math.max(s.vsize, s.rawSize));
const offOf = (v) => { const s = secOf(v); return s ? s.rawOff + (v - s.vaAbs) : -1; };
const R = ["rax","rcx","rdx","rbx","rsp","rbp","rsi","rdi","r8","r9","r10","r11","r12","r13","r14","r15"];
const opnd = (o) => {
  if (!o) return "";
  if (o.k === "reg") return R[o.r] ?? "r" + o.r;
  if (o.k === "imm") return "0x" + (typeof o.v === "bigint" ? Number(o.v) : o.v >>> 0).toString(16);
  if (o.k === "mem") {
    const m = o.m;
    if (m.riprel) return "[rip+0x" + (m.disp >>> 0).toString(16) + "]";
    const b = R[m.base] ?? "r" + m.base;
    const i = m.index != null && m.index < 16 ? "+" + (R[m.index] ?? "r" + m.index) + (m.scale > 1 ? "*" + m.scale : "") : "";
    return "[" + b + i + (m.disp ? (m.disp > 0 ? "+" : "-") + "0x" + Math.abs(m.disp).toString(16) : "") + "]";
  }
  return JSON.stringify(o);
};
const start = Number(process.argv[2]), end = Number(process.argv[3]);
let cur = start;
const lines = [];
while (cur < end) {
  const off = offOf(cur);
  if (off < 0) { cur++; continue; }
  let ins = null;
  try { ins = decode(u8, new DataView(exe.buffer, exe.byteOffset, exe.byteLength), cur, off, 15); } catch {}
  if (!ins || !ins.len) { lines.push(cur.toString(16) + "  (db)"); cur++; continue; }
  const ops = (ins.o ?? []).map(opnd).join(", ");
  lines.push(cur.toString(16) + "  " + ins.op + (ops ? " " + ops : ""));
  cur += ins.len;
}
fs.writeFileSync(process.argv[4] ?? "/tmp/sweep.asm", lines.join("\n") + "\n");
console.log("wrote", lines.length, "lines", start.toString(16), "-", end.toString(16));
