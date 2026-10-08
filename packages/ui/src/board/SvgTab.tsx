import { useMemo, useState } from "react";
import type { BoardComment, CommentView } from "@fabdesk/protocol";
import { buildCommentAskPrompt, commentAnchorLabel } from "@fabdesk/protocol";
import { Button, EmptyState, Input, LoadError, Spinner, Textarea } from "../components/ui";
import { Icon } from "../components/Icon";
import {
  useBoardCommentMutations,
  useBoardComments,
  useCoreClient,
  useProject,
  useProjectText,
  useRunTool,
} from "@fabdesk/client-core";
import { DRAFT_KEY_NEW, useUiStore } from "../stores/ui";
import { CommentPins } from "./CommentPins";
import { SvgViewer } from "./SvgViewer";
import { parseSvgViewBox, type SvgPoint } from "./svg-coords";

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

/** Schematic / PCB tab: shows the daemon's rendered SVG (`renders/<kind>.svg`, drawn by kicad-cli) and offers to render it. */
export function SvgTab({ kind }: { kind: "schematic" | "pcb" }) {
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const rendered = useProjectText(projectId, `renders/${kind}.svg`);
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

  const view = kind as CommentView;
  const pins = useMemo(
    () => (comments.data?.comments ?? []).filter((comment) => comment.anchor.view === view),
    [comments.data, view],
  );
  const selected = pins.find((comment) => comment.id === selectedId) ?? null;
  const box = rendered.data ? parseSvgViewBox(rendered.data) : null;

  const resetCompose = () => {
    setDraftPoint(null);
    setQuestion("");
    setRef("");
    setNet("");
    setPad("");
  };

  const askAgent = async (comment: BoardComment) => {
    const prompt = buildCommentAskPrompt(comment);
    const threadId = useUiStore.getState().activeThreadId;
    if (threadId) {
      await client.sendMessage(threadId, { content: prompt });
      return;
    }
    useUiStore.getState().setDraft(DRAFT_KEY_NEW, prompt);
    useUiStore.getState().focusComposer();
  };

  const savePin = async () => {
    if (!draftPoint || !question.trim()) return;
    const created = await pin.mutateAsync({
      question: question.trim(),
      anchor: {
        view,
        x: draftPoint.x,
        y: draftPoint.y,
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        ...(net.trim() ? { net: net.trim() } : {}),
        ...(pad.trim() ? { pad: pad.trim() } : {}),
      },
    });
    setSelectedId(created.comment.id);
    resetCompose();
    setCommentMode(false);
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
      <div className="flex h-full min-h-0" data-testid={`board-${kind}-svg`}>
        <div className="min-w-0 flex-1">
          <SvgViewer
            svg={rendered.data}
            commentMode={commentMode}
            onDrawingClick={
              commentMode
                ? (point) => {
                    setDraftPoint(point);
                    setSelectedId(null);
                  }
                : undefined
            }
            overlay={
              <CommentPins
                comments={pins}
                box={box}
                selectedId={selectedId}
                onSelect={(id) => {
                  setSelectedId(id);
                  setDraftPoint(null);
                }}
              />
            }
            toolbar={
              <>
                <Button
                  size="sm"
                  variant={commentMode ? "primary" : "secondary"}
                  onClick={() => {
                    setCommentMode((on) => !on);
                    resetCompose();
                  }}
                  data-testid="comment-mode"
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
        {(selected || draftPoint) && (
          <aside className="flex w-72 shrink-0 flex-col gap-2 overflow-auto border-l border-border p-3" data-testid="comment-detail">
            {draftPoint && (
              <>
                <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">New pin</div>
                <Textarea
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="What is this?"
                  rows={4}
                  aria-label="Comment question"
                />
                <Input value={ref} onChange={(event) => setRef(event.target.value)} placeholder="Ref (U12)" aria-label="Component reference" />
                <Input value={pad} onChange={(event) => setPad(event.target.value)} placeholder="Pad / pin" aria-label="Pad or pin" />
                <Input value={net} onChange={(event) => setNet(event.target.value)} placeholder="Net (SPI.CS)" aria-label="Net name" />
                <div className="flex gap-1">
                  <Button size="sm" variant="primary" disabled={!question.trim() || pin.isPending} onClick={() => void savePin()}>
                    Pin
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
                <div className="text-[13px] font-medium">{selected.question}</div>
                {selected.answer ? (
                  <p className="text-[12.5px] leading-relaxed text-fg/90">{selected.answer}</p>
                ) : (
                  <p className="text-[12px] text-muted">No answer yet. Ask the project agent — it should call comment_answer.</p>
                )}
                <div className="mt-auto flex flex-wrap gap-1">
                  <Button size="sm" variant="primary" onClick={() => void askAgent(selected)}>
                    Ask agent
                  </Button>
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
