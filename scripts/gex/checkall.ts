import { execSync } from "node:child_process";
const out = execSync(`bun run scripts/gex/wasmdump.ts /tmp/t.wasm 0 2>&1 | tail -1`).toString();
console.log("fn0:", out.trim());
