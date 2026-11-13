// Run a single lifted function against the real runner's ABI shims.
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { GMRunner } from "/home/user/ichoruous-alt/js/gex/runtime.js";
const R = "/home/user/ichoruous-alt/";
const rb = (p) => { try { return gunzipSync(fs.readFileSync(R + p + ".gz")); } catch { return fs.readFileSync(R + p); } };
const rj = (p) => JSON.parse(fs.readFileSync(R + p, "utf8"));
const runner = new GMRunner();
runner.debugFn = () => {};
await runner.boot(rb("gex/game.wasm"), rb("gex/image.bin"), rj("gex/meta.json"), rj("gex/builtins.json"));
const bytes = fs.readFileSync(process.argv[2] ?? "tools/gex/tmp/one.wasm");
const mod = new WebAssembly.Module(bytes);
const ex = new WebAssembly.Instance(mod, { abi: runner.makeImports() }).exports;
const name = Object.keys(ex).find((k) => k.startsWith("g_gml_"));
console.log("export:", name, " other:", Object.keys(ex).filter((k) => !k.startsWith("g_")).join(","));
const fn = ex[name];
ex.rsp.value = 46137344n;
const self = 32506112n;
// mirror what runEvent passes: (self, other, result, 0, 0)
const t = Date.now();
const timer = setInterval(() => console.log("  ...still running", ((Date.now() - t) / 1000).toFixed(0) + "s"), 5000);
try { const r = fn(self, self, 0n, 0n, 0n); console.log("returned", r[0], r[1], ((Date.now() - t) / 1000).toFixed(1) + "s"); }
catch (e) { console.log("TRAP:", e.message, ((Date.now() - t) / 1000).toFixed(1) + "s"); }
finally { clearInterval(timer); }
