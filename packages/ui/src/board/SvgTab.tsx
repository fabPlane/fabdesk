import { useProjectExitGuard } from "../hooks/useProjectExitGuard";
import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardComment, CommentView } from "@fabdesk/protocol";
import { commentAnchorLabel, commentMillimetrePoint } from "@fabdesk/protocol";
import { Button, EmptyState, IconButton, Input, LoadError, Spinner, Textarea } from "../components/ui";
import { Icon } from "../components/Icon";
import { ErrorNotice } from "../components/ErrorNotice";
import {
  useBoardCommentMutations,
  useBoardSources,
  useBoardComments,
  useProject,
  useThreads,
  useRunsStore,
  usePcbPreviewRevision,
  pcbSvgHasNativeCoordinates,
  useProjectText,
  useRunTool,
} from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { RootFindingOverlay } from "./RootFindingOverlay";
import { NativePartTools } from "./NativePartTools";
import { PcbPreviewStatus } from "./PcbPreviewStatus";
import { CommentPins } from "./CommentPins";
import { SvgViewer } from "./SvgViewer";
import { type SvgPoint } from "./svg-coords";
import { buildCommentsAskPrompt, buildCommentsUserPrompt, pendingBoardComments } from "./comment-requests";
import { SchematicPreviewStatus } from "./SchematicPreviewStatus";
import { MissingNativeSource } from "./MissingNativeSource";

const RENDER_TOOL = { schematic: "render_schematic_svg", pcb: "render_pcb_svg" } as const;

function BoardOutline() {
  return <svg width="100" height="76" viewBox="0 0 100 76" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <rect x="10" y="8" width="80" height="60" rx="8" opacity=".5" />
    <rect x="39" y="25" width="22" height="26" rx="3" />
    <path d="M44 19v6m12-6v6M44 51v6m12-6v6M33 32h6m-6 12h6m22-12h6m-6 12h6M10 28h12l9 10h8M61 38h12l10-10h7" opacity=".6" />
    <circle cx="19" cy="17" r="2" /><circle cx="81" cy="59" r="2" />
  </svg>;
}

export function svgArtifactCopy(kind: "schematic" | "pcb") {
  const label = kind === "pcb" ? "PCB" : "schematic";
  return {
    label,
    title: `No ${label} preview yet`,
    action: `Create ${label} preview`,
  };
}

/** Only exporter-verified native coordinates can be sent as PCB millimetres. */
export function commentPinAnchor(
  view: CommentView,
  point: SvgPoint,
  fields: { ref?: string; net?: string; pad?: string } = {},
  nativeCoordinates = true,
) {
  return {
    view,
    x: point.x,
    y: point.y,
    ...(view === "pcb" ? { coordinateSystem: nativeCoordinates ? "kicad-pcb-mm" as const : "svg" as const } : {}),
    ...(view === "pcb" && nativeCoordinates ? { xMm: point.x, yMm: point.y } : {}),
    ...(fields.ref ? { ref: fields.ref } : {}),
    ...(fields.net ? { net: fields.net } : {}),
    ...(fields.pad ? { pad: fields.pad } : {}),
  };
}

/** Schematic / PCB tab: shows the daemon's rendered SVG (`renders/<kind>.svg`, drawn by kicad-cli) and offers to render it. */
export function SvgTab({ kind, active = true, onOpenChecks }: { kind: "schematic" | "pcb"; active?: boolean; onOpenChecks?: () => void }) {
  const commentTrigger = useRef<HTMLButtonElement>(null);
  const commentToReveal = useUiStore((s) => s.commentToReveal);
  const canvasMode = useUiStore((s) => s.canvasMode);
  const findingRequested = useUiStore((s) => kind === "pcb" && s.rootFinding?.projectId === s.activeProjectId);
  const [canvasPoint, setCanvasPoint] = useState<SvgPoint | null>(null);
  const [nativeEditBusy, setNativeEditBusy] = useState(false);
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const threads = useThreads(projectId ? { projectId } : {});
  const projectWorking = useRunsStore(state => Object.keys(state.runsByThread).some(id => threads.data?.some(thread => thread.id === id)) || Object.values(state.jobs).some(job => job.projectId === projectId && (job.status === "running" || job.status === "queued")));
  const autoPreview = useRef<string | null>(null);
  const sources = useBoardSources(projectId);
  const scopeReady = sources.data?.mode === "single" && !sources.isFetching && !sources.isError;
  const rendered = useProjectText(projectId, `renders/${kind}.svg`);
  const nativeCoordinates = kind === "pcb" && pcbSvgHasNativeCoordinates(rendered.data ?? "");
  const previousFrame = useRef(nativeCoordinates);
  const revision = usePcbPreviewRevision(projectId, (canvasMode || findingRequested) && kind === "pcb" && !!rendered.data);
  useEffect(() => {
    if (previousFrame.current !== nativeCoordinates) { setCanvasPoint(null); setDraftPoint(null); setSelectedId(null); }
    previousFrame.current = nativeCoordinates;
  }, [nativeCoordinates]);
  const render = useRunTool();
  const comments = useBoardComments(projectId);
  const { pin, patch } = useBoardCommentMutations(projectId);
  const [commentMode, setCommentMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftPoint, setDraftPoint] = useState<SvgPoint | null>(null);
  const [question, setQuestion] = useState("");
  const [ref, setRef] = useState("");
  const [net, setNet] = useState("");
  const [pad, setPad] = useState("");

  useProjectExitGuard(projectId, pin.isPending || patch.isPending ? "A drawing comment is being saved. Wait for it to finish." : draftPoint && (question.trim() || ref.trim() || net.trim() || pad.trim()) ? "Save or cancel the unfinished drawing comment." : null);

  useEffect(() => { setCanvasPoint(null); setNativeEditBusy(false); }, [projectId, kind]);
  const view = kind as CommentView;
  const pins = useMemo(
    () => (comments.data?.comments ?? []).filter((comment) => comment.anchor.view === view),
    [comments.data, view],
  );
  useEffect(() => {
    if (!commentToReveal || commentToReveal.projectId !== projectId || commentToReveal.view !== kind || !comments.data) return;
    if (pins.some((comment) => comment.id === commentToReveal.id)) {
      setSelectedId(commentToReveal.id);
      setCommentMode(true);
      setDraftPoint(null);
    }
    useUiStore.setState({ commentToReveal: null });
  }, [commentToReveal, projectId, kind, comments.data, pins]);
  const selected = pins.find((comment) => comment.id === selectedId) ?? null;
  useAssistantSurface(projectId && selected ? { projectId, label: `${kind === "pcb" ? "Board" : "Schematic"} · Comment`, priority: 15, details: JSON.stringify({ view: kind, comment: { id: selected.id, question: selected.question, anchor: selected.anchor } }) } : null);
  const pendingPins = pendingBoardComments(pins, view);
  const beginPin = () => {
    resetCompose();
    setSelectedId(null);
    setCommentMode(true);
  };

  const resetCompose = () => {
    setDraftPoint(null);
    setQuestion("");
    setRef("");
    setNet("");
    setPad("");
  };

  const closeComments = () => {
    setSelectedId(null);
    setCommentMode(false);
    resetCompose();
    requestAnimationFrame(() => commentTrigger.current?.focus());
  };

  const askAgent = (targets: BoardComment[]) => {
    if (!projectId || targets.length === 0) return;
    askAboutSurface({ projectId, priority: 20, label: `${kind === "pcb" ? "PCB" : "Schematic"} · Pinned comments`, details: JSON.stringify({ instructions: buildCommentsAskPrompt(targets), view: kind, source: kind === "pcb" ? "board.kicad_pcb" : "board.kicad_sch", comments: targets.map(comment => ({ id: comment.id, question: comment.question, anchor: comment.anchor })), sourceStatus: "Inspect the saved source before answering; pin locations are not validation results." }) }, buildCommentsUserPrompt(targets));
  };

  const savePin = () => {
    if (!draftPoint || !question.trim()) return;
    pin.mutate({
      question: question.trim(),
      anchor: commentPinAnchor(view, draftPoint, {
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        ...(net.trim() ? { net: net.trim() } : {}),
        ...(pad.trim() ? { pad: pad.trim() } : {}),
      }, nativeCoordinates),
    }, { onSuccess: created => {
      setSelectedId(created.comment.id);
      resetCompose();
      setCommentMode(true);
    } });
  };
  const refreshPreview = () => {
    if (!projectId || !scopeReady || useUiStore.getState().activeProjectId !== projectId) return;
    void render.run(RENDER_TOOL[kind], { projectId }).then(result => { if (result.status === "done") { void rendered.refetch(); if (kind === "pcb") void revision.refetch(); } });
  };
  useEffect(() => {
    // Read the saved source once a build/agent has settled. Alternate image exports are not
    // a coordinate or freshness receipt, so create the normal canvas preview through its tool.
    if (!projectId || !active || !scopeReady || projectWorking || threads.isPending || threads.isError || project.isPending || project.isFetching || project.isError || rendered.isPending || rendered.isError || rendered.data || render.state.status === "running" || !project.data.files.some(file => file.path === `board.kicad_${kind === "pcb" ? "pcb" : "sch"}`)) return;
    const key = `${projectId}/${kind}`;
    if (autoPreview.current === key) return;
    autoPreview.current = key;
    void render.run(RENDER_TOOL[kind], { projectId }).then(result => { if (result.status === "done") { void rendered.refetch(); if (kind === "pcb") void revision.refetch(); } });
  }, [projectId, active, scopeReady, projectWorking, threads.isPending, threads.isError, project.data, project.isPending, project.isFetching, project.isError, rendered.data, rendered.isPending, rendered.isError, render.state.status, kind, render.run]);

  if (!projectId)
    return (
      <div className="fd-canvas-empty h-full"><EmptyState title="Your board starts here" icon={<BoardOutline />}>
        Choose a project to see its {kind}.
      </EmptyState></div>
    );
  if (project.isLoading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (project.isError) return <LoadError title="Could not load project files" onRetry={() => void project.refetch()} />;
  if (sources.isError && !sources.data) return <LoadError title="Could not verify board source scope" onRetry={() => void sources.refetch()} />;
  if (!sources.data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (sources.data.mode === "assembly") return <EmptyState title="Open this assembly’s board canvas" action={<Button onClick={() => { const ui = useUiStore.getState(); ui.setCanvasMode(true); ui.setBoardTab("pcb"); }}>Open assembly canvas</Button>}>Choose an individual board to view its own PCB and schematic.</EmptyState>;
  if (rendered.isError) return <LoadError title="Could not load board preview" onRetry={() => void rendered.refetch()} />;
  if (rendered.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (rendered.data) {
    return (
      <div className="relative flex h-full min-h-0" data-testid={`board-${kind}-svg`} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (canvasPoint) { const drawing = event.currentTarget.querySelector<HTMLElement>(".fd-svg-host"); setCanvasPoint(null); requestAnimationFrame(() => drawing?.focus({ preventScroll: true })); } else if (selected || draftPoint || commentMode) closeComments(); else if (findingRequested) { const drawing = event.currentTarget.querySelector<HTMLElement>(".fd-svg-host"); useUiStore.getState().dismissRootFinding(); requestAnimationFrame(() => drawing?.focus({ preventScroll: true })); } } }}>
        {canvasMode && kind === "pcb" && <PcbPreviewStatus projectId={projectId} coordinatesVerified={nativeCoordinates} scopeReady={scopeReady} {...(sources.isError ? { onRetryScope: () => void sources.refetch() } : {})} busy={render.state.status === "running" || nativeEditBusy} error={render.state.error ?? null} onUpdate={refreshPreview} />}
        {canvasMode && kind === "schematic" && <SchematicPreviewStatus scopeReady={scopeReady} hasSource={project.data?.files.some(file => file.path === "board.kicad_sch") ?? false} updated={render.state.status === "done"} busy={render.state.status === "running"} error={render.state.error ?? null} onUpdate={refreshPreview} onOpenSource={() => { if (useUiStore.getState().activeProjectId === projectId) useUiStore.getState().openProjectFile("board.kicad_sch"); }} {...(sources.isError ? { onRetryScope: () => void sources.refetch() } : {})} />}
        <div className="min-w-0 flex-1">
          <SvgViewer
            svg={rendered.data}
            initialFit={kind === "schematic" ? "width" : "sheet"}
            viewKey={`${projectId}:${kind}`}
            commentMode={commentMode}
            {...((commentMode || canvasMode) ? { onDrawingClick: (point: SvgPoint) => {
              if (commentMode) { setDraftPoint(point); setSelectedId(null); }
              else setCanvasPoint(point);
            } } : {})}
            overlay={(box) => <>
              {kind === "pcb" && active && <RootFindingOverlay {...(onOpenChecks ? { onOpenChecks } : {})} projectId={projectId} svg={rendered.data!} box={box} ready={scopeReady && nativeCoordinates && revision.data === "matches-source" && !revision.isFetching && !revision.isError} />}
              <CommentPins nativePcbCoordinates={nativeCoordinates} comments={pins} box={box} selectedId={selectedId} draftPoint={draftPoint}
                onSelect={(id) => { setSelectedId(id); setDraftPoint(null); setCanvasPoint(null); }} />
              {canvasMode && canvasPoint && box && !commentMode && <div data-canvas-tools className="fd-location-anchor" style={{ visibility: active ? "visible" : "hidden", left: `${(canvasPoint.x - box.x) / box.width * 100}%`, top: `${(canvasPoint.y - box.y) / box.height * 100}%` }}>
                <span className="fd-location-marker" />
                <div className="fd-location-toolbar" style={{ transform: `translateX(${(canvasPoint.x - box.x) / box.width < .25 ? "0" : (canvasPoint.x - box.x) / box.width > .75 ? "-100%" : "-50%"})` }} aria-label="Selected drawing location">
                  <span>{nativeCoordinates ? `${canvasPoint.x.toFixed(1)}, ${canvasPoint.y.toFixed(1)} mm` : "Drawing location"}</span>
                  <Button variant="ghost" size="sm" onClick={() => {
                    const ui = useUiStore.getState();
                    if (ui.activeProjectId !== projectId) return;
                    askAboutSurface({ projectId, label: `${kind === "pcb" ? "PCB" : "Schematic"} / Selected location`, priority: 20, details: JSON.stringify({ view: kind, source: kind === "pcb" ? "board.kicad_pcb" : "board.kicad_sch", point: canvasPoint, coordinateSystem: nativeCoordinates ? "kicad-pcb-mm" : "svg-units-unverified-native-origin", previewRevision: kind === "pcb" ? revision.data : "unverified", instruction: "Inspect the saved native design. Do not interpret unverified drawing coordinates as native millimetres or claim checks passed." }) }, `Explain the selected ${kind === "pcb" ? "PCB" : "schematic"} location and what I should check there.`);
                    setCanvasPoint(null);
                  }}><Icon name="sparkles" width={15} height={15} />Ask about this</Button>
                  <Button variant="ghost" size="sm" onClick={() => { setDraftPoint(canvasPoint); setCanvasPoint(null); setSelectedId(null); setCommentMode(true); }}><Icon name="pin" width={15} height={15} />Pin comment</Button>
                  {kind === "pcb" && <NativePartTools visible={active} onMutationBusyChange={busy => { if (useUiStore.getState().activeProjectId === projectId) setNativeEditBusy(busy); }} box={box} projectId={projectId} point={canvasPoint} canPosition={scopeReady && nativeCoordinates && revision.data === "matches-source" && !revision.isError && !revision.isFetching} openAbove={(canvasPoint.y - box.y) / box.height > .5} onMoved={setCanvasPoint} />}
                  <IconButton size="sm" title="Deselect location" onClick={event => { const drawing = event.currentTarget.closest<HTMLElement>(".fd-svg-host"); setCanvasPoint(null); requestAnimationFrame(() => drawing?.focus({ preventScroll: true })); }}><Icon name="close" width={15} height={15} /></IconButton>
                </div>
              </div>}
            </>}
            toolbar={
              <>
                <Button
                  size="sm"
                  variant={commentMode ? "primary" : "secondary"}
                  onClick={() => {
                    if (commentMode || selected || draftPoint) closeComments();
                    else beginPin();
                  }}
                  ref={commentTrigger}
                  data-testid="comment-mode"
                  aria-pressed={commentMode || !!selected || !!draftPoint}
                  title="Pin a question to this drawing"
                >
                  <Icon name="pin" width={14} height={14} />
                  Comment
                </Button>
                <span className="text-[11px] text-muted">
                  {commentMode ? "Click the board to drop a pin" : `${pins.length} pin${pins.length === 1 ? "" : "s"} · renders/${kind}.svg`}
                </span>
              </>
            }
          />
        </div>
        {active && (selected || draftPoint || commentMode) && (
          <aside className="flex w-72 shrink-0 flex-col gap-2 overflow-auto border-l border-border p-3" data-testid="comment-detail">
            <div className="flex items-center justify-between"><strong className="text-sm">Pinned comments</strong><IconButton size="sm" title="Close comments" onClick={closeComments}><Icon name="close" width={16} height={16} /></IconButton></div>
            {pins.length > 0 && (
              <div className="mb-1 border-b border-border pb-3">
                <p className="mb-2 text-xs font-medium">Pins on this {kind === "pcb" ? "PCB" : "schematic"}</p>
                <ul className="max-h-40 space-y-1 overflow-auto">
                  {pins.map((comment, index) => (
                    <li key={comment.id}>
                      <button type="button" aria-pressed={selectedId === comment.id && !draftPoint}
                        className="flex w-full items-center gap-2 rounded border border-transparent px-2 py-1.5 text-left text-xs hover:bg-panel-2 aria-pressed:border-accent aria-pressed:bg-panel-2"
                        onClick={() => { setSelectedId(comment.id); resetCompose(); }} title={comment.question}>
                        <span className="font-mono text-muted">{index + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{comment.question}</span>
                        <span className="text-[10px] text-muted">{comment.status === "resolved" ? "Resolved" : comment.answer ? "Answered" : "Pending"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {commentMode && !selected && !draftPoint && <p className="text-xs text-muted">Click a location on the board to add a pin. Collect your comments, then ask the agent about them together.</p>}
            {draftPoint && (
              <>
                <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">New pin</div>
                <p className="text-xs text-muted">The blue marker shows the selected location. Click another spot on the board to move it.</p>
                <Textarea
                  autoFocus
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="What is this?"
                  rows={4}
                  aria-label="Comment question"
                />
                <details className="fd-comment-optional"><DisclosureSummary icon="pin" label="Component, pin or net" badge="Optional" /><div className="mt-3 space-y-3">
                <p className="text-[11px] text-muted">The board location is already captured. Add these details if you know them.</p>
                <label className="flex flex-col gap-1 text-xs">
                  <span>Component reference <span className="text-muted">(optional)</span></span>
                  <Input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="e.g. R2, D1, U12" />
                  <span className="text-[11px] text-muted">The part’s label on the board or schematic.</span>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span>Pin or pad number <span className="text-muted">(optional)</span></span>
                  <Input value={pad} onChange={(event) => setPad(event.target.value)} placeholder="e.g. 1 or A1" />
                  <span className="text-[11px] text-muted">A specific connection on that component.</span>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span>Signal / net name <span className="text-muted">(optional)</span></span>
                  <Input value={net} onChange={(event) => setNet(event.target.value)} placeholder="e.g. GND, VCC, SPI.CS" />
                  <span className="text-[11px] text-muted">The named electrical connection you’re asking about.</span>
                </label>
                </div></details>
                <div className="flex gap-1">
                  <Button size="sm" variant="primary" disabled={!question.trim() || pin.isPending} onClick={savePin}>
                    {pin.isPending ? "Saving pin…" : "Save pin"}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pin.isPending} onClick={resetCompose}>Cancel</Button>
                </div>
                {pin.isError && <ErrorNotice error={pin.error} />}
              </>
            )}
            {selected && !draftPoint && (
              <>
                <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">
                  {commentAnchorLabel(selected.anchor)}
                </div>
                {kind === "pcb" && !commentMillimetrePoint(selected.anchor) && <p className="text-xs text-warning">This pin’s PCB origin is unverified. Confirm its location on an updated preview before using it for native edits.</p>}
                <div className="text-[13px] font-medium">{selected.question}</div>
                {selected.answer ? (
                  <p className="text-[12.5px] leading-relaxed text-fg/90">{selected.answer}</p>
                ) : (
                  <p className="text-[12px] text-muted">Saved. Add more pins, or ask the agent when you’re ready.</p>
                )}
                <div className="flex flex-wrap gap-1">
                  {selected.status !== "resolved" && (
                    <Button size="sm" disabled={patch.isPending} onClick={() => patch.mutate({ commentId: selected.id, patch: { status: "resolved" } })}>
                      Resolve
                    </Button>
                  )}
                  {selected.status === "resolved" && (
                    <Button size="sm" disabled={patch.isPending} onClick={() => patch.mutate({ commentId: selected.id, patch: { status: "open" } })}>
                      Reopen
                    </Button>
                  )}
                </div>
              </>
            )}
            {!draftPoint && (
              <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
                <Button size="sm" onClick={beginPin}>Add another pin</Button>
                {pendingPins.length > 0 ? <>
                  <p className="text-[11px] text-muted">Send all {pendingPins.length} unanswered pin{pendingPins.length === 1 ? "" : "s"} in this view as one request.</p>
                  <Button size="sm" variant="primary" onClick={() => askAgent(pendingPins)}>
                    {`Ask fabPlane about ${pendingPins.length} pin${pendingPins.length === 1 ? "" : "s"}`}
                  </Button>
                </> : selected && <Button size="sm" onClick={() => askAgent([selected])}>Ask again about this pin</Button>}
                <p className="text-[11px] text-muted">Review the question in Ask fabPlane, then send when ready.</p>
                {patch.isError && <ErrorNotice error={patch.error} />}
              </div>
            )}
          </aside>
        )}
      </div>
    );
  }
  const sourcePath = kind === "pcb" ? "board.kicad_pcb" : "board.kicad_sch";
  if (!project.data?.files.some((file) => file.path === sourcePath))
    return <MissingNativeSource key={`${projectId}/${kind}`} projectId={projectId} kind={kind} enabled={scopeReady} visible={active} />;
  const running = render.state.status === "running";
  const copy = svgArtifactCopy(kind);
  return (
    <div className="fd-canvas-empty h-full" data-testid={`board-${kind}-empty`}>
      <EmptyState
        title={copy.title}
        icon={<BoardOutline />}
        action={
          <Button
            variant="primary"
            size="sm"
            disabled={running || !scopeReady}
            onClick={refreshPreview}
          >
            {running ? "Creating preview…" : copy.action}
          </Button>
        }
      >
        {kind === "pcb"
          ? "Create a drawing from your saved PCB to inspect the layout. Image exports are available in Outputs."
          : "Create a drawing from your saved KiCad schematic to inspect the circuit here."}
        {render.state.error && <div role="alert" className="mt-2 text-danger">{render.state.error}</div>}
      </EmptyState>
    </div>
  );
}
