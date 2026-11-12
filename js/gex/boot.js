// gex boot — the game engine half of the port.
//
// Plain JavaScript, no framework and no build step. It runs unchanged in a
// worker (drawing to an OffscreenCanvas, audio proxied back to the main thread)
// or directly on the main thread as a fallback.
//
// Everything it loads is fetched relative to this module's own URL, so the site
// works at a domain root or at any sub-path without rewriting a single URL.
import { GMRunner } from "./runtime.js";

// js/gex/boot.js -> site root is two levels up.
export const BASE = new URL("../../", import.meta.url).pathname.replace(/\/+$/, "");

export const CANVAS_W = 320;
export const CANVAS_H = 180;

const asset = (p) => BASE + p;
const yieldToHost = () => new Promise((r) => setTimeout(r, 0));

// The guest ships as .gz (game.wasm is 107 MB raw); inflate on the fly and fall
// back to the raw file for local builds that skipped the gzip step.
async function fetchBin(path) {
  try {
    const res = await fetch(path + ".gz", { cache: "no-store" });
    if (res.ok && typeof DecompressionStream !== "undefined") {
      const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
  } catch { /* fall through to the raw artifact */ }
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
  return new Uint8Array(await res.arrayBuffer());
}

const fetchJson = async (path) => {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
  return res.json();
};

export async function loadArtifacts(onProgress = () => {}) {
  onProgress({ stage: "loading recompiled game code", pct: 5 });
  const [wasmBuf, imageBuf, meta, builtins, objects, rooms, game, tpag] = await Promise.all([
    fetchBin(asset("/gex/game.wasm")),
    fetchBin(asset("/gex/image.bin")),
    fetchJson(asset("/gex/meta.json")),
    fetchJson(asset("/gex/builtins.json")),
    fetchJson(asset("/gex/objects.json")),
    fetchJson(asset("/gex/rooms.json")),
    fetchJson(asset("/cartridge/game.json")),
    fetchJson(asset("/cartridge/tpag.json")),
  ]);

  onProgress({ stage: "loading texture pages", pct: 22 });
  const textures = game.textures ?? [];
  const pages = [];
  for (let i = 0; i < textures.length; i++) {
    const res = await fetch(asset("/cartridge/" + textures[i].file));
    if (!res.ok) throw new Error("texture " + textures[i].file + " -> HTTP " + res.status);
    pages.push(await createImageBitmap(await res.blob()));
    onProgress({ stage: `texture page ${i + 1}/${textures.length}`, pct: 22 + ((i + 1) * 14) / Math.max(1, textures.length) });
  }

  const roomOrder = await fetchJson(asset("/cartridge/room_order.json"));
  return { wasmBuf, imageBuf, meta, builtins, objects, rooms, game, tpag, pages, roomOrder };
}

function buildRenderer(ctx, tpag, pages) {
  const colorOf = (c) => "#" + (c & 0xffffff).toString(16).padStart(6, "0");
  const base = {
    drawSprite(_name, tpagIdx, x, y, xs, ys, rot, alpha, _blend) {
      const t = tpag[tpagIdx];
      if (!t || !pages[t.tex]) return;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.translate(x, y);
      if (rot) ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(pages[t.tex], t.sx, t.sy, t.sw, t.sh, 0, 0, t.sw * xs, t.sh * ys);
      ctx.restore();
    },
    clear(color) { ctx.fillStyle = colorOf(color); ctx.fillRect(0, 0, CANVAS_W, CANVAS_H); },
    rect(x1, y1, x2, y2, fill, color, alpha) {
      ctx.globalAlpha = alpha; ctx.fillStyle = colorOf(color);
      if (fill) ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      else ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1, y2 - y1);
      ctx.globalAlpha = 1;
    },
    circle(x, y, r, fill, color, alpha) {
      ctx.globalAlpha = alpha; ctx.fillStyle = colorOf(color);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      if (fill) ctx.fill(); else ctx.stroke();
      ctx.globalAlpha = 1;
    },
    line(x1, y1, x2, y2, color, alpha) {
      ctx.globalAlpha = alpha; ctx.strokeStyle = colorOf(color);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.globalAlpha = 1;
    },
    text(x, y, s, color, alpha, halign = 0, valign = 0) {
      ctx.globalAlpha = alpha; ctx.fillStyle = colorOf(color);
      ctx.font = "8px monospace";
      ctx.textAlign = halign === 1 ? "center" : halign === 2 ? "right" : "left";
      ctx.textBaseline = valign === 1 ? "middle" : valign === 2 ? "bottom" : "top";
      ctx.fillText(s, x, y);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.globalAlpha = 1;
    },
  };
  return base;
}

// ---------------------------------------------------------------- input -----
const keyMap = (code) => {
  if (code.startsWith("Key")) return code.charCodeAt(3);
  if (code.startsWith("Digit")) return code.charCodeAt(5);
  switch (code) {
    case "ArrowLeft": return 37;
    case "ArrowRight": return 39;
    case "ArrowUp": return 38;
    case "ArrowDown": return 40;
    case "Space": return 32;
    case "Enter": return 13;
    case "ShiftLeft": case "ShiftRight": return 16;
    case "ControlLeft": case "ControlRight": return 17;
    case "Escape": return 27;
    case "Backspace": return 8;
    case "Tab": return 9;
    default: return 0;
  }
};

export function keyDown(runner, code) {
  const k = keyMap(code);
  if (!k) return false;
  if (!runner.keyboard.has(k)) runner.keyboardPressed.add(k);
  runner.keyboard.add(k);
  runner.lastKey = k;
  return true;
}
export function keyUp(runner, code) {
  const k = keyMap(code);
  if (!k) return false;
  runner.keyboardReleased.add(k);
  runner.keyboard.delete(k);
  return true;
}
export function mouseMove(runner, x, y) { runner.mousePos = { x, y }; }
export function mouseDown(runner, button) {
  if (!runner.mouseButtons.has(button)) runner.mousePressed.add(button);
  runner.mouseButtons.add(button);
}
export function mouseUp(runner, button) {
  runner.mouseReleased.add(button);
  runner.mouseButtons.delete(button);
}
// Convert a DOM mouse event on a scaled canvas into guest coordinates.
export function canvasPos(canvas, clientX, clientY, width = CANVAS_W, height = CANVAS_H) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((clientX - r.left) / (r.width || 1)) * width,
    y: ((clientY - r.top) / (r.height || 1)) * height,
  };
}

// ----------------------------------------------------------------- boot -----
// Global scripts whose bodies hang when executed with an unbound `self`.
// Verified by bisecting the boot sequence: world_pos_to_gui spins inside a
// single wasm function with no host calls, so nothing can interrupt it.
const KNOWN_HANGING = ["gml_GlobalScript_world_pos_to_gui"];

export async function createGame({ canvas, audio, onProgress = () => {}, skipList = [], isWorker = false }) {
  const report = onProgress;
  const art = await loadArtifacts(report);

  report({ stage: "compiling WebAssembly (" + art.meta.fns.length + " lifted functions)", pct: 40 });
  await yieldToHost();
  const runner = new GMRunner();
  await runner.boot(art.wasmBuf, art.imageBuf, art.meta, art.builtins);

  report({ stage: "loading world", pct: 55 });
  await yieldToHost();
  const sprites = art.game.sprites.map((s) => ({
    name: s.name, w: s.w, h: s.h,
    ox: s.origin?.[0] ?? 0, oy: s.origin?.[1] ?? 0,
    speed: s.speed, speedType: s.speedType, frames: s.frames,
  }));
  const roomIdxByName = new Map(art.rooms.map((r, i) => [r.name, i]));
  const order = art.roomOrder.map((ro) => roomIdxByName.get(ro.room)).filter((i) => i !== undefined);
  runner.loadWorld(sprites, art.objects, art.rooms, order, art.game.sounds.map((s) => s.name));

  // renderer: canvas 2d, sprite origins handled the way GameMaker draws them
  const ctx = canvas.getContext("2d", { alpha: false });
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  ctx.imageSmoothingEnabled = false;
  const renderer = buildRenderer(ctx, art.tpag, art.pages);
  const spriteByName = new Map(sprites.map((s) => [s.name, s]));
  runner.renderer = {
    ...renderer,
    drawSprite(name, frame, x, y, xs, ys, rot, alpha, blend) {
      const s = spriteByName.get(name);
      renderer.drawSprite(name, frame, x - (s?.ox ?? 0) * xs, y - (s?.oy ?? 0) * ys, xs, ys, rot, alpha, blend);
    },
  };
  runner.audio = audio ?? null;

  // ---- boot scripts (GMS runs script-file top-level code once at startup) ----
  const skip = new Set([...KNOWN_HANGING, ...skipList]);
  const globalInst = runner.createInstance(
    Math.max(0, art.objects.findIndex((o) => o.name === "__InputUpdateController")), 0, 0);
  runner.globalInstPtr = globalInst.guestPtr;

  const scripts = runner.meta.fns.filter((f) => f.n.startsWith("gml_GlobalScript_"));
  let done = 0;
  let skipped = 0;
  for (const f of scripts) {
    if (skip.has(f.n)) { skipped++; continue; }
    // Report before running: if this call never returns, the host knows exactly
    // which script to skip next time.
    if (done % 16 === 0) {
      report({ stage: `running boot scripts ${done}/${scripts.length}`, pct: 60 + (done * 30) / scripts.length, at: f.n });
      await yieldToHost();
    }
    try {
      runner.budgetMs = 3000;
      runner.callGuest(f.n, globalInst.guestPtr, 0, runner.guest.alloc(16, 16), 0);
    } catch (e) {
      runner.log("globalscript " + f.n + ": " + String(e && e.message).slice(0, 140));
    } finally {
      runner.budgetMs = 0;
    }
    done++;
  }
  if (skipped) runner.log("skipped " + skipped + " boot script(s): " + [...skip].join(", "));

  report({ stage: "entering first room", pct: 92, at: null });
  await yieldToHost();
  runner.budgetMs = 5000;
  try { runner.gotoRoom(order[0]); } finally { runner.budgetMs = 0; }

  report({ stage: "running", pct: 100, at: null });
  return { runner, scripts: scripts.map((f) => f.n), skipped };
}

// ----------------------------------------------------------------- loop -----
// Fixed-ish timestep loop. `schedule` is injected so this works with rAF on the
// main thread and with setTimeout inside a worker (workers have no rAF).
export function startLoop(runner, { schedule, onFrame, onError }) {
  let stopped = false;
  let last = (typeof performance !== "undefined" ? performance.now() : Date.now());
  let fpsAcc = 0, fpsN = 0, lastFps = last;

  const tick = () => {
    if (stopped) return;
    schedule(tick);
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const dt = now - last;
    last = now;
    if (dt > 0) {
      // Cap the step so a slow frame (or a backgrounded tab) can't teleport the
      // player across the room when we come back.
      runner.lastDeltaUs = Math.min(dt * 1000, 100000);
      fpsAcc += dt; fpsN++;
      if (now - lastFps > 500) {
        runner.measuredFps = Math.round(1000 / (fpsAcc / fpsN));
        fpsAcc = 0; fpsN = 0; lastFps = now;
        if (onFrame) onFrame(runner.measuredFps);
      }
    }
    try {
      runner.stepFrame();
    } catch (e) {
      if (onError) onError(e);
      else throw e;
    }
  };
  schedule(tick);
  return () => { stopped = true; };
}
