class Wasm {
  constructor() {
    this.types = [];
    // [form, ...params, resultsCount, ...results]
    this.typeIndex = /* @__PURE__ */ new Map();
    this.imports = [];
    this.importNames = /* @__PURE__ */ new Set();
    this.funcs = [];
    this.exports = [];
    this.dataSegments = [];
    this.tableFuncs = 0;
    this.globals = [];
    this.memoryPages = 0;
    this.importIdxByKey = /* @__PURE__ */ new Map();
  }
  // ---- encoding helpers ----
  u8(a, v) {
    a.push(v & 255);
  }
  uleb(a, v) {
    v >>>= 0;
    do {
      let b = v & 127;
      v >>>= 7;
      if (v) b |= 128;
      a.push(b);
    } while (v);
  }
  sleb(a, v) {
    let more = true;
    while (more) {
      let b = v & 127;
      v >>= 7;
      if (v === 0 && (b & 64) === 0 || v === -1 && (b & 64) !== 0) more = false;
      else b |= 128;
      a.push(b);
    }
  }
  f64(a, v) {
    const b = new DataView(new ArrayBuffer(8));
    b.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) a.push(b.getUint8(i));
  }
  str(a, s) {
    const bytes = new TextEncoder().encode(s);
    this.uleb(a, bytes.length);
    for (const b of bytes) a.push(b);
  }
  vec(a, items, fn) {
    this.uleb(a, items.length);
    for (const it of items) fn(it);
  }
  section(a, id, payload) {
    a.push(id);
    this.uleb(a, payload.length);
    for (let i = 0; i < payload.length; i += 8192) {
      const chunk = payload.slice(i, i + 8192);
      a.push(...chunk);
    }
  }
  typeIdxOf(params, results) {
    const key = params.join(",") + "->" + results.join(",");
    let t = this.typeIndex.get(key);
    if (t === void 0) {
      const arr = [96];
      this.vec(arr, params, (p) => this.u8(arr, p));
      this.vec(arr, results, (r) => this.u8(arr, r));
      t = this.types.length;
      this.types.push(arr);
      this.typeIndex.set(key, t);
    }
    return t;
  }
  addImport(module, name, params, results) {
    const key = module + "::" + name;
    if (this.importNames.has(key)) return this.importIdxByKey.get(key);
    this.importNames.add(key);
    const t = this.typeIdxOf(params, results);
    this.imports.push({ module, name, typeIdx: t });
    const fnIdx = this.imports.length - 1;
    this.importIdxByKey.set(key, fnIdx);
    return fnIdx;
  }
  addFunc(params, results, locals, body, exportName) {
    const t = this.typeIdxOf(params, results);
    const idx = this.imports.length + this.funcs.length;
    const bodyBytes = [];
    this.vec(bodyBytes, locals, (lg) => {
      this.uleb(bodyBytes, lg[0]);
      this.u8(bodyBytes, lg[1]);
    });
    for (const b of body) bodyBytes.push(b);
    const bodyU8 = Uint8Array.from(bodyBytes);
    this.funcs.push({ typeIdx: t, locals: [], body: bodyU8, export: exportName });
    if (exportName) this.exports.push({ name: exportName, kind: 0, index: idx });
    return idx;
  }
  exportFunc(idx, name) {
    this.exports.push({ name, kind: 0, index: idx });
  }
  addGlobal(type, mut, init) {
    this.globals.push({ type, mut, init });
    return 256 + this.globals.length - 1;
  }
  addData(memOffset, bytes) {
    this.dataSegments.push({ memOffset, bytes });
  }
  toBytes() {
    const enc = new Uint8Array(1 << 16);
    const tmp = [];
    const sections = [];
    const flush = (id, a) => {
      sections.push({ id, payload: Uint8Array.from(a) });
    };
    {
      const a = [];
      this.vec(a, this.types, (t) => {
        for (const b of t) a.push(b);
      });
      flush(1, a);
    }
    {
      const a = [];
      this.vec(a, this.imports, (im) => {
        this.str(a, im.module);
        this.str(a, im.name);
        this.u8(a, 0);
        this.uleb(a, im.typeIdx);
      });
      flush(2, a);
    }
    {
      const a = [];
      this.vec(a, this.funcs, (f) => this.uleb(a, f.typeIdx));
      flush(3, a);
    }
    {
      const a = [1, 0];
      this.uleb(a, this.memoryPages);
      flush(5, a);
    }
    if (this.globals.length) {
      const a = [];
      this.vec(a, this.globals, (g) => {
        this.u8(a, g.type);
        this.u8(a, g.mut ? 1 : 0);
        this.u8(a, g.type === 126 ? 66 : 65);
        this.sleb(a, g.init);
        this.u8(a, 11);
      });
      flush(6, a);
    }
    {
      const a = [];
      const extra = 1 + (this.globals.length ? 1 : 0);
      this.uleb(a, this.exports.length + extra);
      for (const e2 of this.exports) {
        this.str(a, e2.name);
        this.u8(a, e2.kind);
        this.uleb(a, e2.index);
      }
      this.str(a, "mem");
      this.u8(a, 2);
      this.uleb(a, 0);
      if (this.globals.length) {
        this.str(a, "rsp");
        this.u8(a, 3);
        this.uleb(a, 0);
      }
      flush(7, a);
    }
    {
      let total2 = 0;
      const sizes = [];
      for (const f of this.funcs) {
        const bodyU8 = f.body;
        const n = ulebLen(bodyU8.length) + bodyU8.length;
        sizes.push(n);
        total2 += n;
      }
      const payload = new Uint8Array(ulebLen(this.funcs.length) + total2);
      let c2 = writeUleb(payload, 0, this.funcs.length);
      for (let i = 0; i < this.funcs.length; i++) {
        const bodyU8 = this.funcs[i].body;
        c2 = writeUleb(payload, c2, bodyU8.length);
        payload.set(bodyU8, c2);
        c2 += bodyU8.length;
        this.funcs[i].body = [];
      }
      sections.push({ id: 10, payload: payload.subarray(0, c2) });
    }
    if (this.dataSegments.length) {
      const a = [];
      this.vec(a, this.dataSegments, (d) => {
        this.u8(a, 0);
        this.u8(a, 65);
        this.sleb(a, d.memOffset);
        this.u8(a, 11);
        this.uleb(a, d.bytes.length);
        for (const b of d.bytes) a.push(b);
      });
      flush(11, a);
    }
    let total = 8;
    for (const s of sections) total += 1 + 5 + s.payload.length;
    const out = new Uint8Array(total);
    let c = 0;
    out[0] = 0;
    out[1] = 97;
    out[2] = 115;
    out[3] = 109;
    out[4] = 1;
    out[5] = 0;
    out[6] = 0;
    out[7] = 0;
    c = 8;
    for (const s of sections) {
      out[c++] = s.id;
      let v = s.payload.length;
      const tmp2 = [];
      do {
        let b = v & 127;
        v >>>= 7;
        if (v) b |= 128;
        tmp2.push(b);
      } while (v);
      for (const b of tmp2) out[c++] = b;
      out.set(s.payload, c);
      c += s.payload.length;
    }
    void tmp;
    void enc;
    return out.subarray(0, c);
  }
  ulebTmp(_a, v) {
    void _a;
    void v;
    return 0;
  }
}
const OP = {
  unreachable: 0,
  nop: 1,
  block: 2,
  loop: 3,
  if: 4,
  else: 5,
  end: 11,
  br: 12,
  br_if: 13,
  br_table: 14,
  ret: 15,
  call: 16,
  call_indirect: 17,
  drop: 26,
  select: 27,
  local_get: 32,
  local_set: 33,
  local_tee: 34,
  global_get: 35,
  global_set: 36,
  i32_load: 40,
  i64_load: 41,
  f64_load: 43,
  i32_load8_s: 44,
  i32_load8_u: 45,
  i32_load16_s: 46,
  i32_load16_u: 47,
  i32_store: 54,
  i64_store: 55,
  f64_store: 57,
  i32_store8: 58,
  i32_store16: 59,
  memory_size: 63,
  memory_grow: 64,
  i32_const: 65,
  i64_const: 66,
  f64_const: 68,
  i32_eqz: 69,
  i32_eq: 70,
  i32_ne: 71,
  i32_lt_s: 72,
  i32_lt_u: 73,
  i32_gt_s: 74,
  i32_gt_u: 75,
  i32_le_s: 76,
  i32_le_u: 77,
  i32_ge_s: 78,
  i32_ge_u: 79,
  i64_eqz: 80,
  i64_eq: 81,
  i64_ne: 82,
  i64_lt_s: 83,
  i64_lt_u: 84,
  i64_gt_s: 85,
  i64_gt_u: 86,
  i64_le_s: 87,
  i64_le_u: 88,
  i64_ge_s: 89,
  i64_ge_u: 90,
  f64_eq: 97,
  f64_ne: 98,
  f64_lt: 99,
  f64_gt: 100,
  f64_le: 101,
  f64_ge: 102,
  i32_add: 106,
  i32_sub: 107,
  i32_mul: 108,
  i32_div_s: 109,
  i32_div_u: 110,
  i32_rem_s: 111,
  i32_rem_u: 112,
  i32_and: 113,
  i32_or: 114,
  i32_xor: 115,
  i32_shl: 116,
  i32_shr_s: 117,
  i32_shr_u: 118,
  i32_rotl: 119,
  i64_add: 124,
  i64_sub: 125,
  i64_mul: 126,
  i64_div_s: 127,
  i64_div_u: 128,
  i64_rem_s: 129,
  i64_rem_u: 130,
  i64_and: 131,
  i64_or: 132,
  i64_xor: 133,
  i64_shl: 134,
  i64_shr_s: 135,
  i64_shr_u: 136,
  f64_abs: 153,
  f64_neg: 154,
  f64_ceil: 155,
  f64_floor: 156,
  f64_trunc: 157,
  f64_nearest: 158,
  f64_sqrt: 159,
  f64_min: 166,
  f64_add: 160,
  f64_sub: 161,
  f64_mul: 162,
  f64_div: 163,
  f64_min: 164,
  f64_max: 165,
  i32_wrap_i64: 167,
  i32_trunc_f64_s: 170,
  i32_trunc_f64_u: 171,
  i64_extend_i32_s: 172,
  i64_extend_i32_u: 173,
  i64_trunc_f64_s: 176,
  i64_trunc_f64_u: 177,
  f64_convert_i32_s: 183,
  f64_convert_i32_u: 184,
  f64_convert_i64_s: 185,
  f64_convert_i64_u: 186,
  f64_reinterpret_i64: 191,
  i64_reinterpret_f64: 189,
  f32_reinterpret_i32: 188,
  i32_reinterpret_f32: 211,
  f64_promote_f32: 187,
  f64_demote_f32: 182,
  f32_store: 56,
  f32_load: 42,
  f32_convert: 0,
  // unused
  i32_reinterpret_f32: 188,
  sign_extend_8: 192,
  sign_extend_16: 193,
  sign_extend_32: 194,
  i64_extend_32_s: 196
};
function op(a, o) {
  a.push(o);
}
function opConst(a, o, imm) {
  a.push(o);
  slebA(a, imm);
}
function opI64const(a, v) {
  a.push(OP.i64_const);
  sleb64(a, typeof v === "bigint" ? v : BigInt(Math.trunc(v)));
}
function opF64const(a, v) {
  a.push(OP.f64_const);
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, v, true);
  for (let i = 0; i < 8; i++) a.push(b.getUint8(i));
}
function slebA(a, v) {
  let more = true;
  while (more) {
    let b = v & 127;
    v >>= 7;
    if (v === 0 && (b & 64) === 0 || v === -1 && (b & 64) !== 0) more = false;
    else b |= 128;
    a.push(b);
  }
}
function sleb64(a, v) {
  if (typeof v === "number") v = BigInt(Math.trunc(v));
  let more = true;
  while (more) {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n && (b & 64) === 0 || v === -1n && (b & 64) !== 0) more = false;
    else b |= 128;
    a.push(b);
  }
}
function memarg(a, align, offset) {
  ulebA(a, align);
  ulebA(a, offset >>> 0);
}
function ulebA(a, v) {
  v >>>= 0;
  do {
    let b = v & 127;
    v >>>= 7;
    if (v) b |= 128;
    a.push(b);
  } while (v);
}
function ulebLen(v) {
  let n = 0;
  do {
    v >>>= 7;
    n++;
  } while (v);
  return n;
}
function writeUleb(buf, c, v) {
  v >>>= 0;
  do {
    let b = v & 127;
    v >>>= 7;
    if (v) b |= 128;
    buf[c++] = b;
  } while (v);
  return c;
}
export {
  OP,
  Wasm,
  memarg,
  op,
  opConst,
  opF64const,
  opI64const,
  sleb64,
  ulebA
};
