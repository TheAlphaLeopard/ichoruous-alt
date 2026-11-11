# ichoruous web

The original Windows game **Ichorous** (GameMaker, x64) running in the browser — via
**static recompilation** of the shipped `Ichorous.exe` machine code to WebAssembly.
No emulator, no interpreter, no engine recreation: the lifted guest wasm *is* the
original game code, executing at native-ish speed against a thin browser host.

In the spirit of [gex](https://github.com/JackoProductions/gex) (x64 static recomp
→ wasm), adapted to a GameMaker runner:

```
Ichorous.exe (x64 PE) ──► offline recompiler (this repo, scripts/gex) ──► game.wasm + image.bin
data.win + audio groups ──► extractors ──► cartridge assets (sprites / sfx / world data)
                                                   │
browser host (src/lib/gex) ◄───────────────────────┘
  fetches artifacts, maps guest memory, provides ABI shims, canvas renderer,
  WebAudio, keyboard/mouse input, room stepping at 60 fps
```

- **5,555 functions** lifted from the exe's `.text` (function extents recovered from
  `.pdata` + a Ghidra script map, x64 decoded and lifted to wasm by hand-written
  tooling in `scripts/gex/isa.ts` + `lift.ts` + `wasm.ts`).
- The GML bytecode VM ships *inside* the guest: `data.win`'s bytecode is executed by
  the recompiled original runner, exactly like on Windows.
- Host side (`src/lib/gex/runtime.ts`) only implements the Win32/API ABI surface the
  runner imports (memory, timing, input state, draw/audio callbacks).

## Play it

```bash
bun install
bun run dev        # http://localhost:3000
```

or build a fully static site and host it anywhere:

```bash
bun run build      # emits ./out (GitHub Pages / Netlify / itch.io / nginx ...)
bun run serve      # quick local look at ./out
```

Controls: arrows / WASD to move, Z / J to attack (click the canvas once first).

### Optional: on-page download links

The index page shows two release-download links when zip files are deployed under
`public/_downloads/` (`ichoruous-web.zip`, `ichoruous-web-static.zip`). Drop any
files you want to offer there — with the folder absent or empty the links hide
themselves automatically.

## Repo layout

| Path | What |
| --- | --- |
| `src/lib/gex/runtime.ts` | Browser-side guest runtime: guest memory, calling convention, ABI shims, GML event dispatch |
| `src/lib/gex/boot.ts` | Artifact loading (gz-aware), canvas renderer, WebAudio, input, main loop |
| `src/app/page.tsx` | Minimal UI: title, progress bar, canvas |
| `public/gex/` | **Prebuilt recompilation output**: `game.wasm.gz`, `image.bin.gz`, `meta.json`, `builtins.json`, `objects.json`, `rooms.json` |
| `public/cartridge/` | Game assets: `game.json` (sprites/tpag/sounds), texture `pages/`, all **500 sfx/music** `sfx/`, `room_order.json` |
| `scripts/gex/` | The offline recompiler (see below) |
| `scripts/extract.mjs` | data.win → texture pages / cartridge JSON (needs bzip2) |
| `scripts/extract_audio.mjs` | data.win + audiogroup .dat → all 500 sound files |
| `docs/wasm-jit-case-study.md` | Research notes behind the architecture choice |

Raw `game.wasm` / `image.bin` are not committed (GitHub's 100 MB file limit); the
`.gz` versions are what the site and the pipeline ship.

## The recompiler (`scripts/gex/`)

| Script | Role |
| --- | --- |
| `pe.ts` | Minimal PE32+ parser (sections, `.pdata`, RVA→file offset) |
| `mine.ts` | Mines exact function extents + references from the exe (uses `data/ghidra_pass2_scriptmap.csv`) |
| `minetable.ts` | Cross-references mined call targets into a relocation/reftype table |
| `isa.ts` | Hand-written x64 instruction decoder (no external disassembler) |
| `lift.ts` | Lifts decoded x64 to the wasm op set; tracks ABI (rcx/rdx/r8/r9, xmm) |
| `wasm.ts` | Emits the wasm binary (types, memory, one export per lifted fn) |
| `image.ts` | Builds `image.bin` — the exe's sections mapped at the original image base + mined tables |
| `extractworld.ts` | data.win → `objects.json` (events → gml fns) and `rooms.json` (instances) |
| `build.ts` | Full pipeline: registry → image → lift → emit `game.wasm` + gz artifacts |
| `harness.ts` | Headless run (globalscripts → first room → 30 frames) for CI-style checks |
| `out-*.json` | Mined artifacts (function register order, call tables) consumed by `image.ts`/`lift.ts` |

Rebuild everything from original files (not included in this repo — add your own
`Ichorous.exe`, `data.win`, `audiogroup_music.dat`, `audiogroup_ambiance.dat`
under `upload/`):

```bash
bun scripts/gex/mine.ts          # exe → out-mining.json
bun scripts/gex/minetable.ts     # → out-reftable.json
bun scripts/gex/build.ts         # → public/gex/*  (5555 fns, few minutes)
bun scripts/gex/extractworld.ts  # data.win → objects.json, rooms.json
bun scripts/extract.mjs          # data.win → cartridge pages + game.json
bun scripts/extract_audio.mjs    # audio groups → public/cartridge/sfx/*
bun scripts/gex/harness.ts       # headless smoke test
```

## Notes

- `public/gex/game.wasm.gz` is ~7.8 MB (raw 108 MB), `image.bin.gz` ~9.9 MB (raw 48 MB);
  the host decompresses with `DecompressionStream` and falls back to the raw file.
- Sounds load lazily per name from `public/cartridge/sfx/`; the two audiogroup
  `.dat` files are parsed by `scripts/extract_audio.mjs` (OGG + a few RIFF WAV).
- Requires a browser with WebAssembly + `DecompressionStream` (Chrome/Edge/FF/Safari 16.4+).
