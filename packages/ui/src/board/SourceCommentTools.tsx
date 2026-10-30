import { useEffect, useState } from "react";
import { useBoardComments, useBoardCommentMutations } from "@fabdesk/client-core";
import { commentAnchorLabel, type BoardComment, type BoardSourceSelection } from "@fabdesk/protocol";
import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { Button, Dialog, EmptyState, LoadError, Spinner, Textarea } from "../components/ui";
import { ErrorNotice } from "../components/ErrorNotice";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import { CommentPins } from "./CommentPins";
import { buildCommentsAskPrompt, buildCommentsUserPrompt } from "./comment-requests";
import type { SvgBox, SvgPoint } from "./svg-coords";

/** A source's existing comment file, shared across its physical instances, never a root fallback. */
export function useSourceCommentTools({ projectId, board, directory, enabled, canPin, visible }: { projectId: string; board: BoardSourceSelection; directory: string; enabled: boolean; canPin: boolean; visible: boolean }) {
  const comments = useBoardComments(projectId, board, visible && enabled), { pin, patch } = useBoardCommentMutations(projectId, board);
  const [open, setOpen] = useState(false), [point, setPoint] = useState<SvgPoint | null>(null), [question, setQuestion] = useState(""), [selectedId, setSelectedId] = useState<string | null>(null);
  const requested = useUiStore(state => state.commentToReveal);
  const all = comments.data?.comments ?? [], selected = all.find(comment => comment.id === selectedId);
  const ready = visible && enabled && !comments.isFetching && !comments.isError;
  useEffect(() => {
    if (!visible || !requested || requested.projectId !== projectId || requested.board?.sourceId !== board.sourceId || requested.board.manifestSha256 !== board.manifestSha256 || requested.view !== "pcb" || !comments.data) return;
    if (all.some(comment => comment.id === requested.id)) { setSelectedId(requested.id); setPoint(null); setOpen(true); }
    useUiStore.setState({ commentToReveal: null });
  }, [visible, requested, projectId, board.sourceId, board.manifestSha256, comments.data]);
  useAssistantSurface(visible && open ? { projectId, label: "Board / Source comments", priority: 35, details: JSON.stringify({ board, directory, selected: selected ? { id: selected.id, question: selected.question, anchor: selected.anchor } : null, draft: point ? { pointMm: point, question, saved: false } : null }) } : null);
  const ask = (comment: BoardComment) => {
    askAboutSurface({ projectId, label: "Board / Selected source comment", priority: 35, details: JSON.stringify({ instructions: `Use the captured board selector for comment_list, comment_answer and native inspection tools. Never answer a root or sibling comment with the same ID.\n${buildCommentsAskPrompt([comment])}`, board, directory, comment: { id: comment.id, question: comment.question, anchor: comment.anchor }, sourceStatus: "Inspect saved files before answering; a pin is not validation evidence." }) }, buildCommentsUserPrompt([comment]));
    setOpen(false);
  };
  const pinAt = (next: SvgPoint) => { if (!ready || !canPin || pin.isPending || useUiStore.getState().activeProjectId !== projectId) return; setPoint(next); setSelectedId(null); setQuestion(""); pin.reset(); setOpen(true); };
  const overlay = (box: SvgBox | null) => <CommentPins box={box} nativePcbCoordinates comments={all.filter(comment => comment.anchor.view === "pcb")} selectedId={selectedId} onSelect={id => { setSelectedId(id); setPoint(null); setOpen(true); }} />;
  const toolbar = <Button size="sm" variant="ghost" onClick={() => { setPoint(null); setOpen(true); }}><Icon name="pin" width={14} height={14} />Comments{all.length ? ` · ${all.length}` : ""}</Button>;
  const dialog = <Dialog open={visible && open} onClose={() => { if (!pin.isPending) setOpen(false); }} title={point ? "Pin a board comment" : "Board comments"}>
    <p className="mb-3 text-xs text-muted">Source: {board.sourceId} · {directory}/comments.json. Shared instances use the same discussion.</p>
    {!enabled ? <EmptyState title="Board source needs to be checked">Return to source review before changing this discussion.<div className="mt-3"><Button size="sm" onClick={() => { setOpen(false); useUiStore.getState().setBoardTab("updates"); }}>Review source</Button></div></EmptyState> : comments.isPending ? <Spinner /> : comments.isError ? <LoadError title="Could not load this board’s comments" onRetry={() => void comments.refetch()} /> : point ? <div className="space-y-3">
      <p className="text-xs text-muted">{point.x.toFixed(2)}, {point.y.toFixed(2)} mm · saved PCB location</p>
      <Textarea autoFocus aria-label="Board source comment" value={question} onChange={event => setQuestion(event.target.value)} placeholder="What would you like to ask about this location?" rows={4} disabled={pin.isPending} />
      <div className="flex gap-2"><Button size="sm" variant="primary" disabled={!ready || !canPin || !question.trim() || pin.isPending} onClick={() => {
        if (!ready || !canPin || useUiStore.getState().activeProjectId !== projectId) return;
        pin.mutate({ question: question.trim(), anchor: { view: "pcb", coordinateSystem: "kicad-pcb-mm", xMm: point.x, yMm: point.y } }, { onSuccess: result => { setSelectedId(result.comment.id); setPoint(null); setQuestion(""); } });
      }}>{pin.isPending ? "Saving…" : "Save pin"}</Button><Button size="sm" variant="ghost" disabled={pin.isPending} onClick={() => setPoint(null)}>Cancel</Button></div>
      {!canPin && <p role="status" className="text-xs text-warning">Refresh the saved PCB preview and source ownership before saving this location.</p>}
      {pin.isError && <ErrorNotice error={pin.error} />}
    </div> : <div className="space-y-3">
      {!all.length ? <EmptyState title="No comments on this source yet">Select a location on the PCB, then choose Pin comment.</EmptyState> : <select className="w-full rounded-md border border-border bg-panel p-2 text-sm" aria-label="Board source comment" value={selectedId ?? ""} onChange={event => setSelectedId(event.target.value)}><option value="" disabled>Choose a comment…</option>{all.map(comment => <option key={comment.id} value={comment.id}>{comment.status} · {comment.question.slice(0, 100)}</option>)}</select>}
      {selected && <><p className="text-xs text-muted">{selected.anchor.view} · {commentAnchorLabel(selected.anchor)} · {selected.status}</p><p className="text-sm font-medium">{selected.question}</p>{selected.answer && <p className="whitespace-pre-wrap text-sm">{selected.answer}</p>}<div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => ask(selected)}><Icon name="sparkles" width={14} height={14} />Ask fabPlane</Button><Button size="sm" variant="ghost" disabled={!ready || patch.isPending} onClick={() => patch.mutate({ commentId: selected.id, patch: { status: selected.status === "resolved" ? "open" : "resolved" } })}>{selected.status === "resolved" ? "Reopen" : "Resolve"}</Button>{selected.anchor.view === "pcb" && <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Show on board</Button>}</div><p className="text-xs text-muted">Pins record discussion. Recheck the latest source before relying on their locations or answers.</p></>}
      {patch.isError && <ErrorNotice error={patch.error} />}
    </div>}
  </Dialog>;
  return { pinAt, overlay, toolbar, dialog, ready };
}
