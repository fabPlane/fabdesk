import { useState } from "react";
import { commentAnchorLabel, commentMillimetrePoint, type BoardComment } from "@fabdesk/protocol";
import { useBoardSources, useBoardComments, useBoardCommentMutations } from "@fabdesk/client-core";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { buildCommentsAskPrompt } from "./comment-requests";

/** The same persisted pins as the drawing, collected alongside changes and checks. */
export function ReviewComments() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const sources = useBoardSources(projectId);
  const assembly = sources.data?.mode === "assembly";
  const canLocate = !sources.isPending && !sources.isFetching && !sources.isError && !assembly;
  const comments = useBoardComments(projectId);
  const { patch } = useBoardCommentMutations(projectId);
  const [filter, setFilter] = useState("active");
  const all = comments.data?.comments ?? [];
  const visible = all.filter((comment) => filter === "all" || (filter === "active" ? comment.status !== "resolved" : comment.status === "resolved"));
  const ask = (comment: BoardComment) => {
    const ui = useUiStore.getState();
    const key = ui.activeThreadId ?? newChatDraftKey(projectId);
    const previous = ui.drafts[key] ?? "";
    const prompt = buildCommentsAskPrompt([comment]);
    ui.setDraft(key, previous.trim() ? `${previous}\n\n${prompt}` : prompt);
    ui.focusComposer();
  };
  if (!projectId) return <EmptyState title="Choose a project to review comments" />;
  if (comments.isError) return <LoadError title="Could not load comments" onRetry={() => void comments.refetch()} />;
  if (comments.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  return <div className="fd-review-comments">
    <header><div><h1>Comments</h1><p>{assembly ? "Project-root comments. Member-board pins are not supported yet." : "Questions and answers pinned to this project’s design."}</p></div>
      <select aria-label="Filter comments" value={filter} onChange={(event) => setFilter(event.target.value)}>
        <option value="active">Active ({all.filter((c) => c.status !== "resolved").length})</option>
        <option value="resolved">Resolved ({all.filter((c) => c.status === "resolved").length})</option>
        <option value="all">All ({all.length})</option>
      </select>
    </header>
    {patch.isError && <p role="alert" className="text-sm text-danger">Could not update the comment. Try again.</p>}
    {!visible.length ? <EmptyState title={all.length ? "No comments in this view" : "No comments yet"} icon={<Icon name="pin" width={34} height={34} />}>
      <p>{assembly ? "Comments do not yet carry a member-board source. Keep assembly discussion in project notes until source-qualified pins are available." : "Select a location on the PCB or schematic and choose Pin comment."}</p>
      <div className="mt-4 flex justify-center gap-2">{assembly ? <Button onClick={() => useUiStore.getState().setBoardTab("notes")}>Open project notes</Button> : <><Button disabled={!canLocate} onClick={() => useUiStore.getState().setBoardTab("pcb")}>Open PCB</Button><Button disabled={!canLocate} variant="ghost" onClick={() => useUiStore.getState().setBoardTab("schematic")}>Open schematic</Button></>}</div>
    </EmptyState> : <ul>{visible.map((comment) => <li key={comment.id}>
      <div className="fd-review-comment-meta"><span>{comment.anchor.view === "pcb" ? "PCB" : comment.anchor.view === "schematic" ? "Schematic" : comment.anchor.view === "3d" ? "3D" : "Product"} · {commentAnchorLabel(comment.anchor)}</span><span>{comment.status}</span></div>
      {comment.anchor.view === "pcb" && (comment.anchor.x !== undefined || comment.anchor.y !== undefined) && !commentMillimetrePoint(comment.anchor) && <p className="mt-2 text-xs text-warning">Drawing origin unverified · Confirm this pin on an updated PCB preview.</p>}
      <h2>{comment.question}</h2>
      {comment.answer && <p className="fd-review-comment-answer">{comment.answer}</p>}
      <div className="fd-review-comment-actions">
        {(comment.anchor.view === "pcb" || comment.anchor.view === "schematic") && <Button size="sm" disabled={!canLocate} title={canLocate ? "Open this project-root pin" : "Board source scope is unverified or this pin is not qualified for an assembly member"} onClick={() => useUiStore.getState().openBoardComment(comment.id, comment.anchor.view as "pcb" | "schematic")}><Icon name="pin" width={14} height={14} />Show on drawing</Button>}
        <Button size="sm" variant="ghost" onClick={() => ask(comment)}>Ask about this</Button>
        <Button size="sm" variant="ghost" disabled={patch.isPending} onClick={() => patch.mutate({ commentId: comment.id, patch: { status: comment.status === "resolved" ? "open" : "resolved" } })}>{comment.status === "resolved" ? "Reopen" : "Resolve"}</Button>
      </div>
    </li>)}</ul>}
  </div>;
}
