import { useEffect, useRef, useState } from "react";
import { Button, EmptyState, Select } from "../../components/ui";
import { useCoreClient } from "../../core/CoreProvider";
import { useCinemaStore } from "../../stores/cinema";
import { useUiStore } from "../../stores/ui";
import { cn } from "../../util";
import { useRunTool } from "../tools";
import { DARK_THEME, LIGHT_THEME, drawScene, frameStatusText, layerColor, nextFrameSeq } from "./renderer";

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function CinemaTab() {
  const client = useCoreClient();
  const projectId = useUiStore((s) => s.activeProjectId);
  const runs = useCinemaStore((s) => s.runs);
  const activeRunId = useCinemaStore((s) => s.activeRunId);
  const cursor = useCinemaStore((s) => s.cursor);
  const playing = useCinemaStore((s) => s.playing);
  const followLive = useCinemaStore((s) => s.followLive);
  const hiddenLayers = useCinemaStore((s) => s.hiddenLayers);
  const playbackMs = useCinemaStore((s) => s.playbackMs);
  const { seek, step, goLive, togglePlaying, toggleLayer, setActiveRun, ingestMany, setPlaybackMs } = useCinemaStore.getState();
  const route = useRunTool();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });
  const run = activeRunId ? runs[activeRunId] : undefined;
  const frames = run?.frames.length ?? 0;

  // Catch up on frames we may have missed (tab opened mid-run, reconnect).
  useEffect(() => {
    if (!activeRunId) return;
    const current = useCinemaStore.getState().runs[activeRunId];
    const from = current ? nextFrameSeq(current) : 0;
    client
      .routeFrames(activeRunId, from)
      .then((lines) => {
        if (lines.length > 0) ingestMany(activeRunId, lines);
      })
      .catch(() => {});
  }, [activeRunId, client, ingestMany]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio || 1 });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio || 1 });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !run) return;
    const width = Math.max(1, Math.floor(size.w * size.dpr));
    const height = Math.max(1, Math.floor(size.h * size.dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dark = document.documentElement.classList.contains("dark");
    drawScene(ctx, { run, cursor, hiddenLayers: new Set(hiddenLayers), width, height, theme: dark ? DARK_THEME : LIGHT_THEME });
  }, [run, cursor, hiddenLayers, size]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const s = useCinemaStore.getState();
      const r = s.activeRunId ? s.runs[s.activeRunId] : undefined;
      if (!r || s.cursor >= r.frames.length - 1) {
        s.setPlaying(false);
        return;
      }
      s.seek(s.cursor + 1);
    }, playbackMs);
    return () => clearInterval(id);
  }, [playing, playbackMs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
      const s = useCinemaStore.getState();
      switch (e.key) {
        case " ":
          e.preventDefault();
          s.togglePlaying();
          break;
        case "[":
          s.step(-1);
          break;
        case "]":
          s.step(1);
          break;
        case "Home":
          s.seek(0);
          break;
        case "End":
          s.goLive();
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const runIds = Object.keys(runs);
  if (!run) {
    return (
      <EmptyState
        title="No routing run yet"
        action={
          <Button
            variant="primary"
            size="sm"
            disabled={!projectId || route.state.status === "running"}
            onClick={() => void route.run("route", { projectId })}
          >
            {route.state.status === "running" ? "Routing..." : "Route board"}
          </Button>
        }
      >
        Frames stream in live while the router works; scrub through them afterwards with [ and ].
        {route.state.error && <div className="mt-2 text-danger">{route.state.error}</div>}
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1 text-xs">
        <Button size="sm" variant={followLive ? "primary" : "secondary"} onClick={goLive} title="Follow live (End)">
          &#9654; live
        </Button>
        <Button size="sm" onClick={togglePlaying} title="Play / pause (Space)" disabled={frames === 0}>
          {playing ? "⏸" : "▶"}
        </Button>
        <Button size="sm" onClick={() => step(-1)} title="Previous frame ([)" disabled={cursor <= 0}>
          &#8249;
        </Button>
        <Button size="sm" onClick={() => step(1)} title="Next frame (])" disabled={cursor >= frames - 1}>
          &#8250;
        </Button>
        <input
          type="range"
          className="min-w-24 flex-1 accent-(--fd-accent)"
          min={0}
          max={Math.max(0, frames - 1)}
          value={Math.max(0, cursor)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={frames === 0}
        />
        <Select value={String(playbackMs)} onChange={(e) => setPlaybackMs(Number(e.target.value))} className="h-7 text-xs" title="Playback speed">
          <option value="400">slow</option>
          <option value="120">normal</option>
          <option value="30">fast</option>
        </Select>
        {runIds.length > 1 && (
          <Select value={activeRunId ?? ""} onChange={(e) => setActiveRun(e.target.value || null)} className="h-7 text-xs" title="Run">
            {runIds.map((id) => (
              <option key={id} value={id}>
                {id.slice(0, 8)}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        {(run.meta?.layers ?? []).map((name, index) => {
          const off = hiddenLayers.includes(index);
          return (
            <button
              key={name}
              onClick={() => toggleLayer(index)}
              className={cn("inline-flex items-center gap-1.5 rounded border border-border px-1.5 py-0.5 text-[11px]", off && "opacity-35")}
              title={`Toggle ${name}`}
            >
              <span className="inline-block h-2 w-2 rounded-sm" style={{ background: layerColor(index) }} />
              {name}
            </button>
          );
        })}
        <span className="ml-auto truncate font-mono text-[11px] text-muted" title={frameStatusText(run, cursor)}>
          {frameStatusText(run, cursor)}
        </span>
      </div>
      <div ref={boxRef} className="min-h-0 flex-1">
        <canvas ref={canvasRef} className="block h-full w-full" style={{ width: size.w, height: size.h }} />
      </div>
    </div>
  );
}
