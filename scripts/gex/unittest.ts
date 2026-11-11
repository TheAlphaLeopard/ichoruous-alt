import { decode } from "./isa.ts";
const cases: [string, number[]][] = [
  ["sub rsp,0x60", [0x48, 0x83, 0xec, 0x60]],
  ["mov rax,rsp", [0x48, 0x8b, 0xc4]],
  ["mov [rsp+8],rbx", [0x48, 0x89, 0x5c, 0x24, 0x08]],
  ["mov [rsp+0x20],rdi", [0x48, 0x89, 0x7c, 0x24, 0x20]],
  ["push rdi", [0x57]],
  ["lea rax,[rip+x]", [0x48, 0x8d, 0x05, 0x20, 0xf1, 0xce, 0x00]],
  ["4c 8b dc", [0x4c, 0x8b, 0xdc]],
  ["gs mov rax,fs:[0]", [0x65, 0x48, 0x8b, 0x04, 0x25, 0x00, 0x00, 0x00, 0x00]],
];
const pad = new Uint8Array(64);
const dv = new DataView(pad.buffer);
for (const [name, bytes] of cases) {
  const u8 = new Uint8Array(64); u8.set(bytes);
  try {
    const ins = decode(u8, dv, 0x1000, 0, bytes.length);
    console.log(name.padEnd(24), "->", ins.op, "len:", ins.len, "(expected", bytes.length + ")");
  } catch (e: any) { console.log(name.padEnd(24), "-> ERROR:", e.message); }
}
