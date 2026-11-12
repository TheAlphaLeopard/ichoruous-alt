import fs from "node:fs";
const bytes = fs.readFileSync(process.argv[2] ?? "/tmp/t.wasm");
const target = parseInt(process.argv[3] ?? "0", 10);
const uleb = (p2) => {
  let r = 0, s = 0;
  for (; ; ) {
    const x = bytes[p2.v++];
    r |= (x & 127) << s;
    if (!(x & 128)) break;
    s += 7;
    if (s > 35) throw new Error("uleb overrun");
  }
  return r >>> 0;
};
const sleb = (p2) => {
  let r = 0, s = 0, b;
  do {
    b = bytes[p2.v++];
    r |= (b & 127) << s;
    s += 7;
  } while (b & 128);
  if (s < 64 && b & 64) r |= -(1 << s);
  return r;
};
let p = { v: 8 };
while (p.v < bytes.length) {
  const id = bytes[p.v];
  p.v++;
  const size = uleb(p);
  const end = p.v + size;
  if (id === 10) {
    const n = uleb(p);
    for (let i = 0; i < n; i++) {
      const bsize = uleb(p);
      const bodyEnd = p.v + bsize;
      const nloc = uleb(p);
      let nLocals = 0;
      for (let g = 0; g < nloc; g++) {
        const cnt = uleb(p);
        const t = bytes[p.v++];
        nLocals += cnt;
        void t;
      }
      if (i === target) {
        console.log(`function ${i}: bodySize=${bsize} locals=${nLocals}`);
        const names = { 0: "unreach", 1: "nop", 2: "block", 3: "loop", 4: "if", 5: "else", 11: "end", 12: "br", 13: "br_if", 14: "br_table", 15: "ret", 16: "call", 17: "call_ind", 26: "drop", 27: "select", 32: "l.get", 33: "l.set", 34: "l.tee", 35: "g.get", 36: "g.set", 40: "i32.ld", 41: "i64.ld", 43: "f64.ld", 44: "i32.ld8s", 45: "i32.ld8u", 46: "i32.ld16s", 47: "i32.ld16u", 54: "i32.st", 55: "i64.st", 57: "f64.st", 58: "i32.st8", 59: "i32.st16", 63: "msize", 64: "mgrow", 65: "i32.c", 66: "i64.c", 68: "f64.c", 69: "i32.eqz", 70: "i32.eq", 71: "i32.ne", 72: "lt_s", 74: "gt_s", 76: "le_s", 78: "ge_s", 80: "i64.eqz", 81: "i64.eq", 82: "i64.ne", 83: "i64.lt_s", 85: "i64.gt_s", 87: "i64.le_s", 89: "i64.ge_s", 97: "f64.eq", 98: "f64.ne", 99: "f64.lt", 100: "f64.gt", 101: "f64.le", 102: "f64.ge", 106: "i32.add", 107: "i32.sub", 108: "i32.mul", 113: "i32.and", 114: "i32.or", 115: "i32.xor", 116: "i32.shl", 117: "i32.shr_s", 118: "i32.shr_u", 124: "i64.add", 125: "i64.sub", 126: "i64.mul", 127: "i64.div_s", 129: "i64.rem_s", 131: "i64.and", 132: "i64.or", 133: "i64.xor", 134: "i64.shl", 135: "i64.shr_s", 136: "i64.shr_u", 153: "f64.abs", 154: "f64.neg", 159: "f64.sqrt", 160: "f64.add", 161: "f64.sub", 162: "f64.mul", 163: "f64.div", 165: "f64.max", 167: "i32.wrap", 170: "trunc_f64_s", 172: "ext_i32_s", 173: "ext_i32_u", 176: "i64.trunc_f64_s", 183: "conv_i32_s", 185: "conv_i64_s", 191: "f64.reint", 189: "i64.reint", 42: "f32.ld", 56: "f32.st", 182: "f64.demote", 187: "f64.promote", 188: "f32.reint", 211: "i32.reint", 192: "sext8", 193: "sext16" };
        const q = { v: p.v };
        let depth = 0;
        let count = 0;
        while (q.v < bodyEnd - 1 && count < 2e5) {
          const off = q.v;
          const op = bytes[q.v++];
          let name = names[op] ?? "op_0x" + op.toString(16);
          let arg = "";
          if (op === 2 || op === 3 || op === 4) {
            const bt = sleb(q);
            depth++;
            name += " bt=" + bt;
          } else if (op === 5) {
          } else if (op === 11) {
            depth--;
          } else if (op === 12 || op === 13) {
            arg = " " + uleb(q);
          } else if (op === 14) {
            const n2 = uleb(q);
            const ts = [];
            for (let k = 0; k < n2; k++) ts.push(uleb(q));
            arg = ` n=${n2} [${ts.join(",")}] def=${uleb(q)}`;
          } else if (op === 16) {
            arg = " fn" + uleb(q);
          } else if (op === 32 || op === 33 || op === 34 || op === 35 || op === 36) {
            arg = " " + uleb(q);
          } else if (op >= 40 && op <= 59) {
            const al = uleb(q);
            const off2 = uleb(q);
            arg = ` a=${al} o=${off2}`;
          } else if (op === 65) {
            arg = " " + sleb(q);
          } else if (op === 66) {
            let r = 0n, s = 0n, b;
            do {
              b = BigInt(bytes[q.v++]);
              r |= (b & 0x7fn) << s;
              s += 7n;
            } while (b & 0x80n);
            if (s < 64n && b & 0x40n) r |= -(1n << s);
            arg = " " + r;
          } else if (op === 68) {
            const dv = new DataView(bytes.buffer, bytes.byteOffset + q.v, 8);
            arg = " " + dv.getFloat64(0, true);
            q.v += 8;
          } else if (op === 252) {
            const sub = uleb(q);
            name = "fc_" + sub;
          }
          console.log(`  ${String(count).padStart(3)} @${off}: ${name}${arg}`);
          count++;
          if (depth < 0) {
            console.log("  (unbalanced end)");
            break;
          }
        }
        if (count >= 2e5) console.log("  ... truncated");
      }
      p.v = bodyEnd;
    }
    break;
  }
  p.v = end;
}
import fs2 from "node:fs";
function typecheck(file, targetFn) {
  const bytes2 = fs2.readFileSync(file);
  const uleb2 = (p3) => {
    let r = 0, s = 0;
    for (; ; ) {
      const x = bytes2[p3.v++];
      r |= (x & 127) << s;
      if (!(x & 128)) break;
      s += 7;
    }
    return r >>> 0;
  };
  const sleb2 = (p3) => {
    let r = 0, s = 0, b;
    do {
      b = bytes2[p3.v++];
      r |= (b & 127) << s;
      s += 7;
    } while (b & 128);
    if (s < 64 && b & 64) r |= -(1 << s);
    return r;
  };
  let p2 = { v: 8 };
  while (p2.v < bytes2.length) {
    const id = bytes2[p2.v];
    p2.v++;
    const size = uleb2(p2);
    const secEnd = p2.v + size;
    if (id === 10) {
      const n = uleb2(p2);
      for (let i = 0; i < n; i++) {
        const bsize = uleb2(p2);
        const bodyEnd = p2.v + bsize;
        const nloc = uleb2(p2);
        const localTypes = ["i64", "i64", "i64", "i64"];
        for (let g = 0; g < nloc; g++) {
          const cnt = uleb2(p2);
          const t = bytes2[p2.v++];
          for (let k = 0; k < cnt; k++) localTypes.push(t === 126 ? "i64" : t === 124 ? "f64" : "i32");
        }
        if (i === targetFn) {
          const q = { v: p2.v };
          const stack = [];
          const ctrl = [];
          let pc = 0;
          const fnTypes = globalThis.__fnTypes;
          const pop = (want) => {
            if (ctrl.length && ctrl[ctrl.length - 1].unreach) return want ?? "i64";
            const t = stack.pop();
            if (t === void 0) throw new Error(`stack underflow at ins ${pc} (last op 0x${lastOp.toString(16)}) byte@${q.v}`);
            if (want && t !== want) throw new Error(`type mismatch at ins ${pc} (last op 0x${lastOp.toString(16)}): expected ${want} got ${t}; stack=[${stack.join(",")}]`);
            return t;
          };
          let lastOp = 0;
          try {
            while (q.v < bodyEnd - 1) {
              const op = bytes2[q.v++];
              pc++;
              lastOp = op;
              switch (op) {
                case 0:
                  break;
                case 1:
                  break;
                case 2:
                case 3:
                case 4: {
                  const bt = sleb2(q);
                  ctrl.push({ kind: op === 3 ? "loop" : "block", height: stack.length, unreach: false });
                  if (bt !== -64) stack.push(bt === 126 ? "i64" : bt === 124 ? "f64" : "i32");
                  break;
                }
                case 5: {
                  const c = ctrl[ctrl.length - 1];
                  stack.length = c.height;
                  c.unreach = false;
                  break;
                }
                case 11: {
                  const c = ctrl.pop();
                  const bt = c.kind === "block" || c.kind === "if";
                  stack.length = c.height;
                  if (bt && ctrl.length === 0) {
                  }
                  break;
                }
                case 12:
                case 15: {
                  uleb2(q);
                  stack.length = 0;
                  ctrl[ctrl.length - 1].unreach = true;
                  break;
                }
                case 13: {
                  uleb2(q);
                  pop("i32");
                  break;
                }
                case 14: {
                  const n2 = uleb2(q);
                  for (let k = 0; k < n2 + 1; k++) uleb2(q);
                  pop("i32");
                  stack.length = 0;
                  ctrl[ctrl.length - 1].unreach = true;
                  break;
                }
                case 16: {
                  const fi = uleb2(q);
                  if (fnTypes) {
                    const t = fnTypes(fi);
                    for (let k = t.params.length - 1; k >= 0; k--) pop(t.params[k]);
                    for (const r of t.results) stack.push(r);
                  } else {
                    pop("i64");
                    pop("i64");
                    pop("i64");
                    pop("i64");
                    pop("i64");
                    stack.push("i64");
                    stack.push("f64");
                  }
                  break;
                }
                case 26:
                  pop();
                  break;
                case 27: {
                  const c = pop("i32");
                  const v2 = pop();
                  const v1 = pop();
                  stack.push(v1);
                  void c;
                  void v2;
                  break;
                }
                case 32:
                  stack.push(localTypes[uleb2(q)] ?? "?");
                  break;
                case 33: {
                  const l = uleb2(q);
                  const want = localTypes[l] ?? "?";
                  const got = pop();
                  if (got !== want) throw new Error(`set_local ${l}: expected ${want} got ${got} at ins#${pc} byte@${q.v}`);
                  break;
                }
                case 34: {
                  const l = uleb2(q);
                  const want = localTypes[l] ?? "?";
                  const got = pop();
                  if (got !== want) throw new Error(`tee_local ${l}: expected ${want} got ${got} at ins#${pc}`);
                  stack.push(got);
                  break;
                }
                case 35:
                  stack.push("i64");
                  break;
                // rsp global i64
                case 36:
                  pop("i64");
                  break;
                case 40:
                case 44:
                case 45:
                case 46:
                case 47:
                  uleb2(q);
                  uleb2(q);
                  pop("i32");
                  stack.push("i32");
                  break;
                case 42:
                  uleb2(q);
                  uleb2(q);
                  pop("i32");
                  stack.push("f32");
                  break;
                case 56:
                  uleb2(q);
                  uleb2(q);
                  pop("i32");
                  pop("f32");
                  break;
                case 182:
                  pop("f64");
                  stack.push("f32");
                  break;
                case 187:
                  pop("f32");
                  stack.push("f64");
                  break;
                case 188:
                  pop("i32");
                  stack.push("f32");
                  break;
                case 211:
                  pop("f32");
                  stack.push("i32");
                  break;
                case 41:
                case 43:
                  uleb2(q);
                  uleb2(q);
                  pop("i32");
                  stack.push(op === 41 ? "i64" : "f64");
                  break;
                case 54:
                case 58:
                case 59:
                  uleb2(q);
                  uleb2(q);
                  pop("i32");
                  pop("i32");
                  break;
                case 55:
                  uleb2(q);
                  uleb2(q);
                  pop("i64");
                  pop("i32");
                  break;
                case 57:
                  uleb2(q);
                  uleb2(q);
                  pop("i32");
                  pop("f64");
                  break;
                case 65:
                  sleb2(q);
                  stack.push("i32");
                  break;
                case 66: {
                  let r = 0n, s = 0n, b;
                  do {
                    b = BigInt(bytes2[q.v++]);
                    r |= (b & 0x7fn) << s;
                    s += 7n;
                  } while (b & 0x80n);
                  stack.push("i64");
                  break;
                }
                case 68:
                  q.v += 8;
                  stack.push("f64");
                  break;
                case 69:
                  pop("i32");
                  stack.push("i32");
                  break;
                case 80:
                  pop("i64");
                  stack.push("i32");
                  break;
                case 70:
                case 71:
                case 81:
                case 82:
                case 97:
                case 98:
                case 99:
                case 100:
                case 101:
                case 102:
                  pop();
                  pop();
                  stack.push("i32");
                  break;
                case 72:
                case 74:
                case 76:
                case 78:
                  pop("i32");
                  pop("i32");
                  stack.push("i32");
                  break;
                case 83:
                case 84:
                case 85:
                case 86:
                case 87:
                case 88:
                case 89:
                case 90:
                  pop("i64");
                  pop("i64");
                  stack.push("i32");
                  break;
                case 106:
                case 107:
                case 108:
                case 113:
                case 114:
                case 115:
                case 116:
                case 117:
                case 118:
                  pop("i32");
                  pop("i32");
                  stack.push("i32");
                  break;
                case 124:
                case 125:
                case 126:
                case 131:
                case 132:
                case 133:
                case 134:
                case 135:
                case 136:
                  pop("i64");
                  pop("i64");
                  stack.push("i64");
                  break;
                case 127:
                case 129:
                  pop("i64");
                  pop("i64");
                  stack.push("i64");
                  break;
                case 160:
                case 161:
                case 162:
                case 163:
                  pop("f64");
                  pop("f64");
                  stack.push("f64");
                  break;
                case 159:
                case 154:
                  pop("f64");
                  stack.push("f64");
                  break;
                case 167:
                  pop("i64");
                  stack.push("i32");
                  break;
                case 172:
                case 173:
                  pop("i32");
                  stack.push("i64");
                  break;
                case 176:
                  pop("f64");
                  stack.push("i64");
                  break;
                case 183:
                case 185:
                  pop();
                  stack.push("f64");
                  break;
                case 191:
                  pop("i64");
                  stack.push("f64");
                  break;
                case 189:
                  pop("f64");
                  stack.push("i64");
                  break;
                case 192:
                case 193:
                  pop("i32");
                  stack.push("i32");
                  break;
                default:
                  if (op === 252) {
                    const sub = uleb2(q);
                    throw new Error(`0xfc sub ${sub} at ins#${pc}`);
                  }
                  throw new Error(`unknown op 0x${op.toString(16)} at ins#${pc}`);
                  break;
              }
            }
            console.log(`fn ${targetFn}: typecheck OK (${pc} ins)`);
          } catch (e) {
            console.log(`fn ${targetFn}: ${e.message}`);
          }
        }
        p2.v = bodyEnd;
      }
      break;
    }
    p2.v = secEnd;
  }
}
{
  const bytes2 = fs2.readFileSync(process.argv[2] ?? "/tmp/t.wasm");
  const uleb2 = (p3) => {
    let r = 0, s = 0;
    for (; ; ) {
      const x = bytes2[p3.v++];
      r |= (x & 127) << s;
      if (!(x & 128)) break;
      s += 7;
    }
    return r >>> 0;
  };
  const tn = (b) => b === 126 ? "i64" : b === 124 ? "f64" : "i32";
  const types = [];
  const ftypes = [];
  let p2 = { v: 8 };
  while (p2.v < bytes2.length) {
    const id = bytes2[p2.v];
    p2.v++;
    const size = uleb2(p2);
    const end = p2.v + size;
    if (id === 1) {
      const n = uleb2(p2);
      for (let i = 0; i < n; i++) {
        p2.v++;
        const np = uleb2(p2);
        const params = [];
        for (let k = 0; k < np; k++) {
          params.push(tn(bytes2[p2.v++]));
        }
        const nr = uleb2(p2);
        const results = [];
        for (let k = 0; k < nr; k++) {
          results.push(tn(bytes2[p2.v++]));
        }
        types.push({ params, results });
      }
    } else if (id === 2) {
      const n = uleb2(p2);
      for (let i = 0; i < n; i++) {
        const l1 = uleb2(p2);
        p2.v += l1;
        const l2 = uleb2(p2);
        p2.v += l2;
        const kind = bytes2[p2.v++];
        const ti = uleb2(p2);
        if (kind === 0) ftypes.push(types[ti]);
        else p2.v += kind === 1 ? 0 : 4;
      }
    } else if (id === 3) {
      const n = uleb2(p2);
      for (let i = 0; i < n; i++) {
        ftypes.push(types[uleb2(p2)]);
      }
    }
    p2.v = end;
  }
  globalThis.__fnTypes = (i) => ftypes[i] ?? { params: ["i64", "i64", "i64", "i64", "i64"], results: ["i64", "f64"] };
}
typecheck(process.argv[2] ?? "/tmp/t.wasm", parseInt(process.argv[3] ?? "22", 10));
