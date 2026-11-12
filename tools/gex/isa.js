const GPR_NAMES = ["rax", "rcx", "rdx", "rbx", "rsp", "rbp", "rsi", "rdi", "r8", "r9", "r10", "r11", "r12", "r13", "r14", "r15"];
const CC = ["o", "no", "b", "ae", "e", "ne", "be", "a", "s", "ns", "p", "np", "l", "ge", "le", "g"];
class DecodeError extends Error {
  constructor(msg, va) {
    super(`${msg} @ 0x${va.toString(16)}`);
    this.va = va;
  }
}
function int8(b) {
  return b << 24 >> 24;
}
function i32(c, p) {
  return c.dv.getInt32(c.base + p, true);
}
function memOp(c, m, size, rexB, rexX) {
  const mod = m >> 6;
  if (mod === 3) throw new DecodeError("unexpected reg form", c.va);
  let idx = 1, scale = 1, index, base, disp = 0, riprel = false;
  if ((m & 7) === 4) {
    const sib = c.u8[c.base + c.p + idx];
    idx++;
    scale = 1 << (sib >> 6 & 3);
    const ix = sib >> 3 & 7 | rexX << 3;
    index = ix === 4 ? void 0 : ix;
    const b = sib & 7 | rexB << 3;
    if ((sib & 7) === 5 && mod === 0) {
      disp = i32(c, c.p + idx);
      idx += 4;
    } else base = b;
  } else {
    base = m & 7 | rexB << 3;
  }
  if (mod === 0) {
    if ((m & 7) === 5) {
      disp = i32(c, c.p + idx);
      idx += 4;
      riprel = true;
      base = void 0;
    }
  } else if (mod === 1) {
    disp = int8(c.u8[c.base + c.p + idx]);
    idx += 1;
  } else {
    disp = i32(c, c.p + idx);
    idx += 4;
  }
  return { op: { k: "mem", m: { base, index, scale, disp, riprel, size } }, len: idx };
}
function readRM(c, m, size, rexB, rexX) {
  if (m >> 6 === 3) return { op: { k: "reg", r: m & 7 | rexB << 3, size }, len: 1 };
  return memOp(c, m, size, rexB, rexX);
}
const regOf = (m, size, rexR) => ({ k: "reg", r: m >> 3 & 7 | rexR << 3, size });
function decode(u8, dv, va, base, maxLen) {
  const c = { u8, dv, p: 0, va, base };
  let pfx66 = false, pfxF2 = false, pfxF3 = false, lock = false, rex = 0;
  for (; ; ) {
    const b = u8[c.base + c.p];
    if (b === 102) {
      pfx66 = true;
      c.p++;
      continue;
    }
    if (b === 242) {
      pfxF2 = true;
      c.p++;
      continue;
    }
    if (b === 243) {
      pfxF3 = true;
      c.p++;
      continue;
    }
    if (b === 240) {
      lock = true;
      c.p++;
      continue;
    }
    if (b === 100 || b === 101 || b === 38 || b === 46 || b === 54 || b === 62) {
      c.p++;
      continue;
    }
    if (b >= 64 && b <= 79) {
      rex = b & 15;
      c.p++;
      continue;
    }
    break;
  }
  void maxLen;
  const W = rex & 8 ? 8 : 4;
  const opb = u8[c.base + c.p];
  const start = c.p;
  const done = (op, o) => ({ va, len: c.p, op, o, ...lock ? { lock } : {} });
  const fail = (msg) => {
    throw new DecodeError(msg + ` [${[...u8.slice(c.base + start, Math.min(c.base + start + 10, u8.length))].map((x) => x.toString(16).padStart(2, "0")).join(" ")}]`, va);
  };
  if (opb === 196 || opb === 197) {
    return decodeVEX(c, W, pfx66, pfxF2, pfxF3, start, done, fail);
  }
  if (opb === 15) {
    const op = u8[c.base + c.p + 1];
    c.p += 2;
    const sse = (name, size, store) => {
      const m = u8[c.base + c.p];
      const x = { k: "xmm", r: m >> 3 & 7 | (rex >> 2 & 1) << 3, size };
      const rm = m >> 6 === 3 ? { op: { k: "xmm", r: m & 7 | (rex & 1) << 3, size }, len: 1 } : readRM(c, m, size, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(name, store ? [rm.op, x] : [x, rm.op]);
    };
    const sseBin = (name, size) => sse(name, size, false);
    if (op === 30 && u8[c.base + c.p] === 250) {
      c.p += 1;
      return done("endbr64", []);
    }
    if (op === 31) {
      const m = u8[c.base + c.p];
      const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done("nop", []);
    }
    if (op === 11) return done("ud2", []);
    if (op === 16) return pfxF2 ? sse("movsd", 8, false) : pfxF3 ? sse("movss", 4, false) : pfx66 ? sse("movupd", 16, false) : sse("movups", 16, false);
    if (op === 18) return pfx66 ? sse("movlpd_load", 8, false) : sse("movlps_load", 8, false);
    if (op === 19) return pfx66 ? sse("movlpd_store", 8, true) : sse("movlps_store", 8, true);
    if (op === 22) return pfx66 ? sse("movhpd_load", 8, false) : sse("movhps_load", 8, false);
    if (op === 23) return pfx66 ? sse("movhpd_store", 8, true) : sse("movhps_store", 8, true);
    if (op === 17) return pfxF2 ? sse("movsd", 8, true) : pfxF3 ? sse("movss", 4, true) : pfx66 ? sse("movupd", 16, true) : sse("movups", 16, true);
    if (op === 40) return pfx66 ? sse("movapd", 16, false) : sse("movaps", 16, false);
    if (op === 41) return pfx66 ? sse("movapd", 16, true) : sse("movaps", 16, true);
    if (op === 42) {
      const m = u8[c.base + c.p];
      const x = { k: "xmm", r: m >> 3 & 7 | (rex >> 2 & 1) << 3, size: pfxF2 ? 8 : 4 };
      const rm = readRM(c, m, W === 8 && !pfx66 ? pfx66 ? 4 : 8 : 4, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(pfxF2 ? "cvtsi2sd" : "cvtsi2ss", [x, rm.op]);
    }
    if (op === 44 || op === 45) {
      const m = u8[c.base + c.p];
      const g = { k: "reg", r: m >> 3 & 7 | (rex >> 2 & 1) << 3, size: W };
      const rm = m >> 6 === 3 ? { op: { k: "xmm", r: m & 7 | (rex & 1) << 3, size: pfxF2 ? 8 : 4 }, len: 1 } : readRM(c, m, pfxF2 ? 8 : 4, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      const name = (op === 44 ? "cvtts" : "cvts") + (pfxF2 ? "d2si" : "s2si");
      return done(name, [g, rm.op]);
    }
    if (op === 46) return pfx66 ? sseBin("ucomisd", 8) : sseBin("ucomiss", 4);
    if (op === 47) return pfx66 ? sseBin("comisd", 8) : sseBin("comiss", 4);
    if (op >= 128 && op <= 143) {
      const rel = c.dv.getInt32(c.base + c.p, true);
      c.p += 4;
      return done("j" + CC[op & 15], [{ k: "imm", v: BigInt(va + c.p + rel), size: 8 }]);
    }
    if (op === 186) {
      const m = u8[c.base + c.p];
      const which = m >> 3 & 7;
      const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      const imm = u8[c.base + c.p];
      c.p += 1;
      return done(["bt", "bts", "btr", "btc"][which - 4], [rm.op, { k: "imm", v: imm, size: 1 }]);
    }
    if (op === 230) return pfx66 ? fail("cvtdq2pd 66 unsupported") : sseBin("cvtdq2pd", 16);
    if (op >= 64 && op <= 79) {
      const m = u8[c.base + c.p];
      const dst = regOf(m, W, rex >> 2 & 1);
      const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done("cmov" + CC[op & 15], [dst, rm.op]);
    }
    if (op === 81) return pfxF2 ? sseBin("sqrtsd", 8) : pfxF3 ? sseBin("sqrtss", 4) : fail("packed sqrt unsupported");
    if (op === 84) return pfx66 ? sseBin("andpd", 16) : sseBin("andps", 16);
    if (op === 90) {
      if (!pfx66 && !pfxF2 && !pfxF3) return sseBin("cvtps2pd", 16);
    }
    if (op === 85) return pfx66 ? sseBin("andnpd", 16) : fail("andnps unsupported");
    if (op === 86) return pfx66 ? sseBin("orpd", 16) : fail("orps unsupported");
    if (op === 87) return pfx66 ? sseBin("xorpd", 16) : sseBin("xorps", 16);
    if (op === 88) return pfxF2 ? sseBin("addsd", 8) : pfxF3 ? sseBin("addss", 4) : pfx66 ? sseBin("addpd", 16) : fail("addps unsupported");
    if (op === 89) return pfxF2 ? sseBin("mulsd", 8) : pfxF3 ? sseBin("mulss", 4) : pfx66 ? sseBin("mulpd", 16) : fail("mulps unsupported");
    if (op === 90) return pfxF2 ? sseBin("cvtsd2ss", 8) : pfxF3 ? sseBin("cvtss2sd", 4) : pfx66 ? sseBin("cvtpd2ps", 16) : fail("cvtps2pd unsupported");
    if (op === 91) return pfx66 ? sseBin("cvtdq2ps", 16) : fail("cvtps2dq unsupported");
    if (op === 92) return pfxF2 ? sseBin("subsd", 8) : pfxF3 ? sseBin("subss", 4) : pfx66 ? sseBin("subpd", 16) : fail("subps unsupported");
    if (op === 93) return pfxF2 ? sseBin("minsd", 8) : pfxF3 ? sseBin("minss", 4) : fail("minpd unsupported");
    if (op === 95) return pfxF2 ? sseBin("maxsd", 8) : pfxF3 ? sseBin("maxss", 4) : fail("maxpd unsupported");
    if (op === 94) return pfxF2 ? sseBin("divsd", 8) : pfxF3 ? sseBin("divss", 4) : pfx66 ? sseBin("divpd", 16) : fail("divps unsupported");
    if (op === 110) {
      const m = u8[c.base + c.p];
      const x = { k: "xmm", r: m >> 3 & 7 | (rex >> 2 & 1) << 3, size: pfx66 ? 8 : 4 };
      const rm = readRM(c, m, pfx66 ? 8 : 4, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done("movd2x", [x, rm.op]);
    }
    if (op === 111) return pfxF3 ? sse("movdqu", 16, false) : pfx66 ? sse("movdqa", 16, false) : pfxF2 ? sse("movq_x", 8, false) : fail("movq needs F2");
    if (op === 126) {
      const m = u8[c.base + c.p];
      if (pfxF2) {
        const x2 = { k: "xmm", r: m & 7 | (rex & 1) << 3, size: 8 };
        const rm = readRM(c, m, 8, rex & 1, (rex & 2) >> 1);
        c.p += rm.len;
        return done("movq_x", [x2, rm.op]);
      }
      const g = m >> 6 === 3 ? regOf(m, pfx66 ? 8 : 4, rex & 1) : memOp(c, m, pfx66 ? 8 : 4, rex & 1, (rex & 2) >> 1).op;
      if (m >> 6 !== 3) c.p += memOp(c, m, pfx66 ? 8 : 4, rex & 1, (rex & 2) >> 1).len;
      else c.p += 1;
      const x = { k: "xmm", r: m >> 3 & 7 | (rex >> 2 & 1) << 3, size: pfx66 ? 8 : 4 };
      return done("movd2g", [g, x]);
    }
    if (op === 127) return pfxF3 ? sse("movdqu", 16, true) : pfx66 ? sse("movdqa", 16, true) : pfxF2 ? sse("movq_x", 8, true) : fail("movq store needs F2");
    if (op >= 144 && op <= 159) {
      const m = u8[c.base + c.p];
      const rm = readRM(c, m, 1, rex & 1, 0);
      c.p += rm.len;
      return done("set" + CC[op & 15], [rm.op]);
    }
    if (op === 175) {
      const m = u8[c.base + c.p];
      const dst = regOf(m, W, rex >> 2 & 1);
      const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done("imul", [dst, rm.op]);
    }
    if (op === 171 || op === 179 || op === 187) {
      const m = u8[c.base + c.p];
      const src = regOf(m, 1, rex >> 2 & 1);
      const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(op === 171 ? "btsr" : op === 179 ? "btrr" : "btcr", [rm.op, src]);
    }
    if (op === 182 || op === 183 || op === 190 || op === 191) {
      const m = u8[c.base + c.p];
      const s = op === 182 || op === 190 ? 1 : 2;
      const dst = regOf(m, W, rex >> 2 & 1);
      const rm = readRM(c, m, s, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(op >= 190 ? "movsx" : "movzx", [dst, rm.op]);
    }
    if (op === 198) return pfx66 ? sseBin("shufpd", 16) : fail("shufps unsupported");
    if (op === 214) return pfxF2 ? sse("movq_x", 8, true) : fail("movq store needs F2");
    if (op === 56 || op === 58) fail("SSE4/3op 0F " + op.toString(16) + " unsupported");
    if (op === 162) fail("cpuid unsupported");
    fail("unknown 0F opcode 0x" + op.toString(16));
  }
  const low3 = opb & 7;
  if (opb <= 61 && (low3 === 0 || low3 === 1 || low3 === 2 || low3 === 3 || low3 === 4 || low3 === 5)) {
    const name = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"][opb >> 3];
    c.p += 1;
    if (low3 === 4) {
      const v = u8[c.base + c.p];
      c.p += 1;
      return done(name, [{ k: "reg", r: 0, size: 1 }, { k: "imm", v, size: 1 }]);
    }
    if (low3 === 5) {
      const v = pfx66 ? c.dv.getInt16(c.base + c.p, true) : c.dv.getInt32(c.base + c.p, true);
      c.p += pfx66 ? 2 : 4;
      return done(name, [{ k: "reg", r: 0, size: W }, { k: "imm", v, size: pfx66 ? 2 : 4 }]);
    }
    const m = u8[c.base + c.p];
    const byteOp = low3 === 0 || low3 === 2;
    const size = byteOp ? 1 : W;
    if (low3 === 0 || low3 === 1) {
      const src2 = regOf(m, size, rex >> 2 & 1);
      const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(name, [rm.op, src2]);
    } else {
      const dst = regOf(m, size, rex >> 2 & 1);
      const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(name, [dst, rm.op]);
    }
  }
  if (opb === 128 || opb === 129 || opb === 131) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const gname = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"][m >> 3 & 7];
    const gsize = opb === 128 ? 1 : pfx66 ? 2 : W;
    const rm = readRM(c, m, gsize, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    let v;
    if (opb === 128) {
      v = u8[c.base + c.p];
      c.p += 1;
    } else if (opb === 129) {
      v = gsize === 2 ? c.dv.getInt16(c.base + c.p, true) : c.dv.getInt32(c.base + c.p, true);
      c.p += gsize === 2 ? 2 : 4;
    } else {
      v = int8(u8[c.base + c.p]);
      c.p += 1;
    }
    return done(gname, [rm.op, { k: "imm", v, size: gsize }]);
  }
  if (opb >= 80 && opb <= 87) {
    c.p += 1;
    return done("push", [{ k: "reg", r: opb & 7 | (rex & 1) << 3, size: 8 }]);
  }
  if (opb >= 88 && opb <= 95) {
    c.p += 1;
    return done("pop", [{ k: "reg", r: opb & 7 | (rex & 1) << 3, size: 8 }]);
  }
  if (opb === 105 || opb === 107) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const dst = regOf(m, W, rex >> 2 & 1);
    const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    const v = opb === 105 ? c.dv.getInt32(c.base + c.p, true) : int8(u8[c.base + c.p]);
    c.p += opb === 105 ? 4 : 1;
    return done("imuli", [dst, rm.op, { k: "imm", v, size: 4 }]);
  }
  if (opb === 99) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const dst = regOf(m, W, rex >> 2 & 1);
    const rm = readRM(c, m, 4, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("movsxd", [dst, rm.op]);
  }
  if (opb === 104) {
    c.p += 1;
    const v = c.dv.getInt32(c.base + c.p, true);
    c.p += 4;
    return done("push", [{ k: "imm", v, size: 4 }]);
  }
  if (opb === 106) {
    c.p += 1;
    const v = int8(u8[c.base + c.p]);
    c.p += 1;
    return done("push", [{ k: "imm", v, size: 1 }]);
  }
  if (opb >= 112 && opb <= 127) {
    c.p += 1;
    const d = int8(u8[c.base + c.p]);
    c.p += 1;
    return done("j" + CC[opb & 15], [{ k: "imm", v: BigInt(va + c.p + d), size: 8 }]);
  }
  if (opb === 132 || opb === 133) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const size = opb === 132 ? 1 : W;
    const src = regOf(m, size, rex >> 2 & 1);
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("test", [rm.op, src]);
  }
  if (opb === 134 || opb === 135) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const size = opb === 134 ? 1 : W;
    const src = regOf(m, size, rex >> 2 & 1);
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("xchg", [rm.op, src]);
  }
  if (opb === 136 || opb === 137) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const size = opb === 136 ? 1 : W;
    const src = regOf(m, size, rex >> 2 & 1);
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("mov", [rm.op, src]);
  }
  if (opb === 138 || opb === 139) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const size = opb === 138 ? 1 : W;
    const dst = regOf(m, size, rex >> 2 & 1);
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("mov", [dst, rm.op]);
  }
  if (opb === 141) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const dst = regOf(m, W, rex >> 2 & 1);
    const mm = memOp(c, m, W, rex & 1, (rex & 2) >> 1);
    c.p += mm.len;
    return done("lea", [dst, mm.op]);
  }
  if (opb === 143) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const rm = readRM(c, m, 8, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("pop", [rm.op]);
  }
  if (opb === 144 && !pfxF3) {
    c.p += 1;
    return done("nop", []);
  }
  if (opb === 144 && pfxF3) {
    c.p += 1;
    return done("pause", []);
  }
  if (opb === 152) {
    c.p += 1;
    return done(W === 8 ? "cdqe" : "cwde", []);
  }
  if (opb === 153) {
    c.p += 1;
    return done(W === 8 ? "cqo" : "cdq", []);
  }
  if (opb === 168) {
    c.p += 1;
    const v = u8[c.base + c.p];
    c.p += 1;
    return done("test", [{ k: "reg", r: 0, size: 1 }, { k: "imm", v, size: 1 }]);
  }
  if (opb === 169) {
    c.p += 1;
    const v = pfx66 ? c.dv.getInt16(c.base + c.p, true) : c.dv.getInt32(c.base + c.p, true);
    c.p += pfx66 ? 2 : 4;
    return done("test", [{ k: "reg", r: 0, size: W }, { k: "imm", v, size: pfx66 ? 2 : 4 }]);
  }
  if (opb >= 176 && opb <= 183) {
    c.p += 1;
    const v = u8[c.base + c.p];
    c.p += 1;
    return done("mov", [{ k: "reg", r: opb & 7 | (rex & 1) << 3, size: 1 }, { k: "imm", v, size: 1 }]);
  }
  if (opb >= 184 && opb <= 191) {
    c.p += 1;
    const r = opb & 7 | (rex & 1) << 3;
    if (W === 8 && !pfx66) {
      const v2 = c.dv.getBigInt64(c.base + c.p, true);
      c.p += 8;
      return done("mov", [{ k: "reg", r, size: 8 }, { k: "imm", v: v2, size: 8 }]);
    }
    const v = pfx66 ? c.dv.getInt16(c.base + c.p, true) : c.dv.getInt32(c.base + c.p, true);
    c.p += pfx66 ? 2 : 4;
    return done("mov", [{ k: "reg", r, size: pfx66 ? 2 : 4 }, { k: "imm", v, size: pfx66 ? 2 : 4 }]);
  }
  if (opb === 192 || opb === 193 || opb === 208 || opb === 209 || opb === 210 || opb === 211) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const sh = ["rol", "ror", "rcl", "rcr", "shl", "shr", "sal", "sar"][m >> 3 & 7];
    const size = opb < 192 ? opb === 192 ? 1 : W : opb === 208 || opb === 210 ? 1 : W;
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    let cnt;
    if (opb === 192 || opb === 193) {
      cnt = { k: "imm", v: u8[c.base + c.p], size: 1 };
      c.p += 1;
    } else if (opb === 208 || opb === 209) cnt = { k: "imm", v: 1, size: 1 };
    else cnt = { k: "reg", r: 1, size: 1 };
    if (sh === "rol" || sh === "ror" || sh === "rcl" || sh === "rcr") fail(sh + " unsupported");
    return done(sh, [rm.op, cnt]);
  }
  if (opb === 194) {
    c.p += 1;
    const n = c.dv.getUint16(c.base + c.p, true);
    c.p += 2;
    return done("ret", [{ k: "imm", v: n, size: 2 }]);
  }
  if (opb === 195) {
    c.p += 1;
    return done("ret", []);
  }
  if (opb === 198 || opb === 199) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const size = opb === 198 ? 1 : pfx66 ? 2 : W;
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    let v;
    if (size === 1) {
      v = u8[c.base + c.p];
      c.p += 1;
    } else if (size === 2) {
      v = c.dv.getInt16(c.base + c.p, true);
      c.p += 2;
    } else if (size === 4) {
      v = c.dv.getInt32(c.base + c.p, true);
      c.p += 4;
    } else {
      v = c.dv.getInt32(c.base + c.p, true);
      c.p += 4;
    }
    return done("mov", [rm.op, { k: "imm", v, size }]);
  }
  if (opb === 201) {
    c.p += 1;
    return done("leave", []);
  }
  if (opb === 204) {
    c.p += 1;
    return done("int3", []);
  }
  if (opb === 232) {
    c.p += 1;
    const rel = c.dv.getInt32(c.base + c.p, true);
    c.p += 4;
    return done("call", [{ k: "imm", v: BigInt(va + c.p + rel), size: 8 }]);
  }
  if (opb === 233) {
    c.p += 1;
    const rel = c.dv.getInt32(c.base + c.p, true);
    c.p += 4;
    return done("jmp", [{ k: "imm", v: BigInt(va + c.p + rel), size: 8 }]);
  }
  if (opb === 235) {
    c.p += 1;
    const rel = int8(u8[c.base + c.p]);
    c.p += 1;
    return done("jmp", [{ k: "imm", v: BigInt(va + c.p + rel), size: 8 }]);
  }
  if (opb === 246 || opb === 247) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const form = m >> 3 & 7;
    const size = opb === 246 ? 1 : W;
    const names = ["test", "test", "not", "neg", "mul", "imul", "div", "idiv"];
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    const op = names[form];
    if (form <= 1) {
      let v;
      if (size === 1) {
        v = u8[c.base + c.p];
        c.p += 1;
      } else {
        v = c.dv.getInt32(c.base + c.p, true);
        c.p += 4;
      }
      return done(op, [rm.op, { k: "imm", v, size }]);
    }
    return done(op, [rm.op]);
  }
  if (opb === 254) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const form = m >> 3 & 7;
    if (form > 1) fail("fe form " + form);
    const rm = readRM(c, m, 1, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done(form === 0 ? "inc" : "dec", [rm.op]);
  }
  if (opb === 255) {
    c.p += 1;
    const m = u8[c.base + c.p];
    const form = m >> 3 & 7;
    if (form === 0 || form === 1) {
      const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(form === 0 ? "inc" : "dec", [rm.op]);
    }
    if (form === 2 || form === 4) {
      const rm = readRM(c, m, 8, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(form === 2 ? "icall" : "ijmp", [rm.op]);
    }
    if (form === 6) {
      const rm = readRM(c, m, 8, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done("push", [rm.op]);
    }
    fail("ff form " + form);
  }
  fail("unknown opcode 0x" + opb.toString(16));
}
function decodeVEX(c, W, _p66, _pF2, _pF3, start, done, fail) {
  const b0 = c.u8[c.base + c.p];
  let vexlen, p, L, R, X, B, mmmmm;
  if (b0 === 196) {
    const b12 = c.u8[c.base + c.p + 1], b2 = c.u8[c.base + c.p + 2];
    vexlen = 3;
    R = b12 >> 7 & 1;
    X = b12 >> 6 & 1;
    B = b12 >> 5 & 1;
    mmmmm = b12 & 31;
    p = b2 & 3;
    L = b2 >> 2 & 1;
    c.p += vexlen;
    void W;
    if (mmmmm !== 1 && mmmmm !== 2) fail("VEX mmmmm=" + mmmmm + " unsupported");
    const op2 = c.u8[c.base + c.p];
    const vvvv2 = 15 - (b2 >> 3 & 15);
    const vop2 = (name, size) => {
      const m = c.u8[c.base + c.p];
      const dst = { k: "xmm", r: m >> 3 & 7 | (R ^ 1) << 3, size };
      const v = { k: "xmm", r: vvvv2, size };
      const rm = readRM(c, m, size, B ^ 1, X ^ 1);
      c.p += rm.len;
      return done("v" + name, [dst, v, rm.op]);
    };
    if (mmmmm === 1) {
      if (op2 === 16) return p === 2 ? vop2("movsd", 8) : p === 3 ? vop2("movss", 4) : p === 1 ? vop2("movupd", 16) : vop2("movups", 16);
      if (op2 === 17) {
        const m = c.u8[c.base + c.p];
        const x = { k: "xmm", r: m >> 3 & 7 | (R ^ 1) << 3, size: p === 2 ? 8 : p === 3 ? 4 : 16 };
        const rm = readRM(c, m, p === 2 ? 8 : p === 3 ? 4 : 16, B ^ 1, X ^ 1);
        c.p += rm.len;
        return done("v" + (p === 2 ? "movsd" : p === 3 ? "movss" : p === 1 ? "movupd" : "movups"), [rm.op, x]);
      }
      if (op2 === 42) {
        const m = c.u8[c.base + c.p];
        const dst = { k: "xmm", r: m >> 3 & 7 | (R ^ 1) << 3, size: p === 2 ? 8 : 4 };
        const v = { k: "xmm", r: vvvv2, size: p === 2 ? 8 : 4 };
        const rm = readRM(c, m, p === 1 ? 8 : 4, B ^ 1, X ^ 1);
        c.p += rm.len;
        return done(p === 2 ? "vcvtsi2sd" : "vcvtsi2ss", [dst, v, rm.op]);
      }
      if (op2 === 44) {
        const m = c.u8[c.base + c.p];
        const g = { k: "reg", r: m >> 3 & 7 | (R ^ 1) << 3, size: p === 1 ? 8 : 4 };
        const rm = readRM(c, m, p === 2 ? 8 : 4, B ^ 1, X ^ 1);
        c.p += rm.len;
        return done(p === 2 ? "vcvttsd2si" : "vcvttss2si", [g, rm.op]);
      }
      if (op2 === 46) return p === 1 ? vop2("ucomisd", 8) : vop2("ucomiss", 4);
      if (op2 === 47) return p === 1 ? vop2("comisd", 8) : vop2("comiss", 4);
      if (op2 === 81) return p === 2 ? vop2("sqrtsd", 8) : p === 3 ? vop2("sqrtss", 4) : fail("vsqrtp* unsupported");
      if (op2 === 87) return p === 1 ? vop2("xorpd", 16) : vop2("xorps", 16);
      if (op2 === 88) return p === 2 ? vop2("addsd", 8) : p === 3 ? vop2("addss", 4) : p === 1 ? vop2("addpd", 16) : fail("vaddps unsupported");
      if (op2 === 89) return p === 2 ? vop2("mulsd", 8) : p === 3 ? vop2("mulss", 4) : p === 1 ? vop2("mulpd", 16) : fail("vmulps unsupported");
      if (op2 === 90) return p === 2 ? vop2("cvtsd2ss", 8) : p === 3 ? vop2("cvtss2sd", 4) : fail("vcvtp* unsupported");
      if (op2 === 92) return p === 2 ? vop2("subsd", 8) : p === 3 ? vop2("subss", 4) : p === 1 ? vop2("subpd", 16) : fail("vsubps unsupported");
      if (op2 === 94) return p === 2 ? vop2("divsd", 8) : p === 3 ? vop2("divss", 4) : p === 1 ? vop2("divpd", 16) : fail("vdivps unsupported");
      if (op2 === 126) return p === 2 ? vop2("movq_x", 8) : fail("vmovd unsupported");
      if (op2 === 214) return p === 2 ? vop2("movq_x", 8) : fail("vmovq needs F2");
      fail("VEX 0F op 0x" + op2.toString(16) + " unsupported");
    }
    fail("VEX mmmmm=" + mmmmm + " unsupported");
  }
  const b1 = c.u8[c.base + c.p + 1];
  R = b1 >> 7 & 1;
  X = 1;
  B = 1;
  p = b1 & 3;
  L = b1 >> 2 & 1;
  mmmmm = 1;
  const vvvv = 15 - (b1 >> 3 & 15);
  c.p += 2;
  void mmmmm;
  const op = c.u8[c.base + c.p];
  const vop = (name, size) => {
    const m = c.u8[c.base + c.p];
    const dst = { k: "xmm", r: m >> 3 & 7 | (R ^ 1) << 3, size };
    const v = { k: "xmm", r: vvvv, size };
    const rm = readRM(c, m, size, B ^ 1, X ^ 1);
    c.p += rm.len;
    return done("v" + name, [dst, v, rm.op]);
  };
  if (op === 16) return p === 2 ? vop("movsd", 8) : p === 3 ? vop("movss", 4) : p === 1 ? vop("movupd", 16) : vop("movups", 16);
  if (op === 17) {
    const m = c.u8[c.base + c.p];
    const x = { k: "xmm", r: m >> 3 & 7 | (R ^ 1) << 3, size: p === 2 ? 8 : p === 3 ? 4 : 16 };
    const rm = readRM(c, m, p === 2 ? 8 : p === 3 ? 4 : 16, B ^ 1, X ^ 1);
    c.p += rm.len;
    return done("v" + (p === 2 ? "movsd" : p === 3 ? "movss" : p === 1 ? "movupd" : "movups"), [rm.op, x]);
  }
  if (op === 42) {
    const m = c.u8[c.base + c.p];
    const dst = { k: "xmm", r: m >> 3 & 7 | (R ^ 1) << 3, size: p === 2 ? 8 : 4 };
    const v = { k: "xmm", r: vvvv, size: p === 2 ? 8 : 4 };
    const rm = readRM(c, m, 4, B ^ 1, X ^ 1);
    c.p += rm.len;
    return done(p === 2 ? "vcvtsi2sd" : "vcvtsi2ss", [dst, v, rm.op]);
  }
  if (op === 44) {
    const m = c.u8[c.base + c.p];
    const g = { k: "reg", r: m >> 3 & 7 | (R ^ 1) << 3, size: 4 };
    const rm = readRM(c, m, p === 2 ? 8 : 4, B ^ 1, X ^ 1);
    c.p += rm.len;
    return done(p === 2 ? "vcvttsd2si" : "vcvttss2si", [g, rm.op]);
  }
  if (op === 46) return p === 1 ? vop("ucomisd", 8) : vop("ucomiss", 4);
  if (op === 81) return p === 2 ? vop("sqrtsd", 8) : p === 3 ? vop("sqrtss", 4) : fail("vsqrtp* unsupported");
  if (op === 87) return p === 1 ? vop("xorpd", 16) : vop("xorps", 16);
  if (op === 88) return p === 2 ? vop("addsd", 8) : p === 3 ? vop("addss", 4) : fail("vaddp* unsupported");
  if (op === 89) return p === 2 ? vop("mulsd", 8) : p === 3 ? vop("mulss", 4) : fail("vmulp* unsupported");
  if (op === 90) return p === 2 ? vop("cvtsd2ss", 8) : p === 3 ? vop("cvtss2sd", 4) : fail("vcvtp* unsupported");
  if (op === 92) return p === 2 ? vop("subsd", 8) : p === 3 ? vop("subss", 4) : fail("vsubp* unsupported");
  if (op === 94) return p === 2 ? vop("divsd", 8) : p === 3 ? vop("divss", 4) : fail("vdivp* unsupported");
  fail("VEX-C5 op 0x" + op.toString(16) + " unsupported");
}
export {
  DecodeError,
  GPR_NAMES,
  decode
};
