// Page shell: owns the DOM, the worker lifecycle, input and audio.
//
// The guest runs in a worker (see js/game-worker.js) because a hung WebAssembly
// frame cannot be interrupted — only terminated. This file watches for
// silence from the worker, and if the guest hangs it kills the worker, records
// which boot script did it in localStorage, and relaunches without that script.
// If workers or OffscreenCanvas are missing, it falls back to running the same
// engine on the main thread.
const BASE = new URL("../", import.meta.url).pathname.replace(/\/+$/, "");
const CANVAS_W = 320;
const CANVAS_H = 180;
const SKIP_KEY = "ichorous.skipScripts";
const MAX_RETRIES = 4;

const el = (id) => document.getElementById(id);
const canvas = el("game");
const overlay = el("overlay");
const barFill = el("bar-fill");
const statusEl = el("status");
const hintEl = el("hint");
const errorEl = el("error");
const diagEl = el("diag");

document.querySelector('link[rel="icon"]')?.remove();
const icon = document.createElement("link");
icon.rel = "icon";
icon.href = BASE + "/logo.svg";
document.head.appendChild(icon);

const state = {
  mode: "worker", // or "main"
  worker: null,
  runner: null,
  stopLoop: null,
  retries: 0,
  startedAt: performance.now(),
  booted: false,
  lastAt: null,
  watchdog: 0,
};

function setStatus(text, pct) {
  if (text != null) statusEl.textContent = text;
  if (pct != null) barFill.style.width = Math.min(100, Math.max(0, pct)) + "%";
}

function showError(html) {
  errorEl.hidden = false;
  errorEl.textContent = html;
}

function loadSkipList() {
  try { return JSON.parse(localStorage.getItem(SKIP_KEY) ?? "[]"); } catch { return []; }
}
function saveSkipList(list) {
  try { localStorage.setItem(SKIP_KEY, JSON.stringify(list)); } catch { /* private mode */ }
}

// --------------------------------------------------------------- canvas -----
function scaleCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const availW = (canvas.parentElement?.clientWidth || window.innerWidth) - 2;
  const availH = window.innerHeight - 190;
  const raw = Math.min(availW / CANVAS_W, availH / CANVAS_H);
  const scale = Math.max(1, Math.min(Math.floor(raw * dpr) / dpr, 4));
  canvas.style.width = Math.round(CANVAS_W * scale) + "px";
  canvas.style.height = Math.round(CANVAS_H * scale) + "px";
}
window.addEventListener("resize", scaleCanvas);
scaleCanvas();

// ---------------------------------------------------------------- audio -----
// Sounds are fetched and decoded on demand (500 of them, ~30 MB total) and
// cached, so the first play of a sound costs one fetch instead of stalling the
// boot on all of them.
const audio = (() => {
  let ctx = null;
  const buffers = new Map();
  const pending = new Map();
  const playing = new Map();

  const ensure = () => {
    if (!ctx) ctx = new (window.AudioContext ?? window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  const unlock = () => { try { ensure(); } catch { /* no audio device */ } };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });

  async function load(name) {
    if (buffers.has(name)) return buffers.get(name);
    let p = pending.get(name);
    if (p) return p;
    p = (async () => {
      for (const ext of ["ogg", "wav"]) {
        try {
          const res = await fetch(`${BASE}/cartridge/sfx/${name}.${ext}`);
          if (!res.ok) continue;
          const buf = await ensure().decodeAudioData(await res.arrayBuffer());
          buffers.set(name, buf);
          pending.delete(name);
          return buf;
        } catch { /* try the next extension */ }
      }
      pending.delete(name);
      return null;
    })();
    pending.set(name, p);
    return p;
  }

  return {
    play(name, loop, vol) {
      load(name).then((buf) => {
        if (!buf) return;
        const c = ensure();
        const src = c.createBufferSource();
        src.buffer = buf;
        src.loop = !!loop;
        const gain = c.createGain();
        gain.gain.value = Math.max(0, Math.min(1, vol == null ? 1 : vol));
        src.connect(gain).connect(c.destination);
        src.start();
        const list = playing.get(name) ?? [];
        list.push(src);
        playing.set(name, list);
        src.onended = () => {
          const l = playing.get(name);
          if (l) playing.set(name, l.filter((s) => s !== src));
        };
      }).catch(() => { /* missing sound: skip */ });
    },
    stop(name) {
      for (const s of playing.get(name) ?? []) { try { s.stop(); } catch { /* already stopped */ } }
      playing.set(name, []);
    },
    stopAll() {
      for (const list of playing.values()) for (const s of list) { try { s.stop(); } catch { /* already stopped */ } }
      playing.clear();
    },
  };
})();

// ---------------------------------------------------------------- input -----
// One set of DOM listeners; they either forward to the worker or drive the
// runner directly in fallback mode.
function toGame(ev) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - r.left) / (r.width || 1)) * CANVAS_W,
    y: ((ev.clientY - r.top) / (r.height || 1)) * CANVAS_H,
  };
}

function inputSink() {
  if (state.mode === "worker") {
    const send = (op, extra) => state.worker?.postMessage({ type: "input", op, ...extra });
    return {
      keydown: (code) => send("keydown", { code }),
      keyup: (code) => send("keyup", { code }),
      mousemove: (ev) => { const p = toGame(ev); send("mousemove", p); },
      mousedown: (button) => send("mousedown", { button }),
      mouseup: (button) => send("mouseup", { button }),
      blur: () => send("blur"),
    };
  }
  return {
    keydown: (code) => state.keyDown?.(code),
    keyup: (code) => state.keyUp?.(code),
    mousemove: (ev) => state.mouseMove?.(...Object.values(toGame(ev))),
    mousedown: (button) => state.mouseDown?.(button),
    mouseup: (button) => state.mouseUp?.(button),
    blur: () => {
      const r = state.runner;
      if (!r) return;
      r.keyboard.clear(); r.mouseButtons.clear();
      r.keyboardPressed.clear(); r.keyboardReleased.clear();
      r.mousePressed.clear(); r.mouseReleased.clear();
    },
  };
}

const sink = inputSink();

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (sink.keydown(e.code)) e.preventDefault();
});
window.addEventListener("keyup", (e) => { if (sink.keyup(e.code)) e.preventDefault(); });
canvas.addEventListener("mousemove", (e) => sink.mousemove(e));
canvas.addEventListener("mousedown", (e) => { canvas.focus(); sink.mousedown(e.button); });
window.addEventListener("mouseup", (e) => sink.mouseup(e.button));
window.addEventListener("blur", () => sink.blur());
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ------------------------------------------------------------- watchdog -----
// A transferred canvas cannot be transferred twice, so recovering from a hang
// means a fresh page load — the skip list in localStorage is what survives.
const attempts = () => Number(sessionStorage.getItem("ichorous.attempts") ?? 0);
const bumpAttempts = () => sessionStorage.setItem("ichorous.attempts", String(attempts() + 1));

function armWatchdog() {
  clearTimeout(state.watchdog);
  const ms = state.booted ? 8000 : 30000;
  state.watchdog = setTimeout(() => {
    const at = state.lastAt;
    state.worker?.terminate();
    state.worker = null;
    if (at && attempts() < MAX_RETRIES) {
      const skip = loadSkipList();
      if (!skip.includes(at)) skip.push(at);
      saveSkipList(skip);
      bumpAttempts();
      setStatus(`${at} hung — reloading without it (attempt ${attempts() + 1} of ${MAX_RETRIES + 1})`, null);
      setTimeout(() => location.reload(), 600);
      return;
    }
    overlay.hidden = false;
    setStatus("the game stopped responding", null);
    showError(
      "The recompiled game code stopped responding and was terminated.\n" +
      (at ? `Last boot script reached: ${at}\n` : "") +
      "Reload to try again. Stored workarounds: " + (loadSkipList().join(", ") || "none"),
    );
  }, ms);
}

function noteActivity(at) {
  if (at !== undefined) state.lastAt = at;
  armWatchdog();
}

// --------------------------------------------------------------- worker -----
async function startWorker() {
  const offscreen = typeof canvas.transferControlToOffscreen === "function" ? canvas.transferControlToOffscreen() : null;
  if (!offscreen) throw new Error("no OffscreenCanvas");
  const worker = new Worker(new URL("./game-worker.js", import.meta.url), { type: "module" });
  state.worker = worker;

  worker.onmessage = (e) => {
    const m = e.data;
    switch (m.type) {
      case "progress":
        setStatus(m.stage, m.pct);
        noteActivity(m.at ?? undefined);
        break;
      case "ready":
        state.booted = true;
        overlay.hidden = true;
        hintEl.hidden = false;
        noteActivity(null);
        break;
      case "running":
        diagEl.textContent = `${m.fps} fps · ${m.instances} instances · ${m.drawCalls} draws` +
          (m.logs ? ` · ${m.logs} guest messages` : "") +
          (m.timeouts ? ` · ${m.timeouts} timeouts` : "") +
          (m.disabled ? ` · ${m.disabled} events disabled` : "");
        noteActivity();
        break;
      case "log":
        console.log("[gex]", m.message);
        break;
      case "fatal":
        overlay.hidden = false;
        setStatus("boot failed", null);
        showError("Boot failed: " + m.message);
        clearTimeout(state.watchdog);
        break;
    }
  };
  worker.onerror = (e) => {
    overlay.hidden = false;
    setStatus("worker error", null);
    showError("Worker error: " + (e.message ?? "unknown") + "\n" + (e.filename ?? ""));
    clearTimeout(state.watchdog);
  };

  worker.postMessage({ type: "start", canvas: offscreen, skipList: loadSkipList() }, [offscreen]);
  armWatchdog();
}

// --------------------------------------------------- main-thread fallback ----
async function startMainThread() {
  const boot = await import("./gex/boot.js");
  const game = await boot.createGame({
    canvas,
    audio,
    skipList: loadSkipList(),
    onProgress: (p) => { setStatus(p.stage, p.pct); state.lastAt = p.at ?? null; },
  });
  state.runner = game.runner;
  state.keyDown = (code) => boot.keyDown(game.runner, code);
  state.keyUp = (code) => boot.keyUp(game.runner, code);
  state.mouseMove = (x, y) => boot.mouseMove(game.runner, x, y);
  state.mouseDown = (b) => boot.mouseDown(game.runner, b);
  state.mouseUp = (b) => boot.mouseUp(game.runner, b);
  game.runner.debugFn = (m) => console.log("[gex]", m);

  state.stopLoop = boot.startLoop(game.runner, {
    schedule: (fn) => requestAnimationFrame(fn),
    onFrame: (fps) => {
      diagEl.textContent = `${fps} fps · ${game.runner.instanceList.length} instances · ${game.runner.drawCalls} draws`;
    },
    onError: (e) => console.error("[gex] frame threw:", e),
  });
  state.booted = true;
  overlay.hidden = true;
  hintEl.hidden = false;
}

async function start() {
  overlay.hidden = false;
  errorEl.hidden = true;
  setStatus("starting…", 0);
  try {
    if (state.mode === "worker") await startWorker();
    else await startMainThread();
  } catch (err) {
    console.warn("[gex] worker path unavailable, running on the main thread:", err);
    state.mode = "main";
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    try {
      await startMainThread();
    } catch (err2) {
      setStatus("boot failed", null);
      showError("Boot failed: " + String(err2 && err2.message ? err2.message : err2));
    }
  }
}

canvas.addEventListener("click", () => canvas.focus());
start();
