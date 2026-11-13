# What works, and what does not

A snapshot of where the port stands, how to reproduce every number in it, and
what is left. Read `docs/architecture.md` for *why* it is built this way and
`docs/gamemaker-runtime-model.md` for the GameMaker runtime model it
implements.

## Running the measurements

Everything here comes from two tools. Both need the original executable, which
is not in this repo:

```sh
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --filter=blob:none --no-checkout \
  https://github.com/TheAlphaLeopard/ichorousport.git /tmp/iport
(cd /tmp/iport && git cat-file blob HEAD:raw/Ichorous.exe > /home/user/fixtures/Ichorous.exe)
```

Note that `/home/user/fixtures` is outside the repo and does **not** survive
between sessions — it has to be re-fetched.

| command | what it tells you |
| ------- | ----------------- |
| `node --max-old-space-size=2048 tools/smoke.mjs 200` | boot health and frame timing in the boot room |
| `node --max-old-space-size=2048 tools/room-walk.mjs 10 12` | per-room: instances, draws, throws, wall time |
| `ISOLATE=1 node --max-old-space-size=1200 tools/room-walk.mjs 6` | one child process per room, so one bad room cannot kill the run |

`room-walk.mjs` is the one to trust. `smoke.mjs` only ever enters `rmInit`,
which holds nothing but manager objects and so reports zero draw calls no
matter how broken rendering is.

## Where it stands

Boot, 6 frames per room, one process per room:

| | |
| --- | --- |
| boot scripts | **498 ok, 0 threw, 0 timed out** (was 490 ok / 8 threw) |
| rooms that survive | **72 of 75** |
| rooms that draw something | **61** |
| mean draw calls per frame | **5.4** (peak 18.2 in `rmSqu_alorPlat4`) |
| frame throws | 0 across every surviving room |
| working set | 607 of 5555 lifted functions (10.9 %), RSS ~490 MB |
| frame time in a real room | p50 1 ms, p95 8 ms |

For comparison, before the work in PR #7: 24 rooms before the guest heap ran
out, and 0.1 draw calls per frame.

## What is known to be broken

**The three tutorial rooms run away.** `rmTutorial1`, `rmTutorial2` and
`rmTutorial3` never finish creating their instances. The loop is in an
`oMeatBlob` constructor: it builds a struct, binds a method to it, and repeats,
and since every struct is a fresh allocation nothing can be reused. It fails
identically with method dispatch switched off, so it is not caused by the
method work — it is the struct lifetime problem below, arriving early.

**Structs and methods are never freed.** This is the root cause and the next
piece of real work. The guest heap is a bump allocator with an 8 MB budget and
the decref shims are no-ops, so every `@@NewGMLObject@@` and every bound method
lives forever. A busy room asks for roughly 8k of these per frame. The real
runner survives on refcounting; this one has none.

**Unimplemented ABI imports:** 6419 calls across 149 distinct functions over a
12-room walk — most of the top of that list is the `0x140041xxx`–`0x140046xxx`
refcount and RValue family, which is the same family as the struct problem. See
`docs/reverse-engineering.md` for the ranked list.

**`dispatch: uncallable callee`:** ~1600 per walk, down from being the dominant
failure. The remainder are method values whose script could not be resolved.

## How a runaway is handled

A guest loop can only be stopped where it crosses into the host. Three layers,
in order:

1. `checkBudget` runs on every ABI import call. It compares against
   `eventBudgetMs` (250 ms) for event handlers and `roomBudgetMs` (5 s) for a
   room's creation code.
2. A handler that times out three times is added to `disabledFns` and never
   runs again, so one bad handler degrades one object rather than the game.
3. Anything that does all three of those no good — a loop that never calls the
   host at all — cannot be stopped from inside the process. `js/main.js`
   terminates the worker, and `room-walk.mjs --isolate` gives each room its own
   process.

Two bugs had been defeating all of this, and are worth remembering because
they are invisible until something spins: `callDepth` was only incremented by
`callGuest`, so anything reached through a script-to-script call ran with the
watchdog disarmed; and `dispatchFunction` caught every exception, *including
the watchdog's own timeout*.

## Not yet attempted

* **Refcounting.** The real fix for the memory problem. Needs incref/decref
  shims that track RValue payload lifetimes, which means getting the copy
  semantics exactly right — a premature free is worse than a leak.
* **Struct identity.** Members are stored per object pointer. If a struct is
  ever held as a handle rather than a pointer, reads and writes diverge and
  members come back undefined; a `NaN` from an unset member is the usual cause
  of a loop that never terminates. Worth checking before chasing any
  individual runaway.
* Surfaces, shaders, audio, and the save system are unimplemented.
