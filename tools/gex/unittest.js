import { decode } from "./isa.ts.js";
const cases = [
  ["sub rsp,0x60", [72, 131, 236, 96]],
  ["mov rax,rsp", [72, 139, 196]],
  ["mov [rsp+8],rbx", [72, 137, 92, 36, 8]],
  ["mov [rsp+0x20],rdi", [72, 137, 124, 36, 32]],
  ["push rdi", [87]],
  ["lea rax,[rip+x]", [72, 141, 5, 32, 241, 206, 0]],
  ["4c 8b dc", [76, 139, 220]],
  ["gs mov rax,fs:[0]", [101, 72, 139, 4, 37, 0, 0, 0, 0]]
];
const pad = new Uint8Array(64);
const dv = new DataView(pad.buffer);
for (const [name, bytes] of cases) {
  const u8 = new Uint8Array(64);
  u8.set(bytes);
  try {
    const ins = decode(u8, dv, 4096, 0, bytes.length);
    console.log(name.padEnd(24), "->", ins.op, "len:", ins.len, "(expected", bytes.length + ")");
  } catch (e) {
    console.log(name.padEnd(24), "-> ERROR:", e.message);
  }
}
