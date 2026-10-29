import { useCallback, useEffect, useRef, useState } from "react";
import { Button, EmptyState, LoadError, Select, Spinner } from "../../components/ui";
import { useCoreClient } from "@fabdesk/client-core";
import { useCinemaStore } from "../../stores/cinema";
import { useUiStore } from "../../stores/ui";
import { Icon } from "../../components/Icon";
import { cn } from "../../util";
import { useBoardSources, useProject, useProjectText, useRouteRun, useRouteRuns, useRouters, useRunTool } from "@fabdesk/client-core";
import { SvgViewer } from "../SvgViewer";
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
  return ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY", "A"].includes(tag) || target.isContentEditable;
}

function RoutingReference({ projectId }: { projectId: string }) {
  const drawing = useProjectText(projectId, "renders/pcb.svg");
  return <section className="fd-routing-reference" aria-label="Saved PCB routing reference">
    {drawing.isError ? <LoadError title="Could not load the saved PCB preview" onRetry={() => void drawing.refetch()} /> : drawing.isPending ? <Spinner /> : drawing.data ? <SvgViewer svg={drawing.data} viewKey={`${projectId}/routing-reference`} /> : <EmptyState title="No saved PCB preview" />}
    <p>Saved preview · Routing and source freshness unverified</p>
  </section>;
}

export function CinemaTab() {
  const projectId = useUiStore(s => s.activeProjectId);
  const sources = useBoardSources(projectId);
  if (!projectId) return <EmptyState title="Choose a project" />;
  if (sources.isError) return <LoadError title="Could not check routing source" onRetry={() => void sources.refetch()} />;
  if (!sources.data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (sources.data.mode === "assembly") return <EmptyState title="Routing needs a single-board project" action={<Button onClick={() => useUiStore.getState().setBoardTab("pcb")}>Open Boards</Button>}>Member-board routing is not available in this workspace yet. Inspect each saved PCB in Boards; this action will not route a project-root board in its place.</EmptyState>;
  return <ProjectCinema key={projectId} projectId={projectId} scopeReady={!sources.isFetching} />;
}

function ProjectCinema({ projectId, scopeReady }: { projectId: string; scopeReady: boolean }) {
  const client = useCoreClient();

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
  const cancel = useRunTool();
  const project = useProject(projectId);
  const history = useRouteRuns(projectId);
  const [setupOpen, setSetupOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const setupTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!setupOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setSetupOpen(false);
      setupTrigger.current?.focus();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [setupOpen]);
  const routers = useRouters();
  const [pickedRouter, setPickedRouter] = useState<"default" | RouterCatalogId>("default");
  const picker = routerPickerOptions(routers.data?.routers ?? [], routers.data?.preferredRouter);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const painterRef = useRef<{ painter: CinemaPainter; ctor: typeof CinemaPainter; width: number; height: number } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });
  const [shapeCount, setShapeCount] = useState(0);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [frameRetry, setFrameRetry] = useState(0);
  const runRecord = useRouteRun(activeRunId);
  // Frame metadata has no project identity. Verify the durable record before showing it.
  const ownedRunId = runRecord.data?.projectId === projectId ? activeRunId : null;
  const run = ownedRunId ? runs[ownedRunId] : undefined;
  const runError = runFailureText(runRecord.data);
  const frames = run?.frames.length ?? 0;

  const restoredHistory = useRef(false);
  useEffect(() => {
    if (!history.data) return;
    const foreignActiveRun = !!runRecord.data && runRecord.data.projectId !== projectId;
    if (restoredHistory.current && !foreignActiveRun) return;
    restoredHistory.current = true;
    if (!ownedRunId) setActiveRun(history.data.find(item => item.projectId === projectId)?.id ?? null);
  }, [history.data, ownedRunId, projectId, runRecord.data?.projectId, setActiveRun]);

  // A newly launched run can return immediately. Refresh the project list while awaiting it.
  useEffect(() => {
    if (route.state.status !== "running") return;
    const timer = setInterval(() => void history.refetch(), 3000);
    return () => clearInterval(timer);
  }, [route.state.status, history.refetch]);

  // Catch up on frames we may have missed (tab opened mid-run, reconnect).
  useEffect(() => {
    if (!ownedRunId) return;
    let cancelled = false;
    setFrameError(null);
    const current = useCinemaStore.getState().runs[ownedRunId];
    const from = current ? nextFrameSeq(current) : 0;
    client
      .routeFrames(ownedRunId, from)
      .then((lines) => {
        if (!cancelled && lines.length > 0) ingestMany(ownedRunId, lines);
      })
      .catch(() => { if (!cancelled) setFrameError("Recorded frames could not be loaded."); });
    return () => { cancelled = true; };
  }, [ownedRunId, client, ingestMany, frameRetry]);

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
    if (!playing || !ownedRunId) return;
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
  }, [playing, playbackMs, ownedRunId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!ownedRunId || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return;
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
  }, [ownedRunId]);

  const projectRuns = (history.data ?? []).filter(item => item.projectId === projectId);
  const runIds = [...new Set([...projectRuns.map(item => item.id), ...(ownedRunId ? [ownedRunId] : [])])];
  const active = !!ownedRunId && ["queued", "running", "cancel_requested", "cancelling"].includes(runRecord.data?.status ?? "");
  const busy = route.state.status === "running" || active || projectRuns.some(item => ["queued", "running", "cancel_requested", "cancelling"].includes(item.status));
  const hasPcb = project.data?.files.some(file => file.path === "board.kicad_pcb") ?? false;
  const canRoute = scopeReady && hasPcb && !project.isFetching && !project.isError && !!history.data && !history.isFetching && !history.isError && !busy;
  const preview = project.data?.files.some(file => file.path === "renders/pcb.svg");
  const showSavedReference = frames === 0 && !active && !!runError && preview;
  const cancelButton = active && cancel.manifest?.some(tool => tool.name === "route_cancel") ? <Button size="sm" disabled={cancel.state.status === "running" || ["cancel_requested", "cancelling"].includes(runRecord.data?.status ?? "")} onClick={() => {
    if (ownedRunId && useUiStore.getState().activeProjectId === projectId) void cancel.run("route_cancel", { projectId, runId: ownedRunId }).then(() => { void runRecord.refetch(); void history.refetch(); });
  }}>Cancel run</Button> : null;
  async function startRouting() {
    if (!canRoute || useUiStore.getState().activeProjectId !== projectId) return;
    await route.run("route", { projectId, ...(pickedRouter !== "default" ? { router: pickedRouter } : {}) });
    void history.refetch();
  }
  const failureNotice = runError && (
        <div role="alert" className="border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger" data-testid="route-run-error">
          <p><span className="font-semibold">Routing {runRecord.data?.status === "timed_out" ? "timed out" : "failed"}</span> using {runRecord.data?.router}. Check router availability before trying again. <Button size="sm" variant="ghost" onClick={() => useUiStore.getState().setSettingsOpen(true, "router")}>Manage routers</Button></p>
          <details className="mt-1"><summary className="cursor-pointer">Failure details</summary><p className="mt-2 break-words">{runError}</p></details>
        </div>
      );
  const setup = <section className="fd-routing-setup" aria-label="Routing setup">
    <h2>Routing</h2>
    <p>Saved PCB · Board-level routing</p>
    <label className="flex flex-col gap-2 text-xs">Router
      <Select aria-label="Router" value={pickedRouter} disabled={busy} onChange={e => setPickedRouter(e.target.value as "default" | RouterCatalogId)}>
        {picker.map(option => <option key={option.id} value={option.id} disabled={option.disabled} title={option.hint}>{option.label}{option.disabled ? ` (${option.note ?? "not installed"})` : ""}</option>)}
      </Select>
    </label>
    <details className="fd-routing-options"><summary>Router options</summary><Button size="sm" variant="ghost" onClick={() => useUiStore.getState().setSettingsOpen(true, "router")}>Manage routers</Button></details>
    {routers.isError && <p role="alert">Router availability could not be checked. <Button size="sm" onClick={() => void routers.refetch()}>Retry</Button></p>}
    <p role="status">{project.isError ? "Project files could not be read." : !scopeReady || project.isFetching ? "Checking saved PCB…" : !hasPcb ? "Add a saved PCB in Board before starting routing." : "Routing can update the saved PCB after its source checks. Review the result and current PCB checks before fabrication."}</p>
    <Button className="fd-routing-start-action" variant="primary" disabled={!canRoute} onClick={() => void startRouting()}>{busy ? "Routing…" : "Start routing"}</Button>
    {ownedRunId && <section className="fd-routing-saved-run"><h3>Saved run</h3>{failureNotice || <p>Recorded {runRecord.data?.status ?? "run"} · inspect playback before starting another run.</p>}</section>}
  </section>;
  const feedback = <>{route.state.error && <p role="alert" className="text-danger">{route.state.error}</p>}{cancel.state.error && <p role="alert" className="text-danger">{cancel.state.error}</p>}{history.isError && <p role="alert">Routing history could not be loaded. <Button size="sm" onClick={() => void history.refetch()}>Retry history</Button></p>}{frameError && <p role="alert">{frameError} <Button size="sm" onClick={() => setFrameRetry(value => value + 1)}>Retry frames</Button></p>}</>;
  if (!run) return <div className="fd-routing-start">
    <header><div><h1>Routing</h1><p>Start a run when your board is ready for copper routing.</p></div><Button ref={setupTrigger} size="sm" aria-expanded={setupOpen} onClick={() => setSetupOpen(!setupOpen)}>{setupOpen ? "Close setup" : "Set up routing"}</Button></header>
    <div className="fd-routing-start-body" data-setup-open={setupOpen}>{preview ? <RoutingReference projectId={projectId} /> : <section className="fd-routing-reference"><EmptyState title={hasPcb ? "Saved PCB" : "Start with a saved PCB"}>Choose Set up routing to review router options and requirements.</EmptyState></section>}{setupOpen && setup}</div>
    <div className="fd-routing-feedback">{history.isLoading && <p role="status">Loading recorded runs…</p>}{ownedRunId && <p role="status">Loading this run’s recorded frames…</p>}{cancelButton}{feedback}</div>
  </div>;

  return (
    <div className="fd-routing-player flex h-full flex-col" data-setup-open={setupOpen}>
      <div className="fd-routing-heading"><strong>Routing</strong><span>{runRecord.data?.router} · {runRecord.data?.status} · Recorded run; current PCB coverage unverified</span><Button size="sm" variant="ghost" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>Layers and run details</Button><Button ref={setupTrigger} size="sm" aria-expanded={setupOpen} onClick={() => setSetupOpen(!setupOpen)}>{setupOpen ? "Close setup" : "New run"}</Button>{cancelButton}</div>
      {setupOpen && setup}
      <div className="fd-routing-feedback">{feedback}</div>
      <div className="fd-routing-playback flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="Recorded routing playback">
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
        <Select aria-label="Routing camera" value={viewMode} onChange={(e) => setViewMode(e.target.value === "board" ? "board" : "activity")} className="h-7 text-xs" title="View: follow the router's recent copper, or fit the whole board">
          <option value="activity">follow activity</option>
          <option value="board">whole board</option>
        </Select>
        <Select aria-label="Playback speed" value={String(playbackMs)} onChange={(e) => setPlaybackMs(Number(e.target.value))} className="h-7 text-xs" title="Playback speed">
          <option value="400">slow</option>
          <option value="120">normal</option>
          <option value="30">fast</option>
        </Select>
        {runIds.length > 1 && (
          <Select aria-label="Recorded run" value={ownedRunId ?? ""} onChange={(e) => setActiveRun(e.target.value || null)} className="h-7 text-xs" title="Run">
            {runIds.map((id) => (
              <option key={id} value={id}>
                {projectRuns.find(item => item.id === id)?.startedAt ? new Date(projectRuns.find(item => item.id === id)!.startedAt).toLocaleString() : id}
              </option>
            ))}
          </Select>
        )}
      </div>
      {detailsOpen && <div className="fd-routing-layer-details flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
        {(run.meta?.layers ?? []).map((name, index) => {
          const off = hiddenLayers.includes(index);
          return (
            <button
              key={name}
              onClick={() => toggleLayer(index)}
              className={cn("inline-flex items-center gap-1.5 rounded border border-border px-1.5 py-0.5 text-[11px]", off && "opacity-35")}
              title={`Toggle ${name}`}
              aria-pressed={!off}
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
      }
      {!setupOpen && failureNotice}
      {/* The box owns the size; the canvas is absolutely positioned so its bitmap size never feeds back into layout. */}
      <div ref={boxRef} className="fd-routing-drawing relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" hidden={!!showSavedReference} />
        {showSavedReference && <><RoutingReference projectId={projectId} /><p className="fd-routing-no-frames">This run has no recorded frames. Showing the saved PCB preview.</p></>}
      </div>
    </div>
  );
}
