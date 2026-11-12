# Why this port is built the way it is

Written after studying two working GameMaker web ports
([diceamillion](https://github.com/NotRexed/Unblocked-Games/tree/main/diceamillion)
and [deltarune](https://github.com/NotRexed/Unblocked-Games/tree/main/deltarune),
both in NotRexed/Unblocked-Games) and comparing them to this one.

## What those ports actually are

`diceamillion` ships:

```
runner.json     {"runner": {"version": "2024.14.3.260", "yyc": false}}
runner.js       Emscripten glue (154 KB)
runner.wasm     the GameMaker runner, compiled to wasm (5.7 MB)
runner.data     Emscripten preload bundle (18 MB)
game.unx        the game's data file, GML bytecode included (10 MB)
snd.dat/mus.dat external audio groups
audio-worklet.js, index.html
```

That is a stock GameMaker **HTML5** export. `"yyc": false` is the important line:
the game's GML is shipped as *bytecode*, and the runner compiled by YoYo Games
interprets it. The port's job is only packaging and hosting — every GML
semantic (structs, methods, `ds_*`, buffers, surfaces, save data) is already
implemented, correctly, by the runner they shipped.

`deltarune` is the older flavour of the same thing: per-chapter HTML5 exports
where the GML has been transpiled to JavaScript and runs against the HTML5
runner's runtime library.

So the pattern is: **complete runner + game data, nothing reimplemented.**

## Why we cannot copy it

Our game is a **YYC** build: the GML was compiled to x64 machine code and baked
into `Ichorous.exe`. Verified by parsing `data.win`:

```
FORM (little-endian size)  chunks: GEN8 SPRT OBJT ROOM STRG TXTR AUDO FUNC
                           no CODE chunk, no VARI chunk
```

No `CODE` chunk means there is no GML bytecode anywhere in the distribution.
The only executable form of this game's logic is the x64 machine code in the
exe — which is exactly what `tools/gex/` lifts to wasm. There is no data file
we could hand to the official HTML5 runner, and no bytecode for an independent
interpreter to run.

That settles the architecture: the lifted guest stays, and the work is making
the shim as complete as the runner YoYo ships.

## The shim, measured

The lifted wasm imports every function it could not lift as `abi.f<address>`
(the MSVC runtime and the GameMaker runner internals). `tools/gex/out-mining.json`
lists 281 of them with call counts.

| | count |
| --- | --- |
| runner functions in the exe | 281 |
| implemented in `js/gex/runtime.js` | 26 |
| still stubs returning 0 | 255 |
| named GML builtins dispatched by name | ~200 (works) |

The implemented ones cover the hot paths — `RValue_Free` (84k calls),
`CopyAssign` (33k), `CallFunction`, temp slots — which is why the game boots
and steps at all. The remaining 255 take ~35k calls during boot plus 60 frames,
and each one silently returns 0.

## Bugs found by studying it

1. **Indirect calls pass RVAs, not VAs.** The guest stores some function
   pointers as 32-bit offsets from the image base. `icall_reg` compared them
   against full virtual addresses, so calls to e.g. `RValue_Free` (passed as
   `0x41a50`, real address `0x1400041a50`) threw "unknown fn ptr" and aborted
   the calling GML script. Fixed by rebasing small values, and by letting
   `icall_reg` reach both lifted functions and the shim's own ABI entries.
   Failing boot scripts: 42 → 35.
2. **MSVC vector ctor/dtor iterators were stubs.** `f14128ab40` /
   `f14128aa70` (5,460 calls) build and destroy arrays of `RValue`s. With them
   stubbed, every element of a GML array literal was left as stack garbage.
   Implemented.

## Tooling added for the rest of the job

| Tool | Use |
| --- | --- |
| `tools/probe-abi.mjs` | run the game headlessly, dump the arguments each unimplemented function is called with |
| `tools/disas.mjs` | disassemble the original exe at a VA, annotating call targets and strings (needs `$ICHOROUS_EXE`) |
| `tools/smoke.mjs` | regression test: boot + frames, fails on hangs, throws, leaks |

Known-unidentified, by call count: `f140e87930` (reads `RValue` type at
`[rcx+0xc] & 0xffffff`, 16-way switch — a value-conversion helper), `f140e86fa0`
(instance variable fetch: `self` in rcx, index in rdx), `f140e63aa0` (compares
against 100000 — id → instance lookup), `f140e4cd60` (thin tail-call thunk to
`f140e66080`), `f140e632c0` (large, stack cookie — probably the
call-a-GML-function helper).

## Ideas worth taking from the reference ports

They are host-side, cheap, and independent of the runner:

- **Audio worklet mixing** (`audio-worklet.js`): one worklet with a mixer
  instead of a `BufferSource` per sound. Better for a game that layers dozens
  of sounds. Our per-sound node approach works but will stutter under load.
- **Manifest + checked preload**: `runner.json` lists files and MD5s, and the
  loader shows real progress. Ours reports progress but doesn't verify.
- **Save data**: GameMaker games expect working file I/O; the reference runner
  maps it to IndexedDB/localStorage. Our shim will need the same for
  `ini_open`/`file_text_*`/`ds_map_secure_save` before the game can save.
