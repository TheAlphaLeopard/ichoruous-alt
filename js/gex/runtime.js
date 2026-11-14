const IMAGE_BASE = 5368709120;
// RValue kinds, from the runner's kind table at 0x140e4abe8. GameMaker stores
// an operand's kind in the low 24 bits of the fourth word of the RValue.
const T_DOUBLE = 0, T_STRING = 1, T_ARRAY = 2, T_PTR = 3, T_BOOL = 4, T_UNDEF = 5, T_OBJECT = 6, T_INT32 = 7;
const T_VEC3 = 8, T_VEC4 = 9, T_INT64 = 10, T_ACCESSOR = 11, T_NULL = 12, T_INT_BOOL = 13;
class Guest {
  constructor() {
    this.heapPtr = 32505856;
  }
  attach(mem) {
    this.mem = mem;
    this.u8 = new Uint8Array(mem.buffer);
    this.dv = new DataView(mem.buffer);
  }
  alloc(bytes, align = 8) {
    this.heapPtr = this.heapPtr + align - 1 & ~(align - 1);
    const p = this.heapPtr;
    this.heapPtr += bytes;
    if (this.heapPtr > 40894464) throw new Error("guest heap exhausted");
    return p;
  }
  readRV(p) {
    return { v: p >= 0 && p + 16 <= this.u8.length ? Number(this.dv.getBigUint64(p, true)) : 0, flags: p >= 0 ? this.dv.getUint32(p + 8, true) : 0, t: p >= 0 ? this.dv.getUint32(p + 12, true) & 16777215 : 0 };
  }
  writeRV(p, r) {
    this.dv.setBigUint64(p, BigInt(Math.trunc(r.v)), true);
    this.dv.setUint32(p + 8, r.flags, true);
    this.dv.setUint32(p + 12, r.t, true);
  }
  writeRVDouble(p, d) {
    this.dv.setFloat64(p, d, true);
    this.dv.setUint32(p + 8, 0, true);
    this.dv.setUint32(p + 12, T_DOUBLE, true);
  }
  writeRVInt(p, i) {
    this.dv.setBigUint64(p, BigInt(i | 0), true);
    this.dv.setUint32(p + 8, 0, true);
    this.dv.setUint32(p + 12, T_INT32, true);
  }
  writeRVBool(p, b) {
    this.dv.setBigUint64(p, b ? 1n : 0n, true);
    this.dv.setUint32(p + 8, 0, true);
    this.dv.setUint32(p + 12, T_BOOL, true);
  }
  writeRVUndef(p) {
    this.dv.setBigUint64(p, 0n, true);
    this.dv.setUint32(p + 8, 0, true);
    this.dv.setUint32(p + 12, T_UNDEF, true);
  }
  allocString(s) {
    const bytes = new TextEncoder().encode(s);
    const p = this.alloc(bytes.length + 8, 8);
    this.dv.setUint32(p, bytes.length, true);
    this.u8.set(bytes, p + 8);
    return p;
  }
  readString(p) {
    if (!p || p + 8 > this.u8.length) return "";
    const len = this.dv.getUint32(p, true);
    return new TextDecoder().decode(this.u8.subarray(p + 8, p + 8 + Math.min(len, 1 << 20)));
  }
  readCStr(p) {
    if (!p || p >= this.u8.length) return "";
    let s = "";
    for (let i = 0; i < 4096; i++) {
      const c = this.u8[p + i];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}
const BUILTIN_VARS = ["x", "y", "sprite_index", "image_index", "image_speed", "depth", "visible", "hspeed", "vspeed", "speed", "direction", "image_xscale", "image_yscale", "image_angle", "image_alpha", "id", "object_index", "persistent", "room", "mouse_x", "mouse_y"];
class GMRunner {
  constructor() {
    this.guest = new Guest();
    this.fnByName = /* @__PURE__ */ new Map();
    this.instances = /* @__PURE__ */ new Map();
    this.instanceList = [];
    this.nextInstanceId = 1e5;
    this.sprites = [];
    this.objects = [];
    this.rooms = [];
    this.roomOrder = [];
    this.roomSkip = /* @__PURE__ */ new Set();
    this.currentRoom = -1;
    this.globalVars = /* @__PURE__ */ new Map();
    this.builtinFnNames = /* @__PURE__ */ new Set();
    this.keyboard = /* @__PURE__ */ new Set();
    this.mousePos = { x: 0, y: 0 };
    this.mouseButtons = /* @__PURE__ */ new Set();
    this.drawCalls = 0;
    this.errors = [];
    this.debugFn = null;
    this.unimplementedBuiltins = /* @__PURE__ */ new Map();
    this.nullSlot = 0;
    this.guestPtrMap = /* @__PURE__ */ new Map();
    this.globalInstPtr = 0;
    this.builtinCellCache = [];
    this.lastKey = 0;
    this.keyboardPressed = /* @__PURE__ */ new Set();
    this.keyboardReleased = /* @__PURE__ */ new Set();
    this.mousePressed = /* @__PURE__ */ new Set();
    this.mouseReleased = /* @__PURE__ */ new Set();
    this.drawColor = 16777215;
    this.drawAlpha = 1;
    this.drawFont = -1;
    this.halign = 0;
    this.valign = 0;
    this.viewW = 320;
    this.viewH = 180;
    this.measuredFps = 60;
    this.lastDeltaUs = 16666;
    this.dsNextId = 1;
    this.dsLists = /* @__PURE__ */ new Map();
    this.dsMaps = /* @__PURE__ */ new Map();
    this.dsGrids = /* @__PURE__ */ new Map();
    this.gridDims = /* @__PURE__ */ new Map();
    this.hostArrays = /* @__PURE__ */ new Map();
    this.nextArrayId = 1;
    this.nextLayerId = 1;
    this.nextVarId = 5e4;
    this.globalVarIds = /* @__PURE__ */ new Map();
    this.nameToCell = /* @__PURE__ */ new Map();
    this.running = true;
    this.methods = /* @__PURE__ */ new Map();
    this.methodIntern = /* @__PURE__ */ new Map();
    this.methodSeq = 0;
    this.abiTrace = [];
    this.scopeStack = [];
    this.traceABI = false;
    // member storage for `a.b` (see setMember/getMember) and the self/other
    // pointers the running script was entered with
    this.members = /* @__PURE__ */ new Map();
    this.unknownInsts = /* @__PURE__ */ new Map();
    this.structIds = /* @__PURE__ */ new Map();
    this.unknownCallTargets = /* @__PURE__ */ new Map();
    this.curSelfPtr = 0;
    this.curOtherPtr = 0;
    this.runnerErrors = /* @__PURE__ */ new Map();
    // --- watchdog -----------------------------------------------------------
    // Guest code can spin forever. Some loops call back into the host on every
    // iteration, and those we can abort cooperatively: the hot ABI entries
    // check the budget and throw, which unwinds straight out of the wasm
    // frames. A loop that never calls the host can only be stopped by
    // terminating the worker it runs in — see js/main.js.
    this.callDepth = 0;
    this.budgetMs = 0; // per top-level call, 0 = unlimited
    this.budgetStart = 0;
    this.budgetTicks = 0;
    this.eventBudgetMs = 250;
    this.roomBudgetMs = 5000;
    this.logCount = 0;
    this.timeouts = 0;
    this.eventTimeouts = /* @__PURE__ */ new Map();
    this.disabledFns = /* @__PURE__ */ new Set();
    this.roomTransitionDepth = 0;
    this.pendingRoom = -1;
    this.renderer = null;
    this.audio = null;
    this.soundNames = [];
    this._nullInst = null;
  }
  now() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }
  // Cheap enough to call from hot ABI entries: only actually looks at the clock
  // every 1024th call.
  checkBudget(where) {
    if (!this.budgetMs || this.callDepth === 0) return;
    if ((++this.budgetTicks & 1023) !== 0) return;
    if (this.now() - this.budgetStart > this.budgetMs) {
      this.timeouts++;
      throw new Error("guest timeout after " + this.budgetMs + "ms at " + where);
    }
  }
  log(msg) {
    this.logCount++;
    if (this.debugFn) this.debugFn(msg);
    else if (this.errors.length < 200) this.errors.push(msg);
  }
  async boot(wasmBytes, imageBytes, meta, builtinNames) {
    this.meta = meta;
    for (const f of this.meta.fns) this.fnByName.set(f.n, f);
    for (const n of builtinNames) this.builtinFnNames.add(n);
    this.initCellIndexes();
    const mod = await WebAssembly.instantiate(wasmBytes, { abi: this.makeImports() });
    this.exports = mod.instance.exports;
    const mem = this.exports.mem;
    this.guest.attach(mem);
    this.guest.u8.set(imageBytes.subarray(0, this.guest.u8.length));
    const rsp = this.exports.rsp;
    rsp.value = BigInt(46137344);
  }
  callGuest(fnName, rcx = 0, rdx = 0, r8 = 0, r9 = 0) {
    const f = this.fnByName.get(fnName);
    if (!f) throw new Error("no such guest fn: " + fnName);
    const exportName = "g_" + fnName.replace(/[^A-Za-z0-9_@]/g, "_");
    const fn = this.exports[exportName];
    if (!fn) throw new Error("no export " + exportName);
    const top = this.callDepth === 0;
    if (top && this.budgetMs) this.budgetStart = this.now();
    this.callDepth++;
    let res;
    try {
      res = fn(BigInt(rcx), BigInt(rdx), BigInt(r8), BigInt(r9), 0n);
    } catch (e) {
      e.message = "[" + this.abiTrace.join(" \u2192 ") + "] " + e.message;
      throw e;
    } finally {
      this.callDepth--;
    }
    return { rax: Number(res[0]), xmm0: Number(res[1]) };
  }
  // Enter a lifted function with the same bookkeeping callGuest does. The
  // budget watchdog only arms itself at callDepth 0, and only callGuest used
  // to move that counter - so a script reached through a call from another
  // script ran with the watchdog permanently disarmed, and a handler that
  // spun took the whole tab with it instead of being timed out and disabled.
  enterGuest(fn, a, b, c, d, e) {
    // Runaway recursion burns the JS stack, which V8 reports as an
    // unrecoverable out-of-memory rather than a catchable stack overflow.
    // Bounding the depth turns it into an ordinary error.
    if (this.callDepth >= (this.maxCallDepth ?? 2000)) throw new Error("guest call depth exceeded at " + this.callDepth);
    const top = this.callDepth === 0;
    if (top && this.budgetMs) this.budgetStart = this.now();
    this.callDepth++;
    try {
      return fn(a, b, c, d, e);
    } finally {
      this.callDepth--;
    }
  }
  makeImports() {
    const g = this.guest;
    const self = this;
    const stackArg = (rsp, n) => Number(g.dv.getBigUint64(rsp + 40 + 8 * (n - 4), true));
    const impl = {};
    const rvType = (p) => g.dv.getUint32(p + 12, true) & 16777215;
    impl.f140041a50 = () => [0, 0];
    impl.f140041b80 = (rcx, rdx) => {
      g.u8.copyWithin(rcx, rdx, rdx + 16);
      return [0, 0];
    };
    impl.f1400419b0 = (rcx, rdx) => {
      g.u8.copyWithin(rcx, rdx, rdx + 16);
      return [0, 0];
    };
    impl.f140041c60 = (rcx, rdx) => {
      g.u8.copyWithin(rcx, rdx, rdx + 16);
      return [0, 0];
    };
    impl.f140041b30 = (rcx) => {
      impl.f140041a50(rcx, 0, 0, 0, 0);
      return [0, 0];
    };
    impl.f1400424d0 = (rcx, rdx, r8, r9, rsp) => {
      const ctor = r9 || Number(g.dv.getBigUint64(rsp + 40, true));
      for (let i = 0; i < r8; i++) {
        const elem = rcx + i * rdx;
        if (ctor && Number(ctor) !== 0) {
          try {
            impl.icall_reg(ctor, elem, 0, 0, 0);
            continue;
          } catch {
          }
        }
        g.dv.setBigUint64(elem, 0n, true);
        g.dv.setUint32(elem + 8, 0, true);
        g.dv.setUint32(elem + 12, 0, true);
      }
      return [0, 0];
    };
    impl.f140042560 = (rcx, rdx, r8, _r9, rsp) => {
      const dtor = Number(g.dv.getBigUint64(rsp + 40, true));
      for (let i = 0; i < r8; i++) impl.icall_reg(dtor, rcx + i * rdx, 0, 0, 0);
      return [0, 0];
    };
    impl.f140042490 = () => [0, 0];
    impl.f1400424a0 = () => [0, 0];
    impl.f1400424f0 = () => [0, 0];
    impl.f140e48e40 = (rcx) => {
      self.checkBudget("tempslot");
      const slot = self.guest.alloc(16, 16);
      self.guest.dv.setBigUint64(slot, 0n, true);
      self.guest.dv.setUint32(slot + 8, 0, true);
      self.guest.dv.setUint32(slot + 12, T_UNDEF, true);
      self.guest.writeRV(rcx, { v: slot, flags: 8, t: T_PTR });
      return [slot, 0];
    };
    impl.f140e609c0 = (slotPtr) => {
      self.scopeStack.push(slotPtr);
      return [0, 0];
    };
    impl.f140e60910 = (n) => {
      for (let i = 0; i < n && self.scopeStack.length; i++) self.scopeStack.pop();
      return [0, 0];
    };
    impl.f1400460e0 = (rcx, rdx) => {
      g.u8.copyWithin(rcx, rdx, rdx + 16);
      return [0, 0];
    };
    impl.f140e4b060 = (rcx) => {
      const t = rvType(rcx);
      let d = 0;
      if (t === T_STRING) d = parseFloat(g.readString(Number(g.dv.getBigUint64(rcx, true)))) || 0;
      else d = g.dv.getFloat64(rcx, true);
      return [0, d];
    };
    // Three-way comparison: rcx is the left operand, rdx the right, and the
    // result is -1, 0 or 1 in rax - not a boolean. Lifted `for` and `while`
    // loops test `rax < 0` afterwards (the sign of a subtraction), so a shim
    // that returned a boolean made them run either zero times or forever.
    impl.f140e851f0 = (rcx, rdx) => {
      try {
        const a = g.readRV(rcx), b = g.readRV(rdx);
        if (a.t === T_STRING && b.t === T_STRING) {
          const x = g.readString(a.v), y = g.readString(b.v);
          return [x < y ? -1 : x > y ? 1 : 0, 0];
        }
        const x = self.rvToNum(a), y = self.rvToNum(b);
        return [x < y ? -1 : x > y ? 1 : 0, 0];
      } catch (e) {
        self.log("compare: " + String(e).slice(0, 80));
      }
      return [0, 0];
    };
    // RValue multiply in place: (dst, src) -> dst = dst * src, returning dst.
    // The real function switches on the kind of its first argument and has no
    // third argument at all; reading one as a count made it loop 50 million
    // times over a destructuring thunk it had invented, which hung the whole
    // interpreter inside a single wasm frame where nothing could interrupt it.
    impl.f140042560 = (rcx, rdx) => {
      const a = self.rvToNum(g.readRV(rcx)), b = self.rvToNum(g.readRV(rdx));
      const v = a * b;
      const t = rvType(rcx);
      if (t === T_INT32) g.dv.setInt32(rcx, Math.trunc(v) | 0, true);
      else if (t === T_INT64) g.dv.setBigUint64(rcx, BigInt(Math.trunc(v)), true);
      else g.writeRVDouble(rcx, v);
      return [rcx, 0];
    };
    // Call a GML function: (self, other, RValue *result, argc, callee, args).
    // The callee slot has three shapes - a plain cell id for a built-in, a
    // pointer to an RValue holding a GMS 2.3 method, and occasionally a raw
    // code address - so it has to be resolved before it is dispatched.
    impl.f140e634e0 = (rcx, rdx, r8, r9, rsp) => {
      self.dispatchFunction(rcx, rdx, r8, r9, stackArg(rsp, 4), stackArg(rsp, 5));
      return [0, 0];
    };
    impl.f140e63610 = (rcx, rdx, r8, r9, rsp) => {
      self.dispatchFunction(rcx, rdx, r8, r9, stackArg(rsp, 4), stackArg(rsp, 5));
      return [0, 0];
    };
    // GMS 2.3 method creation: (RValue *out, code address of the script,
    // struct to bind or 0). The real runner allocates a 0xe0-byte object
    // tagged "METH" here and stores the script at +0x90 and the struct at
    // +0xa8. This keeps the record on the JS side instead: the game builds
    // a quarter of a million of these in a single frame, and nothing in this
    // shim frees memory, so handing out a real allocation each time is what
    // exhausted the 8MB guest heap.
    impl.f140e645a0 = (rcx, rdx, r8) => {
      // rdx is the script's code address and arrives as an RVA (0xd21190,
      // not 0x140d21190), so it has to go through fnByPtr rather than being
      // compared against the image base directly.
      const f = self.fnByPtr(rdx);
      const va = f ? f.va : Number(rdx);
      if (!(r8 | 0) && va >= IMAGE_BASE) {
        // Unbound: the script's own code address is the payload. Real guest
        // pointers all live in the 48MB image, so anything at or above the
        // image base can only be one of these, and the method costs no
        // memory at all worth speaking of.
        g.writeRV(rcx, { v: va, flags: 8, t: T_OBJECT });
        return [0, 0];
      }
      // A bound method needs a record, and the game makes them by the
      // hundred thousand. Intern on (script, struct): two methods over the
      // same function and the same struct are interchangeable, so handing
      // back the same handle collapses a loop that would otherwise add a
      // fresh entry per iteration and exhaust memory.
      const key = va + "|" + (r8 | 0);
      let id = self.methodIntern.get(key);
      if (id === void 0) {
        id = ++self.methodSeq;
        self.methodIntern.set(key, id);
        self.methods.set(id, { fn: f ? f.n : null, va, self: r8 | 0 });
      }
      g.writeRV(rcx, { v: id, flags: 8, t: T_OBJECT });
      return [0, 0];
    };
    // `a.b` read where the left-hand side is already an instance pointer: the
    // sibling of f140e87170 that f140e86fa0 is to f140e87930. Arguments are
    // (instance, member cell id, array index or 0x80000000, RValue *out); the
    // byte it returns is "found". Note it takes no stack arguments - an earlier
    // version of this shim read two, which produced the "dispatch: bad id"
    // flood, since those slots hold something else entirely.
    impl.f140e87440 = (rcx, rdx, _r8, r9) => {
      self.getMember(rcx >>> 0, rdx | 0, r9);
      return [1, 0];
    };
    impl.f140e491e0 = (rcx) => {
      const t = rvType(rcx);
      if (t === T_BOOL) return [g.dv.getBigUint64(rcx, true) !== 0n ? 1 : 0, 0];
      const d = g.dv.getFloat64(rcx, true);
      return [d > 0.5 ? 1 : 0, 0];
    };
    impl.f140e4a8b0 = (rcx) => {
      const d = g.dv.getFloat64(rcx, true);
      const i = Number.isFinite(d) ? Math.trunc(d) : 0;
      return [i < 0 ? i + 4294967296 : i, 0];
    };
    impl.f1400441d0 = (rcx, rdx) => {
      g.u8.copyWithin(rcx, rdx, rdx + 16);
      return [0, 0];
    };
    impl.f14128b1e0 = () => [0, 0];
    impl.udiv128 = () => {
      throw new Error("128-bit unsigned division encountered");
    };
    impl.idiv128 = () => {
      throw new Error("128-bit signed division encountered");
    };
    impl.cvttsd2si = (rcx) => {
      const d = rcx;
      if (Number.isNaN(d)) return [0, 0];
      const sat = Math.trunc(d);
      return [Number(BigInt(Math.trunc(Math.max(-2147483648, Math.min(2147483647, sat)))) & 0xffffffffn), 0];
    };
    impl.icall = (vtbl, selfP, disp, rcx, rdx, r8, r9) => {
      void vtbl;
      void selfP;
      void r8;
      void r9;
      // rcx is `this` - a Windows x64 member call always passes the object in
      // rcx. selfP, the base register of the call's memory operand, is the
      // vtable pointer, and using it as the instance sent every object through
      // unknownInst() and so into one shared set of variable slots.
      return self.vtableCall(rcx, disp, rcx, rdx);
    };
    // Resolve an indirect call target. The guest stores some function pointers
    // as RVAs (offsets from the image base) rather than full VAs, so a bare
    // offset has to be rebased before it can be looked up. Note the image base
    // itself has non-zero low 32 bits, so an already-absolute VA must have the
    // base *subtracted*, never masked back down.
    const resolve = (fnptr) => {
      let va = Number(fnptr);
      if (!Number.isFinite(va) || va <= 0) return null;
      if (va >= IMAGE_BASE) va -= IMAGE_BASE;
      if (va > 0 && va < IMAGE_BASE) va += IMAGE_BASE;
      const f = self.fnByVa(va);
      if (f) {
        const fn = self.exports["g_" + f.n.replace(/[^A-Za-z0-9_@]/g, "_")];
        if (fn) return (a, b, c, d) => { const r = fn(a, b, c, d, 0); return [Number(r[0]), Number(r[1])]; };
      }
      // the target may be a runner function this shim implements
      const sub = impl["f" + va.toString(16)];
      if (sub) return (a, b, c, d, rsp) => { const r = sub(a, b, c, d, rsp); return [Number(r[0]), Number(r[1])]; };
      return null;
    };
    impl.icall_reg = (fnptr, rcx, rdx, r8, r9, rsp) => {
      const target = resolve(fnptr);
      if (!target) {
        // Throwing here is deliberate. Returning zero instead lets scripts such
        // as gml_GlobalScript_ImGui spin forever inside a single wasm frame,
        // where the watchdog cannot reach them; aborting costs one script and
        // keeps the page responsive.
        const key = "icall_reg:0x" + (Number(fnptr) >>> 0).toString(16);
        const n = (this.unknownCallTargets.get(key) ?? 0) + 1;
        this.unknownCallTargets.set(key, n);
        throw new Error("icall_reg: unknown fn ptr 0x" + (Number(fnptr) >>> 0).toString(16));
      }
      return target(rcx, rdx, r8, r9, rsp);
    };
    // _eh_vector_constructor_iterator(ptr, stride, count, ctor): MSVC helper the
    // compiler emits for arrays of RValues. Without it every element of a GML
    // array literal is left as whatever was on the stack.
    impl.f14128ab40 = (rcx, rdx, r8, r9, rsp) => {
      const count = r8 | 0;
      if (!(count > 0) || count > 1e6) return [0, 0];
      for (let i = 0; i < count; i++) {
        const elem = rcx + i * rdx;
        let done = false;
        if (r9) { try { impl.icall_reg(r9, elem, 0, 0, 0, rsp); done = true; } catch { /* unresolvable ctor */ } }
        if (!done) { g.dv.setBigUint64(elem, 0n, true); g.dv.setUint32(elem + 8, 0, true); g.dv.setUint32(elem + 12, 0, true); }
      }
      return [0, 0];
    };
    // --- group 1: the ten hottest runner calls -------------------------------
    // YYError(const char *fmt, ...). Every YYC-generated type/variable check
    // funnels into this. The real runner aborts the game; here we record the
    // message once per format string and carry on, which is what the happy
    // path expects (these calls are never reached when the check passes).
    impl.f140e632c0 = (rcx) => {
      const fmt = rcx ? g.readCStr(rcx >>> 0) : "";
      const n = (self.runnerErrors.get(fmt) ?? 0) + 1;
      self.runnerErrors.set(fmt, n);
      if (n <= 3) self.log("runner error: " + (fmt || "0x" + (rcx >>> 0).toString(16)));
      return [0, 0];
    };
    // YYGetInt64(RValue *rcx) -> int64 in rax. See GMRunner.rvToInt64.
    impl.f140e4a740 = (rcx) => [self.rvToInt64(rcx), 0];
    // `a.b = v` where the left-hand side is still an RValue: resolve it, then
    // store. rdx = member cell id, r8 = array index (0x80000000 = none),
    // r9 = RValue holding the value.
    impl.f140e87930 = (rcx, rdx, _r8, r9) => {
      self.setMember(self.memberKeyFor(rcx), rdx | 0, r9);
      return [1, 0];
    };
    // `a.b = v` where the left-hand side is already an instance pointer.
    impl.f140e86fa0 = (rcx, rdx, _r8, r9) => {
      self.setMember(rcx >>> 0, rdx | 0, r9);
      return [1, 0];
    };
    // `a.b` read. Same arguments, but r9 is the RValue to write the result into.
    impl.f140e87170 = (rcx, rdx, _r8, r9) => {
      self.getMember(self.memberKeyFor(rcx), rdx | 0, r9);
      return [1, 0];
    };
    // RValue destructor with the "free the value" flag cleared. YYC emits this
    // at the end of every scope for each temporary; with no refcounting in this
    // shim there is genuinely nothing to do.
    impl.f140e4cd60 = () => [0, 0];
    // Constructor prelude: store the owning instance/struct pointer on the new
    // object. The decrement it performs first is a "am I inside a `new`?" guard
    // whose only effect is the error path above.
    impl.f140e643a0 = (rcx, rdx) => {
      if (rcx) g.dv.setBigUint64(rcx + 0x20, BigInt(rdx), true);
      return [0, 0];
    };
    // Set an object's name pointer and mark it as named (flag 8 at +0x58).
    impl.f140e64380 = (rcx, rdx) => {
      if (!rcx) return [0, 0];
      const flags = Number(g.dv.getBigUint64(rcx + 0x58, true));
      if (flags & 8) return [0, 0];
      g.dv.setBigUint64(rcx + 0x28, BigInt(rdx), true);
      g.dv.setBigUint64(rcx + 0x58, BigInt(flags | 8), true);
      return [0, 0];
    };
    // RValue::operator=(RValue *rcx, int rdx): release the old value if it was
    // a string/array/object, then store rdx as a real.
    impl.f140044220 = (rcx, rdx) => {
      if (!rcx) return [rcx, 0];
      const k = g.dv.getUint32(rcx + 12, true) & 31;
      if (1 << k & 70) impl.f140041a50(rcx, 0, 0, 0, 0);
      g.writeRVDouble(rcx, rdx | 0);
      return [rcx, 0];
    };
    // RValue copy (rcx = dst, rdx = src).
    impl.f1400424f0 = (rcx, rdx) => {
      self.copyRV(rcx, rdx);
      return [rcx, 0];
    };
    impl.f1400424a0 = (rcx, rdx) => {
      self.copyRV(rcx, rdx);
      return [0, 0];
    };
    // _eh_vector_destructor_iterator(ptr, stride, count, dtor): same, in reverse.
    impl.f14128aa70 = (rcx, rdx, r8, r9, rsp) => {
      const count = r8 | 0;
      if (!(count > 0) || count > 1e6) return [0, 0];
      for (let i = count - 1; i >= 0; i--) {
        if (!r9) continue;
        try { impl.icall_reg(r9, rcx + i * rdx, 0, 0, 0, rsp); } catch { /* unresolvable dtor */ }
      }
      return [0, 0];
    };
    this.abiCounts = new Map();
    const wrapped = {};
    for (const [k, fn] of Object.entries(impl)) {
      wrapped[k] = (a, b, c, d, e) => {
        // Every import call is a host boundary, which makes it the only place
        // a guest loop can be stopped from outside. Checking only in
        // dispatchFunction left loops that allocate without calling anything
        // dispatchable free to run until the process ran out of memory.
        self.checkBudget(k);
        if (self.traceABI) {
          self.abiTrace.push(k + "(" + Number(a) + "," + Number(b) + "," + Number(c) + ")");
          if (self.abiTrace.length > 40) self.abiTrace.shift();
        }
        if (self.countABI) self.abiCounts.set(k, (self.abiCounts.get(k) ?? 0) + 1);
        try {
          const r = fn(Number(a), Number(b), Number(c), Number(d), Number(e));
          return [BigInt(Math.trunc(r[0])), r[1]];
        } catch (err) {
          err.message = "[" + self.abiTrace.join(" \u2192 ") + "] " + err.message;
          throw err;
        }
      };
    }
    return new Proxy(wrapped, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return (a, b, c, d, e) => {
          const key = "abi:" + prop;
          const n = (self.unimplementedBuiltins.get(key) ?? 0) + 1;
          self.unimplementedBuiltins.set(key, n);
          // opt-in probe (see tools/probe-abi.mjs): records raw arguments for the
          // first few calls so an unimplemented runner function can be identified
          if (self.abiProbe) {
            let rec = self.abiProbe.get(prop);
            if (!rec) self.abiProbe.set(prop, rec = []);
            if (rec.length < 4) {
              const stack = [];
              for (let i = 4; i <= 8; i++) {
                try { stack.push(Number(g.dv.getBigUint64(Number(e) + 40 + 8 * (i - 4), true))); }
                catch { stack.push(-1); }
              }
              rec.push({ rcx: Number(a), rdx: Number(b), r8: Number(c), r9: Number(d), rsp: Number(e), stack });
            }
          }
          if (n <= 2) {
            // Record who called it: V8 keeps wasm frames in Error.stack, which is
            // the fastest way to work out what an unimplemented import should do.
            let stack = "";
            try { throw new Error("trace"); } catch (e) { stack = String(e.stack); }
            const frames = stack.split("\n").slice(1, 7).map((s) => s.trim().replace(/^at /, "")).join(" | ");
            self.log("unimplemented ABI " + prop + " rcx=" + Number(a) + " rdx=" + Number(b) + " r8=" + Number(c) + " <- " + frames);
          }
          return [0n, 0];
        };
      }
    });
  }
  fnByVa(va) {
    // Built lazily on first use. A linear scan is fine for the handful of
    // resolutions makeImports does, but method creation calls this once per
    // method and the game makes hundreds of thousands in one frame.
    if (!this._fnByVa) {
      this._fnByVa = /* @__PURE__ */ new Map();
      for (const f of this.meta.fns) this._fnByVa.set(f.va, f);
    }
    return this._fnByVa.get(va);
  }
  // Callers sometimes hand us an RVA instead of a full VA (see makeImports).
  fnByPtr(ptr) {
    let va = Number(ptr);
    if (!Number.isFinite(va) || va <= 0) return void 0;
    if (va >= IMAGE_BASE) va -= IMAGE_BASE;
    if (va > 0 && va < IMAGE_BASE) va += IMAGE_BASE;
    return this.fnByVa(va);
  }
  rvToNum(r) {
    if (r.t === T_STRING) return parseFloat(this.guest.readString(r.v)) || 0;
    if (r.t === T_INT32) return r.v | 0;
    return r.v;
  }
  rvToString(r) {
    return r.t === T_STRING ? this.guest.readString(r.v) : String(r.v);
  }
  vtableCall(selfPtr, disp, _rcx, rdx) {
    if (!selfPtr) {
      if (!this.nullSlot) this.nullSlot = this.guest.alloc(16, 16);
      return [this.nullSlot, 0];
    }
    const inst = this.instanceByGuestPtr(selfPtr) ?? this.unknownInst(selfPtr);
    const cellId = rdx > 0 && rdx + 4 <= this.guest.u8.length ? this.guest.dv.getInt32(rdx, true) : -1;
    const name = this.meta.cellNames[cellId] ?? "";
    const slot = this.varSlot(inst, cellId, name);
    return [slot, 0];
  }
  // An indirect call through a pointer we never created (a struct or an object
  // the runner would have allocated). Aborting the script, which is what
  // throwing did, loses everything the script would otherwise have done; a
  // throwaway object with its own variable slots at least lets it run.
  unknownInst(ptr) {
    let o = this.unknownInsts.get(ptr);
    if (!o) {
      o = { id: -1, objIndex: -1, guestPtr: ptr, slots: /* @__PURE__ */ new Map(), alive: true };
      this.unknownInsts.set(ptr, o);
    }
    return o;
  }
  instanceByGuestPtr(p) {
    const id = this.guestPtrMap.get(p);
    return id !== void 0 ? this.instances.get(id) : void 0;
  }
  varSlot(inst, cellId, name) {
    let slot = inst.slots.get(cellId);
    if (slot === void 0) {
      slot = this.guest.alloc(16, 16);
      inst.slots.set(cellId, slot);
    }
    this.syncBuiltinToSlot(inst, name, slot);
    return slot;
  }
  syncBuiltinToSlot(inst, name, slot) {
    const g = this.guest;
    switch (name) {
      case "x":
        g.writeRVDouble(slot, inst.x);
        break;
      case "y":
        g.writeRVDouble(slot, inst.y);
        break;
      case "sprite_index":
        g.writeRVInt(slot, inst.spriteIndex);
        break;
      case "image_index":
        g.writeRVDouble(slot, inst.imageIndex);
        break;
      case "image_speed":
        g.writeRVDouble(slot, inst.imageSpeed);
        break;
      case "depth":
        g.writeRVDouble(slot, inst.depth);
        break;
      case "visible":
        g.writeRVBool(slot, inst.visible);
        break;
      case "hspeed":
        g.writeRVDouble(slot, inst.hspeed);
        break;
      case "vspeed":
        g.writeRVDouble(slot, inst.vspeed);
        break;
      case "speed":
        g.writeRVDouble(slot, inst.speed);
        break;
      case "direction":
        g.writeRVDouble(slot, inst.direction);
        break;
      case "image_xscale":
        g.writeRVDouble(slot, inst.imageXscale);
        break;
      case "image_yscale":
        g.writeRVDouble(slot, inst.imageYscale);
        break;
      case "image_angle":
        g.writeRVDouble(slot, inst.imageAngle);
        break;
      case "image_alpha":
        g.writeRVDouble(slot, inst.imageAlpha);
        break;
      case "id":
        g.writeRVDouble(slot, inst.id);
        break;
      case "object_index":
        g.writeRVInt(slot, inst.objIndex);
        break;
      case "persistent":
        g.writeRVBool(slot, inst.persistent);
        break;
      case "room":
        g.writeRVInt(slot, this.currentRoom);
        break;
      case "mouse_x":
        g.writeRVDouble(slot, this.mousePos.x);
        break;
      case "mouse_y":
        g.writeRVDouble(slot, this.mousePos.y);
        break;
      default:
        break;
    }
  }
  syncBuiltinFromSlot(inst, cellId, name) {
    const slot = inst.slots.get(cellId);
    if (slot === void 0) return;
    const g = this.guest;
    const t = g.dv.getUint32(slot + 12, true) & 16777215;
    const num = t === T_DOUBLE ? g.dv.getFloat64(slot, true) : Number(g.dv.getBigUint64(slot, true));
    switch (name) {
      case "x":
        inst.x = num;
        break;
      case "y":
        inst.y = num;
        break;
      case "sprite_index":
        inst.spriteIndex = num | 0;
        break;
      case "image_index":
        inst.imageIndex = num;
        break;
      case "image_speed":
        inst.imageSpeed = num;
        break;
      case "depth":
        inst.depth = num;
        break;
      case "visible":
        inst.visible = num !== 0;
        break;
      case "hspeed":
        inst.hspeed = num;
        break;
      case "vspeed":
        inst.vspeed = num;
        break;
      case "speed":
        inst.speed = num;
        break;
      case "direction":
        inst.direction = num;
        break;
      case "image_xscale":
        inst.imageXscale = num;
        break;
      case "image_yscale":
        inst.imageYscale = num;
        break;
      case "image_angle":
        inst.imageAngle = num;
        break;
      case "image_alpha":
        inst.imageAlpha = num;
        break;
      default:
        break;
    }
  }
  syncBuiltinFromSlotAll(inst) {
    for (const [cellId, name] of this.builtinCellCache) this.syncBuiltinFromSlot(inst, cellId, name);
  }
  // --- member access (`a.b` / `a.b = v`) ------------------------------------
  // GMS 2.3 compiles the dot operator into three runner calls: one that takes
  // the left-hand side as an RValue (f140e87930 write / f140e87170 read) and
  // one that takes an already-resolved instance pointer (f140e86fa0). The
  // member is identified by a *cell id*, an index into `meta.cellNames`, and
  // the optional array index is 0x80000000 when the access is not indexed.
  //
  // The instance/struct itself is identified by its guest pointer. Instances
  // the shim created have real bookkeeping (`varSlot` + syncBuiltinTo/From);
  // everything else (structs, which the runner allocates with an ABI call we
  // have not implemented yet) falls back to a plain pointer -> cell -> slot
  // table so reads and writes at least round-trip.
  cellName(cellId) {
    return this.meta?.cellNames?.[cellId] ?? "";
  }
  tryInstance(ptr) {
    if (!ptr) return void 0;
    const id = this.guestPtrMap.get(ptr);
    return id !== void 0 ? this.instances.get(id) : void 0;
  }
  memberSlot(key, cellId, create) {
    if (!key) return 0;
    let m = this.members.get(key);
    if (!m) {
      if (!create) return 0;
      m = /* @__PURE__ */ new Map();
      this.members.set(key, m);
    }
    let s = m.get(cellId);
    if (s === void 0) {
      if (!create) return 0;
      s = this.guest.alloc(16, 16);
      this.guest.dv.setBigUint64(s, 0n, true);
      this.guest.dv.setUint32(s + 8, 0, true);
      this.guest.dv.setUint32(s + 12, T_UNDEF, true);
      m.set(cellId, s);
    }
    return s;
  }
  // 16-byte RValue copy. Real RValue assignment bumps refcounts for strings,
  // arrays and objects; this shim has no refcounting, so a flat copy is it.
  copyRV(dst, src) {
    if (!dst || !src || src + 16 > this.guest.u8.length || dst + 16 > this.guest.u8.length) return;
    this.guest.u8.copyWithin(dst, src, src + 16);
  }
  // Left-hand side of a dot access -> guest pointer used as the member key.
  // `self` (-1) and `other` (-2) resolve to the pointers the current script
  // was entered with; anything else is the raw pointer / instance id.
  resolveTargetKey(rvPtr) {
    if (!rvPtr) return 0;
    const g = this.guest;
    if (rvPtr + 16 > g.u8.length) return 0;
    const t = g.dv.getUint32(rvPtr + 12, true) & 16777215;
    if (t === T_OBJECT) return Number(g.dv.getBigUint64(rvPtr, true)) >>> 0;
    if (t === T_INT32) return g.dv.getInt32(rvPtr, true) | 0;
    if (t === T_DOUBLE || t === T_BOOL) return Math.trunc(g.dv.getFloat64(rvPtr, true)) | 0;
    return 0;
  }
  memberKeyFor(rvPtr) {
    const key = this.resolveTargetKey(rvPtr);
    if (key === -1) return this.curSelfPtr || key;
    if (key === -2) return this.curOtherPtr || key;
    return key;
  }
  setMember(key, cellId, valueRv) {
    if (!key || !valueRv) return;
    const name = this.cellName(cellId);
    const inst = this.tryInstance(key);
    if (inst) {
      const slot = this.varSlot(inst, cellId, name);
      this.copyRV(slot, valueRv);
      this.syncBuiltinFromSlot(inst, cellId, name);
      return;
    }
    const slot = this.memberSlot(key, cellId, true);
    this.copyRV(slot, valueRv);
  }
  getMember(key, cellId, outRv) {
    if (!outRv) return;
    if (!key) {
      this.guest.writeRVUndef(outRv);
      return;
    }
    const name = this.cellName(cellId);
    const inst = this.tryInstance(key);
    if (inst) {
      const slot = this.varSlot(inst, cellId, name);
      this.copyRV(outRv, slot);
      return;
    }
    const slot = this.memberSlot(key, cellId, true);
    this.copyRV(outRv, slot);
  }
  // RValue -> int64. This is the runner's `YYGetInt64`: reals and bools are
  // truncated, strings are parsed, pointers/ints are taken as-is, objects give
  // their instance id, and everything else raises a runner error (here: 0).
  rvToInt64(rvPtr) {
    if (!rvPtr || rvPtr + 16 > this.guest.u8.length) return 0;
    const g = this.guest;
    const t = g.dv.getUint32(rvPtr + 12, true) & 16777215;
    switch (t) {
      case T_DOUBLE:
      case T_BOOL: {
        const d = g.dv.getFloat64(rvPtr, true);
        return Number.isFinite(d) ? Math.trunc(d) : 0;
      }
      case T_STRING: {
        const s = g.readString(Number(g.dv.getBigUint64(rvPtr, true)) >>> 0);
        const n = Number.parseInt(s.trim(), 10);
        return Number.isFinite(n) ? n : 0;
      }
      case T_OBJECT: {
        const obj = Number(g.dv.getBigUint64(rvPtr, true)) >>> 0;
        return obj;
      }
      default:
        return Number(g.dv.getBigInt64(rvPtr, true));
    }
  }
  // Index of the ds_map standing in for a struct. Structs arrive either as an
  // object RValue (a pointer) or as the numeric handle the shim handed out.
  structKey(rvPtr) {
    const r = this.guest.readRV(rvPtr);
    if (r.t === T_OBJECT && r.v && r.v < IMAGE_BASE && !this.methods.has(r.v)) {
      let id = this.structIds.get(r.v);
      if (id === void 0) {
        id = this.dsNewMap();
        this.structIds.set(r.v, id);
      }
      return id;
    }
    return this.rvToNum(r) | 0;
  }
  // Resolve the callee argument of f140e634e0 / f140e63610 to a cell id, or
  // -1 when it names nothing we can call. A cell id is small; anything larger
  // is a pointer to an RValue, and only an int32/int64 RValue holding a valid
  // cell id is callable. Everything else is a method value this shim has not
  // populated yet (structs have no methods until the struct ABI exists), and
  // guessing an id from it - the old behaviour - dispatched nonsense.
  callTargetId(v) {
    if (v >= 0 && v < this.meta.cellNames.length) return v;
    const p = v >>> 0;
    if (p && p + 16 <= this.guest.u8.length) {
      const kind = this.guest.dv.getUint32(p + 12, true) & 16777215;
      if (kind === T_INT32 || kind === T_DOUBLE || kind === T_BOOL) {
        const n = kind === T_DOUBLE || kind === T_BOOL
          ? Math.trunc(this.guest.dv.getFloat64(p, true))
          : this.guest.dv.getInt32(p, true);
        if (n > 0 && n < this.meta.cellNames.length && Math.trunc(this.guest.dv.getFloat64(p, true)) === n) return n;
      }
    }
    return -1;
  }
  dispatchFunction(selfPtr, otherPtr, resultPtr, argc, callee, argsPtr) {
    try {
      this.checkBudget("dispatch");
      const target = this.resolveCallee(callee);
      if (!target) {
        this.log("dispatch: uncallable callee");
        this.guest.writeRVUndef(resultPtr);
        return;
      }
      if (target.method) {
        const rec = target.method;
        if (!rec.fn) {
          this.log("dispatch: method with no script (va 0x" + rec.va.toString(16) + ")");
          this.guest.writeRVUndef(resultPtr);
          return;
        }
        const fn = this.exports["g_" + rec.fn.replace(/[^A-Za-z0-9_@]/g, "_")];
        if (!fn) {
          this.log("dispatch: method script not lifted " + rec.fn);
          this.guest.writeRVUndef(resultPtr);
          return;
        }
        // A method carries its own `self`: the struct it was bound to, or,
        // for an unbound function value, whatever the caller was running as.
        const outerSelf = this.curSelfPtr, outerOther = this.curOtherPtr;
        const bound = rec.self || selfPtr;
        try {
          if (bound) this.curSelfPtr = bound;
          this.enterGuest(fn, BigInt(bound), BigInt(otherPtr), BigInt(resultPtr), 0n, 0n);
        } finally {
          this.curSelfPtr = outerSelf;
          this.curOtherPtr = outerOther;
        }
        return;
      }
      const id = target.cell;
      const outerSelf = this.curSelfPtr, outerOther = this.curOtherPtr;
      if (selfPtr) this.curSelfPtr = selfPtr;
      if (otherPtr) this.curOtherPtr = otherPtr;
      try {
        this.dispatchInner(selfPtr, otherPtr, resultPtr, argc, id, argsPtr);
      } finally {
        this.curSelfPtr = outerSelf;
        this.curOtherPtr = outerOther;
      }
    } catch (e) {
      // A timeout has to keep going. Swallowing it here meant a handler that
      // spun was never timed out, never disabled, and never stopped: the
      // cooperative abort exists precisely to unwind out of these frames.
      if (String(e && e.message).includes("guest timeout")) throw e;
      this.log("dispatch threw: " + String(e).slice(0, 120));
    }
  }
  // What a call site named: either a cell id, or a GMS 2.3 method value.
  resolveCallee(v) {
    const id = this.callTargetId(v);
    if (id >= 0) return { cell: id };
    if (this.noMethods) return null;
    const rec = this.resolveMethod(v);
    if (rec) return { method: rec };
    return null;
  }
  resolveMethod(rvPtr) {
    const p = rvPtr >>> 0;
    if (!p || p + 16 > this.guest.u8.length) return null;
    if ((this.guest.dv.getUint32(p + 12, true) & 16777215) !== T_OBJECT) return null;
    const v = Number(this.guest.dv.getBigUint64(p, true));
    if (v >= IMAGE_BASE) {
      const f = this.fnByVa(v);
      return f ? { fn: f.n, va: v, self: 0 } : null;
    }
    return this.methods.get(v) ?? null;
  }
  dispatchInner(selfPtr, otherPtr, resultPtr, argc, id, argsPtr) {
    {
      const name = this.meta.cellNames[id];
      if (name === void 0) {
        this.log("dispatch: bad id " + id);
        this.guest.writeRVUndef(resultPtr);
        return;
      }
      if (this.builtinFnNames.has(name)) {
        this.callBuiltin(name, selfPtr, otherPtr, resultPtr, argc, argsPtr);
        return;
      }
      const f = this.fnByName.get("gml_Script_" + name) ?? this.fnByName.get(name);
      if (!f) {
        this.log("dispatch: unknown function " + name);
        this.guest.writeRVUndef(resultPtr);
        return;
      }
      const exportName = "g_" + f.n.replace(/[^A-Za-z0-9_@]/g, "_");
      const fn = this.exports[exportName];
      if (!fn) {
        this.log("dispatch: no export for " + f.n);
        this.guest.writeRVUndef(resultPtr);
        return;
      }
      this.enterGuest(fn, BigInt(selfPtr), BigInt(otherPtr), BigInt(resultPtr), 0n, 0n);
    }
  }
  callBuiltin(name, selfPtr, _otherPtr, resultPtr, argc, argsPtr) {
    const g = this.guest;
    const arg = (i) => argsPtr + i * 16;
    const num = (i) => this.rvToNum(g.readRV(arg(i)));
    const str = (i) => this.rvToString(g.readRV(arg(i)));
    const outD = (d) => g.writeRVDouble(resultPtr, d);
    const outB = (b) => g.writeRVBool(resultPtr, b);
    const outS = (s) => g.writeRV(resultPtr, { v: g.allocString(s), flags: 8, t: T_STRING });
    const outI = (i) => g.writeRVInt(resultPtr, i | 0);
    let inst;
    try {
      inst = this.instanceByGuestPtr(selfPtr);
    } catch {
      inst = this.nullInstance();
    }
    switch (name) {
      case "abs":
        outD(Math.abs(num(0)));
        return;
      case "sign":
        outD(Math.sign(num(0)));
        return;
      case "round":
        outD(Math.round(num(0)));
        return;
      case "floor":
        outD(Math.floor(num(0)));
        return;
      case "ceil":
      case "ceiling":
        outD(Math.ceil(num(0)));
        return;
      case "sqrt":
        outD(Math.sqrt(num(0)));
        return;
      case "sqr":
        outD(num(0) * num(0));
        return;
      case "sin":
        outD(Math.sin(num(0)));
        return;
      case "cos":
        outD(Math.cos(num(0)));
        return;
      case "tan":
        outD(Math.tan(num(0)));
        return;
      case "arcsin":
        outD(Math.asin(num(0)));
        return;
      case "arccos":
        outD(Math.acos(num(0)));
        return;
      case "arctan":
        outD(Math.atan(num(0)));
        return;
      case "arctan2":
        outD(Math.atan2(num(0), num(1)));
        return;
      case "exp":
        outD(Math.exp(num(0)));
        return;
      case "ln":
        outD(Math.log(num(0)));
        return;
      case "log2":
        outD(Math.log2(num(0)));
        return;
      case "log10":
        outD(Math.log10(num(0)));
        return;
      case "power":
        outD(Math.pow(num(0), num(1)));
        return;
      case "min": {
        let m = Infinity;
        for (let i = 0; i < argc; i++) m = Math.min(m, num(i));
        outD(m);
        return;
      }
      case "max": {
        let m = -Infinity;
        for (let i = 0; i < argc; i++) m = Math.max(m, num(i));
        outD(m);
        return;
      }
      case "median": {
        const a = [];
        for (let i = 0; i < argc; i++) a.push(num(i));
        a.sort((x, y) => x - y);
        outD(a[Math.floor(a.length / 2)]);
        return;
      }
      case "clamp":
        outD(Math.max(num(0), Math.min(num(1), num(2))));
        return;
      case "lerp":
        outD(num(0) + (num(1) - num(0)) * num(2));
        return;
      case "random":
        outD(Math.random());
        return;
      case "random_range":
        outD(num(0) + Math.random() * (num(1) - num(0)));
        return;
      case "irandom":
        outI(Math.floor(Math.random() * (num(0) + 1)));
        return;
      case "irandom_range": {
        const a = num(0), b = num(1);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        outI(Math.floor(lo + Math.random() * (hi - lo + 1)));
        return;
      }
      case "randomise":
      case "randomize":
        return;
      case "degtorad":
        outD(num(0) * Math.PI / 180);
        return;
      case "radtodeg":
        outD(num(0) * 180 / Math.PI);
        return;
      case "dot_product":
        outD(num(0) * num(2) + num(1) * num(3));
        return;
      case "point_distance":
        outD(Math.hypot(num(2) - num(0), num(3) - num(1)));
        return;
      case "point_direction":
        outD(Math.atan2(num(1) - num(3), num(2) - num(0)) * 180 / Math.PI);
        return;
      case "angle_difference": {
        let d = (num(0) - num(1)) % 360;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        outD(d);
        return;
      }
      case "is_real":
        outB(g.readRV(arg(0)).t !== T_STRING);
        return;
      case "is_string":
        outB(g.readRV(arg(0)).t === T_STRING);
        return;
      case "is_bool":
        outB(g.readRV(arg(0)).t === T_BOOL);
        return;
      case "is_undefined":
        outB(g.readRV(arg(0)).t === T_UNDEF);
        return;
      case "instance_exists":
        outB(this.someInstance(num(0)));
        return;
      case "instance_number": {
        const t = num(0);
        let c = 0;
        for (const i2 of this.instanceList) if (i2.alive && this.matchesObject(i2, t)) c++;
        outD(c);
        return;
      }
      case "instance_create_layer":
      case "instance_create_depth":
        outI(this.createInstance(num(2) | 0, num(0), num(1)).id);
        return;
      case "instance_destroy": {
        const t = argc > 0 ? num(0) : inst.id;
        const target = this.instances.get(t);
        if (target) target.alive = false;
        return;
      }
      case "instance_destroy_all": {
        const t = num(0);
        for (const i2 of this.instanceList) if (i2.alive && this.matchesObject(i2, t)) i2.alive = false;
        return;
      }
      case "instance_nearest": {
        const x = num(0), y = num(1), obj = num(2) | 0;
        let best = -1, bd = Infinity;
        for (const i2 of this.instanceList) if (i2.alive && this.matchesObject(i2, obj) && i2.id !== inst.id) {
          const d = Math.hypot(i2.x - x, i2.y - y);
          if (d < bd) {
            bd = d;
            best = i2.id;
          }
        }
        outD(best);
        return;
      }
      case "place_meeting":
        outB(this.placeMeeting(inst, num(0), num(1), num(2)));
        return;
      case "position_meeting":
        outB(this.placeMeeting(inst, num(0), num(1), num(2)));
        return;
      case "position_empty":
        outB(!this.placeMeeting(inst, num(0), num(1), num(2)));
        return;
      case "distance_to_object": {
        const t = num(0) | 0;
        let bd = Infinity;
        for (const i2 of this.instanceList) if (i2.alive && this.matchesObject(i2, t) && i2.id !== inst.id) bd = Math.min(bd, Math.hypot(i2.x - inst.x, i2.y - inst.y));
        outD(bd === Infinity ? -1 : bd);
        return;
      }
      case "instance_find": {
        const t = num(0) | 0, n = num(1) | 0;
        let c = 0;
        for (const i2 of this.instanceList) if (i2.alive && this.matchesObject(i2, t)) {
          if (c === n) {
            outD(i2.id);
            return;
          }
          c++;
        }
        outD(-1);
        return;
      }
      case "instance_change":
        return;
      case "game_get_speed":
        // 0 = fps, 1 = microseconds per frame. The host drives frames at 60.
        outD(num(0) === 1 ? 1e6 / 60 : 60);
        return;
      case "game_set_speed":
        return;
      case "font_get_size": {
        // Real glyph metrics need the font atlas; the game only compares sizes.
        const f = num(0) | 0;
        outD(f >= 0 && f < this.sprites.length ? 12 : 12);
        return;
      }
      case "asset_get_index": {
        const nm = str(0);
        let found = -1;
        for (let i = 0; i < this.objects.length; i++) if (this.objects[i].name === nm) { found = i; break; }
        if (found < 0) {
          for (let i = 0; i < this.sprites.length; i++) if (this.sprites[i].name === nm) { found = i; break; }
        }
        outI(found);
        return;
      }
      case "room_goto":
        this.gotoRoom(num(0) | 0);
        outD(0);
        return;
      case "room_goto_next":
        this.gotoRoom(this.roomOrder[this.roomOrder.indexOf(this.currentRoom) + 1]);
        outD(0);
        return;
      case "room_goto_previous":
        this.gotoRoom(this.roomOrder[this.roomOrder.indexOf(this.currentRoom) - 1]);
        outD(0);
        return;
      case "room_restart":
        this.gotoRoom(this.currentRoom);
        outD(0);
        return;
      case "room":
        outD(this.currentRoom);
        return;
      case "room_width":
        outD(this.rooms[this.currentRoom]?.w ?? 320);
        return;
      case "room_height":
        outD(this.rooms[this.currentRoom]?.h ?? 180);
        return;
      case "game_end":
        this.running = false;
        return;
      case "draw_sprite":
        this.drawSpriteExt(num(0) | 0, num(1) | 0, num(2), num(3), 1, 1, 0, 1, 16777215);
        return;
      case "draw_sprite_ext":
        this.drawSpriteExt(num(0) | 0, num(1) | 0, num(2), num(3), num(4), num(5), num(6), num(7), num(8) | 0);
        return;
      case "draw_sprite_stretched":
        this.drawSpriteStretched(num(0) | 0, num(1) | 0, num(2), num(3), num(4), num(5));
        return;
      case "draw_self":
        this.drawSelf(inst);
        return;
      case "draw_set_color":
        this.drawColor = num(0) | 0;
        return;
      case "draw_set_alpha":
        this.drawAlpha = num(0);
        return;
      case "draw_set_font":
        this.drawFont = num(0) | 0;
        return;
      case "draw_set_halign":
        this.halign = num(0) | 0;
        return;
      case "draw_set_valign":
        this.valign = num(0) | 0;
        return;
      case "draw_rectangle":
        this.drawRect(num(0), num(1), num(2), num(3), num(4) !== 0);
        return;
      case "draw_circle":
        this.drawCircle(num(0), num(1), num(2), num(3) !== 0);
        return;
      case "draw_line":
      case "draw_line_width":
        this.drawLine(num(0), num(1), num(2), num(3));
        return;
      case "draw_text":
      case "draw_text_ext":
      case "draw_text_transformed":
        this.drawText(num(0), num(1), str(2));
        return;
      case "draw_clear":
      case "draw_clear_alpha":
        this.drawClear(num(0) | 0);
        return;
      case "string_width":
        outD(str(0).length * 8);
        return;
      case "string_height":
        outD(16);
        return;
      case "display_get_gui_width":
        outD(this.viewW);
        return;
      case "display_get_gui_height":
        outD(this.viewH);
        return;
      case "window_get_width":
        outD(this.viewW);
        return;
      case "window_get_height":
        outD(this.viewH);
        return;
      case "window_set_size":
        this.viewW = num(0);
        this.viewH = num(1);
        return;
      case "surface_set_target":
        return;
      case "surface_reset_target":
        return;
      case "surface_exists":
        outB(false);
        return;
      case "keyboard_check":
        outB(this.keyboard.has(this.mapKey(num(0))));
        return;
      case "keyboard_check_pressed":
        outB(this.keyboardPressed.has(this.mapKey(num(0))));
        return;
      case "keyboard_check_released":
        outB(this.keyboardReleased.has(this.mapKey(num(0))));
        return;
      case "keyboard_clear":
        return;
      case "keyboard_key":
        outD(this.lastKey);
        return;
      case "mouse_check_button":
        outB(this.mouseButtons.has(num(0) | 0));
        return;
      case "mouse_check_button_pressed":
        outB(this.mousePressed.has(num(0) | 0));
        return;
      case "mouse_check_button_released":
        outB(this.mouseReleased.has(num(0) | 0));
        return;
      case "mouse_x":
      case "window_mouse_get_x":
      case "device_mouse_x_to_gui":
        outD(this.mousePos.x);
        return;
      case "mouse_y":
      case "window_mouse_get_y":
      case "device_mouse_y_to_gui":
        outD(this.mousePos.y);
        return;
      case "device_mouse_check_button":
        outB(this.mouseButtons.has(num(1) | 0));
        return;
      case "gamepad_is_connected":
        outB(false);
        return;
      case "gamepad_button_check":
        outB(false);
        return;
      case "gamepad_axis_value":
        outD(0);
        return;
      case "audio_play_sound":
        this.playSound(num(0) | 0, num(1) !== 0, num(2));
        outB(true);
        return;
      case "audio_play_sound_on":
        this.playSound(num(1) | 0, num(2) !== 0, num(3));
        outB(true);
        return;
      case "audio_stop_sound":
        this.stopSound(num(0) | 0);
        return;
      case "audio_stop_all":
        this.audio?.stopAll();
        return;
      case "audio_sound_gain":
      case "audio_master_gain":
      case "audio_group_gain":
      case "audio_pause_all":
      case "audio_resume_all":
        return;
      case "audio_is_playing":
        outB(false);
        return;
      case "ds_list_create":
        outI(this.dsNewList());
        return;
      case "ds_list_add": {
        const l = this.dsLists.get(num(0) | 0);
        if (l) for (let i = 1; i < argc; i++) l.push(g.readRV(arg(i)));
        return;
      }
      case "ds_list_size": {
        const l = this.dsLists.get(num(0) | 0);
        outD(l ? l.length : 0);
        return;
      }
      case "ds_list_delete": {
        const l = this.dsLists.get(num(0) | 0);
        if (l) l.splice(num(1) | 0, 1);
        return;
      }
      case "ds_list_clear": {
        const l = this.dsLists.get(num(0) | 0);
        if (l) l.length = 0;
        return;
      }
      case "ds_list_destroy":
        this.dsLists.delete(num(0) | 0);
        return;
      case "ds_list_empty": {
        const l = this.dsLists.get(num(0) | 0);
        outB(!l || l.length === 0);
        return;
      }
      case "ds_list_find_value": {
        const l = this.dsLists.get(num(0) | 0);
        const v = l?.[num(1) | 0];
        if (v) g.writeRV(resultPtr, v);
        else outD(0);
        return;
      }
      case "ds_list_set": {
        const l = this.dsLists.get(num(0) | 0);
        if (l) l[num(1) | 0] = g.readRV(arg(2));
        return;
      }
      case "ds_map_create":
        outI(this.dsNewMap());
        return;
      case "ds_map_add": {
        const m = this.dsMaps.get(num(0) | 0);
        if (m) m.set(this.dsKey(arg(1)), g.readRV(arg(2)));
        outB(true);
        return;
      }
      case "ds_map_find_value": {
        const m = this.dsMaps.get(num(0) | 0);
        const v = m?.get(this.dsKey(arg(1)));
        if (v) g.writeRV(resultPtr, v);
        else outD(0);
        return;
      }
      case "ds_map_replace": {
        const m = this.dsMaps.get(num(0) | 0);
        if (m) m.set(this.dsKey(arg(1)), g.readRV(arg(2)));
        return;
      }
      case "ds_map_delete": {
        const m = this.dsMaps.get(num(0) | 0);
        if (m) m.delete(this.dsKey(arg(1)));
        return;
      }
      case "ds_map_destroy":
        this.dsMaps.delete(num(0) | 0);
        return;
      case "ds_map_size": {
        const m = this.dsMaps.get(num(0) | 0);
        outD(m ? m.size : 0);
        return;
      }
      case "ds_map_exists": {
        const m = this.dsMaps.get(num(0) | 0);
        outB(m ? m.has(this.dsKey(arg(1))) : false);
        return;
      }
      case "ds_map_clear": {
        const m = this.dsMaps.get(num(0) | 0);
        if (m) m.clear();
        return;
      }
      case "ds_map_find_first": {
        const m = this.dsMaps.get(num(0) | 0);
        outS(m ? [...m.keys()][0] ?? "" : "");
        return;
      }
      case "ds_map_set": {
        const m = this.dsMaps.get(num(0) | 0);
        if (m) m.set(this.dsKey(arg(1)), g.readRV(arg(2)));
        return;
      }
      case "ds_map_add_list":
      case "ds_map_add_map": {
        const m = this.dsMaps.get(num(0) | 0);
        if (m) m.set(this.dsKey(arg(1)), g.readRV(arg(2)));
        outB(true);
        return;
      }
      case "ds_grid_create":
        outI(this.dsNewGrid(num(0) | 0, num(1) | 0));
        return;
      case "ds_grid_set": {
        const gr = this.dsGrids.get(num(0) | 0);
        if (gr) this.gridSet(num(0) | 0, num(1) | 0, num(2) | 0, num(3));
        return;
      }
      case "ds_grid_get":
        outD(this.gridGet(num(0) | 0, num(1) | 0, num(2) | 0));
        return;
      case "ds_grid_destroy":
        this.dsGrids.delete(num(0) | 0);
        return;
      case "ds_grid_clear": {
        const gr = this.dsGrids.get(num(0) | 0);
        if (gr) gr.fill(num(1));
        return;
      }
      case "ds_grid_add": {
        this.gridSet(num(0) | 0, num(1) | 0, num(2) | 0, this.gridGet(num(0) | 0, num(1) | 0, num(2) | 0) + num(3));
        return;
      }
      case "ds_stack_create":
        outI(this.dsNewList());
        return;
      case "ds_stack_push": {
        const l = this.dsLists.get(num(0) | 0);
        if (l) l.push(g.readRV(arg(1)));
        return;
      }
      case "ds_stack_pop": {
        const l = this.dsLists.get(num(0) | 0);
        const v = l?.pop();
        if (v) g.writeRV(resultPtr, v);
        else outD(0);
        return;
      }
      case "ds_stack_destroy":
        this.dsLists.delete(num(0) | 0);
        return;
      case "ds_queue_create":
        outI(this.dsNewList());
        return;
      case "ds_queue_enqueue": {
        const l = this.dsLists.get(num(0) | 0);
        if (l) l.push(g.readRV(arg(1)));
        return;
      }
      case "ds_queue_destroy":
        this.dsLists.delete(num(0) | 0);
        return;
      case "ds_priority_create":
        outI(this.dsNewList());
        return;
      case "ds_priority_add": {
        const l = this.dsLists.get(num(0) | 0);
        if (l) l.push(g.readRV(arg(1)));
        return;
      }
      case "ds_priority_destroy":
        this.dsLists.delete(num(0) | 0);
        return;
      case "array_length":
        outD(this.arrayLength(g.readRV(arg(0))));
        return;
      case "array_create":
        outI(this.allocHostArray(num(0) | 0));
        return;
      case "array_get": {
        const v = this.arrayGet(g.readRV(arg(0)), num(1) | 0);
        g.writeRV(resultPtr, v);
        return;
      }
      case "array_set":
        this.arraySet(g.readRV(arg(0)), num(1) | 0, g.readRV(arg(2)));
        return;
      case "array_push": {
        const arr = this.hostArrays.get(g.readRV(arg(0)).v);
        if (arr) for (let i = 1; i < argc; i++) arr.push(g.readRV(arg(i)));
        return;
      }
      case "array_delete": {
        const arr = this.hostArrays.get(g.readRV(arg(0)).v);
        if (arr) arr.splice(num(1) | 0, num(2) | 0);
        return;
      }
      case "variable_instance_get":
        outD(this.varByName(inst, str(0)));
        return;
      case "variable_instance_set":
        this.setVarByName(inst, str(0), num(1));
        return;
      case "variable_global_get": {
        const id = this.globalVarIds.get(str(0));
        const v = id !== void 0 ? this.globalVars.get(id) : void 0;
        if (v) g.writeRV(resultPtr, v);
        else g.writeRVUndef(resultPtr);
        return;
      }
      case "variable_global_set": {
        const n = str(0);
        let id = this.globalVarIds.get(n);
        if (id === void 0) {
          id = this.nextVarId++;
          this.globalVarIds.set(n, id);
        }
        this.globalVars.set(id, g.readRV(arg(1)));
        return;
      }
      case "show_debug_message":
        this.log("[debug] " + str(0));
        return;
      case "show_message":
        this.log("[msg] " + str(0));
        return;
      case "fps":
      case "fps_real":
        outD(this.measuredFps);
        return;
      case "delta_time":
        outD(this.lastDeltaUs);
        return;
      case "get_timer":
        outD(Math.floor(performance.now() * 1e3));
        return;
      case "current_time":
        outD(performance.now() | 0);
        return;
      case "current_second":
        outD((/* @__PURE__ */ new Date()).getSeconds());
        return;
      case "current_minute":
        outD((/* @__PURE__ */ new Date()).getMinutes());
        return;
      case "current_hour":
        outD((/* @__PURE__ */ new Date()).getHours());
        return;
      case "randomise":
      case "randomize":
        return;
      case "shader_get_uniform":
        outI(0);
        return;
      case "shader_set":
      case "shader_reset":
        return;
      case "shaders_are_supported":
        outB(false);
        return;
      case "json_parse":
        outI(this.dsNewMap());
        return;
      case "json_stringify":
        outS("{}");
        return;
      case "file_exists":
        outB(false);
        return;
      case "file_text_open_read":
        outI(-1);
        return;
      case "ini_open":
      case "ini_close":
        return;
      case "ini_read_real":
        outD(0);
        return;
      case "ini_read_string":
        outS("");
        return;
      case "ini_write_real":
      case "ini_write_string":
        return;
      case "layer_create":
        outI(this.nextLayerId++);
        return;
      case "layer_destroy":
      case "layer_sprite_create":
      case "layer_background_create":
        return;
      case "layer_exists":
        outB(true);
        return;
      case "buffer_create":
      case "buffer_write":
      case "buffer_read":
        return;
      case "@@NewGMLArray@@":
        outI(this.allocHostArray(argc));
        {
          const arr = this.hostArrays.get(resultPtr === 0 ? -1 : num(0));
          void arr;
        }
        {
          const id = this.nextArrayId - 1;
          const arr = this.hostArrays.get(id);
          if (arr) {
            arr.length = 0;
            for (let i = 0; i < argc; i++) arr.push(g.readRV(arg(i)));
          }
          outI(id);
        }
        return;
      case "@@NewGMLObject@@": {
        // A struct is an object, not a ds_map. Handing back a ds_map handle
        // keyed struct fields by a small integer, but dot-access resolves its
        // left-hand side through resolveTargetKey, which hands member storage
        // a guest pointer - so the two never met. Measured over 12 rooms:
        // 2815 structs created, 2 of them with any member stored, which is
        // why a struct holding a method reads back as 0 and the callee is
        // "uncallable". It also leaked one host ds_map per struct literal.
        const p = g.alloc(32, 16);
        g.writeRV(resultPtr, { v: p, flags: 8, t: T_OBJECT });
        return;
      }
      case "is_array":
        outB(this.hostArrays.has(g.readRV(arg(0)).v));
        return;
      case "typeof": {
        const r = g.readRV(arg(0));
        outS(r.t === T_STRING ? "string" : r.t === T_ARRAY || this.hostArrays.has(r.v) ? "array" : r.t === T_OBJECT ? "struct" : r.t === T_UNDEF ? "undefined" : "number");
        return;
      }
      case "sprite_get_width": {
        const s = this.sprites[num(0) | 0];
        outD(s?.w ?? 0);
        return;
      }
      case "sprite_get_height": {
        const s = this.sprites[num(0) | 0];
        outD(s?.h ?? 0);
        return;
      }
      case "sprite_get_name": {
        const s = this.sprites[num(0) | 0];
        outS(s?.name ?? "");
        return;
      }
      case "sprite_get_uvs":
        outI(this.dsNewList());
        return;
      case "surface_get_width":
        outD(this.viewW);
        return;
      case "surface_get_height":
        outD(this.viewH);
        return;
      case "surface_get_texture":
        outI(-1);
        return;
      case "texture_get_uvs":
        outI(this.dsNewList());
        return;
      case "extension_stubfunc_string":
        outS("");
        return;
      case "asset_get_ids":
        outI(this.dsNewList());
        return;
      case "draw_get_colour":
      case "draw_get_color":
        outD(this.drawColor);
        return;
      case "draw_get_alpha":
        outD(this.drawAlpha);
        return;
      case "variable_instance_exists":
        outB(this.nameToCell.has(str(0)));
        return;
      case "variable_global_exists":
        outB(this.globalVarIds.has(str(0)));
        return;
      case "method_get_index":
        outS("");
        return;
      case "method_get_self":
        outD(-1);
        return;
      case "is_method":
        outB(false);
        return;
      case "instanceof":
        outB(false);
        return;
      case "is_numeric": {
        const t2 = g.readRV(arg(0)).t;
        outB(t2 === T_DOUBLE || t2 === T_BOOL || t2 === T_INT32);
        return;
      }
      case "is_struct":
        outB(g.readRV(arg(0)).t === T_OBJECT);
        return;
      case "is_ptr":
        outB(g.readRV(arg(0)).t === T_PTR);
        return;
      case "is_int32":
        outB(g.readRV(arg(0)).t === T_INT32);
        return;
      case "is_int64":
        outB(g.readRV(arg(0)).t === T_INT32 || g.readRV(arg(0)).t === T_DOUBLE);
        return;
      case "is_nan":
        outB(Number.isNaN(num(0)));
        return;
      case "is_infinity":
        outB(!Number.isFinite(num(0)) && !Number.isNaN(num(0)));
        return;
      case "is_instanceof":
        outB(false);
        return;
      case "string": {
        const r = g.readRV(arg(0));
        outS(r.t === T_STRING ? this.guest.readString(r.v) : r.t === T_UNDEF ? "undefined" : String(this.rvToNum(r)));
        return;
      }
      case "array_foreach": {
        // The callback is a method value this shim cannot call yet; the result
        // is the array itself, which is what GML returns.
        const a = this.hostArrays.get(g.readRV(arg(0)).v);
        if (a) g.writeRV(resultPtr, g.readRV(arg(0)));
        else g.writeRVUndef(resultPtr);
        return;
      }
      case "variable_struct_get":
      case "struct_get_from_hash": {
        const m = this.dsMaps.get(this.structKey(arg(0)));
        const v = m?.get(this.dsKey(arg(1)));
        if (v) g.writeRV(resultPtr, v);
        else g.writeRVUndef(resultPtr);
        return;
      }
      case "variable_struct_set": {
        const m = this.dsMaps.get(this.structKey(arg(0)));
        if (m) m.set(this.dsKey(arg(1)), g.readRV(arg(2)));
        return;
      }
      case "variable_struct_exists": {
        const m = this.dsMaps.get(this.structKey(arg(0)));
        outB(m ? m.has(this.dsKey(arg(1))) : false);
        return;
      }
      case "variable_struct_remove": {
        const m = this.dsMaps.get(this.structKey(arg(0)));
        if (m) m.delete(this.dsKey(arg(1)));
        return;
      }
      case "variable_struct_names_count": {
        const m = this.dsMaps.get(this.structKey(arg(0)));
        outD(m ? m.size : 0);
        return;
      }
      case "struct_get": {
        const m = this.dsMaps.get(num(0) | 0);
        const v = m?.get("s:" + str(1));
        if (v) g.writeRV(resultPtr, v);
        else g.writeRVUndef(resultPtr);
        return;
      }
      case "struct_set": {
        const m = this.dsMaps.get(num(0) | 0);
        if (m) m.set("s:" + str(1), g.readRV(arg(2)));
        return;
      }
      case "struct_exists": {
        const m = this.dsMaps.get(num(0) | 0);
        outB(m ? m.has("s:" + str(1)) : false);
        return;
      }
      case "sprite_exists":
        outB(num(0) >= 0 && (num(0) | 0) < this.sprites.length);
        return;
      case "object_exists":
        outB(num(0) >= 0 && (num(0) | 0) < this.objects.length);
        return;
      case "room_exists":
        outB(true);
        return;
      case "sound_exists":
        outB(num(0) >= 0 && (num(0) | 0) < this.soundNames.length);
        return;
      case "audio_sound_length":
        outD(1);
        return;
      case "window_has_focus":
        outB(true);
        return;
      case "window_set_cursor":
      case "cursor":
        return;
      case "io_clear":
        this.keyboard.clear();
        this.mouseButtons.clear();
        return;
      case "keyboard_set_map":
      case "keyboard_get_map":
      case "keyboard_unset_map":
        return;
      case "keyboard_numlock":
        outB(true);
        return;
      case "date_create_datetime":
        outD(45e3);
        return;
      case "date_compare_datetime":
        outD(0);
        return;
      case "date_get_second":
        outD(0);
        return;
      case "string_join": {
        let s = "";
        for (let i = 0; i < argc; i += 2) {
          if (i > 0) s += str(0);
          if (i + 1 < argc) s += str(i + 1);
        }
        outS(s);
        return;
      }
      case "string_split": {
        const arr = this.dsNewList();
        const l = this.dsLists.get(arr);
        for (const part of str(0).split(str(1))) l.push({ v: g.allocString(part), flags: 8, t: T_STRING });
        outI(arr);
        return;
      }
      case "real":
        outD(parseFloat(str(0)) || 0);
        return;
      case "time_source_create":
        outI(0);
        return;
      case "time_source_start":
      case "time_source_destroy":
        return;
      default: {
        this.unimplementedBuiltins.set(name, (this.unimplementedBuiltins.get(name) ?? 0) + 1);
        if ((this.unimplementedBuiltins.get(name) ?? 0) <= 3) this.log("unimplemented builtin: " + name + " argc=" + argc);
        g.writeRVUndef(resultPtr);
        return;
      }
    }
  }
  dsNewList() {
    const id = this.dsNextId++;
    this.dsLists.set(id, []);
    return id;
  }
  dsNewMap() {
    const id = this.dsNextId++;
    this.dsMaps.set(id, /* @__PURE__ */ new Map());
    return id;
  }
  dsNewGrid(w, h) {
    const id = this.dsNextId++;
    this.dsGrids.set(id, new Float64Array(Math.max(1, w * h)));
    this.gridDims.set(id, [w, h]);
    return id;
  }
  gridSet(id, x, y, v) {
    const gr = this.dsGrids.get(id);
    const d = this.gridDims.get(id);
    if (gr && d) gr[y * d[0] + x] = v;
  }
  gridGet(id, x, y) {
    const gr = this.dsGrids.get(id);
    const d = this.gridDims.get(id);
    return gr && d ? gr[y * d[0] + x] ?? 0 : 0;
  }
  dsKey(p) {
    const r = this.guest.readRV(p);
    return r.t === T_STRING ? "s:" + this.guest.readString(r.v) : "n:" + this.rvToNum(r);
  }
  allocHostArray(n) {
    const id = this.nextArrayId++;
    this.hostArrays.set(id, new Array(n).fill({ v: 0, flags: 0, t: 0 }));
    return id;
  }
  arrayLength(r) {
    return this.hostArrays.get(r.v)?.length ?? 0;
  }
  arrayGet(r, i) {
    return this.hostArrays.get(r.v)?.[i] ?? { v: 0, flags: 0, t: 0 };
  }
  arraySet(r, i, v) {
    const a = this.hostArrays.get(r.v);
    if (a) a[i] = v;
  }
  matchesObject(inst, t) {
    return inst.objIndex === t || t === -1;
  }
  someInstance(t) {
    for (const i of this.instanceList) if (i.alive && this.matchesObject(i, t)) return true;
    return false;
  }
  // Lifted object code reads [instance] as a vtable pointer and calls through
  // it, so it has to be a real address inside the guest memory: the constant
  // this replaced, 485259792, is nearly ten times past the end of it, and the
  // load of the call target trapped on the first virtual call of every object
  // event. The last page of memory is free - the stack grows down from 46MB
  // and the heap grows up from about 31MB - and the slots are never read,
  // because abi.icall resolves the call by displacement instead.
  initInstancePtr(guestPtr) {
    if (!this.vtableBase) this.vtableBase = this.guest.u8.length - 65536;
    this.guest.dv.setBigUint64(guestPtr, BigInt(this.vtableBase), true);
  }
  createInstance(objIndex, x, y) {
    const obj = this.objects[objIndex];
    const guestPtr = this.guest.alloc(256, 8);
    this.initInstancePtr(guestPtr);
    const inst = {
      id: this.nextInstanceId++,
      objIndex,
      guestPtr,
      vars: /* @__PURE__ */ new Map(),
      slots: /* @__PURE__ */ new Map(),
      x,
      y,
      spriteIndex: obj?.sprite ?? -1,
      imageIndex: 0,
      imageSpeed: 1,
      depth: obj?.depth ?? 0,
      visible: obj?.visible ?? true,
      persistent: obj?.persistent ?? false,
      alive: true,
      alarms: new Array(12).fill(0),
      hspeed: 0,
      vspeed: 0,
      speed: 0,
      direction: 0,
      imageXscale: 1,
      imageYscale: 1,
      imageAngle: 0,
      imageAlpha: 1,
      imageBlend: 16777215
    };
    this.instances.set(inst.id, inst);
    this.guestPtrMap.set(guestPtr, inst.id);
    this.instanceList.push(inst);
    // GameMaker runs PreCreate first; objects use it to set up the variables
    // Create depends on.
    this.runEvent(inst, "PreCreate");
    this.runEvent(inst, "Create");
    return inst;
  }
  eventFn(objIndex, ev) {
    const obj = this.objects[objIndex];
    if (!obj) return null;
    const fns = obj.events[ev];
    return fns && fns.length ? fns[0] : null;
  }
  runEvent(inst, ev) {
    const fnName = this.eventFn(inst.objIndex, ev);
    if (!fnName || this.disabledFns.has(fnName)) return;
    this.syncBuiltinFromSlotAll(inst);
    const outer = this.budgetMs;
    if (!outer) this.budgetMs = this.eventBudgetMs;
    try {
      this.callGuest(fnName, inst.guestPtr, inst.guestPtr, 0, 0);
    } catch (e) {
      const msg = String(e && e.message);
      if (msg.includes("guest timeout")) {
        // A step/draw handler that hangs would hang the whole frame — and the
        // tab with it. Three strikes and the handler is switched off for good.
        const n = (this.eventTimeouts.get(fnName) ?? 0) + 1;
        this.eventTimeouts.set(fnName, n);
        if (n >= 3) {
          this.disabledFns.add(fnName);
          this.log("event " + fnName + " disabled after " + n + " timeouts");
        }
      }
      this.log("event " + fnName + " threw: " + msg.slice(0, 200));
    } finally {
      this.budgetMs = outer;
    }
    this.syncBuiltinFromSlotAll(inst);
  }
  loadWorld(sprites, objects, rooms, order, soundNames) {
    this.sprites = sprites;
    this.objects = objects;
    this.rooms = rooms;
    this.roomOrder = order;
    this.soundNames = soundNames;
  }
  gotoRoom(idx) {
    if (idx === void 0 || idx < 0 || idx >= this.rooms.length) {
      this.log("room_goto: bad room " + idx);
      return;
    }
    // A room that hangs cannot be interrupted, only survived: the page
    // watchdog terminates the worker and reloads, and on the next run this
    // steps over the room that did it. Without it the game reaches a bad
    // room, hangs, reloads, reaches it again, and gives up permanently.
    if (this.roomSkip && this.roomSkip.has(this.rooms[idx].name)) {
      const pos = this.roomOrder ? this.roomOrder.indexOf(idx) : -1;
      const next = pos >= 0 ? this.roomOrder[pos + 1] : void 0;
      this.log("room_goto: skipping " + this.rooms[idx].name + " (hung on an earlier run)");
      if (next !== void 0 && next !== idx) {
        this.gotoRoom(next);
        return;
      }
      return;
    }
    if (this.roomTransitionDepth > 4) {
      this.log("room_goto: transition depth exceeded, deferring " + idx);
      this.pendingRoom = idx;
      return;
    }
    this.roomTransitionDepth++;
    try {
      // Other_5 is "room end" - it has to run while the instances are still
      // alive, so it goes before the teardown, not after it.
      for (const i of [...this.instanceList]) if (i.alive && !i.persistent) this.runEvent(i, "Other_5");
      for (const i of this.instanceList) if (i.alive && !i.persistent) i.alive = false;
      this.currentRoom = idx;
      const room = this.rooms[idx];
      this.viewW = room.w;
      this.viewH = room.h;
      for (const ri of room.instances) this.createInstance(ri.obj, ri.x, ri.y);
      const cc = this.fnByName.get("gml_RoomCC_" + room.name + "_Create");
      if (cc) {
        // A room's creation code gets the same treatment as an event
        // handler. Without it there is nothing to stop a room that spins:
        // this ran unbounded and allocated until the process was killed,
        // and no amount of watchdog machinery in the frame loop helps,
        // because room entry never reaches the frame loop.
        const outerB = this.budgetMs;
        if (!outerB) this.budgetMs = this.roomBudgetMs;
        try {
          this.callGuest(cc.n);
        } catch (e) {
          this.log("roomcc: " + String(e).slice(0, 120));
        } finally {
          this.budgetMs = outerB;
        }
      }
      // Other_4 is "room start": every instance exists by now and the room's
      // own creation code has run.
      for (const i of [...this.instanceList]) if (i.alive) this.runEvent(i, "Other_4");
    } finally {
      this.roomTransitionDepth--;
    }
  }
  stepFrame() {
    if (this.pendingRoom >= 0) {
      const r = this.pendingRoom;
      this.pendingRoom = -1;
      this.gotoRoom(r);
    }
    this.keyboardPressed.clear();
    this.keyboardReleased.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
    if (this.currentRoom < 0) return;
    for (const inst of this.instanceList) {
      if (!inst.alive) continue;
      for (let a = 0; a < inst.alarms.length; a++) {
        if (inst.alarms[a] > 0) {
          inst.alarms[a]--;
          if (inst.alarms[a] === 0) this.runEvent(inst, "Alarm_" + a);
        }
      }
    }
    const stepping = this._stepping ?? (this._stepping = []);
    stepping.length = 0;
    for (const inst of this.instanceList) if (inst.alive) stepping.push(inst);
    // Step_1 is begin step and Step_2 end step; GameMaker runs each of them
    // across every instance before moving on.
    for (const inst of stepping) if (inst.alive) this.runEvent(inst, "Step_1");
    for (const inst of stepping) {
      if (!inst.alive) continue;
      inst.x += inst.hspeed;
      inst.y += inst.vspeed;
      this.runEvent(inst, "Step");
    }
    for (const inst of stepping) if (inst.alive) this.runEvent(inst, "Step_2");
    // compact in place: no new array per frame, no filter() garbage
    let w = 0;
    for (const inst of this.instanceList) {
      if (inst.alive) this.instanceList[w++] = inst;
      else {
        this.runEvent(inst, "CleanUp");
        this.runEvent(inst, "Destroy");
        this.instances.delete(inst.id);
        this.guestPtrMap.delete(inst.guestPtr);
      }
    }
    this.instanceList.length = w;
    this.drawCalls = 0;
    const sorted = this._sorted ?? (this._sorted = []);
    sorted.length = 0;
    for (const inst of this.instanceList) sorted.push(inst);
    sorted.sort((a, b) => b.depth - a.depth);
    for (const inst of sorted) {
      if (this.eventFn(inst.objIndex, "Draw")) this.runEvent(inst, "Draw");
      else if (inst.visible) this.drawSelf(inst);
    }
  }
  spriteOf(inst) {
    return inst.spriteIndex >= 0 ? this.sprites[inst.spriteIndex] ?? null : null;
  }
  bbox(inst) {
    const s = this.spriteOf(inst);
    if (!s) return null;
    return [inst.x - s.ox, inst.y - s.oy, inst.x - s.ox + s.w, inst.y - s.oy + s.h];
  }
  placeMeeting(inst, x, y, obj) {
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
  drawSpriteExt(spr, img, x, y, xs, ys, rot, alpha, blend) {
    const s = this.sprites[spr];
    if (!s || !this.renderer) return;
    const f = s.frames.length ? s.frames[(img % s.frames.length + s.frames.length) % s.frames.length] : 0;
    this.renderer.drawSprite(s.name, f, x, y, xs, ys, rot, alpha, blend);
    this.drawCalls++;
  }
  drawSpriteStretched(spr, img, x, y, w, h) {
    const s = this.sprites[spr];
    if (!s || !this.renderer || !s.w) return;
    const f = s.frames.length ? s.frames[(img % s.frames.length + s.frames.length) % s.frames.length] : 0;
    this.renderer.drawSprite(s.name, f, x + w / 2, y + h / 2, w / s.w, h / s.h, 0, 1, 16777215);
  }
  drawSelf(inst) {
    this.drawSpriteExt(inst.spriteIndex, Math.floor(inst.imageIndex), inst.x, inst.y, inst.imageXscale, inst.imageYscale, inst.imageAngle, inst.imageAlpha, inst.imageBlend);
  }
  drawClear(color) {
    this.renderer?.clear(color);
  }
  drawRect(x1, y1, x2, y2, fill) {
    this.renderer?.rect(x1, y1, x2, y2, fill, this.drawColor, this.drawAlpha);
  }
  drawCircle(x, y, r, fill) {
    this.renderer?.circle(x, y, r, fill, this.drawColor, this.drawAlpha);
  }
  drawLine(x1, y1, x2, y2) {
    this.renderer?.line(x1, y1, x2, y2, this.drawColor, this.drawAlpha);
  }
  drawText(x, y, s) {
    this.renderer?.text(x, y, s, this.drawColor, this.drawAlpha, this.halign, this.valign);
  }
  playSound(id, loop, vol) {
    const n = this.soundNames[id];
    if (n) this.audio?.play(n, loop, vol);
  }
  stopSound(id) {
    const n = this.soundNames[id];
    if (n) this.audio?.stop(n);
  }
  nullInstance() {
    if (!this._nullInst) {
      const guestPtr = this.guest.alloc(256, 8);
      this.initInstancePtr(guestPtr);
      this._nullInst = { id: -1, objIndex: 0, guestPtr, vars: /* @__PURE__ */ new Map(), slots: /* @__PURE__ */ new Map(), x: 0, y: 0, spriteIndex: -1, imageIndex: 0, imageSpeed: 1, depth: 0, visible: true, persistent: false, alive: true, alarms: new Array(12).fill(0), hspeed: 0, vspeed: 0, speed: 0, direction: 0, imageXscale: 1, imageYscale: 1, imageAngle: 0, imageAlpha: 1, imageBlend: 16777215 };
    }
    return this._nullInst;
  }
  varByName(inst, name) {
    const cellId = this.nameToCell.get(name);
    if (cellId !== void 0) {
      const slot = inst.slots.get(cellId);
      if (slot !== void 0) return this.rvToNum(this.guest.readRV(slot));
    }
    return 0;
  }
  setVarByName(inst, name, v) {
    const cellId = this.nameToCell.get(name);
    if (cellId !== void 0) {
      let slot = inst.slots.get(cellId);
      if (slot === void 0) slot = this.varSlot(inst, cellId, name);
      this.guest.writeRVDouble(slot, v);
    }
  }
  initCellIndexes() {
    this.meta.cellNames.forEach((n, id) => {
      if (!this.nameToCell.has(n)) this.nameToCell.set(n, id);
    });
    for (const n of BUILTIN_VARS) {
      const cellId = this.nameToCell.get(n);
      if (cellId !== void 0) this.builtinCellCache.push([cellId, n]);
    }
  }
  mapKey(gmKey) {
    return gmKey;
  }
}
export {
  GMRunner,
  Guest,
  IMAGE_BASE,
  T_ARRAY,
  T_BOOL,
  T_DOUBLE,
  T_INT32,
  T_OBJECT,
  T_PTR,
  T_STRING,
  T_UNDEF
};
