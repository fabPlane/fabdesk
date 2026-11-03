import { useEffect, useState } from "react";
import { commentAnchorLabel, commentMillimetrePoint, type BoardComment } from "@fabdesk/protocol";
import { captureAssemblySourceSelection, useBoardComments, useBoardCommentMutations } from "@fabdesk/client-core";
import { Select, Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { ErrorNotice } from "../components/ErrorNotice";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { buildCommentsAskPrompt, buildCommentsUserPrompt } from "./comment-requests";
import { useOutputSource } from "./useOutputSource";
import { ReviewScope } from "./ReviewUpdateLayout";

/** One discussion per native source; repeated physical instances share its saved pins. */
export function ReviewComments() {
  const projectId = useUiStore(s => s.activeProjectId), scope = useOutputSource(projectId ?? "");
  const [legacy, setLegacy] = useState(false), [filter, setFilter] = useState("active");
  useEffect(() => { setLegacy(false); }, [projectId]);
  const assembly = scope.assembly, board = assembly && !legacy ? scope.board : undefined;
  const ready = !!scope.data && !scope.sources.isFetching && !scope.sources.isError && (!assembly || legacy || scope.ready);
  const comments = useBoardComments(projectId, board, ready), { patch } = useBoardCommentMutations(projectId, board);
  const canLocate = ready && (!assembly || !legacy && !!board);
  const all = comments.data?.comments ?? [];
  const visible = all.filter(comment => filter === "all" || (filter === "active" ? comment.status !== "resolved" : comment.status === "resolved"));
  useAssistantSurface(projectId ? { projectId, label: "Review / Comments", priority: 10, details: JSON.stringify({ scope: assembly && legacy ? "Legacy project-root comments; not an assembly member" : scope.row?.source.name ?? "Main board", board, filter, sourceReady: ready, comments: visible.map(comment => ({ id: comment.id, question: comment.question, status: comment.status, anchor: comment.anchor })), instruction: "Inspect the displayed discussion source before answering. Pins record discussion, not validation. Legacy project comments must not be addressed using a remembered member-board selector." }) } : null);
  const openBoard = (comment?: BoardComment) => {
    if (!projectId || !canLocate || useUiStore.getState().activeProjectId !== projectId) return;
    const ui = useUiStore.getState();
    if (assembly) {
      const selection = scope.data && board ? captureAssemblySourceSelection(scope.data, board.sourceId, ui.assemblyBoardByProject[projectId]) : null;
      if (!selection) return;
      ui.setAssemblyBoard(selection);
    }
    if (comment) ui.openBoardComment(comment.id, comment.anchor.view as "pcb" | "schematic", board);
    else ui.setBoardTab("pcb");
  };
  const ask = (comment: BoardComment) => {
    if (!projectId || !ready) return;
    const binding = board ? `Use the captured board selector ${JSON.stringify(board)} for comment_list, comment_answer and native inspection tools. Do not use a root or sibling comment.\n\n` : "";
    askAboutSurface({ projectId, label: "Review / Comments / Selected pin", priority: 20, details: JSON.stringify({ instructions: binding + buildCommentsAskPrompt([comment]), board, sourceDirectory: scope.row?.source.location === "project" ? scope.row.source.directory : undefined, comment: { id: comment.id, question: comment.question, anchor: comment.anchor }, scope: assembly && legacy ? "Legacy project-root pin; not qualified for an assembly member. Verify its source before answering." : "Inspect this saved source before answering; a pin is not validation evidence." }) }, buildCommentsUserPrompt([comment]));
  };
  if (!projectId) return <EmptyState title="Choose a project to review comments" />;
  return <>
    {assembly && <ReviewScope><Select id="comment-source" aria-label="Comment board source" disabled={scope.sources.isFetching || patch.isPending} value={legacy ? "__project__" : scope.sourceId ?? ""} onChange={event => { const root = event.target.value === "__project__"; setLegacy(root); if (!root) scope.choose(event.target.value); }}>
      {!scope.row && !legacy && <option value={scope.sourceId ?? ""} disabled>Choose a board source…</option>}
      {scope.data?.sources.map(row => <option key={row.source.id} value={row.source.id}>{row.source.name}{row.status !== "available" ? " · unavailable" : ""}</option>)}<option value="__project__">Legacy project comments</option>
    </Select></ReviewScope>}
    <div className="fd-review-comments">
      <header><div><h1>Comments</h1><p>{assembly ? legacy ? "Earlier project-level discussion. These pins do not identify an assembly board." : `Discussion for ${scope.row?.source.name ?? "the selected source"}. Shared board instances use the same pins.` : "Questions and answers pinned to this project’s design."}</p></div>
        <Select aria-label="Filter comments" value={filter} onChange={event => setFilter(event.target.value)}><option value="active">Active ({all.filter(c => c.status !== "resolved").length})</option><option value="resolved">Resolved ({all.filter(c => c.status === "resolved").length})</option><option value="all">All ({all.length})</option></Select>
      </header>
      {scope.sources.isError ? <LoadError title="Could not verify comment source" onRetry={() => void scope.sources.refetch()} /> : !scope.data || scope.sources.isFetching ? <Spinner /> : !ready ? <EmptyState title="Select an available board source">Comments are never loaded from another board in its place.<div className="mt-3"><Button disabled={!scope.sourceId || scope.row?.status !== "available"} onClick={() => scope.sourceId && scope.choose(scope.sourceId)}>Select source again</Button></div></EmptyState> : comments.isError ? <LoadError title="Could not load comments" onRetry={() => void comments.refetch()} /> : comments.isPending ? <Spinner /> : <>
        {patch.isError && <ErrorNotice error={patch.error} />}
        {!visible.length ? <EmptyState title={all.length ? "No comments in this view" : "No comments yet"} icon={<Icon name="pin" width={34} height={34} />}>
          <p>{all.length ? filter === "active" ? "All saved comments are resolved. You can review them or add a new pin on the drawing." : "No resolved comments yet. Switch back to the active discussion." : assembly && legacy ? "Keep new board questions with the selected source. Choose a board in Scope to review its discussion." : "Select a location on the PCB and choose Pin comment."}</p>
          <div className="mt-4 flex justify-center gap-2">{all.length > 0 && <Button onClick={() => setFilter(filter === "active" ? "resolved" : "active")}>{filter === "active" ? "View resolved comments" : "View active comments"}</Button>}{canLocate ? <Button variant={all.length ? "ghost" : "secondary"} onClick={() => openBoard()}>Open PCB</Button> : <Button onClick={() => useUiStore.getState().setBoardTab("notes")}>Open project notes</Button>}</div>
        </EmptyState> : <ul>{visible.map(comment => <li key={comment.id}>
          <div className="fd-review-comment-meta"><span>{comment.anchor.view === "pcb" ? "PCB" : comment.anchor.view === "schematic" ? "Schematic" : comment.anchor.view === "3d" ? "3D" : "Product"} · {commentAnchorLabel(comment.anchor)}</span><span>{comment.status}</span></div>
          {comment.anchor.view === "pcb" && (comment.anchor.x !== undefined || comment.anchor.y !== undefined) && !commentMillimetrePoint(comment.anchor) && <p className="mt-2 text-xs text-warning">Drawing origin unverified · Confirm this pin on an updated PCB preview.</p>}
          <h2>{comment.question}</h2>{comment.answer && <p className="fd-review-comment-answer">{comment.answer}</p>}
          <div className="fd-review-comment-actions">
            {canLocate && (comment.anchor.view === "pcb" || !assembly && comment.anchor.view === "schematic") && <Button size="sm" onClick={() => openBoard(comment)}><Icon name="pin" width={14} height={14} />Show on drawing</Button>}
            <Button size="sm" variant="ghost" onClick={() => ask(comment)}><Icon name="sparkles" width={14} height={14} />Ask about this</Button>
            <Button size="sm" variant="ghost" disabled={patch.isPending} onClick={() => patch.mutate({ commentId: comment.id, patch: { status: comment.status === "resolved" ? "open" : "resolved" } })}>{comment.status === "resolved" ? "Reopen" : "Resolve"}</Button>
          </div>
        </li>)}</ul>}
      </>}
    </div>
  </>;
}
