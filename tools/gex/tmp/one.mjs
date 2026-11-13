import fs from "node:fs";
import { buildRegistry, buildImage } from "/home/user/ichoruous-alt/tools/gex/image.ts.js";
import { Lifter } from "/home/user/ichoruous-alt/tools/gex/lift.ts.js";
const EXE = "/home/user/fixtures/Ichorous.exe";
const want = process.argv[2];
const reg = buildRegistry(EXE);
const keep = reg.fns.filter((f) => f.name === want);
if (!keep.length) { console.log("no such function. sample:", reg.fns.slice(0, 3).map((f) => f.name)); process.exit(1); }
console.log("lifting", keep[0].name, "va 0x" + keep[0].va.toString(16), "end 0x" + keep[0].end.toString(16));
reg.fns = keep;
const mem = buildImage(EXE, reg);
const l = new Lifter(reg, mem, new DataView(mem.buffer));
const ok = l.liftAll();
console.log("lifted ok:", ok, "failed:", l.liftedFail, "errors:", l.errors.length);
for (const e of l.errors) console.log("  ERR", e.fn, e.msg.slice(0, 200));
const bytes = l.wasm.toBytes();
fs.writeFileSync("/home/user/ichoruous-alt/tools/gex/tmp/one.wasm", bytes);
console.log("wrote /home/user/ichoruous-alt/tools/gex/tmp/one.wasm", bytes.length, "bytes");
console.log("imports:", l.wasm.imports.map((i) => i.module + "." + i.name).join(" "));
