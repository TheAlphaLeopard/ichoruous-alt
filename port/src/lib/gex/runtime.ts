// gex runtime: the GameMaker runner shim ("wine layer") for the lifted game.
// Implements the runner ABI the YYC game code calls: RValue protocol, CInstance
// variable access, builtin/script dispatch, GML scope frames — plus the event
// loop, rendering, input and audio that the real runner would provide.
export const IMAGE_BASE = 0x140000000;

export const T_DOUBLE = 0, T_STRING = 1, T_ARRAY = 2, T_PTR = 3, T_BOOL = 4, T_UNDEF = 5, T_OBJECT = 6, T_INT32 = 7;

export interface RV { v: number; flags: number; t: number }

export class Guest {
  mem!: WebAssembly.Memory;
  u8!: Uint8Array;
  dv!: DataView;
  heapPtr = 0x01F00000;
  attach(mem: WebAssembly.Memory) {
    this.mem = mem;
    this.u8 = new Uint8Array(mem.buffer);
    this.dv = new DataView(mem.buffer);
  }
  alloc(bytes: number, align = 8): number {
    this.heapPtr = (this.heapPtr + align - 1) & ~(align - 1);
    const p = this.heapPtr;
    this.heapPtr += bytes;
    if (this.heapPtr > 0x02700000) throw new Error("guest heap exhausted");
    return p;
  }
  readRV(p: number): RV { return { v: p >= 0 && p + 16 <= this.u8.length ? Number(this.dv.getBigUint64(p, true)) : 0, flags: p >= 0 ? this.dv.getUint32(p + 8, true) : 0, t: p >= 0 ? this.dv.getUint32(p + 12, true) & 0xffffff : 0 }; }
  writeRV(p: number, r: RV) { this.dv.setBigUint64(p, BigInt(Math.trunc(r.v)), true); this.dv.setUint32(p + 8, r.flags, true); this.dv.setUint32(p + 12, r.t, true); }
  writeRVDouble(p: number, d: number) { this.dv.setFloat64(p, d, true); this.dv.setUint32(p + 8, 0, true); this.dv.setUint32(p + 12, T_DOUBLE, true); }
  writeRVInt(p: number, i: number) { this.dv.setBigUint64(p, BigInt(i | 0), true); this.dv.setUint32(p + 8, 0, true); this.dv.setUint32(p + 12, T_INT32, true); }
  writeRVBool(p: number, b: boolean) { this.dv.setBigUint64(p, b ? 1n : 0n, true); this.dv.setUint32(p + 8, 0, true); this.dv.setUint32(p + 12, T_BOOL, true); }
  writeRVUndef(p: number) { this.dv.setBigUint64(p, 0n, true); this.dv.setUint32(p + 8, 0, true); this.dv.setUint32(p + 12, T_UNDEF, true); }
  allocString(s: string): number {
    const bytes = new TextEncoder().encode(s);
    const p = this.alloc(bytes.length + 8, 8);
    this.dv.setUint32(p, bytes.length, true);
    this.u8.set(bytes, p + 8);
    return p;
  }
  readString(p: number): string {
    if (!p || p + 8 > this.u8.length) return "";
    const len = this.dv.getUint32(p, true);
    return new TextDecoder().decode(this.u8.subarray(p + 8, p + 8 + Math.min(len, 1 << 20)));
  }
  readCStr(p: number): string {
    if (!p || p >= this.u8.length) return "";
    let s = "";
    for (let i = 0; i < 4096; i++) { const c = this.u8[p + i]; if (!c) break; s += String.fromCharCode(c); }
    return s;
  }
}

export interface Instance {
  id: number; objIndex: number; guestPtr: number; vars: Map<number, RV>; slots: Map<number, number>;
  x: number; y: number; spriteIndex: number; imageIndex: number; imageSpeed: number;
  depth: number; visible: boolean; persistent: boolean; alive: boolean; alarms: number[];
  hspeed: number; vspeed: number; speed: number; direction: number;
  imageXscale: number; imageYscale: number; imageAngle: number; imageAlpha: number; imageBlend: number;
}
export interface SpriteDef { name: string; w: number; h: number; ox: number; oy: number; speed: number; speedType: number; frames: number[] }
export interface ObjectDef { name: string; sprite: number; visible: boolean; solid: boolean; depth: number; persistent: boolean; events: Record<string, string[]> }

const BUILTIN_VARS = ["x", "y", "sprite_index", "image_index", "image_speed", "depth", "visible", "hspeed", "vspeed", "speed", "direction", "image_xscale", "image_yscale", "image_angle", "image_alpha", "id", "object_index", "persistent", "room", "mouse_x", "mouse_y"];

export class GMRunner {
  guest = new Guest();
  exports!: Record<string, (a?: unknown) => unknown>;
  meta!: { cellNames: string[]; fns: { n: string; va: number; i: number }[] };
  fnByName = new Map<string, { n: string; va: number; i: number }>();
  instances = new Map<number, Instance>();
  instanceList: Instance[] = [];
  nextInstanceId = 100000;
  sprites: SpriteDef[] = [];
  objects: ObjectDef[] = [];
  rooms: { name: string; w: number; h: number; speed: number; instances: { obj: number; x: number; y: number }[] }[] = [];
  roomOrder: number[] = [];
  currentRoom = -1;
  globalVars = new Map<number, RV>();
  builtinFnNames = new Set<string>();
  keyboard = new Set<number>();
  mousePos = { x: 0, y: 0 };
  mouseButtons = new Set<number>();
  drawCalls = 0;
  errors: string[] = [];
  debugFn: ((msg: string) => void) | null = null;
  unimplementedBuiltins = new Map<string, number>();

  log(msg: string) { if (this.debugFn) this.debugFn(msg); else if (this.errors.length < 200) this.errors.push(msg); }

  async boot(wasmBytes: BufferSource, imageBytes: Uint8Array, meta: { cellNames: string[]; fns: { n: string; va: number; i: number }[] }, builtinNames: string[]) {
    this.meta = meta;
    for (const f of this.meta.fns) this.fnByName.set(f.n, f);
    for (const n of builtinNames) this.builtinFnNames.add(n);
    this.initCellIndexes();
    const mod = await WebAssembly.instantiate(wasmBytes, { abi: this.makeImports() });
    this.exports = (mod as WebAssembly.WebAssemblyInstantiatedSource).instance.exports as typeof this.exports;
    const mem = this.exports.mem as unknown as WebAssembly.Memory;
    this.guest.attach(mem);
    this.guest.u8.set(imageBytes.subarray(0, this.guest.u8.length));
    const rsp = this.exports.rsp as unknown as WebAssembly.Global;
    rsp.value = BigInt(0x02C00000);
  }

  callGuest(fnName: string, rcx = 0, rdx = 0, r8 = 0, r9 = 0): { rax: number; xmm0: number } {
    const f = this.fnByName.get(fnName);
    if (!f) throw new Error("no such guest fn: " + fnName);
    const exportName = "g_" + fnName.replace(/[^A-Za-z0-9_@]/g, "_");
    const fn = this.exports[exportName] as unknown as (a: bigint, b: bigint, c: bigint, d: bigint, e: bigint) => bigint[];
    if (!fn) throw new Error("no export " + exportName);
    let res: bigint[];
    try {
      res = fn(BigInt(rcx), BigInt(rdx), BigInt(r8), BigInt(r9), 0n);
    } catch (e) {
      (e as Error).message = "[" + this.abiTrace.join(" → ") + "] " + (e as Error).message;
      throw e;
    }
    return { rax: Number(res[0]), xmm0: Number(res[1]) };
  }

  makeImports(): Record<string, (rcx: number, rdx: number, r8: number, r9: number, rsp: number) => unknown[]> {
    const g = this.guest;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const stackArg = (rsp: number, n: number): number => Number(g.dv.getBigUint64(rsp + 0x28 + 8 * (n - 4), true));
    const impl: Record<string, (...args: number[]) => unknown[]> = {};
    const rvType = (p: number): number => g.dv.getUint32(p + 12, true) & 0xffffff;

    impl.f140041a50 = () => [0, 0]; // RValue_Free
    impl.f140041b80 = (rcx, rdx) => { g.u8.copyWithin(rcx, rdx, rdx + 16); return [0, 0]; }; // CopyAssign
    impl.f1400419b0 = (rcx, rdx) => { g.u8.copyWithin(rcx, rdx, rdx + 16); return [0, 0]; }; // CopyCtor
    impl.f140041c60 = (rcx, rdx) => { g.u8.copyWithin(rcx, rdx, rdx + 16); return [0, 0]; }; // Assign
    impl.f140041b30 = (rcx) => { impl.f140041a50(rcx, 0, 0, 0, 0); return [0, 0]; };
    // RValue array ctor/dtor helpers: (arr, size, count, [ctor/dtor via reg or stack])
    impl.f1400424d0 = (rcx, rdx, r8, r9, rsp) => {
      const ctor = r9 || Number(g.dv.getBigUint64(rsp + 0x28, true));
      for (let i = 0; i < r8; i++) {
        const elem = rcx + i * rdx;
        if (ctor && Number(ctor) !== 0) {
          try { impl.icall_reg(ctor, elem, 0, 0, 0); continue; } catch { /* fall through to zero-init */ }
        }
        g.dv.setBigUint64(elem, 0n, true); g.dv.setUint32(elem + 8, 0, true); g.dv.setUint32(elem + 12, 0, true);
      }
      return [0, 0];
    };
    // _eh_vector_destructor_iterator_(arr, size, count, dtor): run dtor per element
    impl.f140042560 = (rcx, rdx, r8, _r9, rsp) => {
      const dtor = Number(g.dv.getBigUint64(rsp + 0x28, true));
      for (let i = 0; i < r8; i++) impl.icall_reg(dtor, rcx + i * rdx, 0, 0, 0);
      return [0, 0];
    };
    impl.f140042490 = () => [0, 0]; impl.f1400424a0 = () => [0, 0]; impl.f1400424f0 = () => [0, 0];
    impl.f140e48e40 = (rcx) => { // TempSlot(result, N): allocate a zeroed RValue slot; return it
      const slot = self.guest.alloc(16, 16);
      self.guest.dv.setBigUint64(slot, 0n, true);
      self.guest.dv.setUint32(slot + 8, 0, true);
      self.guest.dv.setUint32(slot + 12, T_UNDEF, true);
      self.guest.writeRV(rcx, { v: slot, flags: 8, t: T_PTR });
      return [slot, 0];
    };
    impl.f140e609c0 = (slotPtr) => { // ScopePush(slot): register temp slot in the scope stack
      self.scopeStack.push(slotPtr);
      return [0, 0];
    };
    impl.f140e60910 = (n) => { // ScopePop(n): drop n scope registrations
      for (let i = 0; i < n && self.scopeStack.length; i++) self.scopeStack.pop();
      return [0, 0];
    };
    impl.f1400460e0 = (rcx, rdx) => { g.u8.copyWithin(rcx, rdx, rdx + 16); return [0, 0]; }; // Assign variant
    impl.f140e4b060 = (rcx) => {
      const t = rvType(rcx);
      let d = 0;
      if (t === T_STRING) d = parseFloat(g.readString(Number(g.dv.getBigUint64(rcx, true)))) || 0;
      else d = g.dv.getFloat64(rcx, true);
      return [0, d];
    };
    impl.f140e851f0 = (rcx, rdx, _r8, r9) => { // UnaryOp(result, a, typeCell, opSel)
      try {
        const opSel = r9 | 0;
        const a = g.readRV(rdx);
        if (a.t === T_STRING) {
          g.u8.copyWithin(rcx, rdx, rdx + 16);
          return [0, 0];
        }
        const av = self.rvToNum(a);
        if (opSel === 0) g.u8.copyWithin(rcx, rdx, rdx + 16); // identity/copy
        else g.writeRVDouble(rcx, -av); // negation variant
      } catch (e) { self.log("unaryop: " + String(e).slice(0, 80)); }
      return [0, 0];
    };
    impl.f140e634e0 = (rcx, rdx, r8, r9, rsp) => { // CallFunction(self, other, result, argc, id, args)
      const id = stackArg(rsp, 4);
      const argsPtr = stackArg(rsp, 5);
      self.dispatchFunction(rcx, rdx, r8, r9, id, argsPtr);
      return [0, 0];
    };
    impl.f140e63610 = (rcx, rdx, r8, r9, rsp) => {
      const id = stackArg(rsp, 4);
      const argsPtr = stackArg(rsp, 5);
      self.dispatchFunction(rcx, rdx, r8, r9, id, argsPtr);
      return [0, 0];
    };
    impl.f140e645a0 = (rcx, rdx, r8) => { // CreateMethod(result, nameStr, self)
      const p = g.alloc(32, 8);
      g.dv.setBigUint64(p, BigInt(rdx), true);
      g.dv.setBigUint64(p + 8, BigInt(r8), true);
      g.dv.setUint32(p + 16, 0x4d455448, true);
      g.writeRV(rcx, { v: p, flags: 8, t: T_OBJECT });
      return [0, 0];
    };
    impl.f140e87440 = (rcx, rdx, _r8, r9, rsp) => { // CallFunctionById(result, funcId, flags, argsPtr, [stack: argc, self])
      const argc = stackArg(rsp, 4);
      const selfInst = stackArg(rsp, 5);
      self.dispatchFunction(selfInst, 0, rcx, argc, rdx | 0, r9);
      return [0, 0];
    };
    impl.f140e491e0 = (rcx) => { // ToBool: value > 0.5 (double path)
      const t = rvType(rcx);
      if (t === T_BOOL) return [g.dv.getBigUint64(rcx, true) !== 0n ? 1 : 0, 0];
      const d = g.dv.getFloat64(rcx, true);
      return [d > 0.5 ? 1 : 0, 0];
    };
    impl.f140e4a8b0 = (rcx) => { // ToInt: floor-ish conversion
      const d = g.dv.getFloat64(rcx, true);
      const i = Number.isFinite(d) ? Math.trunc(d) : 0;
      return [i < 0 ? (i + 4294967296) : i, 0];
    };
    impl.f1400441d0 = (rcx, rdx) => { g.u8.copyWithin(rcx, rdx, rdx + 16); return [0, 0]; }; // Assign variant
    impl.f14128b1e0 = () => [0, 0]; // chkstk
    impl.udiv128 = () => { throw new Error("128-bit unsigned division encountered"); };
    impl.idiv128 = () => { throw new Error("128-bit signed division encountered"); };
    impl.cvttsd2si = (rcx) => {
      const d = rcx;
      if (Number.isNaN(d)) return [0, 0];
      const sat = Math.trunc(d);
      return [Number((BigInt(Math.trunc(Math.max(-2147483648, Math.min(2147483647, sat)))) & 0xffffffffn)), 0];
    };
    impl.icall = (vtbl, selfP, disp, rcx, rdx, r8, r9) => {
      void vtbl; void r8; void r9;
      return self.vtableCall(selfP, disp, rcx, rdx);
    };
    impl.icall_reg = (fnptr, rcx, rdx, r8, r9) => {
      const f = self.fnByVa(fnptr);
      if (!f) throw new Error("icall_reg: unknown fn ptr 0x" + fnptr.toString(16));
      const exportName = "g_" + f.n.replace(/[^A-Za-z0-9_@]/g, "_");
      const fn = self.exports[exportName] as (a: number, b: number, c: number, d: number, e: number) => number[];
      const res = fn(rcx, rdx, r8, r9, 0);
      return [Number(res[0]), Number(res[1])];
    };
    // wrap: wasm passes i64 params as BigInt; i64 returns must be BigInt
    const wrapped: Record<string, (rcx: number, rdx: number, r8: number, r9: number, rsp: number) => unknown[]> = {};
    for (const [k, fn] of Object.entries(impl)) {
      wrapped[k] = (a, b, c, d, e) => {
        if (self.traceABI) {
          self.abiTrace.push(k + "(" + Number(a) + "," + Number(b) + "," + Number(c) + ")");
          if (self.abiTrace.length > 40) self.abiTrace.shift();
        }
        try {
          const r = (fn as (a2: number, b2: number, c2: number, d2: number, e2: number) => number[])(Number(a), Number(b), Number(c), Number(d), Number(e));
          return [BigInt(Math.trunc(r[0])), r[1]];
        } catch (err) {
          (err as Error).message = "[" + self.abiTrace.join(" → ") + "] " + (err as Error).message;
          throw err;
        }
      };
    }
    return new Proxy(wrapped, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        return (a: unknown, b: unknown, c: unknown) => {
          const key = "abi:" + prop;
          self.unimplementedBuiltins.set(key, (self.unimplementedBuiltins.get(key) ?? 0) + 1);
          if ((self.unimplementedBuiltins.get(key) ?? 0) <= 3) self.log("unimplemented ABI " + prop + " rcx=" + Number(a) + " rdx=" + Number(b) + " r8=" + Number(c));
          return [0n, 0];
        };
      },
    });
  }

  fnByVa(va: number) { return this.meta.fns.find((f) => f.va === va); }
  rvToNum(r: RV): number {
    if (r.t === T_STRING) return parseFloat(this.guest.readString(r.v)) || 0;
    if (r.t === T_INT32) return r.v | 0;
    return r.v;
  }
  rvToString(r: RV): string { return r.t === T_STRING ? this.guest.readString(r.v) : String(r.v); }

  nullSlot = 0;
  vtableCall(selfPtr: number, disp: number, _rcx: number, rdx: number): number[] {
    if (!selfPtr) {
      if (!this.nullSlot) this.nullSlot = this.guest.alloc(16, 16);
      return [this.nullSlot, 0];
    }
    const cellId = this.guest.dv.getInt32(rdx, true);
    const inst = this.instanceByGuestPtr(selfPtr);
    const name = this.meta.cellNames[cellId] ?? "";
    const slot = this.varSlot(inst, cellId, name);
    return [slot, 0];
  }
  instanceByGuestPtr(p: number): Instance {
    const id = this.guestPtrMap.get(p);
    const inst = id !== undefined ? this.instances.get(id) : undefined;
    if (!inst) throw new Error("no instance at guest ptr 0x" + p.toString(16));
    return inst;
  }
  guestPtrMap = new Map<number, number>();

  varSlot(inst: Instance, cellId: number, name: string): number {
    let slot = inst.slots.get(cellId);
    if (slot === undefined) { slot = this.guest.alloc(16, 16); inst.slots.set(cellId, slot); }
    this.syncBuiltinToSlot(inst, name, slot);
    return slot;
  }
  syncBuiltinToSlot(inst: Instance, name: string, slot: number) {
    const g = this.guest;
    switch (name) {
      case "x": g.writeRVDouble(slot, inst.x); break;
      case "y": g.writeRVDouble(slot, inst.y); break;
      case "sprite_index": g.writeRVInt(slot, inst.spriteIndex); break;
      case "image_index": g.writeRVDouble(slot, inst.imageIndex); break;
      case "image_speed": g.writeRVDouble(slot, inst.imageSpeed); break;
      case "depth": g.writeRVDouble(slot, inst.depth); break;
      case "visible": g.writeRVBool(slot, inst.visible); break;
      case "hspeed": g.writeRVDouble(slot, inst.hspeed); break;
      case "vspeed": g.writeRVDouble(slot, inst.vspeed); break;
      case "speed": g.writeRVDouble(slot, inst.speed); break;
      case "direction": g.writeRVDouble(slot, inst.direction); break;
      case "image_xscale": g.writeRVDouble(slot, inst.imageXscale); break;
      case "image_yscale": g.writeRVDouble(slot, inst.imageYscale); break;
      case "image_angle": g.writeRVDouble(slot, inst.imageAngle); break;
      case "image_alpha": g.writeRVDouble(slot, inst.imageAlpha); break;
      case "id": g.writeRVDouble(slot, inst.id); break;
      case "object_index": g.writeRVInt(slot, inst.objIndex); break;
      case "persistent": g.writeRVBool(slot, inst.persistent); break;
      case "room": g.writeRVInt(slot, this.currentRoom); break;
      case "mouse_x": g.writeRVDouble(slot, this.mousePos.x); break;
      case "mouse_y": g.writeRVDouble(slot, this.mousePos.y); break;
      default: break;
    }
  }
  syncBuiltinFromSlot(inst: Instance, cellId: number, name: string) {
    const slot = inst.slots.get(cellId);
    if (slot === undefined) return;
    const g = this.guest;
    const t = g.dv.getUint32(slot + 12, true) & 0xffffff;
    const num = t === T_DOUBLE ? g.dv.getFloat64(slot, true) : Number(g.dv.getBigUint64(slot, true));
    switch (name) {
      case "x": inst.x = num; break;
      case "y": inst.y = num; break;
      case "sprite_index": inst.spriteIndex = num | 0; break;
      case "image_index": inst.imageIndex = num; break;
      case "image_speed": inst.imageSpeed = num; break;
      case "depth": inst.depth = num; break;
      case "visible": inst.visible = num !== 0; break;
      case "hspeed": inst.hspeed = num; break;
      case "vspeed": inst.vspeed = num; break;
      case "speed": inst.speed = num; break;
      case "direction": inst.direction = num; break;
      case "image_xscale": inst.imageXscale = num; break;
      case "image_yscale": inst.imageYscale = num; break;
      case "image_angle": inst.imageAngle = num; break;
      case "image_alpha": inst.imageAlpha = num; break;
      default: break;
    }
  }
  syncBuiltinFromSlotAll(inst: Instance) { for (const [cellId, name] of this.builtinCellCache) this.syncBuiltinFromSlot(inst, cellId, name); }
  globalInstPtr = 0;
  builtinCellCache: [number, string][] = [];

  dispatchFunction(selfPtr: number, otherPtr: number, resultPtr: number, argc: number, id: number, argsPtr: number) {
    try {
      const name = this.meta.cellNames[id];
      if (name === undefined) { this.log("dispatch: bad id " + id); this.guest.writeRVUndef(resultPtr); return; }
      if (this.builtinFnNames.has(name)) { this.callBuiltin(name, selfPtr, otherPtr, resultPtr, argc, argsPtr); return; }
      const f = this.fnByName.get("gml_Script_" + name) ?? this.fnByName.get(name);
      if (!f) { this.log("dispatch: unknown function " + name); this.guest.writeRVUndef(resultPtr); return; }
      const exportName = "g_" + f.n.replace(/[^A-Za-z0-9_@]/g, "_");
      const fn = this.exports[exportName] as unknown as (a: bigint, b: bigint, c: bigint, d: bigint, e: bigint) => bigint[];
      fn(BigInt(selfPtr), BigInt(otherPtr), BigInt(resultPtr), 0n, 0n);
    } catch (e) {
      this.log("dispatch " + (this.meta.cellNames[id] ?? id) + " threw: " + String(e).slice(0, 120));
      try { this.guest.writeRVUndef(resultPtr); } catch { /* oob result ptr */ }
    }
  }

  callBuiltin(name: string, selfPtr: number, _otherPtr: number, resultPtr: number, argc: number, argsPtr: number) {
    const g = this.guest;
    const arg = (i: number): number => argsPtr + i * 16;
    const num = (i: number): number => this.rvToNum(g.readRV(arg(i)));
    const str = (i: number): string => this.rvToString(g.readRV(arg(i)));
    const outD = (d: number) => g.writeRVDouble(resultPtr, d);
    const outB = (b: boolean) => g.writeRVBool(resultPtr, b);
    const outS = (s: string) => g.writeRV(resultPtr, { v: g.allocString(s), flags: 8, t: T_STRING });
    const outI = (i: number) => g.writeRVInt(resultPtr, i | 0);
    let inst: Instance;
    try { inst = this.instanceByGuestPtr(selfPtr); }
    catch { inst = this.nullInstance(); }
    switch (name) {
      case "abs": outD(Math.abs(num(0))); return;
      case "sign": outD(Math.sign(num(0))); return;
      case "round": outD(Math.round(num(0))); return;
      case "floor": outD(Math.floor(num(0))); return;
      case "ceil": case "ceiling": outD(Math.ceil(num(0))); return;
      case "sqrt": outD(Math.sqrt(num(0))); return;
      case "sqr": outD(num(0) * num(0)); return;
      case "sin": outD(Math.sin(num(0))); return;
      case "cos": outD(Math.cos(num(0))); return;
      case "tan": outD(Math.tan(num(0))); return;
      case "arcsin": outD(Math.asin(num(0))); return;
      case "arccos": outD(Math.acos(num(0))); return;
      case "arctan": outD(Math.atan(num(0))); return;
      case "arctan2": outD(Math.atan2(num(0), num(1))); return;
      case "exp": outD(Math.exp(num(0))); return;
      case "ln": outD(Math.log(num(0))); return;
      case "log2": outD(Math.log2(num(0))); return;
      case "log10": outD(Math.log10(num(0))); return;
      case "power": outD(Math.pow(num(0), num(1))); return;
      case "min": { let m = Infinity; for (let i = 0; i < argc; i++) m = Math.min(m, num(i)); outD(m); return; }
      case "max": { let m = -Infinity; for (let i = 0; i < argc; i++) m = Math.max(m, num(i)); outD(m); return; }
      case "median": { const a: number[] = []; for (let i = 0; i < argc; i++) a.push(num(i)); a.sort((x, y) => x - y); outD(a[Math.floor(a.length / 2)]); return; }
      case "clamp": outD(Math.max(num(0), Math.min(num(1), num(2)))); return;
      case "lerp": outD(num(0) + (num(1) - num(0)) * num(2)); return;
      case "random": outD(Math.random()); return;
      case "random_range": outD(num(0) + Math.random() * (num(1) - num(0))); return;
      case "irandom": outI(Math.floor(Math.random() * (num(0) + 1))); return;
      case "irandom_range": { const a = num(0), b = num(1); const lo = Math.min(a, b), hi = Math.max(a, b); outI(Math.floor(lo + Math.random() * (hi - lo + 1))); return; }
      case "randomise": case "randomize": return;
      case "degtorad": outD(num(0) * Math.PI / 180); return;
      case "radtodeg": outD(num(0) * 180 / Math.PI); return;
      case "dot_product": outD(num(0) * num(2) + num(1) * num(3)); return;
      case "point_distance": outD(Math.hypot(num(2) - num(0), num(3) - num(1))); return;
      case "point_direction": outD(Math.atan2(num(1) - num(3), num(2) - num(0)) * 180 / Math.PI); return;
      case "angle_difference": { let d = (num(0) - num(1)) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; outD(d); return; }
      case "is_real": outB(g.readRV(arg(0)).t !== T_STRING); return;
      case "is_string": outB(g.readRV(arg(0)).t === T_STRING); return;
      case "is_bool": outB(g.readRV(arg(0)).t === T_BOOL); return;
      case "is_undefined": outB(g.readRV(arg(0)).t === T_UNDEF); return;
      case "instance_exists": outB(this.someInstance(num(0))); return;
      case "instance_number": { const t = num(0); let c = 0; for (const i2 of this.instanceList) if (i2.alive && this.matchesObject(i2, t)) c++; outD(c); return; }
      case "instance_create_layer": case "instance_create_depth": outI(this.createInstance(num(2) | 0, num(0), num(1)).id); return;
      case "instance_destroy": { const t = argc > 0 ? num(0) : inst.id; const target = this.instances.get(t); if (target) target.alive = false; return; }
      case "instance_destroy_all": { const t = num(0); for (const i2 of this.instanceList) if (i2.alive && this.matchesObject(i2, t)) i2.alive = false; return; }
      case "instance_nearest": { const x = num(0), y = num(1), obj = num(2) | 0; let best = -1, bd = Infinity; for (const i2 of this.instanceList) if (i2.alive && this.matchesObject(i2, obj) && i2.id !== inst.id) { const d = Math.hypot(i2.x - x, i2.y - y); if (d < bd) { bd = d; best = i2.id; } } outD(best); return; }
      case "place_meeting": outB(this.placeMeeting(inst, num(0), num(1), num(2))); return;
      case "position_meeting": outB(this.placeMeeting(inst, num(0), num(1), num(2))); return;
      case "position_empty": outB(!this.placeMeeting(inst, num(0), num(1), num(2))); return;
      case "distance_to_object": { const t = num(0) | 0; let bd = Infinity; for (const i2 of this.instanceList) if (i2.alive && this.matchesObject(i2, t) && i2.id !== inst.id) bd = Math.min(bd, Math.hypot(i2.x - inst.x, i2.y - inst.y)); outD(bd === Infinity ? -1 : bd); return; }
      case "instance_find": { const t = num(0) | 0, n = num(1) | 0; let c = 0; for (const i2 of this.instanceList) if (i2.alive && this.matchesObject(i2, t)) { if (c === n) { outD(i2.id); return; } c++; } outD(-1); return; }
      case "instance_change": return;
      case "room_goto": this.gotoRoom(num(0) | 0); outD(0); return;
      case "room_goto_next": this.gotoRoom(this.roomOrder[this.roomOrder.indexOf(this.currentRoom) + 1]); outD(0); return;
      case "room_goto_previous": this.gotoRoom(this.roomOrder[this.roomOrder.indexOf(this.currentRoom) - 1]); outD(0); return;
      case "room_restart": this.gotoRoom(this.currentRoom); outD(0); return;
      case "room": outD(this.currentRoom); return;
      case "room_width": outD(this.rooms[this.currentRoom]?.w ?? 320); return;
      case "room_height": outD(this.rooms[this.currentRoom]?.h ?? 180); return;
      case "game_end": this.running = false; return;
      case "draw_sprite": this.drawSpriteExt(num(0) | 0, num(1) | 0, num(2), num(3), 1, 1, 0, 1, 0xffffff); return;
      case "draw_sprite_ext": this.drawSpriteExt(num(0) | 0, num(1) | 0, num(2), num(3), num(4), num(5), num(6), num(7), num(8) | 0); return;
      case "draw_sprite_stretched": this.drawSpriteStretched(num(0) | 0, num(1) | 0, num(2), num(3), num(4), num(5)); return;
      case "draw_self": this.drawSelf(inst); return;
      case "draw_set_color": this.drawColor = num(0) | 0; return;
      case "draw_set_alpha": this.drawAlpha = num(0); return;
      case "draw_set_font": this.drawFont = num(0) | 0; return;
      case "draw_set_halign": this.halign = num(0) | 0; return;
      case "draw_set_valign": this.valign = num(0) | 0; return;
      case "draw_rectangle": this.drawRect(num(0), num(1), num(2), num(3), num(4) !== 0); return;
      case "draw_circle": this.drawCircle(num(0), num(1), num(2), num(3) !== 0); return;
      case "draw_line": case "draw_line_width": this.drawLine(num(0), num(1), num(2), num(3)); return;
      case "draw_text": case "draw_text_ext": case "draw_text_transformed": this.drawText(num(0), num(1), str(2)); return;
      case "draw_clear": case "draw_clear_alpha": this.drawClear(num(0) | 0); return;
      case "string_width": outD(str(0).length * 8); return;
      case "string_height": outD(16); return;
      case "display_get_gui_width": outD(this.viewW); return;
      case "display_get_gui_height": outD(this.viewH); return;
      case "window_get_width": outD(this.viewW); return;
      case "window_get_height": outD(this.viewH); return;
      case "window_set_size": this.viewW = num(0); this.viewH = num(1); return;
      case "surface_set_target": return;
      case "surface_reset_target": return;
      case "surface_exists": outB(false); return;
      case "keyboard_check": outB(this.keyboard.has(this.mapKey(num(0)))); return;
      case "keyboard_check_pressed": outB(this.keyboardPressed.has(this.mapKey(num(0)))); return;
      case "keyboard_check_released": outB(this.keyboardReleased.has(this.mapKey(num(0)))); return;
      case "keyboard_clear": return;
      case "keyboard_key": outD(this.lastKey); return;
      case "mouse_check_button": outB(this.mouseButtons.has(num(0) | 0)); return;
      case "mouse_check_button_pressed": outB(this.mousePressed.has(num(0) | 0)); return;
      case "mouse_check_button_released": outB(this.mouseReleased.has(num(0) | 0)); return;
      case "mouse_x": case "window_mouse_get_x": case "device_mouse_x_to_gui": outD(this.mousePos.x); return;
      case "mouse_y": case "window_mouse_get_y": case "device_mouse_y_to_gui": outD(this.mousePos.y); return;
      case "device_mouse_check_button": outB(this.mouseButtons.has(num(1) | 0)); return;
      case "gamepad_is_connected": outB(false); return;
      case "gamepad_button_check": outB(false); return;
      case "gamepad_axis_value": outD(0); return;
      case "audio_play_sound": this.playSound(num(0) | 0, num(1) !== 0, num(2)); outB(true); return;
      case "audio_play_sound_on": this.playSound(num(1) | 0, num(2) !== 0, num(3)); outB(true); return;
      case "audio_stop_sound": this.stopSound(num(0) | 0); return;
      case "audio_stop_all": this.audio?.stopAll(); return;
      case "audio_sound_gain": case "audio_master_gain": case "audio_group_gain": case "audio_pause_all": case "audio_resume_all": return;
      case "audio_is_playing": outB(false); return;
      case "ds_list_create": outI(this.dsNewList()); return;
      case "ds_list_add": { const l = this.dsLists.get(num(0) | 0); if (l) for (let i = 1; i < argc; i++) l.push(g.readRV(arg(i))); return; }
      case "ds_list_size": { const l = this.dsLists.get(num(0) | 0); outD(l ? l.length : 0); return; }
      case "ds_list_delete": { const l = this.dsLists.get(num(0) | 0); if (l) l.splice(num(1) | 0, 1); return; }
      case "ds_list_clear": { const l = this.dsLists.get(num(0) | 0); if (l) l.length = 0; return; }
      case "ds_list_destroy": this.dsLists.delete(num(0) | 0); return;
      case "ds_list_empty": { const l = this.dsLists.get(num(0) | 0); outB(!l || l.length === 0); return; }
      case "ds_list_find_value": { const l = this.dsLists.get(num(0) | 0); const v = l?.[num(1) | 0]; if (v) g.writeRV(resultPtr, v); else outD(0); return; }
      case "ds_list_set": { const l = this.dsLists.get(num(0) | 0); if (l) l[num(1) | 0] = g.readRV(arg(2)); return; }
      case "ds_map_create": outI(this.dsNewMap()); return;
      case "ds_map_add": { const m = this.dsMaps.get(num(0) | 0); if (m) m.set(this.dsKey(arg(1)), g.readRV(arg(2))); outB(true); return; }
      case "ds_map_find_value": { const m = this.dsMaps.get(num(0) | 0); const v = m?.get(this.dsKey(arg(1))); if (v) g.writeRV(resultPtr, v); else outD(0); return; }
      case "ds_map_replace": { const m = this.dsMaps.get(num(0) | 0); if (m) m.set(this.dsKey(arg(1)), g.readRV(arg(2))); return; }
      case "ds_map_delete": { const m = this.dsMaps.get(num(0) | 0); if (m) m.delete(this.dsKey(arg(1))); return; }
      case "ds_map_destroy": this.dsMaps.delete(num(0) | 0); return;
      case "ds_map_size": { const m = this.dsMaps.get(num(0) | 0); outD(m ? m.size : 0); return; }
      case "ds_map_exists": { const m = this.dsMaps.get(num(0) | 0); outB(m ? m.has(this.dsKey(arg(1))) : false); return; }
      case "ds_map_clear": { const m = this.dsMaps.get(num(0) | 0); if (m) m.clear(); return; }
      case "ds_map_find_first": { const m = this.dsMaps.get(num(0) | 0); outS(m ? [...m.keys()][0] ?? "" : ""); return; }
      case "ds_grid_create": outI(this.dsNewGrid(num(0) | 0, num(1) | 0)); return;
      case "ds_grid_set": { const gr = this.dsGrids.get(num(0) | 0); if (gr) this.gridSet(num(0) | 0, num(1) | 0, num(2) | 0, num(3)); return; }
      case "ds_grid_get": outD(this.gridGet(num(0) | 0, num(1) | 0, num(2) | 0)); return;
      case "ds_grid_destroy": this.dsGrids.delete(num(0) | 0); return;
      case "ds_grid_clear": { const gr = this.dsGrids.get(num(0) | 0); if (gr) gr.fill(num(1)); return; }
      case "ds_grid_add": { this.gridSet(num(0) | 0, num(1) | 0, num(2) | 0, this.gridGet(num(0) | 0, num(1) | 0, num(2) | 0) + num(3)); return; }
      case "ds_stack_create": outI(this.dsNewList()); return;
      case "ds_stack_push": { const l = this.dsLists.get(num(0) | 0); if (l) l.push(g.readRV(arg(1))); return; }
      case "ds_stack_pop": { const l = this.dsLists.get(num(0) | 0); const v = l?.pop(); if (v) g.writeRV(resultPtr, v); else outD(0); return; }
      case "ds_stack_destroy": this.dsLists.delete(num(0) | 0); return;
      case "ds_queue_create": outI(this.dsNewList()); return;
      case "ds_queue_enqueue": { const l = this.dsLists.get(num(0) | 0); if (l) l.push(g.readRV(arg(1))); return; }
      case "ds_queue_destroy": this.dsLists.delete(num(0) | 0); return;
      case "ds_priority_create": outI(this.dsNewList()); return;
      case "ds_priority_add": { const l = this.dsLists.get(num(0) | 0); if (l) l.push(g.readRV(arg(1))); return; }
      case "ds_priority_destroy": this.dsLists.delete(num(0) | 0); return;
      case "array_length": outD(this.arrayLength(g.readRV(arg(0)))); return;
      case "array_create": outI(this.allocHostArray(num(0) | 0)); return;
      case "array_get": { const v = this.arrayGet(g.readRV(arg(0)), num(1) | 0); g.writeRV(resultPtr, v); return; }
      case "array_set": this.arraySet(g.readRV(arg(0)), num(1) | 0, g.readRV(arg(2))); return;
      case "array_push": { const arr = this.hostArrays.get(g.readRV(arg(0)).v); if (arr) for (let i = 1; i < argc; i++) arr.push(g.readRV(arg(i))); return; }
      case "array_delete": { const arr = this.hostArrays.get(g.readRV(arg(0)).v); if (arr) arr.splice(num(1) | 0, num(2) | 0); return; }
      case "variable_instance_get": outD(this.varByName(inst, str(0))); return;
      case "variable_instance_set": this.setVarByName(inst, str(0), num(1)); return;
      case "variable_global_get": { const id = this.globalVarIds.get(str(0)); const v = id !== undefined ? this.globalVars.get(id) : undefined; if (v) g.writeRV(resultPtr, v); else g.writeRVUndef(resultPtr); return; }
      case "variable_global_set": { const n = str(0); let id = this.globalVarIds.get(n); if (id === undefined) { id = this.nextVarId++; this.globalVarIds.set(n, id); } this.globalVars.set(id, g.readRV(arg(1))); return; }
      case "show_debug_message": this.log("[debug] " + str(0)); return;
      case "show_message": this.log("[msg] " + str(0)); return;
      case "fps": case "fps_real": outD(this.measuredFps); return;
      case "delta_time": outD(this.lastDeltaUs); return;
      case "get_timer": outD(Math.floor(performance.now() * 1000)); return;
      case "current_time": outD(performance.now() | 0); return;
      case "current_second": outD(new Date().getSeconds()); return;
      case "current_minute": outD(new Date().getMinutes()); return;
      case "current_hour": outD(new Date().getHours()); return;
      case "randomise": case "randomize": return;
      case "shader_get_uniform": outI(0); return;
      case "shader_set": case "shader_reset": return;
      case "shaders_are_supported": outB(false); return;
      case "json_parse": outI(this.dsNewMap()); return;
      case "json_stringify": outS("{}"); return;
      case "file_exists": outB(false); return;
      case "file_text_open_read": outI(-1); return;
      case "ini_open": case "ini_close": return;
      case "ini_read_real": outD(0); return;
      case "ini_read_string": outS(""); return;
      case "ini_write_real": case "ini_write_string": return;
      case "layer_create": outI(this.nextLayerId++); return;
      case "layer_destroy": case "layer_sprite_create": case "layer_background_create": return;
      case "layer_exists": outB(true); return;
      case "buffer_create": case "buffer_write": case "buffer_read": return;
      case "@@NewGMLArray@@": outI(this.allocHostArray(argc)); { const arr = this.hostArrays.get(resultPtr === 0 ? -1 : num(0)); void arr; } // args → new array
        { const id = this.nextArrayId - 1; const arr = this.hostArrays.get(id); if (arr) { arr.length = 0; for (let i = 0; i < argc; i++) arr.push(g.readRV(arg(i))); } outI(id); }
        return;
      case "@@NewGMLObject@@": outI(this.dsNewMap()); return;
      case "is_array": outB(this.hostArrays.has(g.readRV(arg(0)).v)); return;
      case "typeof": { const r = g.readRV(arg(0)); outS(r.t === T_STRING ? "string" : r.t === T_ARRAY || this.hostArrays.has(r.v) ? "array" : r.t === T_OBJECT ? "struct" : r.t === T_UNDEF ? "undefined" : "number"); return; }
      case "sprite_get_width": { const s = this.sprites[num(0) | 0]; outD(s?.w ?? 0); return; }
      case "sprite_get_height": { const s = this.sprites[num(0) | 0]; outD(s?.h ?? 0); return; }
      case "sprite_get_uvs": outI(this.dsNewList()); return;
      case "surface_get_width": outD(this.viewW); return;
      case "surface_get_height": outD(this.viewH); return;
      case "surface_get_texture": outI(-1); return;
      case "texture_get_uvs": outI(this.dsNewList()); return;
      case "extension_stubfunc_string": outS(""); return;
      case "asset_get_ids": outI(this.dsNewList()); return;
      case "draw_get_colour": case "draw_get_color": outD(this.drawColor); return;
      case "draw_get_alpha": outD(this.drawAlpha); return;
      case "variable_instance_exists": outB(this.nameToCell.has(str(0))); return;
      case "variable_global_exists": outB(this.globalVarIds.has(str(0))); return;
      case "method_get_index": outS(""); return;
      case "method_get_self": outD(-1); return;
      case "is_method": outB(false); return;
      case "instanceof": outB(false); return;
      case "struct_get": { const m = this.dsMaps.get(num(0) | 0); const v = m?.get("s:" + str(1)); if (v) g.writeRV(resultPtr, v); else g.writeRVUndef(resultPtr); return; }
      case "struct_set": { const m = this.dsMaps.get(num(0) | 0); if (m) m.set("s:" + str(1), g.readRV(arg(2))); return; }
      case "struct_exists": { const m = this.dsMaps.get(num(0) | 0); outB(m ? m.has("s:" + str(1)) : false); return; }
      case "sprite_exists": outB(num(0) >= 0 && (num(0) | 0) < this.sprites.length); return;
      case "object_exists": outB(num(0) >= 0 && (num(0) | 0) < this.objects.length); return;
      case "room_exists": outB(true); return;
      case "sound_exists": outB(num(0) >= 0 && (num(0) | 0) < this.soundNames.length); return;
      case "audio_sound_length": outD(1); return;
      case "window_has_focus": outB(true); return;
      case "window_set_cursor": case "cursor": return;
      case "io_clear": this.keyboard.clear(); this.mouseButtons.clear(); return;
      case "keyboard_set_map": case "keyboard_get_map": case "keyboard_unset_map": return;
      case "keyboard_numlock": outB(true); return;
      case "date_create_datetime": outD(45000); return;
      case "date_compare_datetime": outD(0); return;
      case "date_get_second": outD(0); return;
      case "string_join": { let s = ""; for (let i = 0; i < argc; i += 2) { if (i > 0) s += str(0); if (i + 1 < argc) s += str(i + 1); } outS(s); return; }
      case "string_split": { const arr = this.dsNewList(); const l = this.dsLists.get(arr)!; for (const part of str(0).split(str(1))) l.push({ v: g.allocString(part), flags: 8, t: T_STRING }); outI(arr); return; }
      case "real": outD(parseFloat(str(0)) || 0); return;
      case "time_source_create": outI(0); return;
      case "time_source_start": case "time_source_destroy": return;
      default: {
        this.unimplementedBuiltins.set(name, (this.unimplementedBuiltins.get(name) ?? 0) + 1);
        if ((this.unimplementedBuiltins.get(name) ?? 0) <= 3) this.log("unimplemented builtin: " + name + " argc=" + argc);
        g.writeRVUndef(resultPtr);
        return;
      }
    }
  }
  lastKey = 0;
  keyboardPressed = new Set<number>();
  keyboardReleased = new Set<number>();
  mousePressed = new Set<number>();
  mouseReleased = new Set<number>();
  drawColor = 0xffffff; drawAlpha = 1; drawFont = -1; halign = 0; valign = 0;
  viewW = 320; viewH = 180;
  measuredFps = 60; lastDeltaUs = 16666;
  dsNextId = 1; dsLists = new Map<number, RV[]>(); dsMaps = new Map<number, Map<string, RV>>(); dsGrids = new Map<number, Float64Array>();
  gridDims = new Map<number, [number, number]>();
  hostArrays = new Map<number, RV[]>();
  nextArrayId = 1; nextLayerId = 1; nextVarId = 50000;
  globalVarIds = new Map<string, number>();
  nameToCell = new Map<string, number>();
  running = true;
  abiTrace: string[] = [];
  scopeStack: number[] = [];
  traceABI = false;

  dsNewList() { const id = this.dsNextId++; this.dsLists.set(id, []); return id; }
  dsNewMap() { const id = this.dsNextId++; this.dsMaps.set(id, new Map()); return id; }
  dsNewGrid(w: number, h: number) { const id = this.dsNextId++; this.dsGrids.set(id, new Float64Array(Math.max(1, w * h))); this.gridDims.set(id, [w, h]); return id; }
  gridSet(id: number, x: number, y: number, v: number) { const gr = this.dsGrids.get(id); const d = this.gridDims.get(id); if (gr && d) gr[y * d[0] + x] = v; }
  gridGet(id: number, x: number, y: number): number { const gr = this.dsGrids.get(id); const d = this.gridDims.get(id); return gr && d ? gr[y * d[0] + x] ?? 0 : 0; }
  dsKey(p: number): string { const r = this.guest.readRV(p); return r.t === T_STRING ? "s:" + this.guest.readString(r.v) : "n:" + this.rvToNum(r); }
  allocHostArray(n: number): number { const id = this.nextArrayId++; this.hostArrays.set(id, new Array(n).fill({ v: 0, flags: 0, t: 0 })); return id; }
  arrayLength(r: RV): number { return this.hostArrays.get(r.v)?.length ?? 0; }
  arrayGet(r: RV, i: number): RV { return this.hostArrays.get(r.v)?.[i] ?? { v: 0, flags: 0, t: 0 }; }
  arraySet(r: RV, i: number, v: RV) { const a = this.hostArrays.get(r.v); if (a) a[i] = v; }

  matchesObject(inst: Instance, t: number): boolean { return inst.objIndex === t || t === -1; }
  someInstance(t: number): boolean { for (const i of this.instanceList) if (i.alive && this.matchesObject(i, t)) return true; return false; }

  createInstance(objIndex: number, x: number, y: number): Instance {
    const obj = this.objects[objIndex];
    const guestPtr = this.guest.alloc(256, 8);
    this.guest.dv.setBigUint64(guestPtr, BigInt(0x1cec7a10), true);
    const inst: Instance = {
      id: this.nextInstanceId++, objIndex, guestPtr, vars: new Map(), slots: new Map(),
      x, y, spriteIndex: obj?.sprite ?? -1, imageIndex: 0, imageSpeed: 1,
      depth: obj?.depth ?? 0, visible: obj?.visible ?? true, persistent: obj?.persistent ?? false,
      alive: true, alarms: new Array(12).fill(0),
      hspeed: 0, vspeed: 0, speed: 0, direction: 0,
      imageXscale: 1, imageYscale: 1, imageAngle: 0, imageAlpha: 1, imageBlend: 0xffffff,
    };
    this.instances.set(inst.id, inst);
    this.guestPtrMap.set(guestPtr, inst.id);
    this.instanceList.push(inst);
    this.runEvent(inst, "Create");
    return inst;
  }

  eventFn(objIndex: number, ev: string): string | null {
    const obj = this.objects[objIndex];
    if (!obj) return null;
    const fns = obj.events[ev];
    return fns && fns.length ? fns[0] : null;
  }
  runEvent(inst: Instance, ev: string) {
    const fnName = this.eventFn(inst.objIndex, ev);
    if (!fnName) return;
    this.syncBuiltinFromSlotAll(inst);
    try { this.callGuest(fnName, inst.guestPtr, inst.guestPtr, 0, 0); }
    catch (e) { this.log("event " + fnName + " threw: " + String(e).slice(0, 200)); }
    this.syncBuiltinFromSlotAll(inst);
  }

  loadWorld(sprites: SpriteDef[], objects: ObjectDef[], rooms: typeof this.rooms, order: number[], soundNames: string[]) {
    this.sprites = sprites;
    this.objects = objects;
    this.rooms = rooms;
    this.roomOrder = order;
    this.soundNames = soundNames;
  }
  roomTransitionDepth = 0;
  gotoRoom(idx: number) {
    if (idx === undefined || idx < 0 || idx >= this.rooms.length) { this.log("room_goto: bad room " + idx); return; }
    if (this.roomTransitionDepth > 4) { this.log("room_goto: transition depth exceeded, deferring " + idx); this.pendingRoom = idx; return; }
    this.roomTransitionDepth++;
    try {
    for (const i of this.instanceList) if (i.alive && !i.persistent) i.alive = false;
    this.currentRoom = idx;
    const room = this.rooms[idx];
    this.viewW = room.w; this.viewH = room.h;
    for (const ri of room.instances) this.createInstance(ri.obj, ri.x, ri.y);
    const cc = this.fnByName.get("gml_RoomCC_" + room.name + "_Create");
    if (cc) { try { this.callGuest(cc.n); } catch (e) { this.log("roomcc: " + String(e).slice(0, 120)); } }
    } finally { this.roomTransitionDepth--; }
  }
  pendingRoom = -1;

  stepFrame() {
    if (this.pendingRoom >= 0) { const r = this.pendingRoom; this.pendingRoom = -1; this.gotoRoom(r); }
    this.keyboardPressed.clear(); this.keyboardReleased.clear();
    this.mousePressed.clear(); this.mouseReleased.clear();
    if (this.currentRoom < 0) return;
    for (const inst of this.instanceList) {
      if (!inst.alive) continue;
      for (let a = 0; a < inst.alarms.length; a++) {
        if (inst.alarms[a] > 0) { inst.alarms[a]--; if (inst.alarms[a] === 0) this.runEvent(inst, "Alarm_" + a); }
      }
    }
    for (const inst of [...this.instanceList]) {
      if (!inst.alive) continue;
      inst.x += inst.hspeed; inst.y += inst.vspeed;
      this.runEvent(inst, "Step");
    }
    for (const inst of this.instanceList) {
      if (!inst.alive) { this.runEvent(inst, "Destroy"); this.instances.delete(inst.id); this.guestPtrMap.delete(inst.guestPtr); }
    }
    this.instanceList = this.instanceList.filter((i) => i.alive);
    this.drawCalls = 0;
    const sorted = [...this.instanceList].sort((a, b) => b.depth - a.depth);
    for (const inst of sorted) {
      if (this.eventFn(inst.objIndex, "Draw")) this.runEvent(inst, "Draw");
      else if (inst.visible) this.drawSelf(inst);
    }
  }

  spriteOf(inst: Instance): SpriteDef | null { return inst.spriteIndex >= 0 ? this.sprites[inst.spriteIndex] ?? null : null; }
  bbox(inst: Instance): [number, number, number, number] | null {
    const s = this.spriteOf(inst);
    if (!s) return null;
    return [inst.x - s.ox, inst.y - s.oy, inst.x - s.ox + s.w, inst.y - s.oy + s.h];
  }
  placeMeeting(inst: Instance, x: number, y: number, obj: number): boolean {
    const s = this.spriteOf(inst);
    if (!s) return false;
    const a = [x - s.ox, y - s.oy, x - s.ox + s.w, y - s.oy + s.h];
    for (const other of this.instanceList) {
      if (!other.alive || other.id === inst.id || !this.matchesObject(other, obj)) continue;
      const b = this.bbox(other);
      if (!b) continue;
      if (a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]) return true;
    }
    return false;
  }

  renderer: {
    drawSprite(name: string, frame: number, x: number, y: number, xs: number, ys: number, rot: number, alpha: number, blend: number): void;
    clear(color: number): void;
    rect(x1: number, y1: number, x2: number, y2: number, fill: boolean, color: number, alpha: number): void;
    circle(x: number, y: number, r: number, fill: boolean, color: number, alpha: number): void;
    line(x1: number, y1: number, x2: number, y2: number, color: number, alpha: number): void;
    text(x: number, y: number, s: string, color: number, alpha: number, halign: number, valign: number): void;
  } | null = null;

  drawSpriteExt(spr: number, img: number, x: number, y: number, xs: number, ys: number, rot: number, alpha: number, blend: number) {
    const s = this.sprites[spr];
    if (!s || !this.renderer) return;
    const f = s.frames.length ? s.frames[((img % s.frames.length) + s.frames.length) % s.frames.length] : 0;
    this.renderer.drawSprite(s.name, f, x, y, xs, ys, rot, alpha, blend);
    this.drawCalls++;
  }
  drawSpriteStretched(spr: number, img: number, x: number, y: number, w: number, h: number) {
    const s = this.sprites[spr];
    if (!s || !this.renderer || !s.w) return;
    const f = s.frames.length ? s.frames[((img % s.frames.length) + s.frames.length) % s.frames.length] : 0;
    this.renderer.drawSprite(s.name, f, x + w / 2, y + h / 2, w / s.w, h / s.h, 0, 1, 0xffffff);
  }
  drawSelf(inst: Instance) {
    this.drawSpriteExt(inst.spriteIndex, Math.floor(inst.imageIndex), inst.x, inst.y, inst.imageXscale, inst.imageYscale, inst.imageAngle, inst.imageAlpha, inst.imageBlend);
  }
  drawClear(color: number) { this.renderer?.clear(color); }
  drawRect(x1: number, y1: number, x2: number, y2: number, fill: boolean) { this.renderer?.rect(x1, y1, x2, y2, fill, this.drawColor, this.drawAlpha); }
  drawCircle(x: number, y: number, r: number, fill: boolean) { this.renderer?.circle(x, y, r, fill, this.drawColor, this.drawAlpha); }
  drawLine(x1: number, y1: number, x2: number, y2: number) { this.renderer?.line(x1, y1, x2, y2, this.drawColor, this.drawAlpha); }
  drawText(x: number, y: number, s: string) { this.renderer?.text(x, y, s, this.drawColor, this.drawAlpha, this.halign, this.valign); }

  audio: { play(name: string, loop: boolean, vol: number): void; stop(name: string): void; stopAll(): void } | null = null;
  soundNames: string[] = [];
  playSound(id: number, loop: boolean, vol: number) { const n = this.soundNames[id]; if (n) this.audio?.play(n, loop, vol); }
  stopSound(id: number) { const n = this.soundNames[id]; if (n) this.audio?.stop(n); }

  _nullInst: Instance | null = null;
  nullInstance(): Instance {
    if (!this._nullInst) {
      const guestPtr = this.guest.alloc(256, 8);
      this.guest.dv.setBigUint64(guestPtr, BigInt(0x1cec7a10), true);
      this._nullInst = { id: -1, objIndex: 0, guestPtr, vars: new Map(), slots: new Map(), x: 0, y: 0, spriteIndex: -1, imageIndex: 0, imageSpeed: 1, depth: 0, visible: true, persistent: false, alive: true, alarms: new Array(12).fill(0), hspeed: 0, vspeed: 0, speed: 0, direction: 0, imageXscale: 1, imageYscale: 1, imageAngle: 0, imageAlpha: 1, imageBlend: 0xffffff };
    }
    return this._nullInst;
  }

  varByName(inst: Instance, name: string): number {
    const cellId = this.nameToCell.get(name);
    if (cellId !== undefined) {
      const slot = inst.slots.get(cellId);
      if (slot !== undefined) return this.rvToNum(this.guest.readRV(slot));
    }
    return 0;
  }
  setVarByName(inst: Instance, name: string, v: number) {
    const cellId = this.nameToCell.get(name);
    if (cellId !== undefined) {
      let slot = inst.slots.get(cellId);
      if (slot === undefined) slot = this.varSlot(inst, cellId, name);
      this.guest.writeRVDouble(slot, v);
    }
  }

  initCellIndexes() {
    this.meta.cellNames.forEach((n, id) => { if (!this.nameToCell.has(n)) this.nameToCell.set(n, id); });
    for (const n of BUILTIN_VARS) {
      const cellId = this.nameToCell.get(n);
      if (cellId !== undefined) this.builtinCellCache.push([cellId, n]);
    }
  }

  mapKey(gmKey: number): number { return gmKey; }
}
