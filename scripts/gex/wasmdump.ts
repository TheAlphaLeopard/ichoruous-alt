// Mini wasm code-section disassembler for debugging the lifter output.
import fs from "node:fs";
const bytes = fs.readFileSync(process.argv[2] ?? "/tmp/t.wasm");
const target = parseInt(process.argv[3] ?? "0", 10); // function index among defined funcs
const uleb = (p: { v: number }): number => { let r = 0, s = 0; for (;;) { const x = bytes[p.v++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; if (s > 35) throw new Error("uleb overrun"); } return r >>> 0; };
const sleb = (p: { v: number }): number => { let r = 0, s = 0, b: number; do { b = bytes[p.v++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); if (s < 64 && (b & 0x40)) r |= -(1 << s); return r; };

let p = { v: 8 };
while (p.v < bytes.length) {
  const id = bytes[p.v]; p.v++;
  const size = uleb(p);
  const end = p.v + size;
  if (id === 10) {
    const n = uleb(p);
    for (let i = 0; i < n; i++) {
      const bsize = uleb(p);
      const bodyEnd = p.v + bsize;
      const nloc = uleb(p);
      let nLocals = 0;
      for (let g = 0; g < nloc; g++) { const cnt = uleb(p); const t = bytes[p.v++]; nLocals += cnt; void t; }
      if (i === target) {
        console.log(`function ${i}: bodySize=${bsize} locals=${nLocals}`);
        // disassemble
        const names: Record<number, string> = { 0x00:"unreach",0x01:"nop",0x02:"block",0x03:"loop",0x04:"if",0x05:"else",0x0b:"end",0x0c:"br",0x0d:"br_if",0x0e:"br_table",0x0f:"ret",0x10:"call",0x11:"call_ind",0x1a:"drop",0x1b:"select",0x20:"l.get",0x21:"l.set",0x22:"l.tee",0x23:"g.get",0x24:"g.set",0x28:"i32.ld",0x29:"i64.ld",0x2b:"f64.ld",0x2c:"i32.ld8s",0x2d:"i32.ld8u",0x2e:"i32.ld16s",0x2f:"i32.ld16u",0x36:"i32.st",0x37:"i64.st",0x39:"f64.st",0x3a:"i32.st8",0x3b:"i32.st16",0x3f:"msize",0x40:"mgrow",0x41:"i32.c",0x42:"i64.c",0x44:"f64.c",0x45:"i32.eqz",0x46:"i32.eq",0x47:"i32.ne",0x48:"lt_s",0x4a:"gt_s",0x4c:"le_s",0x4e:"ge_s",0x50:"i64.eqz",0x51:"i64.eq",0x52:"i64.ne",0x53:"i64.lt_s",0x55:"i64.gt_s",0x57:"i64.le_s",0x59:"i64.ge_s",0x61:"f64.eq",0x62:"f64.ne",0x63:"f64.lt",0x64:"f64.gt",0x65:"f64.le",0x66:"f64.ge",0x6a:"i32.add",0x6b:"i32.sub",0x6c:"i32.mul",0x71:"i32.and",0x72:"i32.or",0x73:"i32.xor",0x74:"i32.shl",0x75:"i32.shr_s",0x76:"i32.shr_u",0x7c:"i64.add",0x7d:"i64.sub",0x7e:"i64.mul",0x7f:"i64.div_s",0x81:"i64.rem_s",0x83:"i64.and",0x84:"i64.or",0x85:"i64.xor",0x86:"i64.shl",0x87:"i64.shr_s",0x88:"i64.shr_u",0x99:"f64.abs",0x9a:"f64.neg",0x9f:"f64.sqrt",0xa0:"f64.add",0xa1:"f64.sub",0xa2:"f64.mul",0xa3:"f64.div",0xa5:"f64.max",0xa7:"i32.wrap",0xaa:"trunc_f64_s",0xac:"ext_i32_s",0xad:"ext_i32_u",0xb0:"i64.trunc_f64_s",0xb7:"conv_i32_s",0xb9:"conv_i64_s",0xbf:"f64.reint",0xbd:"i64.reint",0x2a:"f32.ld",0x38:"f32.st",0xb6:"f64.demote",0xbb:"f64.promote",0xbc:"f32.reint",0xd3:"i32.reint",0xc0:"sext8",0xc1:"sext16" };
        const q = { v: p.v };
        let depth = 0;
        let count = 0;
        while (q.v < bodyEnd - 1 && count < 200000) {
          const off = q.v;
          const op = bytes[q.v++];
          let name = names[op] ?? "op_0x" + op.toString(16);
          let arg = "";
          if (op === 0x02 || op === 0x03 || op === 0x04) { const bt = sleb(q); depth++; name += " bt=" + bt; }
          else if (op === 0x05) { }
          else if (op === 0x0b) { depth--; }
          else if (op === 0x0c || op === 0x0d) { arg = " " + uleb(q); }
          else if (op === 0x0e) { const n = uleb(q); const ts: number[] = []; for (let k = 0; k < n; k++) ts.push(uleb(q)); arg = ` n=${n} [${ts.join(",")}] def=${uleb(q)}`; }
          else if (op === 0x10) { arg = " fn" + uleb(q); }
          else if (op === 0x20 || op === 0x21 || op === 0x22 || op === 0x23 || op === 0x24) { arg = " " + uleb(q); }
          else if (op >= 0x28 && op <= 0x3b) { const al = uleb(q); const off2 = uleb(q); arg = ` a=${al} o=${off2}`; }
          else if (op === 0x41) { arg = " " + sleb(q); }
          else if (op === 0x42) { let r = 0n, s = 0n, b: number; do { b = BigInt(bytes[q.v++]); r |= (b & 0x7fn) << s; s += 7n; } while (b & 0x80n); if (s < 64n && (b & 0x40n)) r |= -(1n << s); arg = " " + r; }
          else if (op === 0x44) { const dv = new DataView(bytes.buffer, bytes.byteOffset + q.v, 8); arg = " " + dv.getFloat64(0, true); q.v += 8; }
          else if (op === 0xfc) { const sub = uleb(q); name = "fc_" + sub; }
          console.log(`  ${String(count).padStart(3)} @${off}: ${name}${arg}`);
          count++;
          if (depth < 0) { console.log("  (unbalanced end)"); break; }
        }
        if (count >= 200000) console.log("  ... truncated");
      }
      p.v = bodyEnd;
    }
    break;
  }
  p.v = end;
}

// ---- mini type checker over function <target> ----
import fs2 from "node:fs";
function typecheck(file: string, targetFn: number) {
  const bytes = fs2.readFileSync(file);
  const uleb = (p: { v: number }): number => { let r = 0, s = 0; for (;;) { const x = bytes[p.v++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; } return r >>> 0; };
  const sleb = (p: { v: number }): number => { let r = 0, s = 0, b: number; do { b = bytes[p.v++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); if (s < 64 && (b & 0x40)) r |= -(1 << s); return r; };
  let p = { v: 8 };
  while (p.v < bytes.length) {
    const id = bytes[p.v]; p.v++;
    const size = uleb(p); const secEnd = p.v + size;
    if (id === 10) {
      const n = uleb(p);
      for (let i = 0; i < n; i++) {
        const bsize = uleb(p); const bodyEnd = p.v + bsize;
        const nloc = uleb(p);
        const localTypes: string[] = ["i64","i64","i64","i64"]; // params
        for (let g = 0; g < nloc; g++) { const cnt = uleb(p); const t = bytes[p.v++]; for (let k = 0; k < cnt; k++) localTypes.push(t === 0x7e ? "i64" : t === 0x7c ? "f64" : "i32"); }
        if (i === targetFn) {
          const q = { v: p.v };
          const stack: string[] = [];
          const ctrl: { kind: string; height: number; unreach: boolean }[] = [];
          let pc = 0;
          const fnTypes = (globalThis as any).__fnTypes as ((i: number) => { params: string[]; results: string[] }) | undefined;
          const pop = (want?: string): string => {
            if (ctrl.length && ctrl[ctrl.length-1].unreach) return want ?? "i64";
            const t = stack.pop();
            if (t === undefined) throw new Error(`stack underflow at ins ${pc} (last op 0x${lastOp.toString(16)}) byte@${q.v}`);
            if (want && t !== want) throw new Error(`type mismatch at ins ${pc} (last op 0x${lastOp.toString(16)}): expected ${want} got ${t}; stack=[${stack.join(",")}]`);
            return t;
          };
          let lastOp = 0;
          try {
            while (q.v < bodyEnd - 1) {
              const op = bytes[q.v++]; pc++; lastOp = op;
              switch (op) {
                case 0x00: break;
                case 0x01: break;
                case 0x02: case 0x03: case 0x04: { const bt = sleb(q); ctrl.push({ kind: op===0x03?"loop":"block", height: stack.length, unreach: false }); if (bt !== -64) stack.push(bt === 0x7e ? "i64" : bt === 0x7c ? "f64" : "i32"); break; }
                case 0x05: { const c = ctrl[ctrl.length-1]; stack.length = c.height; c.unreach = false; break; }
                case 0x0b: { const c = ctrl.pop()!; const bt = c.kind === "block" || c.kind === "if"; stack.length = c.height; if (bt && ctrl.length === 0) { /* result below */ } break; }
                case 0x0c: case 0x0f: { uleb(q); stack.length = 0; ctrl[ctrl.length-1].unreach = true; break; }
                case 0x0d: { uleb(q); pop("i32"); break; }
                case 0x0e: { const n = uleb(q); for (let k = 0; k < n + 1; k++) uleb(q); pop("i32"); stack.length = 0; ctrl[ctrl.length-1].unreach = true; break; }
                case 0x10: {
                  const fi = uleb(q);
                  if (fnTypes) {
                    const t = fnTypes(fi);
                    for (let k = t.params.length - 1; k >= 0; k--) pop(t.params[k]);
                    for (const r of t.results) stack.push(r);
                  } else {
                    pop("i64"); pop("i64"); pop("i64"); pop("i64"); pop("i64"); stack.push("i64"); stack.push("f64");
                  }
                  break;
                }
                case 0x1a: pop(); break;
                case 0x1b: { const c = pop("i32"); const v2 = pop(); const v1 = pop(); stack.push(v1); void c; void v2; break; }
                case 0x20: stack.push(localTypes[uleb(q)] ?? "?"); break;
                case 0x21: { const l = uleb(q); const want = localTypes[l] ?? "?"; const got = pop(); if (got !== want) throw new Error(`set_local ${l}: expected ${want} got ${got} at ins#${pc} byte@${q.v}`); break; }
                case 0x22: { const l = uleb(q); const want = localTypes[l] ?? "?"; const got = pop(); if (got !== want) throw new Error(`tee_local ${l}: expected ${want} got ${got} at ins#${pc}`); stack.push(got); break; }
                case 0x23: stack.push("i64"); break; // rsp global i64
                case 0x24: pop("i64"); break;
                case 0x28: case 0x2c: case 0x2d: case 0x2e: case 0x2f: uleb(q); uleb(q); pop("i32"); stack.push("i32"); break;
                case 0x2a: uleb(q); uleb(q); pop("i32"); stack.push("f32"); break;
                case 0x38: uleb(q); uleb(q); pop("i32"); pop("f32"); break;
                case 0xb6: pop("f64"); stack.push("f32"); break;
                case 0xbb: pop("f32"); stack.push("f64"); break;
                case 0xbc: pop("i32"); stack.push("f32"); break;
                case 0xd3: pop("f32"); stack.push("i32"); break;
                case 0x29: case 0x2b: uleb(q); uleb(q); pop("i32"); stack.push(op === 0x29 ? "i64" : "f64"); break;
                case 0x36: case 0x3a: case 0x3b: uleb(q); uleb(q); pop("i32"); pop("i32"); break;
                case 0x37: uleb(q); uleb(q); pop("i64"); pop("i32"); break;
                case 0x39: uleb(q); uleb(q); pop("i32"); pop("f64"); break;
                case 0x41: sleb(q); stack.push("i32"); break;
                case 0x42: { let r = 0n, s = 0n, b: number; do { b = BigInt(bytes[q.v++]); r |= (b & 0x7fn) << s; s += 7n; } while (b & 0x80n); stack.push("i64"); break; }
                case 0x44: q.v += 8; stack.push("f64"); break;
                case 0x45: pop("i32"); stack.push("i32"); break;
                case 0x50: pop("i64"); stack.push("i32"); break;
                case 0x46: case 0x47: case 0x51: case 0x52: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66: pop(); pop(); stack.push("i32"); break;
                case 0x48: case 0x4a: case 0x4c: case 0x4e: pop("i32"); pop("i32"); stack.push("i32"); break;
                case 0x53: case 0x54: case 0x55: case 0x56: case 0x57: case 0x58: case 0x59: case 0x5a: pop("i64"); pop("i64"); stack.push("i32"); break;
                case 0x6a: case 0x6b: case 0x6c: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: pop("i32"); pop("i32"); stack.push("i32"); break;
                case 0x7c: case 0x7d: case 0x7e: case 0x83: case 0x84: case 0x85: case 0x86: case 0x87: case 0x88: pop("i64"); pop("i64"); stack.push("i64"); break;
                case 0x7f: case 0x81: pop("i64"); pop("i64"); stack.push("i64"); break;
                case 0xa0: case 0xa1: case 0xa2: case 0xa3: pop("f64"); pop("f64"); stack.push("f64"); break;
                case 0x9f: case 0x9a: pop("f64"); stack.push("f64"); break;
                case 0xa7: pop("i64"); stack.push("i32"); break;
                case 0xac: case 0xad: pop("i32"); stack.push("i64"); break;
                case 0xb0: pop("f64"); stack.push("i64"); break;
                case 0xb7: case 0xb9: pop(); stack.push("f64"); break;
                case 0xbf: pop("i64"); stack.push("f64"); break;
                case 0xbd: pop("f64"); stack.push("i64"); break;
                case 0xc0: case 0xc1: pop("i32"); stack.push("i32"); break;
                default: if (op === 0xfc) { const sub = uleb(q); throw new Error(`0xfc sub ${sub} at ins#${pc}`); } throw new Error(`unknown op 0x${op.toString(16)} at ins#${pc}`); break;
              }
            }
            console.log(`fn ${targetFn}: typecheck OK (${pc} ins)`);
          } catch (e: any) {
            console.log(`fn ${targetFn}: ${e.message}`);
          }
        }
        p.v = bodyEnd;
      }
      break;
    }
    p.v = secEnd;
  }
}
// parse types + imports for the checker
{
  const bytes2 = fs2.readFileSync(process.argv[2] ?? "/tmp/t.wasm");
  const uleb2 = (p: { v: number }): number => { let r = 0, s = 0; for (;;) { const x = bytes2[p.v++]; r |= (x & 0x7f) << s; if (!(x & 0x80)) break; s += 7; } return r >>> 0; };
  const tn = (b: number) => b === 0x7e ? "i64" : b === 0x7c ? "f64" : "i32";
  const types: { params: string[]; results: string[] }[] = [];
  const ftypes: { params: string[]; results: string[] }[] = [];
  let p2 = { v: 8 };
  while (p2.v < bytes2.length) {
    const id = bytes2[p2.v]; p2.v++;
    const size = uleb2(p2); const end = p2.v + size;
    if (id === 1) {
      const n = uleb2(p2);
      for (let i = 0; i < n; i++) {
        p2.v++; // 0x60
        const np = uleb2(p2); const params: string[] = [];
        for (let k = 0; k < np; k++) { params.push(tn(bytes2[p2.v++])); }
        const nr = uleb2(p2); const results: string[] = [];
        for (let k = 0; k < nr; k++) { results.push(tn(bytes2[p2.v++])); }
        types.push({ params, results });
      }
    } else if (id === 2) {
      const n = uleb2(p2);
      for (let i = 0; i < n; i++) {
        const l1 = uleb2(p2); p2.v += l1;
        const l2 = uleb2(p2); p2.v += l2;
        const kind = bytes2[p2.v++];
        const ti = uleb2(p2);
        if (kind === 0) ftypes.push(types[ti]);
        else p2.v += kind === 1 ? 0 : 4; // table/memory skip (approx)
      }
    } else if (id === 3) {
      const n = uleb2(p2);
      for (let i = 0; i < n; i++) { ftypes.push(types[uleb2(p2)]); }
    }
    p2.v = end;
  }
  (globalThis as any).__fnTypes = (i: number) => ftypes[i] ?? { params: ["i64","i64","i64","i64","i64"], results: ["i64","f64"] };
}
typecheck(process.argv[2] ?? "/tmp/t.wasm", parseInt(process.argv[3] ?? "22", 10));
