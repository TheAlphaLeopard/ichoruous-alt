// gex-emit: minimal WebAssembly binary emitter (wasm32, MVP + multi-value + bulk memory not needed).
// Enough to emit: types, imports, functions, memory, exports, tables, code with all core opcodes.
export class Wasm {
  types: number[][] = []; // [form, ...params, resultsCount, ...results]
  typeIndex = new Map<string, number>();
  imports: { module: string; name: string; typeIdx: number }[] = [];
  importNames = new Set<string>();
  funcs: { typeIdx: number; locals: number[][]; body: number[]; export?: string }[] = [];
  exports: { name: string; kind: number; index: number }[] = [];
  dataSegments: { memOffset: number; bytes: Uint8Array }[] = [];
  tableFuncs = 0;
  globals: { type: number; mut: boolean; init: number }[] = [];
  memoryPages = 0;

  // ---- encoding helpers ----
  private u8(a: number[], v: number) { a.push(v & 0xff); }
  uleb(a: number[], v: number) {
    v >>>= 0;
    do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; a.push(b); } while (v);
  }
  sleb(a: number[], v: number) {
    let more = true;
    while (more) {
      let b = v & 0x7f;
      v >>= 7;
      if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) more = false; else b |= 0x80;
      a.push(b);
    }
  }
  private f64(a: number[], v: number) { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); for (let i = 0; i < 8; i++) a.push(b.getUint8(i)); }
  private str(a: number[], s: string) { const bytes = new TextEncoder().encode(s); this.uleb(a, bytes.length); for (const b of bytes) a.push(b); }
  private vec<T>(a: number[], items: T[], fn: (item: T) => void) { this.uleb(a, items.length); for (const it of items) fn(it); }
  private section(a: number[], id: number, payload: number[]) {
    a.push(id); this.uleb(a, payload.length);
    for (let i = 0; i < payload.length; i += 8192) {
      const chunk = payload.slice(i, i + 8192);
      // @ts-ignore spread of 8k is safe
      a.push(...chunk);
    }
  }

  typeIdxOf(params: number[], results: number[]): number {
    const key = params.join(",") + "->" + results.join(",");
    let t = this.typeIndex.get(key);
    if (t === undefined) {
      const arr: number[] = [0x60];
      this.vec(arr, params, (p) => this.u8(arr, p));
      this.vec(arr, results, (r) => this.u8(arr, r));
      t = this.types.length; this.types.push(arr); this.typeIndex.set(key, t);
    }
    return t;
  }
  addImport(module: string, name: string, params: number[], results: number[]): number {
    const key = module + "::" + name;
    if (this.importNames.has(key)) return this.importIdxByKey.get(key)!;
    this.importNames.add(key);
    const t = this.typeIdxOf(params, results);
    this.imports.push({ module, name, typeIdx: t });
    const fnIdx = this.imports.length - 1;
    this.importIdxByKey.set(key, fnIdx);
    return fnIdx;
  }
  importIdxByKey = new Map<string, number>();
  addFunc(params: number[], results: number[], locals: number[][], body: number[], exportName?: string): number {
    const t = this.typeIdxOf(params, results);
    const idx = this.imports.length + this.funcs.length;
    // precompute the full function body bytes (locals + code + end) and free the number[]
    const bodyBytes: number[] = [];
    this.vec(bodyBytes, locals, (lg) => { this.uleb(bodyBytes, lg[0]); this.u8(bodyBytes, lg[1]); });
    for (const b of body) bodyBytes.push(b);
    const bodyU8 = Uint8Array.from(bodyBytes);
    this.funcs.push({ typeIdx: t, locals: [], body: bodyU8 as unknown as number[], export: exportName });
    if (exportName) this.exports.push({ name: exportName, kind: 0, index: idx });
    return idx;
  }
  exportFunc(idx: number, name: string) { this.exports.push({ name, kind: 0, index: idx }); }
  addGlobal(type: number, mut: boolean, init: number): number { this.globals.push({ type, mut, init }); return 0x100 + this.globals.length - 1; }
  addData(memOffset: number, bytes: Uint8Array) { this.dataSegments.push({ memOffset, bytes }); }

  toBytes(): Uint8Array {
    // pre-compute section payloads as Uint8Arrays to avoid giant JS number arrays
    const enc = new Uint8Array(1 << 16);
    const tmp: number[] = [];
    const sections: { id: number; payload: Uint8Array }[] = [];
    const flush = (id: number, a: number[]) => { sections.push({ id, payload: Uint8Array.from(a) }); };

    {
      const a: number[] = [];
      this.vec(a, this.types, (t) => { for (const b of t) a.push(b); });
      flush(1, a);
    }
    {
      const a: number[] = [];
      this.vec(a, this.imports, (im) => { this.str(a, im.module); this.str(a, im.name); this.u8(a, 0); this.uleb(a, im.typeIdx); });
      flush(2, a);
    }
    {
      const a: number[] = [];
      this.vec(a, this.funcs, (f) => this.uleb(a, f.typeIdx));
      flush(3, a);
    }
    {
      const a: number[] = [1, 0x00];
      this.uleb(a, this.memoryPages);
      flush(5, a);
    }
    if (this.globals.length) {
      const a: number[] = [];
      this.vec(a, this.globals, (g) => { this.u8(a, g.type); this.u8(a, g.mut ? 1 : 0); this.u8(a, g.type === 0x7e ? 0x42 : 0x41); this.sleb(a, g.init); this.u8(a, 0x0b); });
      flush(6, a);
    }
    {
      const a: number[] = [];
      const extra = 1 + (this.globals.length ? 1 : 0);
      this.uleb(a, this.exports.length + extra);
      for (const e2 of this.exports) { this.str(a, e2.name); this.u8(a, e2.kind); this.uleb(a, e2.index); }
      this.str(a, "mem"); this.u8(a, 2); this.uleb(a, 0);
      if (this.globals.length) { this.str(a, "rsp"); this.u8(a, 3); this.uleb(a, 0); }
      flush(7, a);
    }
    {
      // code section: exact-size buffer, copy prebuilt bodies
      let total = 0;
      const sizes: number[] = [];
      for (const f of this.funcs) {
        const bodyU8 = f.body as unknown as Uint8Array;
        const n = ulebLen(bodyU8.length) + bodyU8.length;
        sizes.push(n); total += n;
      }
      const payload = new Uint8Array(ulebLen(this.funcs.length) + total);
      let c = writeUleb(payload, 0, this.funcs.length);
      for (let i = 0; i < this.funcs.length; i++) {
        const bodyU8 = this.funcs[i].body as unknown as Uint8Array;
        c = writeUleb(payload, c, bodyU8.length);
        payload.set(bodyU8, c); c += bodyU8.length;
        this.funcs[i].body = [];
      }
      sections.push({ id: 10, payload: payload.subarray(0, c) });
    }
    if (this.dataSegments.length) {
      const a: number[] = [];
      this.vec(a, this.dataSegments, (d) => {
        this.u8(a, 0); this.u8(a, 0x41); this.sleb(a, d.memOffset); this.u8(a, 0x0b);
        this.uleb(a, d.bytes.length); for (const b of d.bytes) a.push(b);
      });
      flush(11, a);
    }
    let total = 8;
    for (const s of sections) total += 1 + 5 + s.payload.length;
    const out = new Uint8Array(total);
    let c = 0;
    out[0] = 0x00; out[1] = 0x61; out[2] = 0x73; out[3] = 0x6d; out[4] = 1; out[5] = 0; out[6] = 0; out[7] = 0; c = 8;
    for (const s of sections) {
      out[c++] = s.id;
      // uleb size
      let v = s.payload.length; const tmp2: number[] = [];
      do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; tmp2.push(b); } while (v);
      for (const b of tmp2) out[c++] = b;
      out.set(s.payload, c); c += s.payload.length;
    }
    void tmp; void enc;
    return out.subarray(0, c);
  }
  private ulebTmp(_a: number[], v: number): number { void _a; void v; return 0; }
}

// ---- instruction opcodes used by the lifter ----
export const OP = {
  unreachable: 0x00, nop: 0x01, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, br_if: 0x0d, br_table: 0x0e, ret: 0x0f,
  call: 0x10, call_indirect: 0x11, drop: 0x1a, select: 0x1b,
  local_get: 0x20, local_set: 0x21, local_tee: 0x22, global_get: 0x23, global_set: 0x24,
  i32_load: 0x28, i64_load: 0x29, f64_load: 0x2b, i32_load8_s: 0x2c, i32_load8_u: 0x2d, i32_load16_s: 0x2e, i32_load16_u: 0x2f,
  i32_store: 0x36, i64_store: 0x37, f64_store: 0x39, i32_store8: 0x3a, i32_store16: 0x3b,
  memory_size: 0x3f, memory_grow: 0x40,
  i32_const: 0x41, i64_const: 0x42, f64_const: 0x44,
  i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_lt_u: 0x49, i32_gt_s: 0x4a, i32_gt_u: 0x4b,
  i32_le_s: 0x4c, i32_le_u: 0x4d, i32_ge_s: 0x4e, i32_ge_u: 0x4f,
  i64_eqz: 0x50, i64_eq: 0x51, i64_ne: 0x52, i64_lt_s: 0x53, i64_lt_u: 0x54, i64_gt_s: 0x55, i64_gt_u: 0x56, i64_le_s: 0x57, i64_le_u: 0x58, i64_ge_s: 0x59, i64_ge_u: 0x5a,
  f64_eq: 0x61, f64_ne: 0x62, f64_lt: 0x63, f64_gt: 0x64, f64_le: 0x65, f64_ge: 0x66,
  i32_add: 0x6a, i32_sub: 0x6b, i32_mul: 0x6c, i32_div_s: 0x6d, i32_div_u: 0x6e, i32_rem_s: 0x6f, i32_rem_u: 0x70, i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73, i32_shl: 0x74, i32_shr_s: 0x75, i32_shr_u: 0x76, i32_rotl: 0x77,
  i64_add: 0x7c, i64_sub: 0x7d, i64_mul: 0x7e, i64_div_s: 0x7f, i64_div_u: 0x80, i64_rem_s: 0x81, i64_rem_u: 0x82, i64_and: 0x83, i64_or: 0x84, i64_xor: 0x85, i64_shl: 0x86, i64_shr_s: 0x87, i64_shr_u: 0x88,
  f64_abs: 0x99, f64_neg: 0x9a, f64_ceil: 0x9b, f64_floor: 0x9c, f64_trunc: 0x9d, f64_nearest: 0x9e, f64_sqrt: 0x9f, f64_min: 0xa6,
  f64_add: 0xa0, f64_sub: 0xa1, f64_mul: 0xa2, f64_div: 0xa3, f64_min: 0xa4, f64_max: 0xa5,
  i32_wrap_i64: 0xa7, i32_trunc_f64_s: 0xaa, i32_trunc_f64_u: 0xab,
  i64_extend_i32_s: 0xac, i64_extend_i32_u: 0xad, i64_trunc_f64_s: 0xb0, i64_trunc_f64_u: 0xb1,
  f64_convert_i32_s: 0xb7, f64_convert_i32_u: 0xb8, f64_convert_i64_s: 0xb9, f64_convert_i64_u: 0xba,
  f64_reinterpret_i64: 0xbf, i64_reinterpret_f64: 0xbd, f32_reinterpret_i32: 0xbc, i32_reinterpret_f32: 0xd3, f64_promote_f32: 0xbb, f64_demote_f32: 0xb6, f32_store: 0x38, f32_load: 0x2a,
  f32_convert: 0, // unused
  i32_reinterpret_f32: 0xbc,
  sign_extend_8: 0xc0, sign_extend_16: 0xc1, sign_extend_32: 0xc2,
  i64_extend_32_s: 0xc4,
} as const;

export function op(a: number[], o: number) { a.push(o); }
export function opConst(a: number[], o: number, imm: number) { a.push(o); slebA(a, imm); }
export function opI64const(a: number[], v: number | bigint) { a.push(OP.i64_const); sleb64(a, typeof v === "bigint" ? v : BigInt(Math.trunc(v))); }
export function opF64const(a: number[], v: number) { a.push(OP.f64_const); const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); for (let i = 0; i < 8; i++) a.push(b.getUint8(i)); }
function slebA(a: number[], v: number) {
  let more = true;
  while (more) {
    let b = v & 0x7f; v >>= 7;
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) more = false; else b |= 0x80;
    a.push(b);
  }
}
export function sleb64(a: number[], v: bigint | number) {
  if (typeof v === "number") v = BigInt(Math.trunc(v));
  let more = true;
  while (more) {
    let b = Number(v & 0x7fn); v >>= 7n;
    if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) more = false; else b |= 0x80;
    a.push(b);
  }
}
export function memarg(a: number[], align: number, offset: number) { ulebA(a, align); ulebA(a, offset >>> 0); }
export function ulebA(a: number[], v: number) { v >>>= 0; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; a.push(b); } while (v); }
function ulebLen(v: number): number { let n = 0; do { v >>>= 7; n++; } while (v); return n; }
function writeUleb(buf: Uint8Array, c: number, v: number): number { v >>>= 0; do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; buf[c++] = b; } while (v); return c; }
