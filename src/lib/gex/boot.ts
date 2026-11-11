// gex boot: loads the prebuilt guest (game.wasm + memory image + world data),
// wires the canvas renderer, WebAudio and input, and runs the game loop.
"use client";
import { GMRunner, type SpriteDef, type ObjectDef } from "./runtime";

export interface BootProgress { stage: string; pct: number }

const CANVAS_W = 320, CANVAS_H = 180;

// Load a binary artifact, preferring the pre-gzipped variant (the recompiler
// ships game.wasm/image.bin as .gz to stay under repo/hosting size limits),
// falling back to the raw file for local builds that skipped gzipping.
async function fetchBin(path: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const res = await fetch(path + ".gz", { cache: "no-store" });
    if (res.ok && typeof DecompressionStream !== "undefined") {
      const stream = (await res.blob()).stream().pipeThrough(new DecompressionStream("gzip"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
  } catch { /* fall back to raw below */ }
  const res = await fetch(path, { cache: "no-store" });
  return new Uint8Array(await res.arrayBuffer());
}

function scaleCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const availW = canvas.parentElement?.clientWidth ?? window.innerWidth;
  const availH = window.innerHeight - 120;
  const scale = Math.max(1, Math.min(Math.floor(Math.min(availW / CANVAS_W, availH / CANVAS_H) * dpr) / dpr, 4));
  canvas.style.width = `${CANVAS_W * scale}px`;
  canvas.style.height = `${CANVAS_H * scale}px`;
}

export async function bootGame(
  canvas: HTMLCanvasElement,
  onProgress: (p: BootProgress) => void,
): Promise<{ runner: GMRunner; stop: () => void }> {
  onProgress({ stage: "loading recompiled game code", pct: 5 });
  const [wasmBuf, imageBuf, metaBuf, builtinsBuf, objectsBuf, roomsBuf, gameBuf, tpagBuf] = await Promise.all([
    fetchBin("/gex/game.wasm"),
    fetchBin("/gex/image.bin"),
    fetch("/gex/meta.json", { cache: "no-store" }).then((r) => r.json()),
    fetch("/gex/builtins.json").then((r) => r.json()),
    fetch("/gex/objects.json").then((r) => r.json()),
    fetch("/gex/rooms.json").then((r) => r.json()),
    fetch("/cartridge/game.json").then((r) => r.json()),
    fetch("/cartridge/tpag.json").then((r) => r.json()),
  ]);
  onProgress({ stage: "loading texture pages", pct: 25 });
  const pages: ImageBitmap[] = [];
  const textures = gameBuf.textures as { file: string }[];
  for (let i = 0; i < textures.length; i++) {
    const res = await fetch("/cartridge/" + textures[i].file);
    pages.push(await createImageBitmap(await res.blob()));
    onProgress({ stage: `texture page ${i + 1}/${textures.length}`, pct: 25 + (i + 1) * 5 });
  }

  onProgress({ stage: "compiling WebAssembly (5,555 lifted functions)", pct: 55 });
  const runner = new GMRunner();
  await runner.boot(wasmBuf, imageBuf, metaBuf, builtinsBuf);

  onProgress({ stage: "loading world (75 rooms, 340 objects)", pct: 75 });
  // sprites: merge cartridge sprite metadata with tpag frames
  const sprites: SpriteDef[] = (gameBuf.sprites as SpriteDef[]).map((s) => ({
    name: s.name, w: s.w, h: s.h,
    ox: (s as unknown as { origin: [number, number] }).origin?.[0] ?? 0,
    oy: (s as unknown as { origin: [number, number] }).origin?.[1] ?? 0,
    speed: s.speed, speedType: s.speedType, frames: s.frames,
  }));
  const objects = objectsBuf as ObjectDef[];
  const roomsRaw = roomsBuf as { name: string; w: number; h: number; speed: number; instances: { obj: number; x: number; y: number }[] }[];
  const roomOrder = (await fetch("/cartridge/room_order.json").then((r) => r.json())) as { order: number; room: string }[];
  const roomIdxByName = new Map(roomsRaw.map((r, i) => [r.name, i]));
  const order = roomOrder.map((ro) => roomIdxByName.get(ro.room) ?? -1).filter((i) => i >= 0);
  const soundNames = (gameBuf.sounds as { name: string }[]).map((s) => s.name);
  runner.loadWorld(sprites, objects, roomsRaw, order, soundNames);

  // ---------- renderer ----------
  const ctx = canvas.getContext("2d", { alpha: false })!;
  canvas.width = CANVAS_W; canvas.height = CANVAS_H;
  ctx.imageSmoothingEnabled = false;
  scaleCanvas(canvas);
  window.addEventListener("resize", () => scaleCanvas(canvas));

  const colorOf = (c: number): string => "#" + (c & 0xffffff).toString(16).padStart(6, "0");
  runner.renderer = {
    drawSprite(_name, tpagIdx, x, y, xs, ys, rot, alpha, blend) {
      const t = (tpagBuf as { sx: number; sy: number; sw: number; sh: number; tex: number }[])[tpagIdx];
      if (!t || !pages[t.tex]) return;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.translate(x, y);
      if (rot) ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(pages[t.tex], t.sx, t.sy, t.sw, t.sh, 0, 0, t.sw * xs, t.sh * ys);
      void blend;
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
    text(x, y, s, color, alpha) {
      ctx.globalAlpha = alpha; ctx.fillStyle = colorOf(color);
      ctx.font = "8px monospace";
      ctx.fillText(s, x, y);
      ctx.globalAlpha = 1;
    },
  };

  // sprite origin handling: wrap drawSprite to subtract origin
  const spriteByName = new Map(sprites.map((s) => [s.name, s]));
  const baseRenderer = runner.renderer!;
  const wrapped = {
    ...baseRenderer,
    drawSprite(name: string, frame: number, x: number, y: number, xs: number, ys: number, rot: number, alpha: number, blend: number) {
      const s = spriteByName.get(name);
      const ox = s?.ox ?? 0, oy = s?.oy ?? 0;
      // runner passes instance position; GameMaker draws at (x - ox, y - oy)
      baseRenderer.drawSprite(name, frame, x - ox * xs, y - oy * ys, xs, ys, rot, alpha, blend);
    },
  };
  runner.renderer = wrapped;

  // ---------- audio ----------
  const audioCtx = new AudioContext();
  const audioBuffers = new Map<string, AudioBuffer>();
  const playing = new Map<string, AudioBufferSourceNode[]>();
  runner.audio = {
    play(name, loop, vol) {
      const buf = audioBuffers.get(name);
      if (!buf) return;
      const src = audioCtx.createBufferSource();
      src.buffer = buf; src.loop = loop;
      const gain = audioCtx.createGain();
      gain.gain.value = Math.max(0, Math.min(1, vol));
      src.connect(gain).connect(audioCtx.destination);
      src.start();
      const list = playing.get(name) ?? [];
      list.push(src);
      playing.set(name, list);
      src.onended = () => { const l = playing.get(name); if (l) playing.set(name, l.filter((s2) => s2 !== src)); };
    },
    stop(name) { for (const s of playing.get(name) ?? []) { try { s.stop(); } catch { /* already stopped */ } } playing.set(name, []); },
    stopAll() { for (const l of playing.values()) for (const s of l) { try { s.stop(); } catch { /* already stopped */ } } playing.clear(); },
  };
  // lazily load the sounds that were extracted
  const soundIndexByName = new Map(soundNames.map((n, i) => [n, i]));
  const loadSound = async (name: string) => {
    if (audioBuffers.has(name)) return;
    try {
      let res = await fetch(`/cartridge/sfx/${name}.ogg`);
      if (!res.ok) res = await fetch(`/cartridge/sfx/${name}.wav`); // a few sounds ship as RIFF wav
      if (!res.ok) return;
      audioBuffers.set(name, await audioCtx.decodeAudioData(await res.arrayBuffer()));
    } catch { /* not extracted — skip */ }
  };
  const origPlaySound = runner.audio.play.bind(runner.audio);
  runner.audio.play = (name, loop, vol) => { void loadSound(name).then(() => origPlaySound(name, loop, vol)); };

  // ---------- input ----------
  const keyMap = (code: string): number => {
    if (code.startsWith("Key")) return code.charCodeAt(3);
    if (code.startsWith("Digit")) return code.charCodeAt(5);
    if (code === "ArrowLeft") return 37; if (code === "ArrowRight") return 39;
    if (code === "ArrowUp") return 38; if (code === "ArrowDown") return 40;
    if (code === "Space") return 32; if (code === "Enter") return 13;
    if (code === "ShiftLeft" || code === "ShiftRight") return 16;
    if (code === "ControlLeft" || code === "ControlRight") return 17;
    if (code === "Escape") return 27;
    if (code === "Backspace") return 8;
    if (code === "Tab") return 9;
    return 0;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const k = keyMap(e.code);
    if (k) { e.preventDefault(); if (!runner.keyboard.has(k)) runner.keyboardPressed.add(k); runner.keyboard.add(k); runner.lastKey = k; }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const k = keyMap(e.code);
    if (k) { e.preventDefault(); runner.keyboardReleased.add(k); runner.keyboard.delete(k); }
  };
  const toGame = (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * CANVAS_W, y: ((e.clientY - r.top) / r.height) * CANVAS_H };
  };
  const onMouseMove = (e: MouseEvent) => { runner.mousePos = toGame(e); };
  const onMouseDown = (e: MouseEvent) => { const p = toGame(e); runner.mousePos = p; if (!runner.mouseButtons.has(e.button)) runner.mousePressed.add(e.button); runner.mouseButtons.add(e.button); };
  const onMouseUp = (e: MouseEvent) => { runner.mouseReleased.add(e.button); runner.mouseButtons.delete(e.button); };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);

  // ---------- boot the game ----------
  onProgress({ stage: "running boot scripts", pct: 85 });
  // the "global" instance context for script registration
  const globalInst = runner.createInstance(objects.findIndex((o) => o.name === "__InputUpdateController") >= 0 ? objects.findIndex((o) => o.name === "__InputUpdateController") : 0, 0, 0);
  for (const f of runner.meta.fns) {
    if (f.n.startsWith("gml_GlobalScript_")) {
      try { runner.callGuest(f.n, globalInst.guestPtr, 0, runner.guest.alloc(16, 16), 0); }
      catch (e) { runner.log("globalscript " + f.n + ": " + String(e).slice(0, 120)); }
    }
  }
  onProgress({ stage: "entering first room", pct: 92 });
  runner.gotoRoom(order[0]);

  // ---------- main loop ----------
  onProgress({ stage: "running", pct: 100 });
  let raf = 0;
  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, lastT = last;
  let stopped = false;
  const loop = (t: number) => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    const dt = t - last;
    last = t;
    if (dt > 0) {
      runner.lastDeltaUs = Math.min(dt * 1000, 100000);
      fpsAcc += dt; fpsN++;
      if (t - lastT > 500) { runner.measuredFps = Math.round(1000 / (fpsAcc / fpsN)); fpsAcc = 0; fpsN = 0; lastT = t; }
    }
    runner.stepFrame();
  };
  raf = requestAnimationFrame(loop);

  return {
    runner,
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mouseup", onMouseUp);
    },
  };
}
