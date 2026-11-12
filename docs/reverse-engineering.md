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

Not yet characterised, next in line by call count: `0x14128a900` /
`0x14128a960` (a paired id allocate/release, both 1052), `0x140e63aa0` (996,
instance lookup by id — it tests `rcx >= 0x186a0`, the 100000 instance-id
base), `0x1400462a0` (897), `0x140069500` (808), `0x140041df0` (704).

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
