"use client";
import { useEffect, useRef, useState } from "react";
import { bootGame, type BootProgress } from "@/lib/gex/boot";

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [progress, setProgress] = useState<BootProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasDownloads, setHasDownloads] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // show the download row only when release zips are deployed under public/_downloads
    fetch("/_downloads/ichoruous-web.zip", { method: "HEAD" })
      .then((r) => setHasDownloads(r.ok))
      .catch(() => setHasDownloads(false));
  }, []);

  useEffect(() => {
    if (started.current || !canvasRef.current) return;
    started.current = true;
    bootGame(canvasRef.current, setProgress)
      .then(({ runner }) => {
        runner.debugFn = (msg) => console.log("[gex]", msg);
        (window as unknown as { __gex: unknown }).__gex = runner;
      })
      .catch((e) => {
        console.error("[gex] boot failed:", e);
        setError(String(e).slice(0, 400));
      });
  }, []);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-black gap-4 p-4">
      <h1 className="text-neutral-300 font-mono text-lg tracking-widest select-none">ichoruous web</h1>
      <canvas
        ref={canvasRef}
        className={`border border-neutral-800 bg-black ${progress?.pct === 100 && !error ? "" : "hidden"}`}
        tabIndex={0}
      />
      {error && (
        <div className="text-red-400 font-mono text-xs max-w-md text-center">{error}</div>
      )}
      {progress && progress.pct < 100 && !error && (
        <div className="w-64 flex flex-col gap-2">
          <div className="h-2 bg-neutral-900 rounded overflow-hidden border border-neutral-800">
            <div className="h-full bg-red-700 transition-all duration-200" style={{ width: `${progress.pct}%` }} />
          </div>
          <div className="text-neutral-500 font-mono text-[10px] text-center">{progress.stage}…</div>
        </div>
      )}
      {progress?.pct === 100 && !error && (
        <div className="text-neutral-600 font-mono text-[10px] text-center select-none">
          arrows / WASD to move · Z / J to attack · click canvas first
        </div>
      )}
      {!error && (
        <div className="text-neutral-700 font-mono text-[9px] text-center max-w-md select-none">
          static recompilation: Ichorous.exe x64 → {""}
          {""}WebAssembly · 5,555 functions · no emulator, no interpreter
        </div>
      )}
      {hasDownloads && (
        <div className="flex flex-wrap justify-center gap-x-5 gap-y-1 pt-2">
          <a
            href="/_downloads/ichoruous-web.zip"
            download
            className="text-neutral-500 hover:text-neutral-200 font-mono text-[10px] underline underline-offset-2 select-none"
          >
            ↓ ichoruous-web.zip — source repo (GitHub-ready, 46 MB)
          </a>
          <a
            href="/_downloads/ichoruous-web-static.zip"
            download
            className="text-neutral-500 hover:text-neutral-200 font-mono text-[10px] underline underline-offset-2 select-none"
          >
            ↓ ichoruous-web-static.zip — ready-to-host build (45 MB)
          </a>
        </div>
      )}
    </main>
  );
}
