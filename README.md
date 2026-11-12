# ichoruous web

The original Windows game **Ichorous** (GameMaker, x64) running in the browser via
**static recompilation** of the shipped `Ichorous.exe` machine code to WebAssembly.
No emulator, no interpreter, no engine recreation — and, since this rewrite, no
TypeScript, no Next.js, no framework and no build step. It is a folder of plain
HTML, CSS, JavaScript, JSON and `.wasm`; open it and it runs.

## Run it

```bash
npm start          # serves this folder at http://localhost:8080
```

Or point any static server at the folder — `python3 -m http.server`, nginx, S3,
`npx serve`. There is nothing to install and nothing to compile: the `npm start`
script is 40 lines of `node:http` in `tools/serve-static.mjs`.

To deploy on GitHub Pages: **Settings → Pages → Deploy from a branch → `main` /
`/ (root)`**. `.nojekyll` is committed so Jekyll doesn't eat files it thinks are
special. The site figures out its own base path from `import.meta.url`, so it
works at a domain root or under `/<repo>/` with no rewriting.

## Layout

```
index.html            the page
css/style.css         styles
js/main.js            page shell: worker lifecycle, watchdog, input, audio
js/game-worker.js     the game, off the main thread
js/gex/boot.js        engine: fetch artifacts, boot the guest, wire renderer/audio/input
js/gex/runtime.js     the runner shim (RValue protocol, builtins, events, drawing)
gex/                  game.wasm.gz, image.bin.gz, meta.json, builtins.json, objects.json, rooms.json
cartridge/            game.json, tpag.json, room_order.json, texture pages, 500 sfx
tools/                dev tooling (see below)
docs/                 write-up of the recompilation approach
```

## Why the game runs in a worker

Some recompiled guest code enters a loop that never calls back into the host —
`gml_GlobalScript_world_pos_to_gui` does exactly that once the other boot scripts
have run. A WebAssembly frame that never returns cannot be interrupted from
JavaScript: not by a promise, not by a timer, not even by a signal (the old build
would hang the tab so hard that even SIGINT to Node went unhandled).

So the guest lives in `js/game-worker.js`, and `js/main.js` watches it:

- **Cooperative budget.** Hot ABI entries check a deadline every 1024th call and
  throw, which unwinds out of the wasm frames. Catches loops that *do* call the host.
- **Event circuit breaker.** A step/draw handler that times out three times is
  switched off for the session instead of hanging every frame.
- **Worker watchdog.** If the worker goes silent, the main thread terminates it,
  records the boot script it died on in `localStorage`, and relaunches without
  that script. A hang becomes a one-time stutter plus a permanent workaround.
- **Fallback.** Without workers or `OffscreenCanvas` the same engine runs on the
  main thread (no watchdog, but it works).

## Verifying it

```bash
npm run smoke          # boots the guest headlessly and runs 300 frames
npm run verify:loader  # serves the folder and checks every artifact the page fetches
```

`tools/smoke.mjs` is the regression test for the freeze: it fails if a boot script
hangs, if any frame throws, if the slowest frame exceeds 500 ms, or if the guest
heap grows more than 4 MB across the run.

Current numbers (Node 22, 200 frames): boot scripts 1.6 s, median frame 0.0 ms,
worst frame 1.0 ms, guest heap flat. Before the rewrite the boot never completed.

## Known limits

This is a work in progress and the rewrite did not change where it stands: the
game boots, loads every artifact, enters its first room and then **stalls in
`rmInit`** — six manager objects step forever and nothing is drawn.

The shim is missing pieces of the GameMaker runner, not of the web port:

- ~15 runner ABI functions are unimplemented (the busiest are at `0x14128ab40`,
  `0x14128aa70`, `0x14040fdc0`, `0x140e64380`) — they are not lifted GML, they are
  internals of the original runner that still need to be reverse-engineered.
- GMS 2.3 **method dispatch** is unsupported, so calls like `__state()`,
  `target()`, `uiClick()` log "unknown function" and return undefined.
- 42 of the 499 boot scripts throw when executed with an unbound `self` (caught
  and logged; they are mostly script registration).

None of these hang or crash any more — they are correctness gaps. Say the word and
I will start on the ABI functions.

## Tools

| Command | What it does |
| --- | --- |
| `npm start` | static server for the site (`--base` mirrors a sub-path deploy) |
| `npm run smoke` | headless boot + frame loop, fails on hangs/throws/leaks |
| `npm run verify:loader` | serves the folder, checks every artifact the page fetches |
| `node tools/gex/harness.js` | boot + 30 frames with per-event failure stats |
| `node tools/gex/build.js` | the recompiler: `Ichorous.exe` → `gex/game.wasm` + `image.bin` |
| `node tools/extract.mjs` | `data.win` → cartridge (sprites, world data) |

The recompiler under `tools/gex/` was mechanically transpiled from TypeScript along
with the rest of the repo and is **untested** — it needs your own `Ichorous.exe`
and `data.win` under `upload/`, which are not distributed here.
