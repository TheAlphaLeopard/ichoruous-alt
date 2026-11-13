# How a GameMaker game actually runs

This is the part of the port that is not about this particular game. It is a
description of the GameMaker (YYC) runtime model as observed by disassembling
one shipped game, written so that it can be used to build an interpreter, an
emulator, or another static recompiler without redoing the archaeology.

Everything below was measured, not assumed. Where something is an inference it
says so. Offsets are from *this* build's runner and will move between GameMaker
versions; the shapes are what generalise.

GameMaker ships games in two forms. The **VM** build interprets bytecode stored
in the `CODE` chunk of `data.win`, and is what tools like UndertaleModTool
target. The **YYC** build statically recompiles all GML to native code at build
time: there is no bytecode, no `CODE` chunk, and no `VARI` chunk. A YYC game can
only be run by lifting the machine code. This port does that.

## The RValue

Everything in GameMaker is a 16-byte `RValue`. It is passed by pointer, copied
by value, and never boxed:

```
+0x0  qword   payload   a union: double, or int64, or a pointer
+0x8  dword   flags
+0xc  dword   kind      masked with & 0xffffff
```

The kind table lives at a fixed address in the runner (`0x140e4abe8` here) and
is what `typeof` and every type check switch on:

| kind | type | kind | type |
| ---- | ---- | ---- | ---- |
| 0 | number (double) | 8 | vec3 |
| 1 | string | 9 | vec4 |
| 2 | array | 10 | int64 |
| 3 | pointer | 11 | accessor |
| 4 | bool | 12 | null |
| 5 | undefined | 13 | int32-as-bool |
| 6 | object / instance | 14 | iterator |
| 7 | int32 | 15 | ref |

Two details matter constantly:

* **Bools are doubles.** `true` is `1.0`, `false` is `0.0`, and there is no
  separate boolean kind in normal use.
* **Refcounting is a bit test.** `1 << kind & 0x46` selects kinds 1 (string),
  2 (array) and 6 (object) — the three that own memory. YYC emits that test
  inline before every decref, so you see `and rcx,0x1f / shl rax,cl /
  test rax,0x46 / je <skip> / call decref` around every temporary.

An `RValue` copy is a flat 16-byte move *plus* an incref when the kind needs
one. That is the whole reason a naive port leaks: dropping the refcount side of
the copy is invisible right up until the process runs out of memory.

## Instances

An instance is a heap object whose **first qword is a vtable pointer**. Lifted
code loads it and calls through it:

```asm
mov  rax, [rsi]          ; rsi = instance
mov  rdx, [rip+0x11d0f63] ; the member's cell id
mov  rcx, rsi            ; this
icall [rax+0x10]         ; virtual call
```

`+0x10` is the member-access slot; `+0x8` is another (it appears in event
dispatch). The vtable entries are *thunks into the runner*, not into GML, so an
emulator does not need a real vtable — it needs to know which displacement
means "read member", "write member", and so on.

Other offsets seen in this build:

| offset | what |
| ------ | ---- |
| `+0x0` | vtable pointer |
| `+0x18` | for arrays: element storage |
| `+0x24` | for arrays: element count |
| `+0x74` | class tag, used by `instanceof`: 0 script/struct, 1 accessor, 2 instance, 3 function, 4 weakref |
| `+0xb0` | an `RValue` used by member get/set |

Instance ids start at `100000` (`0x186a0`). The lookup helper tests
`rcx >= 0x186a0` to tell an id from a direct object pointer.

## Events

GameMaker dispatches by *(category, sub-index)*. The YYC compiler emits one
function per event, named by a scheme you can rely on because it is what makes
a name-matching extractor possible:

```
gml_Object_<object>_<Category>_<sub>
gml_Script_<name>
gml_RoomCC_<room>_Create
gml_GlobalScript_<name>
```

Categories and the sub-indices that occur in practice:

| category | sub-indices seen |
| -------- | ---------------- |
| `Create` | 0 |
| `Destroy` | 0 |
| `Alarm` | 0..11 |
| `Step` | 0 normal, 1 begin, 2 end |
| `Draw` | 0 normal, 64/72/74/77 GUI and post-draw |
| `Other` | 0 outside room, 1 boundary, 2 game start, 3 game end, 4 room start, 5 room end, 7 animation end, 10+ user events |
| `CleanUp` | 0 |
| `PreCreate` | 0 |
| `KeyPress` | keycode |

Two orderings an emulator must get right, because objects depend on them:
`PreCreate` runs before `Create`, and the three step events each sweep *all*
instances in turn — begin step across everything, then normal step across
everything, then end step. Room end (`Other_5`) has to fire while the outgoing
instances are still alive; room start (`Other_4`) after the new room is built
and its creation code has run.

The event-dispatch prologue (here `0x140e98b30`, called as
`(instance, instance, category)`) validates the instance and raises a runner
error if it is not usable. Getting a category or sub-index wrong does not crash
— it silently runs the wrong event, which is far worse to debug.

## Structs and methods (GMS 2.3)

These are the two features that most separate a modern GameMaker game from an
old one, and they are worth spelling out because they are where a port stalls.

A **struct literal** compiles to a call to a synthetic built-in named
`@@NewGMLObject@@` that returns a fresh handle. Structs are heap objects with
refcounted lifetimes, and a single frame of a busy room can create hundreds of
thousands of them. Member access on a struct goes through the same member ABI
as instances, keyed by cell id.

An **anonymous function** becomes a real function
(`gml_Script_anon@N@<enclosing>@<enclosing>`) plus a **method value**. Method
creation is a single runner call:

```asm
xor  r8, r8                  ; struct to bind, or 0 for unbound
lea  rdx, [rip+0xfffd436b]   ; the script's code address — an RVA
lea  rcx, [rbp+0x650]        ; out RValue
call 0x140e645a0
```

It sets the out `RValue`'s kind to 6 (object) and points it at a `0xe0`-byte
object tagged `"METH"` (`0x4d455448`): script at `+0x90`, bound struct at
`+0xa8` (written only when non-zero), resolved script record at `+0xb8`.

Two things follow. First, **the code address arrives as an RVA, not a VA** —
`0xd21190`, not `0x140d21190` — so any lookup has to add the image base.
Second, an unbound method needs no storage at all: the code address is itself
an unambiguous payload, because no real guest pointer is anywhere near the
image base. That is the difference between a method costing one integer and
costing a quarter of a million unfreed allocations per frame.

Calling a method sets `self` to the bound struct; an unbound function value
keeps the caller's `self`.

## How GML compiles to x86-64

Recognising these shapes is most of reverse-engineering the ABI, because the
argument setup is what identifies a function.

**Member access.** `a.b` becomes a member-ABI call taking the target, the
member's *cell id* (not a string — names are interned into a table indexed by
small integers), an array index or `0x80000000`, and an out `RValue`. There
are several variants: one for an `RValue` target, one for an already-resolved
instance pointer, and separate read and write forms.

**Loops.** `for` and `while` compare through a **three-way comparison** helper
that returns `-1`, `0` or `1` — not a boolean — and then test the sign of the
result:

```asm
lea  rdx, [rbp-0x70]      ; right operand
lea  rcx, [rsp+0x70]      ; left operand
call 0x140e851f0          ; -> -1 / 0 / 1 in rax
test rax, rax
setl rdi                  ; keep looping while the result is negative
test rdi, rdi
je   <exit>
```

The helper switches on `kindA*16 + kindB` through a compressed jump table, and
returns `-2` for "not comparable". A shim that returns a boolean makes every
loop in the game run either zero times or forever.

**Calls.** A GML call is `(self, other, RValue *result, argc, callee, args)`
in `rcx, rdx, r8, r9` with the last two on the stack. The `callee` slot has
three shapes and all three occur: a plain cell id for a built-in or named
script, a pointer to an `RValue` for a method value, and occasionally a raw
code address.

**Built-ins** are registered at startup by a repeated pattern, which is how you
recover the whole name → implementation map without guessing:

```asm
xor  r9, r9
lea  rdx, [rip+d]     ; implementation
lea  rcx, [rip+d]     ; name
lea  r8, [r9+N]       ; argument count
call 0x140fbf1f0      ; register
```

## The runner ABI, in families

The functions lifted GML code calls fall into a small number of families. This
is the map to hold in your head:

| family | what it does | how to recognise it |
| ------ | ------------ | ------------------- |
| refcount | incref / decref | called behind `1 << kind & 0x46` tests; enormous call counts |
| RValue ops | arithmetic and comparison in place | `(dst, src)`, switch on kind |
| RValue copy / assign | 16-byte move plus incref | two pointers, returns `rcx` or 0 |
| member access | read/write a named member | takes a *cell id* |
| dispatch | call a GML function or built-in | takes `(self, other, result, argc, callee, args)` |
| scope | push/pop temporaries | paired around every expression |
| error | `YYError` | varargs, takes a format string |
| MSVC runtime | `_eh_vector_{ctor,dtor}_iterator`, eh helpers | unremarkable names in the map |

`docs/reverse-engineering.md` has the identified addresses for this build.

## The three rules that keep a port honest

Learned the hard way, in order of how much time they cost:

1. **A wrong shim looks like working software.** A comparison that returns a
   boolean, a multiply that reads a third argument, a vtable slot holding a
   sentinel: all three produced a running frame loop and unremarkable logs.
   Only call counts and per-room measurements exposed them.
2. **Never return zero from an indirect-call handler for a target you cannot
   resolve.** The guest will spin inside a single wasm frame, which no
   watchdog or debugger can interrupt. Throw instead.
3. **Measure the real rooms.** The boot room holds nothing but manager objects.
   Every metric computed only there — draw calls above all — is meaningless.
