// gex-isa: x86-64 instruction decoder for the Ichorous YYC lift.
// Decodes the MSVC-generated subset exactly; ANY unknown encoding is a hard error
// (no placeholders — the build fails with the guest VA so the subset can be extended).
export interface MemOp { base?: number; index?: number; scale: number; disp: number; riprel: boolean; size: 1 | 2 | 4 | 8 | 16 }
export type Operand =
  | { k: "reg"; r: number; size: 1 | 2 | 4 | 8 }   // GPR 0..15 (x86 order: rax,rcx,rdx,rbx,rsp,rbp,rsi,rdi,r8..r15)
  | { k: "xmm"; r: number; size: 4 | 8 | 16 }
  | { k: "mem"; m: MemOp }
  | { k: "imm"; v: number | bigint; size: 1 | 2 | 4 | 8 };

export interface Ins {
  va: number; len: number; op: string;
  o: Operand[];                    // Intel order: o[0]=destination, o[1]=source
  lock?: boolean;
}

export const GPR_NAMES = ["rax","rcx","rdx","rbx","rsp","rbp","rsi","rdi","r8","r9","r10","r11","r12","r13","r14","r15"];
const CC = ["o","no","b","ae","e","ne","be","a","s","ns","p","np","l","ge","le","g"];

export class DecodeError extends Error {
  constructor(msg: string, public va: number) { super(`${msg} @ 0x${va.toString(16)}`); }
}

interface Ctx { u8: Uint8Array; dv: DataView; p: number; va: number; base: number }

function int8(b: number): number { return (b << 24) >> 24; }
function i32(c: Ctx, p: number): number { return c.dv.getInt32(c.base + p, true); }

// decode modrm+optional sib+disp into a memory operand; returns bytes consumed
function memOp(c: Ctx, m: number, size: 1 | 2 | 4 | 8 | 16, rexB: number, rexX: number): { op: Operand; len: number } {
  const mod = m >> 6;
  if (mod === 3) throw new DecodeError("unexpected reg form", c.va);
  let idx = 1, scale = 1, index: number | undefined, base: number | undefined, disp = 0, riprel = false;
  if ((m & 7) === 4) {
    const sib = c.u8[c.base + c.p + idx]; idx++;
    scale = 1 << ((sib >> 6) & 3);
    const ix = ((sib >> 3) & 7) | (rexX << 3);
    index = ix === 4 ? undefined : ix;
    const b = (sib & 7) | (rexB << 3);
    if ((sib & 7) === 5 && mod === 0) { disp = i32(c, c.p + idx); idx += 4; }
    else base = b;
  } else {
    base = (m & 7) | (rexB << 3);
  }
  if (mod === 0) {
    if ((m & 7) === 5) { disp = i32(c, c.p + idx); idx += 4; riprel = true; base = undefined; }
  } else if (mod === 1) { disp = int8(c.u8[c.base + c.p + idx]); idx += 1; }
  else { disp = i32(c, c.p + idx); idx += 4; }
  return { op: { k: "mem", m: { base, index, scale, disp, riprel, size } }, len: idx };
}

function readRM(c: Ctx, m: number, size: 1 | 2 | 4 | 8 | 16, rexB: number, rexX: number): { op: Operand; len: number } {
  if ((m >> 6) === 3) return { op: { k: "reg", r: (m & 7) | (rexB << 3), size: size as 1 | 2 | 4 | 8 }, len: 1 };
  return memOp(c, m, size, rexB, rexX);
}
const regOf = (m: number, size: 1 | 2 | 4 | 8, rexR: number): Operand => ({ k: "reg", r: ((m >> 3) & 7) | (rexR << 3), size });

// main decoder
export function decode(u8: Uint8Array, dv: DataView, va: number, base: number, maxLen: number): Ins {
  const c: Ctx = { u8, dv, p: 0, va, base };
  let pfx66 = false, pfxF2 = false, pfxF3 = false, lock = false, rex = 0;
  for (;;) {
    const b = u8[c.base + c.p];
    if (b === 0x66) { pfx66 = true; c.p++; continue; }
    if (b === 0xf2) { pfxF2 = true; c.p++; continue; }
    if (b === 0xf3) { pfxF3 = true; c.p++; continue; }
    if (b === 0xf0) { lock = true; c.p++; continue; }
    if (b === 0x64 || b === 0x65 || b === 0x26 || b === 0x2e || b === 0x36 || b === 0x3e) { c.p++; continue; }
    if (b >= 0x40 && b <= 0x4f) { rex = b & 0x0f; c.p++; continue; }
    break;
  }
  void maxLen;
  const W: 4 | 8 = rex & 8 ? 8 : 4;
  const opb = u8[c.base + c.p];
  const start = c.p;
  const done = (op: string, o: Operand[]): Ins => ({ va, len: c.p, op, o, ...(lock ? { lock } : {}) }); // c.p starts at 0 per instruction: len includes prefixes
  const fail = (msg: string): never => {
    throw new DecodeError(msg + ` [${[...u8.slice(c.base + start, Math.min(c.base + start + 10, u8.length))].map((x) => x.toString(16).padStart(2, "0")).join(" ")}]`, va);
  };

  // ---------------- VEX (AVX) ----------------
  if (opb === 0xc4 || opb === 0xc5) {
    return decodeVEX(c, W, pfx66, pfxF2, pfxF3, start, done, fail);
  }

  // ---------------- 0F two-byte ----------------
  if (opb === 0x0f) {
    const op = u8[c.base + c.p + 1];
    c.p += 2;
    // xmm <- xmm/mem or xmm -> mem
    const sse = (name: string, size: 4 | 8 | 16, store: boolean): Ins => {
      const m = u8[c.base + c.p];
      const x: Operand = { k: "xmm", r: ((m >> 3) & 7) | (((rex >> 2) & 1) << 3), size };
      const rm = (m >> 6) === 3
        ? { op: { k: "xmm", r: (m & 7) | ((rex & 1) << 3), size } as Operand, len: 1 }
        : readRM(c, m, size, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(name, store ? [rm.op, x] : [x, rm.op]);
    };
    const sseBin = (name: string, size: 4 | 8 | 16): Ins => sse(name, size, false);
    if (op === 0x1e && u8[c.base + c.p] === 0xfa) { c.p += 1; return done("endbr64", []); }
    if (op === 0x1f) { // nop r/m
      const m = u8[c.base + c.p];
      const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
      c.p += rm.len; return done("nop", []);
    }
    if (op === 0x0b) return done("ud2", []);
    if (op === 0x10) return pfxF2 ? sse("movsd", 8, false) : pfxF3 ? sse("movss", 4, false) : pfx66 ? sse("movupd", 16, false) : sse("movups", 16, false);
    if (op === 0x12) return pfx66 ? sse("movlpd_load", 8, false) : sse("movlps_load", 8, false);
    if (op === 0x13) return pfx66 ? sse("movlpd_store", 8, true) : sse("movlps_store", 8, true);
    if (op === 0x16) return pfx66 ? sse("movhpd_load", 8, false) : sse("movhps_load", 8, false);
    if (op === 0x17) return pfx66 ? sse("movhpd_store", 8, true) : sse("movhps_store", 8, true);
    if (op === 0x11) return pfxF2 ? sse("movsd", 8, true) : pfxF3 ? sse("movss", 4, true) : pfx66 ? sse("movupd", 16, true) : sse("movups", 16, true);
    if (op === 0x28) return pfx66 ? sse("movapd", 16, false) : sse("movaps", 16, false);
    if (op === 0x29) return pfx66 ? sse("movapd", 16, true) : sse("movaps", 16, true);
    if (op === 0x2a) { // cvtsi2sd/cvtsi2ss xmm, r/m32/64
      const m = u8[c.base + c.p];
      const x: Operand = { k: "xmm", r: ((m >> 3) & 7) | (((rex >> 2) & 1) << 3), size: pfxF2 ? 8 : 4 };
      const rm = readRM(c, m, W === 8 && !pfx66 ? (pfx66 ? 4 : 8) : 4, rex & 1, (rex & 2) >> 1);
      // F2 0F 2A /r with REX.W: cvtsi2sd xmm, r64 ; without REX.W: r/m32. pfx66 never used here.
      c.p += rm.len;
      return done(pfxF2 ? "cvtsi2sd" : "cvtsi2ss", [x, rm.op]);
    }
    if (op === 0x2c || op === 0x2d) { // cvttsd2si / cvtsd2si  r64/r32 <- xmm
      const m = u8[c.base + c.p];
      const g: Operand = { k: "reg", r: ((m >> 3) & 7) | (((rex >> 2) & 1) << 3), size: W };
      const rm = (m >> 6) === 3
        ? { op: { k: "xmm", r: (m & 7) | ((rex & 1) << 3), size: pfxF2 ? 8 : 4 } as Operand, len: 1 }
        : readRM(c, m, pfxF2 ? 8 : 4, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      const name = (op === 0x2c ? "cvtts" : "cvts") + (pfxF2 ? "d2si" : "s2si");
      return done(name, [g, rm.op]);
    }
    if (op === 0x2e) return pfx66 ? sseBin("ucomisd", 8) : sseBin("ucomiss", 4);
    if (op === 0x2f) return pfx66 ? sseBin("comisd", 8) : sseBin("comiss", 4);
    if (op >= 0x80 && op <= 0x8f) { // jcc rel32
      const rel = c.dv.getInt32(c.base + c.p, true); c.p += 4;
      return done("j" + CC[op & 15], [{ k: "imm", v: BigInt(va + c.p + rel), size: 8 }]);
    }
    if (op === 0xba) { // BT group r/m, imm8
      const m = u8[c.base + c.p];
      const which = (m >> 3) & 7;
      const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      const imm = u8[c.base + c.p]; c.p += 1;
      return done(["bt", "bts", "btr", "btc"][which - 4], [rm.op, { k: "imm", v: imm, size: 1 }]);
    }
    if (op === 0xe6) return pfx66 ? fail("cvtdq2pd 66 unsupported") : sseBin("cvtdq2pd", 16);
    if (op >= 0x40 && op <= 0x4f) {
      const m = u8[c.base + c.p];
      const dst = regOf(m, W, (rex >> 2) & 1);
      const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done("cmov" + CC[op & 15], [dst, rm.op]);
    }
    if (op === 0x51) return pfxF2 ? sseBin("sqrtsd", 8) : pfxF3 ? sseBin("sqrtss", 4) : fail("packed sqrt unsupported");
    if (op === 0x54) return pfx66 ? sseBin("andpd", 16) : sseBin("andps", 16);
    if (op === 0x5a) if (!pfx66 && !pfxF2 && !pfxF3) return sseBin("cvtps2pd", 16);
    if (op === 0x55) return pfx66 ? sseBin("andnpd", 16) : fail("andnps unsupported");
    if (op === 0x56) return pfx66 ? sseBin("orpd", 16) : fail("orps unsupported");
    if (op === 0x57) return pfx66 ? sseBin("xorpd", 16) : sseBin("xorps", 16);
    if (op === 0x58) return pfxF2 ? sseBin("addsd", 8) : pfxF3 ? sseBin("addss", 4) : pfx66 ? sseBin("addpd", 16) : fail("addps unsupported");
    if (op === 0x59) return pfxF2 ? sseBin("mulsd", 8) : pfxF3 ? sseBin("mulss", 4) : pfx66 ? sseBin("mulpd", 16) : fail("mulps unsupported");
    if (op === 0x5a) return pfxF2 ? sseBin("cvtsd2ss", 8) : pfxF3 ? sseBin("cvtss2sd", 4) : pfx66 ? sseBin("cvtpd2ps", 16) : fail("cvtps2pd unsupported");
    if (op === 0x5b) return pfx66 ? sseBin("cvtdq2ps", 16) : fail("cvtps2dq unsupported");
    if (op === 0x5c) return pfxF2 ? sseBin("subsd", 8) : pfxF3 ? sseBin("subss", 4) : pfx66 ? sseBin("subpd", 16) : fail("subps unsupported");
    if (op === 0x5d) return pfxF2 ? sseBin("minsd", 8) : pfxF3 ? sseBin("minss", 4) : fail("minpd unsupported");
    if (op === 0x5f) return pfxF2 ? sseBin("maxsd", 8) : pfxF3 ? sseBin("maxss", 4) : fail("maxpd unsupported");
    if (op === 0x5e) return pfxF2 ? sseBin("divsd", 8) : pfxF3 ? sseBin("divss", 4) : pfx66 ? sseBin("divpd", 16) : fail("divps unsupported");
    if (op === 0x6e) { // movd/movq gpr/mem -> xmm
      const m = u8[c.base + c.p];
      const x: Operand = { k: "xmm", r: ((m >> 3) & 7) | (((rex >> 2) & 1) << 3), size: pfx66 ? 8 : 4 };
      const rm = readRM(c, m, pfx66 ? 8 : 4, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done("movd2x", [x, rm.op]);
    }
    if (op === 0x6f) return pfxF3 ? sse("movdqu", 16, false) : pfx66 ? sse("movdqa", 16, false) : pfxF2 ? sse("movq_x", 8, false) : fail("movq needs F2");
    if (op === 0x7e) {
      const m = u8[c.base + c.p];
      if (pfxF2) { // movq xmm/mem -> xmm  (or xmm -> xmm)
        const x: Operand = { k: "xmm", r: (m & 7) | ((rex & 1) << 3), size: 8 };
        const rm = readRM(c, m, 8, rex & 1, (rex & 2) >> 1);
        c.p += rm.len;
        return done("movq_x", [x, rm.op]);
      }
      // movd/movq xmm -> gpr/mem
      const g: Operand = ((m >> 6) === 3)
        ? regOf(m, pfx66 ? 8 : 4, rex & 1)
        : memOp(c, m, pfx66 ? 8 : 4, rex & 1, (rex & 2) >> 1).op;
      if ((m >> 6) !== 3) c.p += memOp(c, m, pfx66 ? 8 : 4, rex & 1, (rex & 2) >> 1).len;
      else c.p += 1;
      const x: Operand = { k: "xmm", r: ((m >> 3) & 7) | (((rex >> 2) & 1) << 3), size: pfx66 ? 8 : 4 };
      return done("movd2g", [g, x]);
    }
    if (op === 0x7f) return pfxF3 ? sse("movdqu", 16, true) : pfx66 ? sse("movdqa", 16, true) : pfxF2 ? sse("movq_x", 8, true) : fail("movq store needs F2");
    if (op >= 0x90 && op <= 0x9f) {
      const m = u8[c.base + c.p];
      const rm = readRM(c, m, 1, rex & 1, 0);
      c.p += rm.len;
      return done("set" + CC[op & 15], [rm.op]);
    }
    if (op === 0xaf) {
      const m = u8[c.base + c.p];
      const dst = regOf(m, W, (rex >> 2) & 1);
      const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done("imul", [dst, rm.op],);
    }
    if (op === 0xab || op === 0xb3 || op === 0xbb) { // BTS/BTR/BTC r/m, r
      const m = u8[c.base + c.p];
      const src = regOf(m, 1, (rex >> 2) & 1);
      const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(op === 0xab ? "btsr" : op === 0xb3 ? "btrr" : "btcr", [rm.op, src]);
    }
    if (op === 0xb6 || op === 0xb7 || op === 0xbe || op === 0xbf) {
      const m = u8[c.base + c.p];
      const s: 1 | 2 = op === 0xb6 || op === 0xbe ? 1 : 2;
      const dst = regOf(m, W, (rex >> 2) & 1);
      const rm = readRM(c, m, s, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(op >= 0xbe ? "movsx" : "movzx", [dst, rm.op]);
    }
    if (op === 0xc6) return pfx66 ? sseBin("shufpd", 16) : fail("shufps unsupported");
    if (op === 0xd6) return pfxF2 ? sse("movq_x", 8, true) : fail("movq store needs F2");
    if (op === 0x38 || op === 0x3a) fail("SSE4/3op 0F " + op.toString(16) + " unsupported");
    if (op === 0xa2) fail("cpuid unsupported");
    fail("unknown 0F opcode 0x" + op.toString(16));
  }

  // ---------------- one-byte ----------------
  // 0x00-0x3D arith family: low3 selects encoding, modrm reg field is a REGISTER (not /digit)
  const low3 = opb & 7;
  if (opb <= 0x3d && (low3 === 0 || low3 === 1 || low3 === 2 || low3 === 3 || low3 === 4 || low3 === 5)) {
    const name = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"][opb >> 3];
    c.p += 1;
    if (low3 === 4) { // AL, imm8
      const v = u8[c.base + c.p]; c.p += 1;
      return done(name, [{ k: "reg", r: 0, size: 1 }, { k: "imm", v, size: 1 }]);
    }
    if (low3 === 5) { // eAX, imm32 (sext to 64 with REX.W)
      const v = pfx66 ? c.dv.getInt16(c.base + c.p, true) : c.dv.getInt32(c.base + c.p, true); c.p += pfx66 ? 2 : 4;
      return done(name, [{ k: "reg", r: 0, size: W }, { k: "imm", v, size: pfx66 ? 2 : 4 }]);
    }
    const m = u8[c.base + c.p];
    const byteOp = low3 === 0 || low3 === 2;
    const size: 1 | 4 | 8 = byteOp ? 1 : W;
    if (low3 === 0 || low3 === 1) { // r/m <- reg
      const src2 = regOf(m, size, (rex >> 2) & 1);
      const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(name, [rm.op, src2]);
    } else { // reg <- r/m
      const dst = regOf(m, size, (rex >> 2) & 1);
      const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
      c.p += rm.len;
      return done(name, [dst, rm.op]);
    }
  }

  if (opb === 0x80 || opb === 0x81 || opb === 0x83) { // group 1: arith r/m, imm
    c.p += 1; const m = u8[c.base + c.p];
    const gname = ["add", "or", "adc", "sbb", "and", "sub", "xor", "cmp"][(m >> 3) & 7];
    const gsize: 1 | 2 | 4 | 8 = opb === 0x80 ? 1 : pfx66 ? 2 : W;
    const rm = readRM(c, m, gsize, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    let v: number;
    if (opb === 0x80) { v = u8[c.base + c.p]; c.p += 1; }
    else if (opb === 0x81) { v = gsize === 2 ? c.dv.getInt16(c.base + c.p, true) : c.dv.getInt32(c.base + c.p, true); c.p += gsize === 2 ? 2 : 4; }
    else { v = int8(u8[c.base + c.p]); c.p += 1; } // imm8 sign-extended
    return done(gname, [rm.op, { k: "imm", v, size: gsize }]);
  }
  if (opb >= 0x50 && opb <= 0x57) { c.p += 1; return done("push", [{ k: "reg", r: (opb & 7) | ((rex & 1) << 3), size: 8 }]); }
  if (opb >= 0x58 && opb <= 0x5f) { c.p += 1; return done("pop", [{ k: "reg", r: (opb & 7) | ((rex & 1) << 3), size: 8 }]); }
  if (opb === 0x69 || opb === 0x6b) { // imul r, r/m, imm
    c.p += 1; const m = u8[c.base + c.p];
    const dst = regOf(m, W, (rex >> 2) & 1);
    const rm = readRM(c, m, W, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    const v = opb === 0x69 ? c.dv.getInt32(c.base + c.p, true) : int8(u8[c.base + c.p]);
    c.p += opb === 0x69 ? 4 : 1;
    return done("imuli", [dst, rm.op, { k: "imm", v, size: 4 }]);
  }
  if (opb === 0x63) { // movsxd
    c.p += 1; const m = u8[c.base + c.p];
    const dst = regOf(m, W, (rex >> 2) & 1);
    const rm = readRM(c, m, 4, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("movsxd", [dst, rm.op]);
  }
  if (opb === 0x68) { c.p += 1; const v = c.dv.getInt32(c.base + c.p, true); c.p += 4; return done("push", [{ k: "imm", v, size: 4 }]); }
  if (opb === 0x6a) { c.p += 1; const v = int8(u8[c.base + c.p]); c.p += 1; return done("push", [{ k: "imm", v, size: 1 }]); }
  if (opb >= 0x70 && opb <= 0x7f) { c.p += 1; const d = int8(u8[c.base + c.p]); c.p += 1; return done("j" + CC[opb & 15], [{ k: "imm", v: BigInt(va + c.p + d), size: 8 }]); }
  if (opb === 0x84 || opb === 0x85) {
    c.p += 1; const m = u8[c.base + c.p];
    const size = opb === 0x84 ? 1 : W;
    const src = regOf(m, size, (rex >> 2) & 1);
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("test", [rm.op, src]);
  }
  if (opb === 0x86 || opb === 0x87) {
    c.p += 1; const m = u8[c.base + c.p];
    const size = opb === 0x86 ? 1 : W;
    const src = regOf(m, size, (rex >> 2) & 1);
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("xchg", [rm.op, src]);
  }
  if (opb === 0x88 || opb === 0x89) { // mov r/m <- reg
    c.p += 1; const m = u8[c.base + c.p];
    const size = opb === 0x88 ? 1 : W;
    const src = regOf(m, size, (rex >> 2) & 1);
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("mov", [rm.op, src]);
  }
  if (opb === 0x8a || opb === 0x8b) { // mov reg <- r/m
    c.p += 1; const m = u8[c.base + c.p];
    const size = opb === 0x8a ? 1 : W;
    const dst = regOf(m, size, (rex >> 2) & 1);
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("mov", [dst, rm.op]);
  }
  if (opb === 0x8d) { // lea
    c.p += 1; const m = u8[c.base + c.p];
    const dst = regOf(m, W, (rex >> 2) & 1);
    const mm = memOp(c, m, W, rex & 1, (rex & 2) >> 1);
    c.p += mm.len;
    return done("lea", [dst, mm.op]);
  }
  if (opb === 0x8f) {
    c.p += 1; const m = u8[c.base + c.p];
    const rm = readRM(c, m, 8, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done("pop", [rm.op]);
  }
  if (opb === 0x90 && !pfxF3) { c.p += 1; return done("nop", []); }
  if (opb === 0x90 && pfxF3) { c.p += 1; return done("pause", []); }
  if (opb === 0x98) { c.p += 1; return done(W === 8 ? "cdqe" : "cwde", []); }
  if (opb === 0x99) { c.p += 1; return done(W === 8 ? "cqo" : "cdq", []); }
  if (opb === 0xa8) { c.p += 1; const v = u8[c.base + c.p]; c.p += 1; return done("test", [{ k: "reg", r: 0, size: 1 }, { k: "imm", v, size: 1 }]); }
  if (opb === 0xa9) { c.p += 1; const v = pfx66 ? c.dv.getInt16(c.base + c.p, true) : c.dv.getInt32(c.base + c.p, true); c.p += pfx66 ? 2 : 4; return done("test", [{ k: "reg", r: 0, size: W }, { k: "imm", v, size: pfx66 ? 2 : 4 }]); }
  if (opb >= 0xb0 && opb <= 0xb7) { c.p += 1; const v = u8[c.base + c.p]; c.p += 1; return done("mov", [{ k: "reg", r: (opb & 7) | ((rex & 1) << 3), size: 1 }, { k: "imm", v, size: 1 }]); }
  if (opb >= 0xb8 && opb <= 0xbf) {
    c.p += 1;
    const r = (opb & 7) | ((rex & 1) << 3);
    if (W === 8 && !pfx66) { const v = c.dv.getBigInt64(c.base + c.p, true); c.p += 8; return done("mov", [{ k: "reg", r, size: 8 }, { k: "imm", v, size: 8 }]); }
    const v = pfx66 ? c.dv.getInt16(c.base + c.p, true) : c.dv.getInt32(c.base + c.p, true); c.p += pfx66 ? 2 : 4;
    return done("mov", [{ k: "reg", r, size: pfx66 ? 2 : 4 }, { k: "imm", v, size: pfx66 ? 2 : 4 }]);
  }
  if (opb === 0xc0 || opb === 0xc1 || opb === 0xd0 || opb === 0xd1 || opb === 0xd2 || opb === 0xd3) {
    c.p += 1; const m = u8[c.base + c.p];
    const sh = ["rol", "ror", "rcl", "rcr", "shl", "shr", "sal", "sar"][(m >> 3) & 7];
    const size: 1 | 4 | 8 = opb < 0xc0 ? (opb === 0xc0 ? 1 : W) : (opb === 0xd0 || opb === 0xd2) ? 1 : W;
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    let cnt: Operand;
    if (opb === 0xc0 || opb === 0xc1) { cnt = { k: "imm", v: u8[c.base + c.p], size: 1 }; c.p += 1; }
    else if (opb === 0xd0 || opb === 0xd1) cnt = { k: "imm", v: 1, size: 1 };
    else cnt = { k: "reg", r: 1, size: 1 };
    if (sh === "rol" || sh === "ror" || sh === "rcl" || sh === "rcr") fail(sh + " unsupported");
    return done(sh, [rm.op, cnt]);
  }
  if (opb === 0xc2) { c.p += 1; const n = c.dv.getUint16(c.base + c.p, true); c.p += 2; return done("ret", [{ k: "imm", v: n, size: 2 }]); }
  if (opb === 0xc3) { c.p += 1; return done("ret", []); }
  if (opb === 0xc6 || opb === 0xc7) {
    c.p += 1; const m = u8[c.base + c.p];
    const size: 1 | 2 | 4 | 8 = opb === 0xc6 ? 1 : pfx66 ? 2 : W;
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    let v: number | bigint;
    if (size === 1) { v = u8[c.base + c.p]; c.p += 1; }
    else if (size === 2) { v = c.dv.getInt16(c.base + c.p, true); c.p += 2; }
    else if (size === 4) { v = c.dv.getInt32(c.base + c.p, true); c.p += 4; }
    else { v = c.dv.getInt32(c.base + c.p, true); c.p += 4; } // mov r/m64, imm32 sign-extended
    return done("mov", [rm.op, { k: "imm", v, size }]);
  }
  if (opb === 0xc9) { c.p += 1; return done("leave", []); }
  if (opb === 0xcc) { c.p += 1; return done("int3", []); }
  if (opb === 0xe8) { c.p += 1; const rel = c.dv.getInt32(c.base + c.p, true); c.p += 4; return done("call", [{ k: "imm", v: BigInt(va + c.p + rel), size: 8 }]); }
  if (opb === 0xe9) { c.p += 1; const rel = c.dv.getInt32(c.base + c.p, true); c.p += 4; return done("jmp", [{ k: "imm", v: BigInt(va + c.p + rel), size: 8 }]); }
  if (opb === 0xeb) { c.p += 1; const rel = int8(u8[c.base + c.p]); c.p += 1; return done("jmp", [{ k: "imm", v: BigInt(va + c.p + rel), size: 8 }]); }
  if (opb === 0xf6 || opb === 0xf7) {
    c.p += 1; const m = u8[c.base + c.p];
    const form = (m >> 3) & 7;
    const size: 1 | 4 | 8 = opb === 0xf6 ? 1 : W;
    const names = ["test", "test", "not", "neg", "mul", "imul", "div", "idiv"];
    const rm = readRM(c, m, size, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    const op = names[form];
    if (form <= 1) {
      let v: number;
      if (size === 1) { v = u8[c.base + c.p]; c.p += 1; } else { v = c.dv.getInt32(c.base + c.p, true); c.p += 4; }
      return done(op, [rm.op, { k: "imm", v, size }]);
    }
    return done(op, [rm.op]);
  }
  if (opb === 0xfe) {
    c.p += 1; const m = u8[c.base + c.p];
    const form = (m >> 3) & 7;
    if (form > 1) fail("fe form " + form);
    const rm = readRM(c, m, 1, rex & 1, (rex & 2) >> 1);
    c.p += rm.len;
    return done(form === 0 ? "inc" : "dec", [rm.op]);
  }
  if (opb === 0xff) {
    c.p += 1; const m = u8[c.base + c.p];
    const form = (m >> 3) & 7;
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

// VEX (C4/C5) decoding for AVX-encoded scalar SSE — emitted by modern MSVC even for /arch:SSE2 builds.
function decodeVEX(
  c: Ctx, W: 4 | 8, _p66: boolean, _pF2: boolean, _pF3: boolean,
  start: number, done: (op: string, o: Operand[]) => Ins,
  fail: (m: string) => never,
): Ins {
  const b0 = c.u8[c.base + c.p];
  let vexlen: number, p: number, L: number, R: number, X: number, B: number, mmmmm: number;
  if (b0 === 0xc4) {
    const b1 = c.u8[c.base + c.p + 1], b2 = c.u8[c.base + c.p + 2];
    vexlen = 3;
    R = (b1 >> 7) & 1; X = (b1 >> 6) & 1; B = (b1 >> 5) & 1; mmmmm = b1 & 0x1f;
    p = b2 & 3; L = (b2 >> 2) & 1;
    c.p += vexlen;
    void W;
    if (mmmmm !== 1 && mmmmm !== 2) fail("VEX mmmmm=" + mmmmm + " unsupported");
    const op = c.u8[c.base + c.p];
    const vvvv = 15 - ((b2 >> 3) & 15);
    // unary SSE-equivalent ops with VEX: opcode maps 0F (mmmmm=1), 0F38 (2)
    const vop = (name: string, size: 4 | 8 | 16): Ins => {
      const m = c.u8[c.base + c.p];
      const dst: Operand = { k: "xmm", r: ((m >> 3) & 7) | ((R ^ 1) << 3), size };
      const v: Operand = { k: "xmm", r: vvvv, size };
      const rm = readRM(c, m, size, (B ^ 1), (X ^ 1));
      c.p += rm.len;
      return done("v" + name, [dst, v, rm.op]);
    };
    if (mmmmm === 1) {
      if (op === 0x10) return p === 2 ? vop("movsd", 8) : p === 3 ? vop("movss", 4) : p === 1 ? vop("movupd", 16) : vop("movups", 16);
      if (op === 0x11) {
        // store form: dst=rm
        const m = c.u8[c.base + c.p];
        const x: Operand = { k: "xmm", r: ((m >> 3) & 7) | ((R ^ 1) << 3), size: p === 2 ? 8 : p === 3 ? 4 : 16 };
        const rm = readRM(c, m, p === 2 ? 8 : p === 3 ? 4 : 16, (B ^ 1), (X ^ 1));
        c.p += rm.len;
        return done("v" + (p === 2 ? "movsd" : p === 3 ? "movss" : p === 1 ? "movupd" : "movups"), [rm.op, x]);
      }
      if (op === 0x2a) {
        const m = c.u8[c.base + c.p];
        const dst: Operand = { k: "xmm", r: ((m >> 3) & 7) | ((R ^ 1) << 3), size: p === 2 ? 8 : 4 };
        const v: Operand = { k: "xmm", r: vvvv, size: p === 2 ? 8 : 4 };
        const rm = readRM(c, m, p === 1 ? 8 : 4, (B ^ 1), (X ^ 1));
        c.p += rm.len;
        return done(p === 2 ? "vcvtsi2sd" : "vcvtsi2ss", [dst, v, rm.op]);
      }
      if (op === 0x2c) {
        const m = c.u8[c.base + c.p];
        const g: Operand = { k: "reg", r: ((m >> 3) & 7) | ((R ^ 1) << 3), size: p === 1 ? 8 : 4 };
        const rm = readRM(c, m, p === 2 ? 8 : 4, (B ^ 1), (X ^ 1));
        c.p += rm.len;
        return done(p === 2 ? "vcvttsd2si" : "vcvttss2si", [g, rm.op]);
      }
      if (op === 0x2e) return p === 1 ? vop("ucomisd", 8) : vop("ucomiss", 4);
      if (op === 0x2f) return p === 1 ? vop("comisd", 8) : vop("comiss", 4);
      if (op === 0x51) return p === 2 ? vop("sqrtsd", 8) : p === 3 ? vop("sqrtss", 4) : fail("vsqrtp* unsupported");
      if (op === 0x57) return p === 1 ? vop("xorpd", 16) : vop("xorps", 16);
      if (op === 0x58) return p === 2 ? vop("addsd", 8) : p === 3 ? vop("addss", 4) : p === 1 ? vop("addpd", 16) : fail("vaddps unsupported");
      if (op === 0x59) return p === 2 ? vop("mulsd", 8) : p === 3 ? vop("mulss", 4) : p === 1 ? vop("mulpd", 16) : fail("vmulps unsupported");
      if (op === 0x5a) return p === 2 ? vop("cvtsd2ss", 8) : p === 3 ? vop("cvtss2sd", 4) : fail("vcvtp* unsupported");
      if (op === 0x5c) return p === 2 ? vop("subsd", 8) : p === 3 ? vop("subss", 4) : p === 1 ? vop("subpd", 16) : fail("vsubps unsupported");
      if (op === 0x5e) return p === 2 ? vop("divsd", 8) : p === 3 ? vop("divss", 4) : p === 1 ? vop("divpd", 16) : fail("vdivps unsupported");
      if (op === 0x7e) return p === 2 ? vop("movq_x", 8) : fail("vmovd unsupported");
      if (op === 0xd6) return p === 2 ? vop("movq_x", 8) : fail("vmovq needs F2");
      fail("VEX 0F op 0x" + op.toString(16) + " unsupported");
    }
    fail("VEX mmmmm=" + mmmmm + " unsupported");
  }
  // C5: 2-byte VEX
  const b1 = c.u8[c.base + c.p + 1];
  R = (b1 >> 7) & 1; X = 1; B = 1;
  p = b1 & 3; L = (b1 >> 2) & 1;
  mmmmm = 1;
  const vvvv = 15 - ((b1 >> 3) & 15);
  c.p += 2;
  void mmmmm;
  const op = c.u8[c.base + c.p];
  const vop = (name: string, size: 4 | 8 | 16): Ins => {
    const m = c.u8[c.base + c.p];
    const dst: Operand = { k: "xmm", r: ((m >> 3) & 7) | ((R ^ 1) << 3), size };
    const v: Operand = { k: "xmm", r: vvvv, size };
    const rm = readRM(c, m, size, (B ^ 1), (X ^ 1));
    c.p += rm.len;
    return done("v" + name, [dst, v, rm.op]);
  };
  if (op === 0x10) return p === 2 ? vop("movsd", 8) : p === 3 ? vop("movss", 4) : p === 1 ? vop("movupd", 16) : vop("movups", 16);
  if (op === 0x11) {
    const m = c.u8[c.base + c.p];
    const x: Operand = { k: "xmm", r: ((m >> 3) & 7) | ((R ^ 1) << 3), size: p === 2 ? 8 : p === 3 ? 4 : 16 };
    const rm = readRM(c, m, p === 2 ? 8 : p === 3 ? 4 : 16, (B ^ 1), (X ^ 1));
    c.p += rm.len;
    return done("v" + (p === 2 ? "movsd" : p === 3 ? "movss" : p === 1 ? "movupd" : "movups"), [rm.op, x]);
  }
  if (op === 0x2a) {
    const m = c.u8[c.base + c.p];
    const dst: Operand = { k: "xmm", r: ((m >> 3) & 7) | ((R ^ 1) << 3), size: p === 2 ? 8 : 4 };
    const v: Operand = { k: "xmm", r: vvvv, size: p === 2 ? 8 : 4 };
    const rm = readRM(c, m, 4, (B ^ 1), (X ^ 1));
    c.p += rm.len;
    return done(p === 2 ? "vcvtsi2sd" : "vcvtsi2ss", [dst, v, rm.op]);
  }
  if (op === 0x2c) {
    const m = c.u8[c.base + c.p];
    const g: Operand = { k: "reg", r: ((m >> 3) & 7) | ((R ^ 1) << 3), size: 4 };
    const rm = readRM(c, m, p === 2 ? 8 : 4, (B ^ 1), (X ^ 1));
    c.p += rm.len;
    return done(p === 2 ? "vcvttsd2si" : "vcvttss2si", [g, rm.op]);
  }
  if (op === 0x2e) return p === 1 ? vop("ucomisd", 8) : vop("ucomiss", 4);
  if (op === 0x51) return p === 2 ? vop("sqrtsd", 8) : p === 3 ? vop("sqrtss", 4) : fail("vsqrtp* unsupported");
  if (op === 0x57) return p === 1 ? vop("xorpd", 16) : vop("xorps", 16);
  if (op === 0x58) return p === 2 ? vop("addsd", 8) : p === 3 ? vop("addss", 4) : fail("vaddp* unsupported");
  if (op === 0x59) return p === 2 ? vop("mulsd", 8) : p === 3 ? vop("mulss", 4) : fail("vmulp* unsupported");
  if (op === 0x5a) return p === 2 ? vop("cvtsd2ss", 8) : p === 3 ? vop("cvtss2sd", 4) : fail("vcvtp* unsupported");
  if (op === 0x5c) return p === 2 ? vop("subsd", 8) : p === 3 ? vop("subss", 4) : fail("vsubp* unsupported");
  if (op === 0x5e) return p === 2 ? vop("divsd", 8) : p === 3 ? vop("divss", 4) : fail("vdivp* unsupported");
  fail("VEX-C5 op 0x" + op.toString(16) + " unsupported");
}
