# ichoruous web

**Play it: <https://thealphaleopard.github.io/ichoruous-alt/>**

The original Windows game **Ichorous** (GameMaker, x64) running in the browser, via
**static recompilation** of the shipped `Ichorous.exe` machine code to WebAssembly.
No emulator, no interpreter, no engine recreation — no server either. The site is a
plain folder of static files; any host that serves files can serve it.

## Layout

```
/                 the static build — this is what GitHub Pages serves
├── index.html    the game (loads gex/game.wasm.gz + cartridge/*)
├── _next/        Next.js export chunks
├── gex/          recompiled guest: game.wasm.gz, image.bin.gz, meta.json, …
├── cartridge/    extracted assets: texture pages, 500 sfx, room order
├── downloads.html
└── .nojekyll     keeps Jekyll from eating _next/

port/             the Next.js + TypeScript source that produces the above
tools/            set-base-path.mjs, serve-static.mjs
```

The `port/` directory is the buildable source (kept, just not what's served):
`port/src` is the browser host/runtime, `port/scripts` is the offline recompiler
toolchain that turns `Ichorous.exe` into `public/gex/*`. See
[port/README.md](port/README.md) for the technical write-up.

## Serving it locally

```bash
node tools/serve-static.mjs . --port 8080 --base /ichoruous-alt
# http://localhost:8080/ichoruous-alt/
```

That mirrors the Pages layout (the site lives at `/ichoruous-alt/`, not a domain
root). Drop `--base` to serve straight from `/`.

## Deploying

GitHub Pages is enabled for this repo: **Settings → Pages → Deploy from a branch →
`main` / root**. Pushing to `main` publishes. `.nojekyll` is required — without it
Jekyll strips `_next/` and the page comes up blank.

To host anywhere else (Netlify, itch.io, nginx, S3…), upload the repo root as-is.

## Changing where it's hosted

The export writes absolute URLs (`/_next/…`, `/gex/game.wasm.gz`), so moving the
site to a different sub-path needs a rebase:

```bash
node tools/set-base-path.mjs /new-path   # or "" to serve from a domain root
```

It's idempotent and records the current prefix in `tools/.base-path`.
