import { createPortal } from "react-dom";
import { BoardViewTabs } from "../BoardViewTabs";
import { AssemblyBoardPicker } from "../AssemblyBoardPicker";
import { DisclosureSummary } from "../../components/DisclosureSummary";
import { askAboutSurface, useAssistantSurface } from "../../chat/useAssistantSurface";
import { CanvasToolButton } from "../../components/CanvasToolButton";
import { useOutputSource } from "../useOutputSource";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, EmptyState, LoadError, Select, Spinner } from "../../components/ui";
import { restoreAssemblySelection, routeRunMatchesSource, selectOwnedRouteRun, useCoreClient } from "@fabdesk/client-core";
import { useCinemaStore } from "../../stores/cinema";
import { useUiStore } from "../../stores/ui";
import { Icon } from "../../components/Icon";
import { cn } from "../../util";
import { useBoardSources, useProject, useProjectText, useRouteRun, useRouteRuns, useRouters, useRunTool } from "@fabdesk/client-core";
import { SvgViewer } from "../SvgViewer";
import type { BoardSourceSelection, RouterCatalogId } from "@fabdesk/protocol";
import { routerPickerOptions } from "../../settings/routers";
import { runFailureNotice, runFailureText } from "./runError";
import { RouteCandidateReview } from "./RouteCandidateReview";
import { CinemaPainter, DARK_THEME, LIGHT_THEME, frameStatusText, layerColor, nextFrameSeq, perfStatusText, type OffscreenLike } from "./renderer";
import "./routing-reference.css";

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

function RoutingReference({ projectId, prefix = "" }: { projectId: string; prefix?: string }) {
  const drawing = useProjectText(projectId, `${prefix}renders/pcb.svg`);
  return <section className="fd-routing-reference" aria-label="Saved PCB routing reference">
    {drawing.isError ? <LoadError title="Could not load the saved PCB preview" onRetry={() => void drawing.refetch()} /> : drawing.isPending ? <Spinner /> : drawing.data ? <>
      <SvgViewer svg={drawing.data} viewKey={`${projectId}/routing-reference`} fitLabel="Fit board" />
      <details className="fd-routing-reference-status">
        <DisclosureSummary icon="info" label="Saved PCB preview" badge="Unverified" warning variant="compact" />
        <div><p>This is a reference drawing, not live routing progress. It may differ from the current PCB.</p><p>Open PCB to check or update the preview. Review design checks separately before manufacturing.</p>
          <Button size="sm" onClick={() => { if (useUiStore.getState().activeProjectId === projectId) useUiStore.getState().setBoardTab("pcb"); }}><Icon name="pcb" width={15} height={15} />Open PCB</Button>
        </div>
      </details>
    </> : <EmptyState title="No saved PCB preview" />}
  </section>;
}

export function CinemaTab({ canvas = false, onOpenChecks }: { canvas?: boolean; onOpenChecks?: () => void } = {}) {
  const projectId = useUiStore(s => s.activeProjectId);
  const [rootBusy, setRootBusy] = useState(false);
  const sources = useBoardSources(projectId);
  if (!projectId) return <EmptyState title="Choose a project" />;
  if (sources.isError) return <LoadError title="Could not check routing source" onRetry={() => void sources.refetch()} />;
  if (!sources.data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (sources.data.mode === "assembly") return <MemberCinema key={projectId} projectId={projectId} canvas={canvas} {...(onOpenChecks ? { onOpenChecks } : {})} />;
  return <div className="flex h-full min-h-0 flex-col">{canvas && <RoutingToolbar projectId={projectId} disabled={rootBusy || sources.isFetching} {...(onOpenChecks ? { onOpenChecks } : {})} />}<div className="min-h-0 flex-1"><ProjectCinema key={projectId} projectId={projectId} scopeReady={!sources.isFetching} onBusyChange={setRootBusy} /></div></div>;
}

/** Project-owned source picker and the same named tabs as the PCB/schematic/model canvas. */
function RoutingToolbar({ projectId, disabled, onOpenChecks, children }: { projectId: string; disabled: boolean; onOpenChecks?: () => void; children?: import("react").ReactNode }) {
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => { setHost(document.querySelector("[data-routing-toolbar-slot]")); }, []);
  const content = <>{children}<BoardViewTabs value="pcb" disabled={disabled} onChange={tab => useUiStore.getState().setBoardTab(tab)} /><CanvasToolButton icon="sparkles" label="Ask about routing this board" disabled={disabled} onClick={() => {
    const ui = useUiStore.getState(); if (ui.activeProjectId !== projectId) return;
    const surface = Object.values(ui.assistantSurfaces).filter(row => row.projectId === projectId).sort((a,b) => b.priority - a.priority)[0];
    askAboutSurface(surface ?? { projectId, label: "Board / Routing", priority: 10, details: JSON.stringify({ board: ui.assemblyBoardByProject[projectId] }) }, "Review this board’s saved source and routing needs. Explain the remaining connections, current candidate and router settings before proposing changes.");
  }} /><div className="fd-board-task-actions"><Button size="sm" variant="primary" aria-current="page" title="Close routing and return to PCB" disabled={disabled} onClick={() => useUiStore.getState().setBoardTab("pcb")}><Icon name="route" width={18} height={18} />Routing</Button><Button size="sm" disabled={disabled} onClick={() => onOpenChecks ? onOpenChecks() : useUiStore.getState().setBoardTab("drc")}><Icon name="checkCircle" width={18} height={18} />Checks</Button></div></>;
  return host ? createPortal(content, host) : <div className="fd-routing-toolbar-inline">{content}</div>;
}

function MemberCinema({ projectId, canvas, onOpenChecks }: { projectId: string; canvas: boolean; onOpenChecks?: () => void }) {
  const scope = useOutputSource(projectId), [busy, setBusy] = useState(false);
  const surface = { projectId, label: "Routing / Board source", priority: 5, details: JSON.stringify({ board: scope.board, source: scope.row?.source, sourceReady: scope.ready, instruction: "Routing applies to the selected source, shared by its declared physical instances. Connections and electrical parity remain unverified." }) };
  useAssistantSurface(surface);
  return <div className="flex h-full min-h-0 flex-col">{canvas ? <RoutingToolbar projectId={projectId} disabled={busy || scope.sources.isFetching || scope.sources.isError} {...(onOpenChecks ? { onOpenChecks } : {})}>{scope.data && <AssemblyBoardPicker projectId={projectId} data={scope.data} selection={restoreAssemblySelection(scope.data, useUiStore.getState().assemblyBoardByProject[projectId])} disabled={busy || scope.sources.isFetching || scope.sources.isError} onBack={() => useUiStore.getState().setWorkspaceArea("overview")} onChoose={selection => { useUiStore.getState().setAssemblyBoard(selection); scope.choose(selection.sourceId); }} />}</RoutingToolbar> : <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 py-3"><label className="flex items-center gap-2 text-sm">Board source<Select aria-label="Board source for routing" disabled={busy || scope.sources.isFetching} value={scope.sourceId ?? ""} onChange={event => scope.choose(event.target.value)}><option value="" disabled>Choose a board…</option>{scope.data?.sources.map(row => <option key={row.source.id} value={row.source.id}>{row.source.name}{row.status !== "available" ? " · source unavailable" : ""}</option>)}</Select></label><CanvasToolButton icon="sparkles" label="Ask about routing this board" onClick={() => askAboutSurface(surface, "Review this board’s saved source and routing needs. Explain the remaining connections and router settings before proposing a candidate.")} /></div>}<div className="min-h-0 flex-1">{scope.board && scope.board.manifestSha256 === scope.data?.manifestSha256 && scope.row?.status === "available" && scope.row.pcbSha256 ? <ProjectCinema key={`${scope.board.sourceId}/${scope.board.manifestSha256}`} projectId={projectId} scopeReady={scope.ready} board={scope.board} prefix={scope.prefix} sourceSha256={scope.row.pcbSha256} sourceName={scope.row.source.name} onOpenPcb={() => { if (useUiStore.getState().activeProjectId !== projectId) return; scope.choose(scope.board!.sourceId); useUiStore.getState().setBoardTab("pcb"); }} onBusyChange={setBusy} /> : <EmptyState title="Choose an available board source" action={<div className="flex gap-2"><Button onClick={() => scope.sourceId && scope.row?.status === "available" ? scope.choose(scope.sourceId) : void scope.sources.refetch()}>{scope.row?.status === "available" ? "Select source again" : "Recheck sources"}</Button><Button onClick={() => useUiStore.getState().openProjectFile("fabplane.assembly.json")}>Review source files</Button></div>}>Missing or changed source definitions must be resolved before creating a routing candidate.</EmptyState>}</div></div>;
}

function ProjectCinema({ projectId, scopeReady, board, prefix = "", sourceSha256, sourceName, onOpenPcb, onBusyChange }: { projectId: string; scopeReady: boolean; board?: BoardSourceSelection; prefix?: string; sourceSha256?: string; sourceName?: string; onOpenPcb?: () => void; onBusyChange?: (busy: boolean) => void }) {
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
  const [applying, setApplying] = useState(false);
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
  // Metadata has no project identity. Keep diagnostics as well as geometry scoped.
  const ownedRecord = runRecord.data && routeRunMatchesSource(runRecord.data, projectId, board, client.nativeSource) ? runRecord.data : undefined;
  const ownedRunId = ownedRecord ? activeRunId : null;
  const run = ownedRunId ? runs[ownedRunId] : undefined;
  const runError = runFailureText(ownedRecord);
  const frames = run?.frames.length ?? 0;

  const seenRunIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!history.data) return;
    const nextId = selectOwnedRouteRun(history.data, { projectId, ...(board ? { board } : {}), ...(client.nativeSource ? { nativeSource: client.nativeSource } : {}) }, {
      currentId: activeRunId, current: ownedRecord, seen: seenRunIds.current, followNew: followLive,
    });
    seenRunIds.current = new Set(history.data.map(row => row.id));
    if (nextId !== activeRunId) setActiveRun(nextId);
  }, [history.data, activeRunId, ownedRecord?.id, projectId, board?.sourceId, board?.manifestSha256, followLive, client.nativeSource, setActiveRun]);

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

  const projectRuns = (history.data ?? []).filter(item => routeRunMatchesSource(item, projectId, board, client.nativeSource));
  const runIds = [...new Set([...projectRuns.map(item => item.id), ...(ownedRunId ? [ownedRunId] : [])])];
  const active = !!ownedRunId && ["queued", "running", "cancel_requested", "cancelling"].includes(ownedRecord?.status ?? "");
  const busy = applying || route.state.status === "running" || active || projectRuns.some(item => ["queued", "running", "cancel_requested", "cancelling"].includes(item.status));
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useAssistantSurface({ projectId, label: sourceName ? `Routing / ${sourceName}` : "Routing", priority: 10, details: JSON.stringify({ board, sourceSha256, sourceDirectory: prefix || ".", router: pickedRouter, setupOpen, runId: ownedRunId, runState: ownedRecord?.status, creatingCandidate: busy, error: runError ?? route.state.error, instruction: "Candidate creation and explicit Apply are separate. Partial routing and recorded playback do not establish electrical checks or manufacturing readiness." }) });
  const hasPcb = project.data?.files.some(file => file.path === `${prefix}board.kicad_pcb`) ?? false;
  const routerAvailable = !routers.isPending && !routers.isFetching && !routers.isError && picker.some(option => option.id === pickedRouter && !option.disabled);
  const canRoute = scopeReady && hasPcb && routerAvailable && !project.isFetching && !project.isError && !!history.data && !history.isFetching && !history.isError && !busy;
  const preview = project.data?.files.some(file => file.path === `${prefix}renders/pcb.svg`);
  const showSavedReference = frames === 0 && !active && !!runError && preview;
  const cancelButton = active && cancel.manifest?.some(tool => tool.name === "route_cancel") ? <Button size="sm" disabled={cancel.state.status === "running" || ["cancel_requested", "cancelling"].includes(ownedRecord?.status ?? "")} onClick={() => {
    if (ownedRunId && useUiStore.getState().activeProjectId === projectId) void cancel.run("route_cancel", { projectId, ...(board ? { board } : {}), runId: ownedRunId }).then(() => { void runRecord.refetch(); void history.refetch(); });
  }}>Cancel run</Button> : null;
  async function startRouting() {
    if (!canRoute || useUiStore.getState().activeProjectId !== projectId) return;
    goLive();
    await route.run("route", { projectId, applyPolicy: "manual", ...(board ? { board, expectedSourceSha256: sourceSha256 } : {}), ...(pickedRouter !== "default" ? { router: pickedRouter } : {}) });
    void history.refetch();
  }
  const failure = runFailureNotice(ownedRecord, !!picker.find(option => option.id === ownedRecord?.router)?.disabled);
  const failureNotice = runError && (
        <div role="alert" className="border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-danger" data-testid="route-run-error">
          <p><span className="font-semibold">{failure.title}</span> using {ownedRecord?.router}. {failure.hint}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2"><Button size="sm" disabled={!scopeReady || busy} onClick={() => { if (onOpenPcb) onOpenPcb(); else useUiStore.getState().setBoardTab("pcb"); }}>Review PCB</Button><CanvasToolButton icon="sparkles" label="Ask about this routing result" onClick={() => askAboutSurface({ projectId, label: "Routing / Stopped run", priority: 40, details: JSON.stringify({ board, runId: ownedRunId, router: ownedRecord?.router, status: ownedRecord?.status, error: runError, diagnostics: ownedRecord?.result?.diagnostics, endpointCollisions: ownedRecord?.result?.endpointCollisions, instruction: "Recorded result only; inspect current saved inputs before proposing changes." }) }, "Explain why this routing run stopped and review its reported constraints or collisions. Propose the next step before changing the PCB or its design rules.")} />{picker.find(option => option.id === ownedRecord?.router)?.disabled && <Button size="sm" variant="ghost" onClick={() => useUiStore.getState().setSettingsOpen(true, "router")}>Manage routers</Button>}</div>
          <details className="mt-1"><DisclosureSummary icon="warning" label="Failure details" variant="compact" /><p className="mt-2 break-words">{runError}</p></details>
        </div>
      );
  const setup = <section className="fd-routing-setup" aria-label="Routing setup">
    <h2>Routing</h2>
    <p>{sourceName ?? "Saved PCB"} · Board-level routing</p>
    <label className="flex flex-col gap-2 text-xs">Router
      <Select aria-label="Router" value={pickedRouter} disabled={busy} onChange={e => setPickedRouter(e.target.value as "default" | RouterCatalogId)}>
        {picker.map(option => <option key={option.id} value={option.id} disabled={option.disabled} title={option.hint}>{option.label}{option.disabled ? ` (${option.note ?? "not installed"})` : ""}</option>)}
      </Select>
    </label>
    <details className="fd-routing-options"><DisclosureSummary icon="settings" label="Router options" /><Button size="sm" variant="ghost" onClick={() => useUiStore.getState().setSettingsOpen(true, "router")}>Manage routers</Button></details>
    {routers.isError && <p role="alert">Router availability could not be checked. <Button size="sm" onClick={() => void routers.refetch()}>Retry</Button></p>}
    {!routers.isPending && !routers.isError && !routerAvailable && <p role="status">{routers.isFetching ? "Checking router availability…" : picker.find(option => option.id === pickedRouter)?.hint ?? "Choose an available router."}</p>}
    <p role="status">{project.isError ? "Project files could not be read." : !scopeReady || project.isFetching ? "Checking saved PCB…" : !hasPcb ? "Add a saved PCB in Board before starting routing." : "Routing creates a candidate and keeps the saved PCB. Review the result, then choose whether to apply it."}</p>
    <Button className="fd-routing-start-action" variant="primary" disabled={!canRoute} onClick={() => void startRouting()}>{busy ? "Routing…" : "Start routing"}</Button>
    {ownedRunId && <section className="fd-routing-saved-run"><h3>Saved run</h3>{failureNotice || <p>Recorded {ownedRecord?.status ?? "run"} · inspect playback before starting another run.</p>}</section>}
  </section>;
  const feedback = <>{ownedRunId && !active && ownedRecord?.candidate?.available && <RouteCandidateReview key={ownedRunId} projectId={projectId} runId={ownedRunId} sourceName={sourceName ?? project.data?.name ?? "Saved PCB"} {...(board ? { board } : {})} {...(onOpenPcb ? { onOpenPcb } : {})} enabled={scopeReady && !busy} onBusyChange={setApplying} onChanged={() => { void runRecord.refetch(); void history.refetch(); void project.refetch(); }} />}{route.state.error && <p role="alert" className="text-danger">{route.state.error}</p>}{cancel.state.error && <p role="alert" className="text-danger">{cancel.state.error}</p>}{history.isError && <p role="alert">Routing history could not be loaded. <Button size="sm" onClick={() => void history.refetch()}>Retry history</Button></p>}{frameError && <p role="alert">{frameError} <Button size="sm" onClick={() => setFrameRetry(value => value + 1)}>Retry frames</Button></p>}</>;
  if (!run) return <div className="fd-routing-start">
    <header><div><h1>Routing</h1><p>Start a run when your board is ready for copper routing.</p></div><Button ref={setupTrigger} size="sm" aria-expanded={setupOpen} onClick={() => setSetupOpen(!setupOpen)}>{setupOpen ? "Close setup" : "Set up routing"}</Button></header>
    <div className="fd-routing-start-body" data-setup-open={setupOpen}>{preview ? <RoutingReference projectId={projectId} prefix={prefix} /> : <section className="fd-routing-reference"><EmptyState title={hasPcb ? "Saved PCB" : "Start with a saved PCB"}>Choose Set up routing to review router options and requirements.</EmptyState></section>}{setupOpen && setup}</div>
    <div className="fd-routing-feedback">{history.isLoading && <p role="status">Loading recorded runs…</p>}{ownedRunId && <p role="status">Loading this run’s recorded frames…</p>}{cancelButton}{feedback}</div>
  </div>;

  return (
    <div className="fd-routing-player flex h-full flex-col" data-setup-open={setupOpen}>
      <div className="fd-routing-heading"><strong>Routing</strong><span>{ownedRecord?.router} · {ownedRecord?.result?.state ?? ownedRecord?.status}{ownedRecord?.result?.state && ["complete", "partial"].includes(ownedRecord.result.state) ? ` · ${ownedRecord.result.open.length} unrouted nets in recorded result` : ""} · Current saved PCB coverage unverified</span><Button size="sm" variant="ghost" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>Layers and run details</Button><Button ref={setupTrigger} size="sm" aria-expanded={setupOpen} onClick={() => setSetupOpen(!setupOpen)}>{setupOpen ? "Close setup" : "New run"}</Button>{cancelButton}</div>
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
        {showSavedReference && <><RoutingReference projectId={projectId} prefix={prefix} /><p className="fd-routing-no-frames">This run has no recorded frames. Showing the saved PCB preview.</p></>}
      </div>
    </div>
  );
}
