# Reverse-engineering the runner ABI

The lifted guest (`gex/game.wasm`) contains the game's 5555 GML functions and
nothing else. Everything they call in the original GameMaker runner arrives as
a WebAssembly import named `abi.f<va>`, where `<va>` is the address of the
runner function in the original `Ichorous.exe`. When the port started, 281 of
those imports existed and 26 had hand-written shims in `js/gex/runtime.js`.

This page is the notebook for closing that gap. It records the ground truth
that is expensive to rediscover.

## Ground truth: the RValue

Every GML value is a 16-byte `RValue`:

| offset | size | meaning |
| ------ | ---- | ------- |
| `+0`   | 8    | value: `double` for reals and bools, pointer for strings/arrays/objects, `int64` for ints |
| `+8`   | 4    | flags |
| `+12`  | 4    | kind, read as `kind & 0xffffff` (`0xffffff` = "unset") |

The kind numbering is *not* guessable; it comes from the runner's own
`typeof` implementation. `tools/builtin-scan.mjs` recovers the built-in
registration table, `typeof`'s body calls `0x140e4aab0` to turn a kind into a
name, and `tools/jumptable.mjs 0x140e4aab0` decodes that switch:

```
0 number    1 string    2 array     3 ptr       4 vec3      5 undefined
6 object    7 int32     8 vec4      9 matrix   10 int64    11 accessor
12 null    13 bool     14 iterator  15 ref
```

Two things fall out of this that matter:

* **Bool is 13, not 4**, and a bool is stored as the *double* `0.0`/`1.0`.
  Confirmed by `is_bool` (`0x140e6fee0`), which compares the kind against `13`
  and writes its result with `cvtdq2pd` plus kind `13`.
* `1 << kind & 0x46` is the runner's "does this value need a refcount"
  predicate — kinds 1, 2 and 6. Every RValue assignment in the lifted code
  tests it before releasing the old value.

## Ground truth: how `a.b` compiles

GMS 2.3 lowers the dot operator to three runner calls, all with the shape
`(target, member, arrayIndex, value)`:

| address | role |
| ------- | ---- |
| `0x140e87930` | **write** to a member; `rcx` is an `RValue*` that still has to be resolved |
| `0x140e86fa0` | **write** to a member; `rcx` is already an instance pointer |
| `0x140e87170` | **read**; `r9` is the `RValue*` to store the result into |

The member is a **cell id** — an index into `meta.cellNames`. The lifted code
loads it with `mov rdx, [rip+...]` from a cell in `.data`, and
`tools/gex/image.js` fills those cells with ids when it builds
`gex/image.bin`, so the ids are live in the guest image.

`r8` is an array index, or `0x80000000` when the access is not indexed.

Instance layout offsets that show up repeatedly:

| offset | meaning |
| ------ | ------- |
| `+0x20` | parent / prototype |
| `+0x74` | object kind: 0 struct, 1 instance, 2 accessor, 3 function, 6 weakref |
| `+0x88` | the object definition (`+0` is its name, `+0x80` holds a read-only flag) |
| `+0xb4` | instance id |

## Functions identified so far

| address | calls | what it is |
| ------- | ----- | ---------- |
| `0x140e632c0` | 1776 | `YYError(const char *fmt, ...)`. Every YYC type/variable check funnels here; the real runner aborts. We log once per format string and return. |
| `0x140e87930` | 1938 | member write, RValue target (above) |
| `0x140e86fa0` | 1935 | member write, instance pointer (above) |
| `0x140e87170` |  920 | member read (above) |
| `0x140e4cd60` | 1162 | release a scope temporary. YYC emits `test rcx,rcx / je / call / mov [local],0` around every one. Genuinely a no-op without refcounting. |
| `0x140e4a740` |  946 | `YYGetInt64(RValue*)`: `cvttsd2si` for reals and bools, `atof` for strings, the raw 64 bits for pointer/int32/int64/ref, the instance id for objects, an error (→ 0) for everything else |
| `0x140e643a0` |  703 | constructor prelude: `[rcx+0x20] = rdx`, behind a "called a constructor directly?" guard |
| `0x140e64380` |  620 | set an object's name pointer (`+0x28`) and set flag `8` in `+0x58` |
| `0x140044220` |  430 | `RValue::operator=(RValue *rcx, int rdx)`: release if `1<<kind & 0x46`, then store `rdx` as a real |
| `0x1400424f0` |  450 | 16-byte RValue copy; same as `0x1400424a0` but returns `rcx` |
| `0x1400424a0` |   51 | 16-byte RValue copy |
| `0x140041a50` | 84565 | release an RValue's value (no-op) |
| `0x14128ab40` | — | MSVC `_eh_vector_constructor_iterator` |
| `0x14128aa70` | — | MSVC `_eh_vector_destructor_iterator` |
| `0x140e851f0` | — | **three-way comparison.** `(RValue *left, RValue *right) -> -1 / 0 / 1` in `rax`. It switches on `kindA*16 + kindB` (capped at `0xf0`, i.e. 15×15) through a compressed jump table; the plain integer case is `cvttsd2si rax,[left] / sub rax,[right] / sar 31 / and -2 / +1`. `-2` means "not comparable". See below: getting this wrong hangs the interpreter. |
| `0x140042560` | — | **in-place RValue multiply.** `(RValue *dst, RValue *src) -> dst` with `dst = dst * src`; the double case is literally `movsd xmm0,[src] / mulsd xmm0,[dst] / movsd [dst],xmm0`. Only two arguments. |
| `0x140e645a0` | 255822 | **GMS 2.3 method creation.** `(RValue *out, script, struct)` sets `out->kind = 6` (object) and points it at a freshly allocated `0xe0`-byte method object tagged `"METH"` (`0x4d455448`), which stores the script at `+0x90`, the bound struct at `+0xa8` (only when non-zero) and the resolved script record at `+0xb8`. Two gotchas: the script arrives as an **RVA** (`0xd21190`, not `0x140d21190`), so it has to go through `fnByPtr`; and the struct argument is 0 for an unbound function value, which is the common case. See below. |

### Call shapes that bite

`0x140e87440` and `0x140e634e0` are worth singling out because both had shims
that read arguments the functions do not have.

`0x140e87440(instance, memberCell, arrayIndexOr0x80000000, RValue *out)` is the
member read for an *already resolved* instance pointer — the sibling of
`0x140e87170`. It takes **no stack arguments**. Reading two anyway produced the
`dispatch: bad id` flood that dominated the guest log for a long time.

`0x140e634e0(self, other, RValue *result, argc, callee, args)` is the generic
call. Its `callee` slot has three shapes and has to be resolved before use
(`callTargetId`):

* a plain **cell id** — calling a built-in or a named script;
* a pointer to an **RValue** — a GMS 2.3 method held in a variable. When that
  RValue is `undefined`, which is every struct method until the struct ABI
  exists, there is nothing to call; guessing an id from the bits used to
  dispatch nonsense;
* occasionally a raw **code address**.

### Three shims that were not just wrong but catastrophic

All three of these produced plausible-looking logs and a running frame loop, so
none of them announced itself. It is worth writing down how each one presented.

**`instance + 0` is a vtable pointer.** Lifted object code does `mov rax,[self]`
and then calls through it, so whatever sits at an instance's first qword has to
be a real address inside the 48MB guest image. `createInstance` wrote a
sentinel, `485259792`, there instead. Every object event then trapped `memory
access out of bounds` on its first virtual call, with an empty `abiTrace`
because no import call preceded the fault. It now points at an unread page at
the top of memory; `abi.icall` resolves calls by displacement, so the slots are
never actually fetched.

**`0x140e851f0` returns -1/0/1, not a boolean.** Lifted loops compare that way:
`call 0x140e851f0 / test rax,rax / setl rdi / test rdi,rdi / je <exit>`, which
is to say *keep looping while the result is negative*. A shim returning `0` or
`1` makes every `for` and `while` in the game run either zero times or — when
the comparison is inverted — forever. Fixing it also cleared all eight
remaining boot failures at a stroke: boot went from 490 ok / 8 threw to
498 ok / 0 threw.

**`0x140042560` takes two arguments, not three.** The old shim read the third
as an element count and looped that many times over a destructor thunk it had
invented. One call site passed `50266112`, so that was 50 million iterations of
a no-op with *no import call in between* — and because `icall_reg` is called
directly rather than through the import proxy, the ABI trace showed nothing.
The whole interpreter hung inside a single wasm frame, where neither the
watchdog nor the debugger can reach it. When the guest log stops mid-event
after a burst of import calls, suspect a shim of your own looping, not the
guest.

### Not yet characterised, next in line by call count

Re-ranked with the frame loop actually running (12 rooms × 20 frames, via
`tools/room-walk.mjs`), which is a very different picture from the boot-only
ranking: `0x140041df0` (1081), `0x140486f90` (862), `0x140046040` (805),
`0x140046500` (480), `0x140041c40` (320), `0x1400419a0` (312), `0x140e8da20`
(194), `0x140069500` (171), `0x1400462a0` (170), `0x140e98b30` (168),
`0x140e86c30` (164), `0x14040fdc0` (146), `0x140e78f40` (121), `0x140e78ec0`
(93), `0x14008e020` (85) — 6419 calls across 149 distinct imports in total.
Most of the top of the list is the `0x140041xxx`–`0x140046xxx` refcount and
RValue family, which is the same family as the heap exhaustion below.

Earlier boot-only leaders: `0x14128a900` / `0x14128a960` (a paired id
allocate/release, both 1052), `0x140e63aa0` (996, instance lookup by id — it
tests `rcx >= 0x186a0`, the 100000 instance-id base).

## Tooling

All of these read the original executable, which is **not** in this repo. Put
it at `/home/user/fixtures/Ichorous.exe` and export
`ICHOROUS_EXE=/home/user/fixtures/Ichorous.exe` (the tools default to a
`/tmp` path that does not survive a restart). To re-extract it:

```sh
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --filter=blob:none --no-checkout \
  https://github.com/TheAlphaLeopard/ichorousport.git /tmp/iport
(cd /tmp/iport && git cat-file blob HEAD:raw/Ichorous.exe > /home/user/fixtures/Ichorous.exe)
```

| tool | what it answers |
| ---- | --------------- |
| `tools/disas.mjs <va> [n]` | "what is this address?" — disassembles, annotating strings and call targets |
| `tools/xrefs.mjs <va>` | "who calls it, and with what?" — call sites *inside lifted GML functions only*, with the instruction window around each. This is the single most useful tool: argument setup is what identifies a function. |
| `tools/jumptable.mjs <va>` | decodes an MSVC switch table (RValue-kind dispatch is always one) |
| `tools/builtin-scan.mjs` | recovers `name -> implementation VA` for every built-in GML function from the runner's registration table |
| `tools/boot-report.mjs` | groups the boot scripts that throw by root cause |
| `tools/room-walk.mjs [frames] [maxrooms]` | the frame-loop benchmark: enters each room in the game's own order, runs it, and reports instances, draw calls, throws and wall time per room. Measuring only the boot room is useless — `rmInit` holds nothing but managers, so it always reports zero draw calls. |
| `tools/gex/tmp/one.mjs <fn>` | lifts a **single** function out of the exe into a standalone wasm module, so its behaviour can be studied without booting 107MB of game |
| `tools/gex/tmp/one-run.mjs` | runs that module against the real shims |
| `tools/gex/tmp/sweep.mjs <start> <end> <out>` | linear-sweep disassembly that restarts one byte later on an undecodable byte. `tools/disas.mjs` *stops* at inline data — a jump table or a string blob truncates the listing and silently hides the rest of the function, including every loop back-edge |

### Traps

* `call rel32` targets decode as **full VAs**. The image base
  (`0x140000000`) has non-zero low 32 bits, so an RVA is `va - imageBase` and
  *not* `va & 0xffffffff`. Masking instead of subtracting is a silent bug that
  made an early xref scanner report zero hits. `resolve()` and `fnByPtr()` in
  `js/gex/runtime.js` had this bug too.
* `out-fnreg-order.json` stores `va` as a **decimal number**, so grepping for
  a hex address finds nothing.
* `.data` is larger on disk than in the file (`vsize` 0x48eb14 vs `rawSize`
  0x10c600); everything past the raw part is zero at load, so reads there are
  meaningless.
* `tools/disas.mjs` stops at the first undecodable byte. Use
  `tools/gex/tmp/sweep.mjs` when you need a whole function — it is the
  difference between "no backward jumps, so it cannot loop" and the five
  back-edges that were actually there.
* The runner keeps a linked list of `{prev, name}` frames for error reporting,
  and the head is a `.data` global at `31226448`. Reading it names the *guest*
  caller of an import, which is the only way to attribute a call when the
  JavaScript stack is nothing but wasm frames.
* `pkill -f <pattern>` kills the shell running it when the pattern appears in
  the command line. It took out a whole turn's harness that way.
* `/tmp` does not survive between turns. Harnesses worth keeping live in
  `tools/gex/tmp/`.
* The guest's own error-reporting frame chain (head at `31226448`) names the
  caller of an import, but it is only correct while frames are balanced. It
  blamed `anon@897@…oRogueLevelManager_Other_13` for 255822 method
  creations that the disassembly of that function shows it cannot possibly
  make — it has no loop and calls nothing of the kind. Trust the chain for
  narrow questions, verify with a call count before acting on it.

## Two ways to lose the whole run

Both of these are about a guest loop that never terminates. There is no
`Error.stack` to read, the watchdog cannot see inside a wasm frame, and the
failure looks like an out-of-memory rather than a bug.

**The watchdog was wired up but could never fire.** `checkBudget` only arms
itself at `callDepth 0`, and only `callGuest` moved that counter — so a script
reached through a call from another script ran with the watchdog permanently
disarmed. And `dispatchFunction` caught every exception, *including the
watchdog's own timeout*, so even when it did fire the throw was swallowed and
the loop carried on. Both now fixed: the budget is checked on every ABI import,
`enterGuest` does the same bookkeeping `callGuest` does, a timeout is rethrown
rather than logged, and a handler that overruns three times is disabled for
good. A room's creation code gets its own budget, because it never reaches the
frame loop and no amount of frame-loop machinery helps it.

**A loop that never calls the host cannot be stopped at all.** A single frame
of `rmSqualorLevelBoss` runs 2046500 member reads, 767447 GML calls and 255822
method creations. When one of those loops instead touches nothing but its own
registers, there is no host boundary to intercept: the process grows until
something kills it. The only defences are structural — terminate the worker
(`js/main.js`) or isolate the room in its own process
(`room-walk.mjs --isolate`).

`enterGuest` also bounds call depth, because runaway recursion burns the JS
stack and V8 reports that as an unrecoverable out-of-memory rather than a
catchable stack overflow.

## Reading an unimplemented ABI import

Every import in `gex/game.wasm` is declared `(i64, i64, i64, i64, i64) ->
(i64, f64)`. Five raw registers in, integer result in slot 0 and the xmm0
result in slot 1. Two consequences that are easy to get wrong:

* A shim receives **raw 64-bit register values**. Whether that is a pointer,
  a cell id, or the bit pattern of a double is up to the function — the
  disassembly is the only way to tell, and guessing has produced wrong shims
  before. For a float function the i64 has to be reinterpreted as an f64; for
  `f140e851f0` (which compares with `comisd` in the original) the arguments are
  RValue *pointers*, not doubles, despite the x86 being pure floating point.
* `tools/gex/tmp/abiargs.mjs` logs real calls with arguments decoded — RValues
  shown by kind and value, small integers resolved to their cell name. Log
  before implementing.

Measured signatures for the imports the browser console reports most:

| import | observed args | reading |
| ------ | ------------- | ------- |
| `f140e78ec0` | `(rv, rv, rv)` | leaf body is `maxsd; minsd; movaps; ret`, so `clamp` — but the arguments arrive as RValue pointers, which contradicts the leaf body, so it needs more than a disassembly to pin down |
| `f140e794b0` | `(rv, rv, 0x80000000, rv)` | `comisd` then a `subsd` loop: real `mod` |
| `f140e162c50` | `(rv, rv, 0x80000000, rv)` | switches on the RValue kind at `rcx+0xc` with cases for double, string, int32, int64 and bool, and an error path otherwise — a numeric conversion like `YYGetInt64`. It is being called with `T_UNDEF`, which the real runner rejects |
| `f140e78db0` | `(out, rv, rv, rv)` | zeroes `rcx` first (`[rcx+0xc]` then `[rcx]`), so `rcx` is the output RValue; then branches on whether `rdx` is 0 |
| `f140e98b30` | `(rv, rv, cell, 271568)` | third argument is a function-name cell (`ds_stack`, `ds_queue`), so a two-argument call through a named function |

None of these are implemented yet. They are logged here because the shape is
half the work and re-deriving it costs a disassembler run each time.

## The tutorial-room runaway is ours, not the game's

Chasing this through the lifted wasm is hopeless, which is worth saying
plainly because it cost a lot of time. `gml_Object_oMeatBlob_Create_0`
lifts to 120 KB of wasm containing **1803 `loop` blocks**, 2804 `block`s
and 3918 `if`s — none of which correspond to anything in the source. The
x86 is ground truth, and it says the opposite:

* **2015 instructions, 133 branch instructions, 130 distinct branch
  targets, and zero backward jumps** across `gml_Object_oMeatBlob_Create_0`
  *and* all five of its anonymous struct methods (0x140b51d20–0x140b53aa0);
* it makes **no direct call to any other GML function** — every call goes
  out through the ABI dispatcher (`f140e634e0`), so a static call graph
  from it has exactly one node and there is no callee to blame;
* it therefore provably terminates. Executing it does not.

So the lifter produces the runaway. `tools/gex/tmp/callgraph.mjs` walks
the x86 call graph from a root and reports backward jumps per function,
which is how the "no callee" part was established.

### How the lifter compiles a function

It does not translate branches into branches. `tools/gex/lift.js` builds a
dispatcher state machine (`lift.js:284` onward):

```wasm
block                      ; exit target
  loop                     ; the dispatcher
    block × N              ; one per basic block
    block                  ; br_table default
    local.get BLOCKID
    br_table  N, <targets...>, <default>
    end
    ;; body of block j:
    ;;   ...instructions...
    ;;   BLOCKID = <successor>;  br <blockDepth(j)>   ; back to the dispatcher
    end
    ...
  end
end
```

Every terminator sets a `BLOCKID` local and branches back to the top of
the `loop`, where `br_table` picks the next block. `blockDepth(j) = j`,
`exitDepth(j) = j + 1`, and the `br_table` default is `N + 2` (return).

This is why the `loop` count tells you nothing: the 1803 loops come from
per-instruction expansions inside block bodies, not from the 130 real
basic blocks. Counting them was a dead end.

The ways this shape can spin are all in the successor computation: a
`jcc` whose condition `condTo` mistranslates (`lift.js:356`), a block
that falls through into the next body without setting `BLOCKID`, or an
`idByVa` successor that maps back into the block that produced it. Since
the x86 cannot loop, one of those is happening.

### On using an x86 emulator

v86 is 32-bit only — it cannot run this x86-64 PE, so "just emulate it"
is not available. What *is* available, and what settled this question, is
treating the x86 as ground truth and the wasm as a translation to be
suspected: disassemble the original, count its real control flow, and
believe that over anything the lifted module appears to be doing.

## Where the frame loop stands

Methods are the most recent piece: `0x140e645a0` is implemented, and an
unbound method costs no storage at all because the script's own code address
is already an unambiguous payload — no real guest pointer is anywhere near the
image base. That matters more than it sounds, because the old shim handed out
a 32-byte allocation per method and the game makes a quarter of a million of
them in a single frame. Rooms that drew 0.1 sprites per frame now draw 5–8.

See `docs/port-status.md` for the current measurements. As of this writing:
498 boot scripts with none throwing, 72 of 75 rooms survivable, 61 of them
drawing, 5.4 draw calls per frame on average.

**The three tutorial rooms run away**, and they run away somewhere the runner
cannot see. `rmTutorial2`'s entry gets through about 1600 ABI imports and then
stops making them entirely — fewer than 100 in the next twenty seconds — while
process RSS climbs roughly 300 MB/s until the OS kills it. Wasm linear memory
stays flat at 48 MB, so it is not `memory.grow`. A 2.5 GB heap changes nothing,
and neither does a small `--stack-size`, which would have turned runaway
recursion into a catchable `RangeError` — so it is a loop, and it never reaches
a host boundary. No budget check, no three-strikes, and no worker termination
short of the OS can stop it.

The measurement is worth keeping: `tools/gex/tmp/tutwatch.mjs` runs the entry
on a worker thread so the main thread's timers keep firing during a
synchronous guest loop. It is the only way to watch a runaway that makes no
host calls, which is exactly the case that is hardest to see into.

**Two leads that looked like the cause and are not.** Recording them so they
are not re-chased.

The lifted wasm for `gml_Object_oMeatBlob_Create_0` contains **1803 `loop`
blocks**, and a linear sweep of the original x86 (0x140b51d20–0x140b53aa0)
finds **zero backward jumps** in 133 of them. That reads like the lifter
inventing loops that are not there — but `gml_Object_oWall_PreCreate_0`, which
runs fine, lifts to **2544 loops from 4 backward jumps**. The loops are how
this lifter encodes conditional regions generally, not a per-loop bug, so the
count is not the discriminator.

There is also no direct self-call: `oMeatBlob`'s Create has 534 `call`s across
69 distinct targets and none is itself. So it is not simple recursion either. It builds a struct, binds a method to it, and repeats; every
struct is a fresh allocation, so nothing can be reused. It fails identically
with method dispatch switched off.

**Nothing is ever freed**, which is the root cause and is the next piece of
real work. The heap is a bump allocator with an 8MB budget (32505856 →
40894464) and the decref shims are no-ops, so every `@@NewGMLObject@@` and
every bound method lives forever. The real runner survives on refcounting.

## The alternative to hand-shimming

`tools/gex/lift.js` is the same static recompiler that produced
`gex/game.wasm`, and `tools/gex/image.js#buildRegistry` currently feeds it
only the functions named `gml_*` in `data/ghidra_pass2_scriptmap.csv`. The
`.pdata` section has extents for *every* function in the executable, including
all 281 runner ABI targets, and `lift.js` emits an internal wasm `call` for any
target that is in `reg.fns` (`abiImportFor` is only reached otherwise).

So adding the runner functions to `reg.fns` would replace hand-written shims
with lifted code — the same trick
[HeyPuter/gex](https://github.com/HeyPuter/gex) applies to whole programs. It
is the obvious next thing to try; the open questions are how many of them lift
cleanly and whether the ones that walk real `CInstance` structures behave
better or worse than a shim that knows the guest's own object model.

### Answered: it lifts, and it is a regression (measured)

`tools/gex/build-runner.js` adds the runner addresses to `reg.fns` and walks to
a fixed point. It works mechanically:

| | shipped | + runner fns |
|---|---|---|
| functions in the module | 5555 | 5876–5900 |
| lifted / failed | 5555 / 0 | 5876 / 0 |
| distinct ABI imports | 422 | 229 |
| direct (internal) call sites | 7117 | 33 594 |
| `game.wasm` | 107.18 MB | 111.5 MB |
| boot scripts | 490 ok, 8 threw, 2.6 s | 379 ok, 119 threw, 203 s |
| 200 frames | 0 throws, p50 0.0 ms | 0 throws, p50 0.0 ms |

Frames are unaffected; boot is both slower and less successful. Lifting whole
runner functions is not the shortcut — the shims survive because they encode
knowledge of the guest's object model that lifted runner code does not have.
`build-runner.js` is kept because it is the tool that found the next section.

### Two bugs in how the lifter emits a direct call

Chasing that regression turned up two defects in `lift.js` that are present in
the shipped `gex/game.wasm` as well. Both concern the direct `call` to a target
that is in `reg.fns` (the `abi.*` import path was fine).

1. **The index was short by the number of imports.** Wasm lays imports out
   first, so `reg.fns[i]` lives at index `imports.length + i`
   (`wasm.js#addFunc` returns exactly that). The call sites used
   `fnIndexByVa`, which is the plain array index `i`. Imports are created
   lazily as call targets are seen, so `internalFnIdx()` now adds the base,
   `precreateImports()` creates every import before the first body is emitted,
   and `liftAll()` throws if the import count moves afterwards. Without the
   pre-creation the base changes under already-emitted bodies.

2. **The fifth argument shifted the arguments by one.** Lifted functions take
   four parameters (rcx, rdx, r8, r9) and read rsp from a global; the ABI
   imports take five, the fifth being rsp, because they run in JS. The emitter
   pushed five in both cases. A four-parameter callee then receives
   **rdx, r8, r9, rsp** instead of rcx, rdx, r8, r9 — wasm takes the *last* N
   values pushed, so the extra value at the bottom drops the real first
   argument. Verified with a four-line module:

   ```
   local.get 0..3; global.get $rsp; call $callee   ;; callee sees p0 = 2, not 1
   ```

   (It did not trap: extra values below the stack are legal, and every block
   ends in a `br`, which discards them. That is why this was invisible.)

Both are fixed in `tools/gex/lift.js`. The rebuilt module is **not** shipped:
with correct direct calls the 2 299 GML→GML call sites execute for the first
time and mostly die with `memory access out of bounds` (boot falls to 71 ok /
427 threw). In other words the scoreboard we have been tracking was flattered —
a direct call used to land `imports.length` functions early in `reg.fns`, or on
an ABI import whose shim returned `[0n, 0]`, and garbage that does not throw
counts as "ok". The room does get further with the fix (11 instances instead of
9), so the work is real; the next problem is whatever those scripts touch that
neither the shims nor the image model support yet.

### Tooling added for this

| tool | what it does |
|---|---|
| `tools/gex/build-runner.js` | lifts runner functions into the module |
| `tools/boot-trace.mjs` | runs the boot scripts one at a time, printing each name before it starts and a JS stack on the first error (`STACK=1`) |
| `tools/abi-count.mjs` | runs one guest function with per-ABI-import call counts |
| `GMRunner.countABI` | fills `runner.abiCounts` with a call count per ABI import |
