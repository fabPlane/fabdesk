import { useCallback, useEffect, useRef, useState } from "react";
import { Button, EmptyState, Select } from "../../components/ui";
import { useCoreClient } from "@fabdesk/client-core";
import { useCinemaStore } from "../../stores/cinema";
import { useUiStore } from "../../stores/ui";
import { Icon } from "../../components/Icon";
import { cn } from "../../util";
import { useRouteRun, useRouters, useRunTool } from "@fabdesk/client-core";
import type { RouterCatalogId } from "@fabdesk/protocol";
import { routerPickerOptions } from "../../settings/routers";
import { runFailureText } from "./runError";
import { CinemaPainter, DARK_THEME, LIGHT_THEME, frameStatusText, layerColor, nextFrameSeq, perfStatusText, type OffscreenLike } from "./renderer";

/** Offscreen layers for the painter: statics and settled copper, sized like the visible canvas. */
function makePainter(width: number, height: number): CinemaPainter {
  const make = (): { canvas: HTMLCanvasElement | OffscreenCanvas; ctx: OffscreenLike } => {
    const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(width, height) : document.createElement("canvas");
    if (!(canvas instanceof OffscreenCanvas)) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d") as unknown as OffscreenLike;
    return { canvas, ctx };
  };
  const statics = make();
  const copper = make();
  return new CinemaPainter({ statics: statics.ctx, copper: copper.ctx, image: (which) => (which === "statics" ? statics.canvas : copper.canvas) });
}

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
  const perf = useCinemaStore((s) => s.perf);
  const viewMode = useCinemaStore((s) => s.viewMode);
  const setViewMode = useCinemaStore((s) => s.setViewMode);
  const { seek, step, goLive, togglePlaying, toggleLayer, setActiveRun, ingestMany, setPlaybackMs, reportDraw } = useCinemaStore.getState();
  const route = useRunTool();
  const routers = useRouters();
  const [pickedRouter, setPickedRouter] = useState<"default" | RouterCatalogId>("default");
  const picker = routerPickerOptions(routers.data?.routers ?? [], routers.data?.preferredRouter);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painterRef = useRef<{ painter: CinemaPainter; ctor: typeof CinemaPainter; width: number; height: number } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });
  const [shapeCount, setShapeCount] = useState(0);
  const run = activeRunId ? runs[activeRunId] : undefined;
  const runRecord = useRouteRun(activeRunId);
  const runError = runFailureText(runRecord.data);
  const frames = run?.frames.length ?? 0;

  // The store receives live route events, but starts empty after an app restart. Restore the
  // latest persisted run for the selected project so Route Cinema remains useful across sessions.
  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setActiveRun(null);
      return;
    }
    client
      .listRouteRuns(projectId)
      .then((persisted) => {
        if (cancelled) return;
        setActiveRun(persisted[0]?.id ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, projectId, setActiveRun]);

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

  // The canvas box only exists once a run is loaded (the empty state renders without it), so the
  // observer must follow the element: a callback ref re-attaches whenever the box mounts.
  const resizeRef = useRef<ResizeObserver | null>(null);
  const boxRef = useCallback((el: HTMLDivElement | null) => {
    resizeRef.current?.disconnect();
    resizeRef.current = null;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio || 1 });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    resizeRef.current = ro;
    measure();
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
    // Statics are painted once to an offscreen layer and copper is extended per frame while
    // following live; only the composite hits the visible canvas each frame.
    // Recreate on resize, and when the renderer module was hot-swapped (a stale instance would keep the old code).
    if (!painterRef.current || painterRef.current.width !== width || painterRef.current.height !== height || painterRef.current.ctor !== CinemaPainter) {
      painterRef.current = { painter: makePainter(width, height), ctor: CinemaPainter, width, height };
    }
    const t0 = performance.now();
    const painted = painterRef.current.painter.paint(ctx as unknown as OffscreenLike, { run, cursor, hiddenLayers: new Set(hiddenLayers), width, height, theme: dark ? DARK_THEME : LIGHT_THEME, view: viewMode });
    reportDraw(performance.now() - t0);
    setShapeCount(painted.shapes);
  }, [run, cursor, hiddenLayers, size, reportDraw, viewMode]);

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
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Select
              aria-label="Router"
              className="h-8 text-xs"
              value={pickedRouter}
              onChange={(e) => setPickedRouter(e.target.value as "default" | RouterCatalogId)}
            >
              {picker.map((option) => (
                <option key={option.id} value={option.id} disabled={option.disabled} title={option.hint}>
                  {option.label}
                  {option.disabled ? ` (${option.note ?? "not installed"})` : ""}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              size="sm"
              disabled={!projectId || route.state.status === "running"}
              onClick={() =>
                void route.run("route", {
                  projectId,
                  ...(pickedRouter !== "default" ? { router: pickedRouter } : {}),
                })
              }
            >
              {route.state.status === "running" ? "Routing..." : "Route board"}
            </Button>
          </div>
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
          <Icon name="play" width={14} height={14} /> Live
        </Button>
        <Button size="sm" onClick={togglePlaying} title="Play / pause (Space)" disabled={frames === 0}>
          <Icon name={playing ? "pause" : "play"} width={16} height={16} />
        </Button>
        <Button size="sm" onClick={() => step(-1)} title="Previous frame ([)" disabled={cursor <= 0}>
          <Icon name="chevronLeft" width={16} height={16} />
        </Button>
        <Button size="sm" onClick={() => step(1)} title="Next frame (])" disabled={cursor >= frames - 1}>
          <Icon name="chevronRight" width={16} height={16} />
        </Button>
        <input
          type="range"
          aria-label="Routing frame"
          className="min-w-24 flex-1 accent-(--fd-accent)"
          min={0}
          max={Math.max(0, frames - 1)}
          value={Math.max(0, cursor)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={frames === 0}
        />
        <Select value={viewMode} onChange={(e) => setViewMode(e.target.value === "board" ? "board" : "activity")} className="h-7 text-xs" title="View: follow the router's recent copper, or fit the whole board">
          <option value="activity">follow activity</option>
          <option value="board">whole board</option>
        </Select>
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
        <span className="shrink-0 font-mono text-[11px] text-muted" title="frames/s received · last draw · shapes drawn · frames this client never received (throttled upstream)">
          {perfStatusText(perf, shapeCount)}
        </span>
      </div>
      {runError && (
        <div role="alert" className="border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger" data-testid="route-run-error">
          <span className="font-semibold">Routing {runRecord.data?.status === "timed_out" ? "timed out" : "failed"}</span> ({runRecord.data?.router}): {runError}
        </div>
      )}
      {/* The box owns the size; the canvas is absolutely positioned so its bitmap size never feeds back into layout. */}
      <div ref={boxRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
      </div>
    </div>
  );
}
