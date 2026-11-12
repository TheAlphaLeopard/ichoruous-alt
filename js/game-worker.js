// The game runs here, off the main thread.
//
// That is not a micro-optimisation: some recompiled guest code can enter a loop
// that never calls back into the host, and a WebAssembly frame that never
// returns cannot be interrupted from JavaScript — not by a timer, not even by a
// signal. Running it in a worker is the only way to keep a hung guest from
// taking the whole tab down with it: the main thread can terminate() this
// worker, note which boot script it died on, and relaunch without it.
//
// Rendering happens on an OffscreenCanvas transferred from the page; audio is
// proxied back to the main thread (AudioContext is not available in workers).
import { createGame, startLoop, keyDown, keyUp, mouseDown, mouseUp, mouseMove, CANVAS_W, CANVAS_H } from "./gex/boot.js";

let game = null;
let stopLoop = null;

const post = (msg) => self.postMessage(msg);

const audioProxy = {
  play: (name, loop, vol) => post({ type: "sound", op: "play", name, loop, vol }),
  stop: (name) => post({ type: "sound", op: "stop", name }),
  stopAll: () => post({ type: "sound", op: "stopAll" }),
};

function applyInput(msg) {
  if (!game) return;
  const r = game.runner;
  switch (msg.op) {
    case "keydown": keyDown(r, msg.code); break;
    case "keyup": keyUp(r, msg.code); break;
    case "mousemove": mouseMove(r, msg.x, msg.y); break;
    case "mousedown": mouseDown(r, msg.button); break;
    case "mouseup": mouseUp(r, msg.button); break;
    case "blur":
      r.keyboard.clear(); r.mouseButtons.clear();
      r.keyboardPressed.clear(); r.keyboardReleased.clear();
      r.mousePressed.clear(); r.mouseReleased.clear();
      break;
  }
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "input") { applyInput(msg); return; }
  if (msg.type !== "start") return;

  const { canvas, skipList = [] } = msg;
  try {
    game = await createGame({
      canvas,
      audio: audioProxy,
      skipList,
      isWorker: true,
      onProgress: (p) => post({ type: "progress", stage: p.stage, pct: p.pct, at: p.at ?? null }),
    });
    const r = game.runner;
    r.debugFn = (m) => post({ type: "log", message: m });

    // Fixed-rate scheduler: workers have no requestAnimationFrame.
    let target = performance.now();
    const schedule = (fn) => {
      target += 1000 / 60;
      const now = performance.now();
      if (now - target > 250) target = now; // fell badly behind (tab throttling); resync
      setTimeout(fn, Math.max(0, target - performance.now()));
    };

    stopLoop = startLoop(r, {
      schedule,
      onFrame: (fps) => post({
        type: "running",
        fps,
        instances: r.instanceList.length,
        drawCalls: r.drawCalls,
        logs: r.logCount,
        timeouts: r.timeouts,
        disabled: r.disabledFns.size,
      }),
      onError: (err) => post({ type: "log", message: "frame threw: " + String(err && err.message).slice(0, 200) }),
    });
    post({ type: "ready", canvasW: CANVAS_W, canvasH: CANVAS_H, skipped: game.skipped });
  } catch (err) {
    post({ type: "fatal", message: String(err && err.message ? err.message : err).slice(0, 400) });
  }
};

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "stop" && stopLoop) stopLoop();
});
