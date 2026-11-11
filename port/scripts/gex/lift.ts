// gex-lift: x86-64 → wasm lifter for Ichorous YYC game functions.
// Faithful transliteration: guest registers = wasm locals, guest memory = wasm memory,
// guest rsp = wasm global (call stack lives in linear memory), win-x64 ABI preserved.
// Control flow: per-function basic-block dispatch loop (provably correct for any CFG).
import { decode, type Ins, type Operand } from "./isa.ts";
import { Wasm, OP, sleb64, ulebA } from "./wasm.ts";
import { IMAGE_BASE, type Registry, type FnEntry } from "./image.ts";

// flag bits: CF=1 ZF=2 SF=4 OF=8 PF=16
const F_CF = 1, F_ZF = 2, F_SF = 4, F_OF = 8, F_PF = 16;

// locals: params 0..3 = rcx,rdx,r8,r9 ; 4=rax 5=rbx 6=rbp 7=rsi 8=rdi 9..14=r10..r15
// 15..30 = xmm lo (f64) ; 31..46 = xmm hi (i64) ; 47 = flags(i32) ; 48=blockId(i32)
// 49,50,51 = i64 scratch ; 52 = i32 cond scratch
const RAX = 4, RBX = 5, RBP = 6, RSI = 7, RDI = 8, R10 = 9, R11 = 10, R12 = 11, R13 = 12, R14 = 13, R15 = 14;
const XLO = 15, XHI = 31, FLAGS = 47, BLOCKID = 48, SA = 49, SB = 50, SC = 51, COND = 52, FA = 53, FB = 54;
const RSPG = 0; // rsp global index

export function regLocal(r: number): number {
  switch (r) {
    case 0: return RAX;
    case 1: return 0;  // rcx = param 0
    case 2: return 1;  // rdx = param 1
    case 3: return RBX;
    case 4: return -1; // rsp → global
    case 5: return RBP;
    case 6: return RSI;
    case 7: return RDI;
    case 8: return 2;  // r8 = param 2
    case 9: return 3;  // r9 = param 3
    case 10: return R10; case 11: return R11; case 12: return R12; case 13: return R13; case 14: return R14; case 15: return R15;
  }
  throw new Error("bad reg " + r);
}

interface Block { va: number; insns: Ins[]; succs: (number | null)[]; term: "jmp" | "jcc" | "ret" | "switch" | "tailcall"; cc?: string; ijmp?: { tableVA: number; indexReg: number; count: number }; tailReg?: number }

export interface EmitCtx {
  a: number[]; f: FnEntry;
  e: (b: number) => void; u: (v: number) => void;
  i32c: (v: number) => void; i64c: (v: number | bigint) => void;
  lg: (l: number) => void; ls: (l: number) => void;
  blockDepth: (j: number) => number; exitDepth: (j: number) => number;
  idByVa: Map<number, number>; L: Lifter;
  getR: (r: number) => void; setR: (r: number) => void;
  memAddrFrom: (m: any, insVa: number) => void;
  loadI64: (o: Operand, size: 1 | 2 | 4 | 8, sext: boolean, insVa: number) => void;
  loadF64: (o: Operand, insVa: number) => void;
  storeOp: (o: Operand, size: 1 | 2 | 4 | 8, insVa: number) => void;
  loadXmmLo: (r: number) => void; loadXmmHi: (r: number) => void;
  setXmmLo: (r: number) => void; setXmmHi: (r: number) => void;
}

export class Lifter {
  wasm = new Wasm();
  abiCallCounts = new Map<number, number>();
  opCounts = new Map<string, number>();
  errors: { fn: string; msg: string }[] = [];
  liftedOk = 0; liftedFail = 0;
  fnIndexByVa = new Map<number, number>();
  dataRefs = new Set<number>();
  callTargets = new Set<number>();
  icallDisps = new Map<number, number>();

  fnByVa = new Map<number, FnEntry>();
  constructor(public reg: Registry, public mem: Uint8Array, public dv: DataView) {
    this.wasm.memoryPages = 0x300; // 48MB
    this.wasm.globals.push({ type: 0x7e, mut: true, init: 0 }); // rsp global
    reg.fns.forEach((f, i) => { this.fnIndexByVa.set(f.va, i); this.fnByVa.set(f.va, f); });
  }

  private offOf(va: number): number { return va - IMAGE_BASE; }
  bytesAt(va: number, len: number): string {
    return [...this.mem.slice(va - IMAGE_BASE, va - IMAGE_BASE + len)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  }

  liftAll(): number {
    for (const f of this.reg.fns) {
      try { this.liftFunction(f); this.liftedOk++; }
      catch (e: any) {
        this.liftedFail++;
        // stub keeps the wasm function index space aligned with registry order
        this.wasm.addFunc([0x7e, 0x7e, 0x7e, 0x7e], [0x7e, 0x7c], [], [OP.unreachable, OP.end], "g_" + f.name.replace(/[^A-Za-z0-9_@]/g, "_") + "__STUB");
        if (this.errors.length < 50) this.errors.push({ fn: f.name, msg: String(e.message ?? e).slice(0, 220) + '\nSTACK:' + (e.stack ?? '').split('\n').slice(1, 5).map((s: string) => s.trim().slice(0, 90)).join(' | ') });
      }
    }
    return this.liftedOk;
  }

  private liftFunction(f: FnEntry): number {
    const blocks = this.discoverBlocks(f);
    if (!blocks.has(f.va)) throw new Error("no entry block");
    const blockList = [...blocks.values()];
    const idByVa = new Map<number, number>();
    blockList.forEach((b, i) => idByVa.set(b.va, i));
    // rewrite jump tables: entry VA -> block id (i32 in low half; entries are 8B slots)
    for (const b of blockList) {
      if (b.term === "switch" && b.ijmp) {
        for (let n = 0; n < b.ijmp.count; n++) {
          const target = b.succs[n]!;
          const bid = idByVa.get(target);
          if (bid === undefined) throw new Error(`ijmp target 0x${target.toString(16)} not a block of ${f.name}`);
          this.dv.setInt32(b.ijmp.tableVA - IMAGE_BASE + n * 8, bid, true);
        }
      }
    }
    const body = this.emitFunctionBody(f, blockList, idByVa);
    const locals: number[][] = [
      [1, 0x7e], [1, 0x7e], [1, 0x7e], [1, 0x7e], [1, 0x7e], // rax..rdi
      [6, 0x7e],                                             // r10..r15
      [16, 0x7c], [16, 0x7e],                                // xmm lo, xmm hi
      [1, 0x7f], [1, 0x7f],                                  // flags, blockid
      [3, 0x7e], [1, 0x7f],                                  // scratch, cond
      [2, 0x7c],                                             // f64 scratch FA, FB
    ];
    return this.wasm.addFunc([0x7e, 0x7e, 0x7e, 0x7e], [0x7e, 0x7c], locals, body, "g_" + f.name.replace(/[^A-Za-z0-9_@]/g, "_"));
  }

  // ---------------- CFG ----------------
  private discoverBlocks(f: FnEntry): Map<number, Block> {
    const blocks = new Map<number, Block>();
    const queue = [f.va];
    while (queue.length) {
      const va = queue.shift()!;
      if (blocks.has(va)) continue;
      if (va < f.va || va >= f.end) throw new Error(`block 0x${va.toString(16)} outside extent of ${f.name}`);
      const insns: Ins[] = [];
      let cur = va;
      let term: Block["term"] = "ret";
      const succs: (number | null)[] = [];
      let cc: string | undefined;
      for (;;) {
        if (cur >= f.end) { term = "jmp"; succs.push(cur); queue.push(cur); break; }
        const ins = decode(this.mem, this.dv, cur, this.offOf(cur), f.end - cur);
        if (!ins || ins.op === undefined) throw new Error(`decoder returned undefined @0x${cur.toString(16)} bytes=${this.bytesAt(cur, 10)}`);
        insns.push(ins);
        this.opCounts.set(ins.op, (this.opCounts.get(ins.op) ?? 0) + 1);
        const next = cur + ins.len;
        for (const o of ins.o) if (o.k === "mem" && o.m.riprel) this.dataRefs.add(cur + o.m.disp);
        if (ins.op === "jmp") { term = "jmp"; succs.push(Number((ins.o[0] as any).v)); queue.push(Number((ins.o[0] as any).v)); break; }
        if (typeof ins.op === "string" && ins.op.length > 1 && ins.op[0] === "j" && ins.op !== "jmp") {
          const t = Number((ins.o[0] as any).v);
          term = "jcc"; cc = ins.op.slice(1); succs.push(t, next); queue.push(t); queue.push(next); break;
        }
        if (ins.op === "ret" || ins.op === "int3" || ins.op === "ud2") { term = "ret"; succs.push(null); break; }
        if (ins.op === "ijmp") {
          const mo = ins.o[0];
          if (mo.k === "reg") {
            // tail call through a register holding a guest code VA
            term = "tailcall"; succs.push(null);
            (ins as any).tailReg = (mo as any).r as number;
            break;
          }
          if (mo.k !== "mem" || mo.m.index === undefined || mo.m.scale !== 8 || mo.m.base === undefined) throw new Error(`ijmp unsupported form @0x${cur.toString(16)}`);
          let tableVA = -1;
          for (let k = insns.length - 1; k >= 0; k--) {
            const pi = insns[k];
            if (pi.op === "lea" && pi.o[0].k === "reg" && (pi.o[0] as any).r === mo.m.base && pi.o[1].k === "mem" && (pi.o[1] as any).m.riprel) {
              tableVA = cur + (pi.o[1] as any).m.disp; // rip target of the lea
              break;
            }
          }
          if (tableVA < 0) throw new Error(`ijmp table base not found @0x${cur.toString(16)}`);
          // read entries (folded code VAs)
          const entries: number[] = [];
          const tblOff = tableVA - IMAGE_BASE;
          for (let n = 0; n < 4096; n++) {
            const e = Number(this.dv.getBigInt64(tblOff + n * 8, true));
            if (e >= f.va && e < f.end) entries.push(e);
            else break;
          }
          if (entries.length === 0) throw new Error(`ijmp table empty @0x${tableVA.toString(16)}`);
          // rewrite entries as block ids (filled after idByVa known — store raw for now)
          term = "switch"; succs.push(...entries);
          (ins as any).ijmpTable = { tableVA, indexReg: mo.m.index, count: entries.length };
          for (const t of entries) queue.push(t);
          break;
        }
        if (ins.op === "call") this.callTargets.add(Number((ins.o[0] as any).v));
        if (ins.op === "icall") {
          const o = ins.o[0];
          if (o.k === "mem" && o.m.base !== undefined && o.m.index === undefined) this.icallDisps.set(o.m.disp, (this.icallDisps.get(o.m.disp) ?? 0) + 1);
        }
        cur = next;
      }
      blocks.set(va, { va, insns, succs, term, cc, ijmp: (insns[insns.length - 1] as any)?.ijmpTable, tailReg: (insns[insns.length - 1] as any)?.tailReg });
    }
    return blocks;
  }

  // ---------------- function body ----------------
  private emitFunctionBody(f: FnEntry, blockList: Block[], idByVa: Map<number, number>): number[] {
    const a: number[] = [];
    const N = blockList.length;
    const e = (b: number) => { if (typeof b !== "number") throw new Error("emit of non-opcode: " + String(b)); a.push(b); };
    const u = (v: number) => { if (typeof v !== "number") throw new Error("emit of non-uleb: " + String(v)); ulebA(a, v); };
    const i32c = (v: number) => { e(OP.i32_const); sleb64(a, v | 0); };
    const i64c = (v: number | bigint) => { e(OP.i64_const); sleb64(a, BigInt(v)); };
    const lg = (l: number) => { e(OP.local_get); u(l); };
    const ls = (l: number) => { e(OP.local_set); u(l); };
    const getR = (r: number) => { const l = regLocal(r); if (l >= 0) lg(l); else { e(OP.global_get); u(RSPG); } };
    const setR = (r: number) => { const l = regLocal(r); if (l >= 0) ls(l); else { e(OP.global_set); u(RSPG); } };
    const blockDepth = (j: number) => j;
    const exitDepth = (j: number) => j + 1;

    e(OP.block); u(0x40);       // $exit
    e(OP.loop); u(0x40);        // $dispatch
    for (let i = 0; i < N; i++) { e(OP.block); u(0x40); }  // $b0..$bN-1
    e(OP.block); u(0x40);       // $def
    lg(BLOCKID);
    e(OP.br_table);
    u(N);
    for (let i = 0; i < N; i++) u(N - i);
    u(N + 2);                    // default → $exit
    e(OP.end);                   // end $def
    for (let j = N - 1; j >= 0; j--) {
      e(OP.end);                 // close $b_j; body of b_j sits at its label
      const b = blockList[j];
      const C = this.makeCtx(f, a, e, u, i32c, i64c, lg, ls, getR, setR, blockDepth, exitDepth, idByVa);
      const nEmit = b.term === "ret" ? b.insns.length : b.insns.length - 1; // last ins is jmp/jcc terminator
      for (let k = 0; k < nEmit; k++) {
        try { this.emitIns(b.insns[k], C); }
        catch (e: any) {
          const bi = b.insns[k];
          throw new Error(`emitIns failed for "${bi.op}" @0x${bi.va.toString(16)} bytes=${this.bytesAt(bi.va, bi.len)}: ${e.message}`);
        }
      }
      if (b.term === "ret") {
        e(OP.br); u(exitDepth(j));
      } else if (b.term === "tailcall") {
        // rt_icall_reg(fnptr, rcx, rdx, r8, r9, rsp) -> (rax, xmm0)
        C.getR(b.tailReg!);
        lg(0); lg(1); lg(2); lg(3);
        e(OP.global_get); u(RSPG);
        e(OP.call); u(C.L.icallRegImportIdx());
        ls(XLO + 0); ls(RAX);
        e(OP.br); u(exitDepth(j));
      } else if (b.term === "jmp") {
        const tid = idByVa.get(b.succs[0]!);
        if (tid === undefined) throw new Error("jmp target outside fn");
        i32c(tid); ls(BLOCKID);
        e(OP.br); u(blockDepth(j));
      } else if (b.term === "switch") {
        // jump table rewritten to block ids at build time: i32.load table[idx*8] → blockId
        const t = b.ijmp!;
        const tblOff = t.tableVA - IMAGE_BASE;
        i32c(tblOff | 0);
        C.getR(t.indexReg); e(OP.i32_wrap_i64);
        i32c(8); e(OP.i32_mul); e(OP.i32_add);
        e(OP.i32_load); u(2); u(0);
        ls(BLOCKID);
        e(OP.br); u(blockDepth(j));
      } else {
        const tid = idByVa.get(b.succs[0]!), fid = idByVa.get(b.succs[1]!);
        if (tid === undefined || fid === undefined) throw new Error("jcc target outside fn");
        this.condTo(COND, b.cc!, C);
        i32c(tid); i32c(fid); lg(COND);
        e(OP.select);
        ls(BLOCKID);
        e(OP.br); u(blockDepth(j));
      }
    }
    e(OP.end); // $dispatch
    e(OP.end); // $exit
    lg(RAX); lg(XLO + 0);
    e(OP.end); // function
    return a;
  }

  private makeCtx(f: FnEntry, a: number[], e: any, u: any, i32c: any, i64c: any, lg: any, ls: any, getR: any, setR: any, blockDepth: any, exitDepth: any, idByVa: Map<number, number>): EmitCtx {
    const L = this;
    const memAddrFrom = (m: any, insVa: number) => {
      const t = m.riprel ? (insVa + m.insLen + m.disp) : -1;
      if (m.riprel) { i32c((t - IMAGE_BASE) | 0); return; }
      let has = false;
      if (m.base !== undefined) { getR(m.base); e(OP.i32_wrap_i64); has = true; }
      if (m.index !== undefined) { getR(m.index); e(OP.i32_wrap_i64); if (m.scale !== 1) { i32c(m.scale); e(OP.i32_mul); } if (has) e(OP.i32_add); has = true; }
      if (m.disp !== 0 || !has) { i32c(m.disp | 0); if (has) e(OP.i32_add); }
    };
    const addrPush = (m: any, insVa: number, insLen: number) => {
      if (m.riprel) { i32c((insVa + insLen + m.disp - IMAGE_BASE) | 0); return; }
      let has = false;
      if (m.base !== undefined) { getR(m.base); e(OP.i32_wrap_i64); has = true; }
      if (m.index !== undefined) { getR(m.index); e(OP.i32_wrap_i64); if (m.scale !== 1) { i32c(m.scale); e(OP.i32_mul); } if (has) e(OP.i32_add); has = true; }
      if (m.disp !== 0 || !has) { i32c(m.disp | 0); if (has) e(OP.i32_add); }
    };
    const loadI64 = (o: Operand, size: 1 | 2 | 4 | 8, sext: boolean, insVa: number, insLen = 0) => {
      if (o.k === "imm") {
        let v = o.v;
        if (typeof v === "bigint" && v >= BigInt(IMAGE_BASE) && v < BigInt(IMAGE_BASE + 0x2000000)) v -= BigInt(IMAGE_BASE);
        i64c(v); return;
      }
      if (o.k === "reg") { getR((o as any).r); return; }
      const m = o.m;
      addrPush(m, insVa, insLen);
      switch (size) {
        case 1: e(sext ? OP.i32_load8_s : OP.i32_load8_u); u(0); u(0); e(sext ? OP.i64_extend_i32_s : OP.i64_extend_i32_u); break;
        case 2: e(sext ? OP.i32_load16_s : OP.i32_load16_u); u(1); u(0); e(sext ? OP.i64_extend_i32_s : OP.i64_extend_i32_u); break;
        case 4: e(OP.i32_load); u(2); u(0); e(sext ? OP.i64_extend_i32_s : OP.i64_extend_i32_u); break;
        case 8: e(OP.i64_load); u(3); u(0); break;
      }
    };
    const loadF64 = (o: Operand, insVa: number, insLen = 0) => {
      if (o.k !== "mem") throw new Error(`loadF64 on non-mem operand k=${o.k} at 0x${insVa.toString(16)}`);
      const m = o.m;
      addrPush(m, insVa, insLen);
      e(OP.f64_load); u(3); u(0);
    };
    const storeI64Mem = (m: any, size: 1 | 2 | 4 | 8, insVa: number, insLen = 0) => {
      // value is on the stack; save, push address (i32), restore value, store
      ls(SA);
      addrPush(m, insVa, insLen);
      lg(SA);
      if (size === 8) { e(OP.i64_store); u(3); u(0); return; }
      e(OP.i32_wrap_i64);
      switch (size) {
        case 1: e(OP.i32_store8); u(0); u(0); break;
        case 2: e(OP.i32_store16); u(1); u(0); break;
        case 4: e(OP.i32_store); u(2); u(0); break;
      }
    };
    const writeReg = (o: Operand, size: 1 | 2 | 4 | 8) => {
      const r = (o as any).r as number;
      if (size === 8) { setR(r); return; }
      if (size === 4) { e(OP.i32_wrap_i64); e(OP.i64_extend_i32_u); setR(r); return; }
      const mask = size === 1 ? 0xffn : 0xffffn;
      ls(SB);
      getR(r);
      i64c(~mask); e(OP.i64_and);
      lg(SB); i64c(mask); e(OP.i64_and);
      e(OP.i64_or);
      setR(r);
    };
    const storeOp = (o: Operand, size: 1 | 2 | 4 | 8, insVa: number, insLen = 0) => {
      if (o.k === "reg") writeReg(o, size);
      else storeI64Mem(o.m, size, insVa, insLen);
    };
    const loadXmmLo = (r: number) => lg(XLO + r);
    const loadXmmHi = (r: number) => lg(XHI + r);
    const setXmmLo = (r: number) => ls(XLO + r);
    const setXmmHi = (r: number) => ls(XHI + r);
    return { a, f, e, u, i32c, i64c, lg, ls, blockDepth, exitDepth, idByVa, L, getR, setR, memAddrFrom, loadI64, loadF64, storeOp, loadXmmLo, loadXmmHi, setXmmLo, setXmmHi, addrPush, storeI64Mem, writeReg };
  }

  private condTo(dst: number, cc: string, C: EmitCtx) {
    const { e, lg, ls, i32c } = C;
    const bit = (m: number) => { lg(FLAGS); i32c(m); e(OP.i32_and); e(OP.i32_eqz); };
    switch (cc) {
      case "e": bit(F_ZF); break;
      case "ne": bit(F_ZF); e(OP.i32_eqz); break;
      case "b": bit(F_CF); break;
      case "ae": bit(F_CF); e(OP.i32_eqz); break;
      case "be": lg(FLAGS); i32c(F_CF | F_ZF); e(OP.i32_and); e(OP.i32_eqz); break;
      case "a": lg(FLAGS); i32c(F_CF | F_ZF); e(OP.i32_and); e(OP.i32_eqz); e(OP.i32_eqz); break;
      case "s": bit(F_SF); break;
      case "ns": bit(F_SF); e(OP.i32_eqz); break;
      case "p": bit(F_PF); break;
      case "np": bit(F_PF); e(OP.i32_eqz); break;
      case "l": bit(F_SF); bit(F_OF); e(OP.i32_xor); break;
      case "ge": bit(F_SF); bit(F_OF); e(OP.i32_xor); e(OP.i32_eqz); break;
      case "le": bit(F_ZF); bit(F_SF); bit(F_OF); e(OP.i32_xor); e(OP.i32_or); break;
      case "g": {
        bit(F_ZF); e(OP.i32_eqz);
        bit(F_SF); bit(F_OF); e(OP.i32_xor); e(OP.i32_eqz);
        e(OP.i32_and); break;
      }
      default: throw new Error("cc " + cc);
    }
    ls(dst);
  }

  // flags: cmp/sub of a (local sA) and b (local sB), masked to size
  private cmpFlagsSet(C: EmitCtx, sA: number, sB: number, size: 1 | 2 | 4 | 8) {
    const { e, lg, ls, i32c, i64c } = C;
    const mask = size === 8 ? null : BigInt((1n << BigInt(size * 8)) - 1n);
    const bits = BigInt(size * 8 - 1);
    // diff = (a - b) [& mask]
    lg(sA); lg(sB); e(OP.i64_sub);
    if (mask !== null) { i64c(mask); e(OP.i64_and); }
    ls(SC); // diff
    // zf | sf
    lg(SC); e(OP.i64_eqz);
    lg(SC); i64c(bits); e(OP.i64_shr_s); e(OP.i32_wrap_i64); i32c(F_SF); e(OP.i32_and);
    e(OP.i32_or);
    // cf = a u< b
    lg(sA); lg(sB); e(OP.i64_lt_u); i32c(F_CF); e(OP.i32_mul);
    e(OP.i32_or);
    // of = ((a^b) & (a^diff)) >> sign & 1
    lg(sA); lg(sB); e(OP.i64_xor);
    lg(sA); lg(SC); e(OP.i64_xor);
    e(OP.i64_and);
    i64c(bits); e(OP.i64_shr_s); e(OP.i32_wrap_i64); i32c(F_OF); e(OP.i32_mul);
    e(OP.i32_or);
    ls(FLAGS);
  }

  // flags for and/or/xor/test result in local sRes
  private logicFlagsSet(C: EmitCtx, sRes: number, size: 1 | 2 | 4 | 8) {
    const { e, lg, ls, i32c, i64c } = C;
    lg(sRes); e(OP.i64_eqz);
    lg(sRes); i64c(BigInt(size * 8 - 1)); e(OP.i64_shr_s); e(OP.i32_wrap_i64); i32c(F_SF); e(OP.i32_and);
    e(OP.i32_or);
    ls(FLAGS);
  }

  // flags for add/sub: result in sRes, b in sB, a in sA
  private addSubFlagsSet(C: EmitCtx, sA: number, sB: number, sRes: number, size: 1 | 2 | 4 | 8, op: "add" | "sub") {
    const { e, lg, ls, i32c, i64c } = C;
    const mask = size === 8 ? null : BigInt((1n << BigInt(size * 8)) - 1n);
    const bits = BigInt(size * 8 - 1);
    lg(sRes); e(OP.i64_eqz); // zf
    lg(sRes); i64c(bits); e(OP.i64_shr_s); e(OP.i32_wrap_i64); i32c(F_SF); e(OP.i32_and); e(OP.i32_or);
    if (op === "add") {
      // cf = res u< a (unsigned overflow)
      lg(sRes); lg(sA); e(OP.i64_lt_u); i32c(F_CF); e(OP.i32_mul); e(OP.i32_or);
      // of = (~(a^b) & (a^res)) sign
      lg(sA); lg(sB); e(OP.i64_xor); i64c(-1); e(OP.i64_xor);
      lg(sA); lg(sRes); e(OP.i64_xor);
      e(OP.i64_and);
    } else {
      // cf = a u< b
      lg(sA); lg(sB); e(OP.i64_lt_u); i32c(F_CF); e(OP.i32_mul); e(OP.i32_or);
      // of = ((a^b) & (a^res)) sign
      lg(sA); lg(sB); e(OP.i64_xor);
      lg(sA); lg(sRes); e(OP.i64_xor);
      e(OP.i64_and);
    }
    i64c(bits); e(OP.i64_shr_s); e(OP.i32_wrap_i64); i32c(F_OF); e(OP.i32_mul);
    e(OP.i32_or);
    ls(FLAGS);
    void mask;
  }

  // ---------------- instruction emission ----------------
  private emitIns(ins: Ins, C: EmitCtx) {
    const { e, u, i32c, i64c, lg, ls, getR, setR } = C;
    const L = this;
    const va = ins.va, ilen = ins.len;
    const o0 = ins.o[0], o1 = ins.o[1];
    const sizeOf = (o: Operand): 1 | 2 | 4 | 8 => o.k === "reg" ? (o as any).size : (o as any).m.size;

    switch (ins.op) {
      case "nop": case "endbr64": case "pause": case "int3": case "ud2": return;

      case "mov": {
        const size = sizeOf(o0);
        C.loadI64(o1, size, false, va, ilen);
        C.storeOp(o0, size, va, ilen);
        return;
      }
      case "movzx": {
        C.loadI64(o1, sizeOf(o1) as 1 | 2, false, va, ilen);
        C.storeOp(o0, sizeOf(o0) === 4 ? 4 : 8, va, ilen);
        return;
      }
      case "movsx": {
        C.loadI64(o1, sizeOf(o1) as 1 | 2, true, va, ilen);
        C.storeOp(o0, sizeOf(o0) === 4 ? 4 : 8, va, ilen);
        return;
      }
      case "movsxd": {
        C.loadI64(o1, 4, true, va, ilen);
        C.storeOp(o0, 8, va, ilen);
        return;
      }
      case "lea": {
        C.addrPush(o1.m, va, ilen);
        e(OP.i64_extend_i32_u);
        C.storeOp(o0, 8, va, ilen);
        return;
      }

      case "add": case "sub": case "and": case "or": case "xor": case "cmp": case "test": {
        const size = sizeOf(o0);
        const isCmpOnly = ins.op === "cmp" || ins.op === "test";
        C.loadI64(o0, size, false, va, ilen); ls(SA);
        C.loadI64(o1, size, false, va, ilen);
        const mask = size === 8 ? null : BigInt((1n << BigInt(size * 8)) - 1n);
        if (mask !== null) { i64c(mask); e(OP.i64_and); }
        ls(SB);
        if (isCmpOnly) {
          if (ins.op === "test") { lg(SA); lg(SB); e(OP.i64_and); ls(SA); L.logicFlagsSet(C, SA, size); }
          else L.cmpFlagsSet(C, SA, SB, size);
          return;
        }
        lg(SA); lg(SB);
        e(ins.op === "add" ? OP.i64_add : ins.op === "sub" ? OP.i64_sub : ins.op === "and" ? OP.i64_and : ins.op === "or" ? OP.i64_or : OP.i64_xor);
        if (mask !== null) { i64c(mask); e(OP.i64_and); }
        ls(SA);
        if (ins.op === "add" || ins.op === "sub") L.addSubFlagsSet(C, SA, SB, SA, size, ins.op as "add" | "sub");
        else L.logicFlagsSet(C, SA, size);
        lg(SA);
        C.storeOp(o0, size, va, ilen);
        return;
      }

      case "inc": case "dec": {
        const size = sizeOf(o0);
        C.loadI64(o0, size, false, va, ilen);
        i64c(1);
        e(ins.op === "inc" ? OP.i64_add : OP.i64_sub);
        const mask = size === 8 ? null : BigInt((1n << BigInt(size * 8)) - 1n);
        if (mask !== null) { i64c(mask); e(OP.i64_and); }
        ls(SA);
        lg(SA); e(OP.i64_eqz);
        lg(SA); i64c(BigInt(size * 8 - 1)); e(OP.i64_shr_s); e(OP.i32_wrap_i64); i32c(F_SF); e(OP.i32_and);
        e(OP.i32_or);
        lg(FLAGS); i32c(F_CF); e(OP.i32_and);
        e(OP.i32_or);
        ls(FLAGS);
        lg(SA);
        C.storeOp(o0, size, va, ilen);
        return;
      }
      case "neg": {
        const size = sizeOf(o0);
        C.loadI64(o0, size, false, va, ilen);
        const mask = size === 8 ? null : BigInt((1n << BigInt(size * 8)) - 1n);
        if (mask !== null) { i64c(mask); e(OP.i64_and); }
        i64c(0); e(OP.i64_sub);
        if (mask !== null) { i64c(mask); e(OP.i64_and); }
        ls(SA);
        // cf = val != 0 ; zf/sf; of = val == min (approx: skip of)
        lg(SA); e(OP.i64_eqz); e(OP.i32_eqz); i32c(F_CF); e(OP.i32_mul);
        lg(SA); e(OP.i64_eqz); i32c(F_ZF); e(OP.i32_mul); e(OP.i32_or);
        lg(SA); i64c(BigInt(size * 8 - 1)); e(OP.i64_shr_s); e(OP.i32_wrap_i64); i32c(F_SF); e(OP.i32_and); e(OP.i32_or);
        ls(FLAGS);
        lg(SA);
        C.storeOp(o0, size, va, ilen);
        return;
      }
      case "not": {
        const size = sizeOf(o0);
        C.loadI64(o0, size, false, va, ilen);
        i64c(-1); e(OP.i64_xor);
        const mask = size === 8 ? null : BigInt((1n << BigInt(size * 8)) - 1n);
        if (mask !== null) { i64c(mask); e(OP.i64_and); }
        C.storeOp(o0, size, va, ilen);
        return;
      }
      case "imuli": {
        // imul dst, r/m, imm → dst = rm * imm (low size*8 bits)
        const size = sizeOf(o0);
        C.loadI64(o1, size, true, va, ilen);
        i64c(Number((ins.o[2] as any).v));
        e(OP.i64_mul);
        const maski = size === 8 ? null : BigInt((1n << BigInt(size * 8)) - 1n);
        if (maski !== null) { i64c(maski); e(OP.i64_and); }
        C.storeOp(o0, size, va, ilen);
        lg(FLAGS); i32c(0); ls(FLAGS); // cf/of approximation (low product only)
        return;
      }
      case "imul": {
        if (o0.k === "reg" && o1 !== undefined) {
          const size = sizeOf(o0);
          C.loadI64(o0, size, true, va, ilen); ls(SA);
          C.loadI64(o1, size, true, va, ilen);
          lg(SA); e(OP.i64_mul);
          const mask = size === 8 ? null : BigInt((1n << BigInt(size * 8)) - 1n);
          if (mask !== null) { i64c(mask); e(OP.i64_and); }
          C.storeOp(o0, size, va, ilen);
          lg(FLAGS); i32c(0); ls(FLAGS); // cf/of documented approximation (low-64 product)
          return;
        }
        // F7 /5 one-operand: rdx:rax = rax * rm — approximate with rax only, rdx = sign of rax
        const size = sizeOf(o0);
        getR(0); ls(SA);
        C.loadI64(o0, size, true, va, ilen);
        lg(SA); e(OP.i64_mul);
        C.storeOp(o0, size, va, ilen);
        getR(0); i64c(63); e(OP.i64_shr_s); setR(2);
        lg(FLAGS); i32c(0); ls(FLAGS);
        return;
      }
      case "mul": {
        const size = sizeOf(o0);
        getR(0); ls(SA);
        C.loadI64(o0, size, false, va, ilen);
        lg(SA); e(OP.i64_mul);
        C.storeOp(o0, size, va, ilen);
        i64c(0); setR(2);
        lg(FLAGS); i32c(0); ls(FLAGS);
        return;
      }
      case "div": case "idiv": {
        // rax = rdx:rax / rm ; rdx = rem. Common case rdx==0 (div) / rdx==sign(rax) (idiv) → direct wasm.
        const size = sizeOf(o0);
        if (size !== 8) throw new Error("div/idiv only 64-bit supported");
        C.loadI64(o0, 8, ins.op === "idiv", va, ilen); ls(SB); // divisor
        getR(2); ls(SA); // rdx
        getR(0); // rax on stack
        lg(SA); // rdx
        if (ins.op === "div") {
          // if rdx == 0 → rax/rm else import (128-bit)
          lg(SA); e(OP.i64_eqz);
          e(OP.if); u(0x7e);
          getR(0); lg(SB); e(OP.i64_div_u);
          e(OP.else);
          getR(0); lg(SB); e(OP.call); u(L.div128ImportIdx(false));
          e(OP.drop); // drop f64 half of the (i64,f64) result
          e(OP.end);
          ls(SA); // quotient
          lg(SA); lg(SB); e(OP.i64_rem_u); setR(2); // rem (exact when rdx==0)
          lg(SA); setR(0);
          return;
        }
        // idiv: if rdx == sign-ext(rax>>63) → direct; else 128-bit import
        getR(0); i64c(63); e(OP.i64_shr_s);
        lg(SA); e(OP.i64_eq);
        e(OP.if); u(0x7e);
        getR(0); lg(SB); e(OP.i64_div_s);
        e(OP.else);
        getR(0); lg(SB); e(OP.call); u(L.div128ImportIdx(true));
        e(OP.drop);
        e(OP.end);
        ls(SA);
        lg(SA); lg(SB); e(OP.i64_rem_s); setR(2);
        lg(SA); setR(0);
        return;
      }
      case "shl": case "sal": case "shr": case "sar": {
        const size = sizeOf(o0);
        const bits = BigInt(size * 8);
        const cntMask = size === 8 ? 63n : 31n;
        C.loadI64(o0, size, false, va, ilen); ls(SA);
        C.loadI64(o1, 1, false, va, ilen);
        i64c(cntMask); e(OP.i64_and);
        ls(SB); // count
        lg(SA); lg(SB);
        e(ins.op === "shl" || ins.op === "sal" ? OP.i64_shl : ins.op === "shr" ? OP.i64_shr_u : OP.i64_shr_s);
        const mask = size === 8 ? null : BigInt((1n << BigInt(size * 8)) - 1n);
        if (mask !== null) { i64c(mask); e(OP.i64_and); }
        ls(SC); // shifted
        lg(SB); e(OP.i64_eqz); e(OP.i32_eqz); ls(COND); // cond = count != 0
        lg(SC); lg(SA); lg(COND);
        e(OP.select);
        ls(SA);
        // flags if count != 0: zf/sf from result; cf approx; else preserve
        lg(SB); e(OP.i64_eqz); e(OP.i32_eqz); ls(COND);
        lg(COND);
        e(OP.if); u(0x7f); // i32 result
        lg(SA); e(OP.i64_eqz);
        lg(SA); i64c(bits - 1n); e(OP.i64_shr_s); e(OP.i32_wrap_i64); i32c(F_SF); e(OP.i32_and); e(OP.i32_or);
        e(OP.else);
        lg(FLAGS); i32c(F_CF | F_ZF | F_SF | F_OF | F_PF); e(OP.i32_and); // preserve (approx: keep non-cf bits)
        e(OP.end);
        ls(FLAGS);
        lg(SA);
        C.storeOp(o0, size, va, ilen);
        return;
      }
      case "push": {
        C.loadI64(o0, 8, false, va, ilen);
        e(OP.global_get); u(RSPG); i64c(8); e(OP.i64_sub); e(OP.global_set); u(RSPG);
        C.storeI64Mem({ base: 4, scale: 1, disp: 0, riprel: false, size: 8 }, 8, va, ilen);
        return;
      }
      case "pop": {
        C.loadI64({ k: "mem", m: { base: 4, scale: 1, disp: 0, riprel: false, size: 8 } }, 8, false, va, ilen);
        e(OP.global_get); u(RSPG); i64c(8); e(OP.i64_add); e(OP.global_set); u(RSPG);
        C.storeOp(o0, 8, va, ilen);
        return;
      }
      case "ret": {
        if (o0) {
          e(OP.global_get); u(RSPG);
          i64c(Number((o0 as any).v));
          e(OP.i64_add);
          e(OP.global_set); u(RSPG);
        }
        return;
      }
      case "call": {
        const t = Number((o0 as any).v);
        e(OP.global_get); u(RSPG); i64c(8); e(OP.i64_sub); e(OP.global_set); u(RSPG);
        lg(0); lg(1); lg(2); lg(3);
        e(OP.global_get); u(RSPG);
        const gfn = L.fnByVa.get(t);
        const idx = gfn !== undefined ? L.fnIndexByVa.get(gfn.va)! : L.abiImportFor(t);
        e(OP.call); u(idx);
        ls(XLO + 0); ls(RAX);
        e(OP.global_get); u(RSPG); i64c(8); e(OP.i64_add); e(OP.global_set); u(RSPG);
        return;
      }
      case "icall": {
        const m = o0.m;
        if (m.index !== undefined || m.scale !== 1 || m.riprel) throw new Error("unsupported icall form");
        // vtbl = [base]; call abi.icall(self=base, vtbl, disp, rcx, rdx, r8, r9)
        C.loadI64({ k: "mem", m: { base: m.base, scale: 1, disp: 0, riprel: false, size: 8 } }, 8, false, va, ilen); // vtbl
        getR(m.base!); // self
        i64c(m.disp);
        lg(0); lg(1); lg(2); lg(3);
        e(OP.call); u(L.icallImportIdx());
        ls(XLO + 0); ls(RAX);
        return;
      }
      case "cdq": {
        getR(0); e(OP.i32_wrap_i64); i32c(31); e(OP.i32_shr_s); e(OP.i64_extend_i32_s); setR(2);
        return;
      }
      case "cqo": {
        getR(0); i64c(63); e(OP.i64_shr_s); setR(2);
        return;
      }
      case "cdqe": { getR(0); e(OP.i32_wrap_i64); e(OP.i64_extend_i32_s); setR(0); return; }
      case "cwde": { getR(0); e(OP.i32_wrap_i64); e(OP.sign_extend_16); e(OP.i64_extend_i32_s); setR(0); return; }
      case "leave": {
        getR(5); e(OP.global_set); u(RSPG);
        C.loadI64({ k: "mem", m: { base: 4, scale: 1, disp: 0, riprel: false, size: 8 } }, 8, false, va, ilen);
        e(OP.global_get); u(RSPG); i64c(8); e(OP.i64_add); e(OP.global_set); u(RSPG);
        setR(5);
        return;
      }
      case "xchg": {
        const size = sizeOf(o0);
        C.loadI64(o0, size, false, va, ilen); ls(SA);
        C.loadI64(o1, size, false, va, ilen);
        C.storeOp(o0, size, va, ilen);
        lg(SA);
        C.storeOp(o1, size, va, ilen);
        return;
      }
      case "bt": {
        const size = sizeOf(o0);
        C.loadI64(o0, size, false, va, ilen);
        i64c(Number((o1 as any).v));
        e(OP.i64_shr_u); e(OP.i64_eqz); e(OP.i32_eqz);
        i32c(F_CF); e(OP.i32_mul);
        lg(FLAGS); i32c(~F_CF & 0x1f); e(OP.i32_and);
        e(OP.i32_or); ls(FLAGS);
        return;
      }
      case "bts": case "btr": case "btc": {
        // cf = old bit; modify bit
        const size = sizeOf(o0);
        C.loadI64(o0, size, false, va, ilen); ls(SA);
        lg(SA); i64c(Number((o1 as any).v)); e(OP.i64_shr_u); e(OP.i64_eqz); e(OP.i32_eqz); // old bit
        i32c(F_CF); e(OP.i32_mul);
        lg(FLAGS); i32c(~F_CF & 0x1f); e(OP.i32_and);
        e(OP.i32_or); ls(FLAGS);
        const bitv = 1n << (BigInt(Number((o1 as any).v)) & 63n);
        lg(SA);
        if (ins.op === "bts") { i64c(bitv); e(OP.i64_or); }
        else if (ins.op === "btr") { i64c(~bitv); e(OP.i64_and); }
        else { lg(SA); ls(SC); lg(SC); i64c(bitv); e(OP.i64_and); e(OP.i64_eqz); e(OP.i64_extend_i32_u); i64c(bitv); e(OP.i64_mul); e(OP.i64_xor); }
        C.storeOp(o0, size, va, ilen);
        return;
      }
      case "btsr": case "btrr": case "btcr": {
        const size = sizeOf(o0);
        C.loadI64(o0, size, false, va, ilen); ls(SA);
        C.loadI64(o1, 1, false, va, ilen); // bit index (0..63)
        ls(SC);
        // cf = (val >> idx) & 1
        lg(SA); lg(SC); e(OP.i64_shr_u); e(OP.i64_eqz); e(OP.i32_eqz);
        i32c(F_CF); e(OP.i32_mul);
        lg(FLAGS); i32c(~F_CF & 0x1f); e(OP.i32_and);
        e(OP.i32_or); ls(FLAGS);
        // modify
        lg(SA); lg(SC);
        i64c(1n); e(OP.i64_shl); // mask
        if (ins.op === "btsr") e(OP.i64_or);
        else if (ins.op === "btrr") { ls(SC); i64c(-1); e(OP.i64_xor); ls(SC); lg(SA); lg(SC); e(OP.i64_and); }
        else { ls(SC); lg(SA); lg(SC); e(OP.i64_and); e(OP.i64_eqz); e(OP.i64_extend_i32_u); i64c(1n); lg(SC); e(OP.i64_shl); e(OP.i64_xor); }
        C.storeOp(o0, size, va, ilen);
        return;
      }
      case "shld": case "shrd": case "lock": {
        throw new Error(`${ins.op} unsupported @0x${va.toString(16)}`);
      }
      // ---------------- SSE ----------------
      case "movhps_load": case "movhpd_load": {
        const xr = (o0 as any).r as number;
        if (o1.k === "xmm") { C.loadXmmHi((o1 as any).r); C.setXmmHi(xr); return; } // movhlps
        C.loadI64(o1, 8, false, va, ilen);
        C.setXmmHi(xr);
        return;
      }
      case "movlps_load": case "movlpd_load": {
        const xr = (o0 as any).r as number;
        C.loadF64(o1, va, ilen);
        C.setXmmLo(xr);
        return;
      }
      case "movhps_store": case "movhpd_store": {
        const xr = (o1 as any).r as number;
        C.loadXmmHi(xr);
        C.storeI64Mem(o0.m, 8, va, ilen);
        return;
      }
      case "movlps_store": case "movlpd_store": {
        const xr = (o1 as any).r as number;
        C.loadXmmLo(xr); e(OP.i64_reinterpret_f64);
        C.storeI64Mem(o0.m, 8, va, ilen);
        return;
      }
      case "movd2x": {
        const xr = (o0 as any).r as number;
        const srcSize = o1.k === "reg" ? (o1 as any).size as 1 | 2 | 4 | 8 : o1.m.size as 1 | 2 | 4 | 8;
        C.loadI64(o1, srcSize, false, va, ilen);
        e(OP.f64_reinterpret_i64);
        C.setXmmLo(xr);
        i64c(0); C.setXmmHi(xr);
        return;
      }
      case "movsd": case "movupd": case "movups": case "movaps": case "movapd": case "movdqa": case "movdqu": case "movq_x": {
        const store = o0.k === "mem";
        const xr = store ? (o1 as any).r as number : (o0 as any).r as number;
        const full16 = ["movupd", "movups", "movaps", "movapd", "movdqa", "movdqu"].includes(ins.op);
        if (store) {
          const m = o0.m;
          if (m.size === 8 || ins.op === "movsd" || ins.op === "movq_x") {
            C.loadXmmLo(xr);
            e(OP.i64_reinterpret_f64);
            C.storeI64Mem(m, 8, va, ilen);
          } else {
            C.loadXmmLo(xr); e(OP.i64_reinterpret_f64);
            C.storeI64Mem(m, 8, va, ilen);
            C.loadXmmHi(xr);
            C.storeI64Mem({ ...m, disp: m.disp + 8 }, 8, va, ilen);
          }
          return;
        }
        if (o1.k === "xmm") {
          const src = (o1 as any).r as number;
          C.loadXmmLo(src); C.setXmmLo(xr);
          if (full16 || ins.op === "movd2x") {
            if (full16) { C.loadXmmHi(src); C.setXmmHi(xr); }
            else { i64c(0); C.setXmmHi(xr); }
          } else if (ins.op === "movsd") {
            // high unchanged
          } else {
            i64c(0); C.setXmmHi(xr); // movq reg-reg clears high
          }
          return;
        }
        // from memory
        const m = o1.m;
        if (m.size === 8 || ins.op === "movsd" || ins.op === "movq_x") {
          C.loadF64(o1, va, ilen); C.setXmmLo(xr);
          if (ins.op !== "movsd") { i64c(0); C.setXmmHi(xr); } // movq clears high; movsd keeps
          else if (full16) { i64c(0); C.setXmmHi(xr); }
        } else {
          C.loadF64(o1, va, ilen); C.setXmmLo(xr);
          C.loadI64({ k: "mem", m: { ...m, disp: m.disp + 8 } }, 8, false, va, ilen); C.setXmmHi(xr);
        }
        return;
      }
      case "movq_x_store": case "movd2g": {
        if (ins.op === "movq_x_store") {
          const m = o0.m;
          const xr = (o1 as any).r as number;
          C.loadXmmLo(xr); e(OP.i64_reinterpret_f64);
          C.storeI64Mem(m, 8, va, ilen);
          return;
        }
        // movd2g: gpr = xmm low 32/64
        const xr = (o1 as any).r as number;
        const size = sizeOf(o0) as 1 | 2 | 4 | 8;
        C.loadXmmLo(xr); e(OP.i64_reinterpret_f64);
        C.storeOp(o0, size, va, ilen);
        return;
      }
      case "addsd": case "subsd": case "mulsd": case "divsd": case "sqrtsd": case "addss": case "subss": case "mulss": case "divss": case "sqrtss": {
        const isSS = ins.op.endsWith("ss");
        const xr = (o0 as any).r as number;
        const base = ins.op.slice(0, -2);
        const opm = { add: OP.f64_add, sub: OP.f64_sub, mul: OP.f64_mul, div: OP.f64_div, sqrt: OP.f64_sqrt }[base]!;
        if (base === "sqrt") {
          C.loadXmmLo(xr);
          e(OP.f64_sqrt);
          if (isSS) { e(OP.f64_demote_f32); e(OP.f64_promote_f32); }
          C.setXmmLo(xr);
          return;
        }
        C.loadXmmLo(xr); // a
        if (isSS && o1.k === "mem") {
          C.addrPush(o1.m, va, ilen);
          e(OP.f32_load); u(2); u(0);
          e(OP.f64_promote_f32);
        } else if (o1.k === "xmm") C.loadXmmLo((o1 as any).r);
        else C.loadF64(o1, va, ilen); // b
        e(opm);
        if (isSS) { e(OP.f64_demote_f32); e(OP.f64_promote_f32); }
        C.setXmmLo(xr);
        return;
      }
      case "movss": {
        const store = o0.k === "mem";
        if (store) {
          const xr2 = (o1 as any).r as number;
          C.addrPush(o0.m, va, ilen);
          C.loadXmmLo(xr2); e(OP.f64_demote_f32);
          e(OP.f32_store); u(2); u(0);
          return;
        }
        const xr2 = (o0 as any).r as number;
        if (o1.k === "xmm") { C.loadXmmLo((o1 as any).r); C.setXmmLo(xr2); return; }
        C.addrPush(o1.m, va, ilen);
        e(OP.f32_load); u(2); u(0);
        e(OP.f64_promote_f32);
        C.setXmmLo(xr2); i64c(0); C.setXmmHi(xr2);
        return;
      }
      case "cvtsd2ss": case "cvtss2sd": {
        const xr2 = (o0 as any).r as number;
        if (o1.k === "xmm") C.loadXmmLo((o1 as any).r);
        else C.loadF64(o1, va, ilen);
        e(OP.f64_demote_f32); e(OP.f64_promote_f32); // fround
        C.setXmmLo(xr2);
        return;
      }
      case "xorpd": case "xorps": case "andpd": case "orpd": case "andps": {
        const xr = (o0 as any).r as number;
        const wop = ins.op.startsWith("xor") ? OP.i64_xor : ins.op.startsWith("and") ? OP.i64_and : OP.i64_or;
        const srcXmm = o1 && o1.k === "xmm" ? (o1 as any).r as number : -1;
        // lo bits
        C.loadXmmLo(xr); e(OP.i64_reinterpret_f64);
        if (srcXmm >= 0) { C.loadXmmLo(srcXmm); e(OP.i64_reinterpret_f64); }
        else if (o1 && o1.k === "mem") { C.loadI64(o1, 8, false, va, ilen); }
        else throw new Error(`bad SSE src operand for ${ins.op} @0x${va.toString(16)} bytes=${C.L.bytesAt(va, ilen)}`);
        e(wop);
        e(OP.f64_reinterpret_i64); C.setXmmLo(xr);
        // hi bits
        C.loadXmmHi(xr);
        if (srcXmm >= 0) C.loadXmmHi(srcXmm);
        else if (o1 && o1.k === "mem") C.loadI64({ k: "mem", m: { ...(o1 as any).m, disp: (o1 as any).m.disp + 8 } }, 8, false, va, ilen);
        e(wop);
        C.setXmmHi(xr);
        return;
      }
      case "cvtsi2sd": {
        const xr = (o0 as any).r as number;
        const srcSize = o1.k === "reg" ? (o1 as any).size as 1 | 2 | 4 | 8 : o1.m.size as 1 | 2 | 4 | 8;
        if (srcSize === 8) { C.loadI64(o1, 8, true, va, ilen); e(OP.f64_convert_i64_s); }
        else { C.loadI64(o1, 4, true, va, ilen); e(OP.f64_convert_i32_s); }
        C.setXmmLo(xr);
        return;
      }
      case "cvttsd2si": case "cvtsd2si": {
        const size = sizeOf(o0);
        const xr = (o1.k === "xmm" ? (o1 as any).r : (o1 as any).m ? -1 : -1);
        void xr;
        if (o1.k === "xmm") C.loadXmmLo((o1 as any).r);
        else C.loadF64(o1, va, ilen);
        if (ins.op === "cvttsd2si") {
          e(OP.call); u(L.cvttsdImportIdx()); // (f64) -> (i64, f64); exact x86 semantics
          e(OP.drop);
        } else {
          e(OP.i64_trunc_f64_s);
        }
        C.storeOp(o0, size, va, ilen);
        return;
      }
      case "cvtpd2ps": case "cvtps2pd": {
        const xr = (o0 as any).r as number;
        if (o1.k === "xmm") C.loadXmmLo((o1 as any).r);
        else C.loadF64(o1, va, ilen);
        e(OP.f64_demote_f32); e(OP.f64_promote_f32);
        C.setXmmLo(xr);
        return;
      }
      case "cvtdq2pd": {
        const xr = (o0 as any).r as number;
        if (o1.k === "xmm") {
          // low 32 bits of src xmm → double
          C.loadXmmLo((o1 as any).r); e(OP.i64_reinterpret_f64); e(OP.i32_wrap_i64); e(OP.f64_convert_i32_s);
        } else {
          C.loadI64(o1, 4, true, va, ilen); e(OP.f64_convert_i32_s);
        }
        C.setXmmLo(xr); i64c(0); C.setXmmHi(xr);
        return;
      }
      case "ucomisd": case "comisd": {
        const xr = (o0 as any).r as number;
        C.loadXmmLo(xr); // a
        if (o1.k === "xmm") C.loadXmmLo((o1 as any).r);
        else C.loadF64(o1, va, ilen); // b
        // stack [a, b] (f64 each)
        ls(FB); ls(FA);
        // unordered = a!=a || b!=b
        lg(FA); lg(FA); e(OP.f64_ne);
        lg(FB); lg(FB); e(OP.f64_ne);
        e(OP.i32_or); ls(COND); // u
        // zf = (a==b) | u
        lg(FA); lg(FB); e(OP.f64_eq); lg(COND); e(OP.i32_or); i32c(F_ZF); e(OP.i32_mul);
        // cf = (a<b) | u
        lg(FA); lg(FB); e(OP.f64_lt); lg(COND); e(OP.i32_or); i32c(F_CF); e(OP.i32_mul); e(OP.i32_or);
        // pf = u
        lg(COND); i32c(F_PF); e(OP.i32_mul); e(OP.i32_or);
        ls(FLAGS);
        return;
      }
      case "seto": case "setno": case "setb": case "setae": case "sete": case "setne": case "setbe": case "seta":
      case "sets": case "setns": case "setp": case "setnp": case "setl": case "setge": case "setle": case "setg": {
        L.condTo(COND, ins.op.slice(3), C);
        lg(COND); e(OP.i64_extend_i32_u);
        C.storeOp(o0, 1, va, ilen);
        return;
      }
      case "cmovo": case "cmovno": case "cmovb": case "cmovae": case "cmove": case "cmovne": case "cmovbe": case "cmova":
      case "cmovs": case "cmovns": case "cmovp": case "cmovnp": case "cmovl": case "cmovge": case "cmovle": case "cmovg": {
        const size = sizeOf(o0);
        C.loadI64(o0, size, false, va, ilen); ls(SA);
        C.loadI64(o1, size, false, va, ilen); ls(SB);
        L.condTo(COND, ins.op.slice(4), C);
        lg(SB); lg(SA); lg(COND);
        e(OP.select);
        C.storeOp(o0, size, va, ilen);
        return;
      }
      case "jmp": case "ret": case "call": case "int3": case "ud2": case "ijmp": {
        // terminators handled elsewhere; call also handled here for mid-block? (no: call is not a terminator)
        if (ins.op === "call") {
          const t = Number((o0 as any).v);
          e(OP.global_get); u(RSPG); i64c(8); e(OP.i64_sub); e(OP.global_set); u(RSPG);
            lg(0); lg(1); lg(2); lg(3);
          e(OP.global_get); u(RSPG);
          const gfn = L.reg.fnByVa.get(t);
          const idx = gfn ? L.fnIndexByVa.get(gfn.va)! : L.abiImportFor(t);
          e(OP.call); u(idx);
          ls(XLO + 0); ls(RAX);
          e(OP.global_get); u(RSPG); i64c(8); e(OP.i64_add); e(OP.global_set); u(RSPG);
          return;
        }
        throw new Error(`terminator ${ins.op} reached emitIns`);
      }
      default:
        throw new Error(`unhandled op "${ins.op}" @0x${va.toString(16)}`);
    }
  }

  private abiImportFor(va: number): number {
    this.abiCallCounts.set(va, (this.abiCallCounts.get(va) ?? 0) + 1);
    let idx = this._abiIdx.get(va);
    if (idx === undefined) {
      idx = this.wasm.addImport("abi", "f" + va.toString(16), [0x7e, 0x7e, 0x7e, 0x7e, 0x7e], [0x7e, 0x7c]);
      this._abiIdx.set(va, idx);
    }
    return idx;
  }
  private _abiIdx = new Map<number, number>();
  icallRegImportIdx(): number {
    if (!this._icallReg) this._icallReg = this.wasm.addImport("abi", "icall_reg", [0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e], [0x7e, 0x7c]);
    return this._icallReg;
  }
  private _icallReg = 0;
  private icallImportIdx(): number {
    if (!this._icall) this._icall = this.wasm.addImport("abi", "icall", [0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e], [0x7e, 0x7c]);
    return this._icall;
  }
  private _icall = 0;
  private div128ImportIdx(signed: boolean): number {
    const key = signed ? "idiv128" : "udiv128";
    if (!this._div128.has(key)) this._div128.set(key, this.wasm.addImport("abi", key, [0x7e, 0x7e], [0x7e, 0x7c]));
    return this._div128.get(key)!;
  }
  private _div128 = new Map<string, number>();
  private cvttsdImportIdx(): number {
    if (!this._cvttsd) this._cvttsd = this.wasm.addImport("abi", "cvttsd2si", [0x7c], [0x7e, 0x7c]);
    return this._cvttsd;
  }
  private _cvttsd = 0;
}

// memarg helper re-export
export { ulebA };
