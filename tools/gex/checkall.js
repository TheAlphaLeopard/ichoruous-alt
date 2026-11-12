import { execSync } from "node:child_process";
const out = execSync(`node tools/gex/wasmdump.js /tmp/t.wasm 0 2>&1 | tail -1`).toString();
console.log("fn0:", out.trim());
