import fs from "node:fs";
import { buildRegistry, buildImage } from "./image.ts";
import { Lifter } from "./lift.ts";
const reg = buildRegistry(`${import.meta.dir}/../../upload/Ichorous.exe`);
reg.fns = reg.fns.slice(0, 400);
const mem = buildImage(`${import.meta.dir}/../../upload/Ichorous.exe`, reg);
const lifter = new Lifter(reg, mem, new DataView(mem.buffer));
lifter.liftAll();
const bytes = lifter.wasm.toBytes();
fs.writeFileSync("/tmp/t.wasm", bytes);
// scan for 0xFC bytes in code sections
let fcCount = 0, fcCtx: string[] = [];
for (let i = 0; i < bytes.length - 1; i++) {
  if (bytes[i] === 0xfc) { fcCount++; if (fcCtx.length < 10) fcCtx.push(i + ": " + [...bytes.slice(i - 6, i + 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ")); }
}
console.log("0xFC bytes:", fcCount);
for (const c of fcCtx) console.log("  ", c);
// find which function failed on xorps and dump around it
const err = lifter.errors[0];
console.log("first error:", err.fn, err.msg);
