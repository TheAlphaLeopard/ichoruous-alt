import fs from "node:fs";
const bytes = fs.readFileSync("/home/user/ichoruous-alt/tools/gex/tmp/one.wasm");
const mod = new WebAssembly.Module(bytes);
const names = WebAssembly.Module.exports(mod).map((e) => e.name);
const trace = [];
const stub = (n) => (...a) => { trace.push(n + "(" + a.map((x) => "0x" + (BigInt(x) >= 0n ? BigInt(x) : BigInt(x) + (1n << 64n)).toString(16)).join(",") + ")"); return [0n, 0]; };
const imports = { abi: {} };
for (const n of ["f140041a50", "f140041b80", "icall", "f140e98b30"]) imports.abi[n] = stub(n);
const inst = new WebAssembly.Instance(mod, imports);
const ex = inst.exports;
console.log("exports:", names.join(" "));
const g = ex["g_gml_Object_oCam_Create_0"];
ex.rsp.value = 46137344n;
const self = 32506112n;
try {
  const r = g(self, self, 0n, 0n, 0n);
  console.log("returned", r[0], r[1]);
} catch (e) {
  console.log("TRAP:", e.message);
  console.log(String(e.stack).split("\n").slice(0, 3).join("\n"));
}
console.log("import calls before trap:", trace.length);
for (const t of trace.slice(0, 12)) console.log("   " + t);
