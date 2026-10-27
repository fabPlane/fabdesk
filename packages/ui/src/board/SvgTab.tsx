import { useEffect, useMemo, useRef, useState } from "react";
import type { BoardComment, CommentView } from "@fabdesk/protocol";
import { commentAnchorLabel, commentMillimetrePoint } from "@fabdesk/protocol";
import { Button, EmptyState, IconButton, Input, LoadError, Spinner, Textarea } from "../components/ui";
import { Icon } from "../components/Icon";
import {
  useBoardCommentMutations,
  useBoardComments,
  useCoreClient,
  useProject,
  usePcbPreviewRevision,
  pcbSvgHasNativeCoordinates,
  useProjectText,
  useRunTool,
} from "@fabdesk/client-core";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { NativePartTools } from "./NativePartTools";
import { PcbPreviewStatus } from "./PcbPreviewStatus";
import { CommentPins } from "./CommentPins";
import { SvgViewer } from "./SvgViewer";
import { type SvgPoint } from "./svg-coords";
import { buildCommentsAskPrompt, pendingBoardComments } from "./comment-requests";

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
    title: `No ${label} SVG render yet`,
    action: `Render ${label} SVG`,
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
export function SvgTab({ kind }: { kind: "schematic" | "pcb" }) {
  const commentToReveal = useUiStore((s) => s.commentToReveal);
  const canvasMode = useUiStore((s) => s.canvasMode);
  const [canvasPoint, setCanvasPoint] = useState<SvgPoint | null>(null);
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const rendered = useProjectText(projectId, `renders/${kind}.svg`);
  const nativeCoordinates = kind === "pcb" && pcbSvgHasNativeCoordinates(rendered.data ?? "");
  const previousFrame = useRef(nativeCoordinates);
  const revision = usePcbPreviewRevision(projectId, canvasMode && kind === "pcb" && !!rendered.data);
  useEffect(() => {
    if (previousFrame.current !== nativeCoordinates) { setCanvasPoint(null); setDraftPoint(null); setSelectedId(null); }
    previousFrame.current = nativeCoordinates;
  }, [nativeCoordinates]);
  const render = useRunTool();
  const comments = useBoardComments(projectId);
  const { pin, patch } = useBoardCommentMutations(projectId);
  const client = useCoreClient();
  const [commentMode, setCommentMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftPoint, setDraftPoint] = useState<SvgPoint | null>(null);
  const [question, setQuestion] = useState("");
  const [ref, setRef] = useState("");
  const [net, setNet] = useState("");
  const [pad, setPad] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  useEffect(() => { setCanvasPoint(null); }, [projectId, kind]);
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
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-testid="comment-mode"]')?.focus());
  };

  const askAgent = async (targets: BoardComment[]) => {
    if (asking || targets.length === 0) return;
    setAsking(true);
    setAskError(null);
    try {
      const prompt = buildCommentsAskPrompt(targets);
      const threadId = useUiStore.getState().activeThreadId;
      if (threadId) {
        await client.sendMessage(threadId, { content: prompt });
      } else {
        useUiStore.getState().setDraft(newChatDraftKey(useUiStore.getState().activeProjectId), prompt);
        useUiStore.getState().focusComposer();
      }
    } catch (error) {
      setAskError(error instanceof Error ? error.message : "Could not send the pinned comments. Try again.");
    } finally {
      setAsking(false);
    }
  };

  const savePin = async () => {
    if (!draftPoint || !question.trim()) return;
    const created = await pin.mutateAsync({
      question: question.trim(),
      anchor: commentPinAnchor(view, draftPoint, {
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        ...(net.trim() ? { net: net.trim() } : {}),
        ...(pad.trim() ? { pad: pad.trim() } : {}),
      }, nativeCoordinates),
    });
    setSelectedId(created.comment.id);
    resetCompose();
    setCommentMode(true);
  };

  if (!projectId)
    return (
      <div className="fd-canvas-empty h-full"><EmptyState title="Your board starts here" icon={<BoardOutline />}>
        Pick a project in the sidebar to see its {kind}.
      </EmptyState></div>
    );
  if (project.isLoading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (project.isError) return <LoadError title="Could not load project files" onRetry={() => void project.refetch()} />;
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
      <div className="relative flex h-full min-h-0" data-testid={`board-${kind}-svg`} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (canvasPoint) setCanvasPoint(null); else if (selected || draftPoint || commentMode) closeComments(); } }}>
        {canvasMode && kind === "pcb" && <PcbPreviewStatus projectId={projectId} coordinatesVerified={nativeCoordinates} busy={render.state.status === "running"} error={render.state.error ?? null} onUpdate={() => void render.run(RENDER_TOOL.pcb, { projectId })} />}
        <div className="min-w-0 flex-1">
          <SvgViewer
            svg={rendered.data}
            viewKey={`${projectId}:${kind}`}
            commentMode={commentMode}
            {...((commentMode || canvasMode) ? { onDrawingClick: (point: SvgPoint) => {
              if (commentMode) { setDraftPoint(point); setSelectedId(null); }
              else setCanvasPoint(point);
            } } : {})}
            overlay={(box) => <>
              <CommentPins nativePcbCoordinates={nativeCoordinates} comments={pins} box={box} selectedId={selectedId} draftPoint={draftPoint}
                onSelect={(id) => { setSelectedId(id); setDraftPoint(null); setCanvasPoint(null); }} />
              {canvasMode && canvasPoint && box && !commentMode && <div data-canvas-tools className="fd-location-anchor" style={{ left: `${(canvasPoint.x - box.x) / box.width * 100}%`, top: `${(canvasPoint.y - box.y) / box.height * 100}%` }}>
                <span className="fd-location-marker" />
                <div className="fd-location-toolbar" style={{ transform: `translateX(${(canvasPoint.x - box.x) / box.width < .25 ? "0" : (canvasPoint.x - box.x) / box.width > .75 ? "-100%" : "-50%"})` }} aria-label="Selected drawing location">
                  <span>{nativeCoordinates ? `${canvasPoint.x.toFixed(1)}, ${canvasPoint.y.toFixed(1)} mm` : "Drawing location"}</span>
                  <Button variant="ghost" size="sm" onClick={() => {
                    const ui = useUiStore.getState();
                    const key = ui.activeThreadId ?? newChatDraftKey(ui.activeProjectId);
                    const prompt = `Explain this ${kind === "pcb" ? "PCB" : "schematic"} location near ${canvasPoint.x.toFixed(2)}, ${canvasPoint.y.toFixed(2)}${nativeCoordinates ? " native PCB mm" : kind === "pcb" ? " drawing units (PCB origin not verified)" : " SVG units"}.`;
                    const existing = ui.drafts[key] ?? "";
                    ui.setDraft(key, existing.trim() ? `${existing}\n\n${prompt}` : prompt);
                    ui.focusComposer();
                    setCanvasPoint(null);
                  }}><Icon name="sparkles" width={15} height={15} />Ask about this</Button>
                  <Button variant="ghost" size="sm" onClick={() => { setDraftPoint(canvasPoint); setCanvasPoint(null); setSelectedId(null); setCommentMode(true); }}><Icon name="pin" width={15} height={15} />Pin comment</Button>
                  {kind === "pcb" && <NativePartTools projectId={projectId} point={canvasPoint} canPosition={nativeCoordinates && revision.data === "matches-source"} openAbove={(canvasPoint.y - box.y) / box.height > .5} onMoved={setCanvasPoint} />}
                  <IconButton size="sm" title="Deselect location" onClick={() => setCanvasPoint(null)}><Icon name="close" width={15} height={15} /></IconButton>
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
        {(selected || draftPoint || commentMode) && (
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
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="What is this?"
                  rows={4}
                  aria-label="Comment question"
                />
                <p className="mt-1 text-[11px] text-muted">Optional details: the board location is already captured. Add these only if you know them.</p>
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
                <div className="flex gap-1">
                  <Button size="sm" variant="primary" disabled={!question.trim() || pin.isPending} onClick={() => void savePin()}>
                    Save pin
                  </Button>
                  <Button size="sm" variant="ghost" onClick={resetCompose}>Cancel</Button>
                </div>
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
                    <Button size="sm" onClick={() => void patch.mutateAsync({ commentId: selected.id, patch: { status: "resolved" } })}>
                      Resolve
                    </Button>
                  )}
                  {selected.status === "resolved" && (
                    <Button size="sm" onClick={() => void patch.mutateAsync({ commentId: selected.id, patch: { status: "open" } })}>
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
                  <Button size="sm" variant="primary" disabled={asking} onClick={() => void askAgent(pendingPins)}>
                    {asking ? "Sending…" : `Ask agent about ${pendingPins.length} pin${pendingPins.length === 1 ? "" : "s"}`}
                  </Button>
                </> : selected && <Button size="sm" disabled={asking} onClick={() => void askAgent([selected])}>{asking ? "Sending…" : "Ask again about this pin"}</Button>}
                {askError && <p role="alert" className="text-xs text-danger">{askError}</p>}
              </div>
            )}
          </aside>
        )}
      </div>
    );
  }
  const sourcePath = kind === "pcb" ? "board.kicad_pcb" : "board.kicad_sch";
  if (!project.data?.files.some((file) => file.path === sourcePath))
    return <div className="fd-canvas-empty h-full" data-testid={`board-${kind}-missing-source`}><EmptyState title={kind === "pcb" ? "No KiCad board found" : "No KiCad schematic found"} icon={<BoardOutline />}>
      {kind === "pcb" ? "Add a KiCad board to this project to preview it here." : "Add a KiCad schematic to this project to preview it here."}
    </EmptyState></div>;
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
            disabled={running}
            onClick={() => void render.run(RENDER_TOOL[kind], { projectId })}
          >
            {running ? "Rendering..." : copy.action}
          </Button>
        }
      >
        {kind === "pcb"
          ? "Generate a preview from your saved PCB to inspect the layout. Image exports are available in Renders."
          : "Generate a preview from your saved KiCad schematic to inspect the circuit alongside your conversation."}
        {render.state.error && <div className="mt-2 text-danger">{render.state.error}</div>}
      </EmptyState>
    </div>
  );
}
