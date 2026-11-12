import fs from "node:fs";
import { buildRegistry, buildImage } from "./image.ts.js";
import { Lifter } from "./lift.ts.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const reg = buildRegistry(`${HERE}/../../upload/Ichorous.exe`);
reg.fns = reg.fns.slice(0, 400);
const mem = buildImage(`${HERE}/../../upload/Ichorous.exe`, reg);
const lifter = new Lifter(reg, mem, new DataView(mem.buffer));
lifter.liftAll();
const bytes = lifter.wasm.toBytes();
fs.writeFileSync("/tmp/t.wasm", bytes);
let fcCount = 0, fcCtx = [];
for (let i = 0; i < bytes.length - 1; i++) {
  if (bytes[i] === 252) {
    fcCount++;
    if (fcCtx.length < 10) fcCtx.push(i + ": " + [...bytes.slice(i - 6, i + 4)].map((b) => b.toString(16).padStart(2, "0")).join(" "));
  }
}
console.log("0xFC bytes:", fcCount);
for (const c of fcCtx) console.log("  ", c);
const err = lifter.errors[0];
console.log("first error:", err.fn, err.msg);
