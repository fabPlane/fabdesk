import { useEffect, useMemo, useState } from "react";
import type { BoardFile, BoardView, PartEndpoint, ResolvedPartLink } from "@fabdesk/protocol";
import { boardFileLabel, partLinkPeer, sameEndpoint, sharedNetLabel, sortedBoardParts, useBoardView, useBoardWorkspaceAction, usePartLinkSuggestions, usePartLinks, useProjectBoards } from "@fabdesk/client-core";
import { Button, EmptyState, LoadError, Select, Spinner } from "../components/ui";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { useUiStore } from "../stores/ui";
import { BoardPairView } from "./BoardPairView";

const STATE_LABEL: Record<ResolvedPartLink["state"], string> = { current: "Unverified", "needs-review": "Needs review", missing: "Part missing" };

function SidePicker({ label, boards, board, view, part, onBoard, onPart }: {
  label: string;
  boards: readonly BoardFile[];
  board: string | null;
  view: BoardView | undefined;
  part: string | null;
  onBoard: (path: string) => void;
  onPart: (ref: string | null) => void;
}) {
  const parts = useMemo(() => sortedBoardParts(view?.parts ?? []), [view]);
  return <div className="fd-connection-side">
    <Select aria-label={`${label} board`} value={board ?? ""} onChange={event => onBoard(event.target.value)}>
      {boards.map(item => <option key={item.path} value={item.path} title={item.path}>{item.name}</option>)}
    </Select>
    <Select aria-label={`${label} part`} value={part ?? ""} disabled={!view} onChange={event => onPart(event.target.value || null)}>
      <option value="">Choose part…</option>
      {parts.map(item => <option key={item.ref} value={item.ref}>{item.ref}{item.value ? ` · ${item.value}` : ""}</option>)}
    </Select>
  </div>;
}

export function ConnectionsWorkspace({ projectId }: { projectId: string }) {
  const boards = useProjectBoards(projectId);
  const links = usePartLinks(projectId);
  const list = boards.data ?? [];
  const remembered = useUiStore(s => s.boardWorkspacePaths[projectId]);
  const [leftPath, setLeftPath] = useState<string | null>(null);
  const [rightPath, setRightPath] = useState<string | null>(null);
  const [left, setLeft] = useState<string | null>(null);
  const [right, setRight] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<string | null>(null);
  // Small windows keep the room for the two boards until the list is asked for.
  const [listOpen, setListOpen] = useState(() => window.innerWidth >= 1200);
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useBoardWorkspaceAction(projectId);

  // Open on boards that already have a link when there are any, so saved work is what you see first.
  const firstLink = links.data?.links[0];
  const defaultLeft = firstLink?.a.boardPath ?? list.find(board => board.path === remembered)?.path ?? list[0]?.path ?? null;
  const defaultRight = firstLink?.b.boardPath ?? list.find(board => board.path !== defaultLeft)?.path ?? defaultLeft;
  const boardLeft = leftPath ?? defaultLeft, boardRight = rightPath ?? defaultRight;
  const viewLeft = useBoardView(projectId, boardLeft), viewRight = useBoardView(projectId, boardRight);
  const suggestions = usePartLinkSuggestions(projectId, boardLeft, boardRight, suggesting);
  const saved = links.data?.links ?? [], declared = links.data?.declared ?? [];
  const selectedLink = saved.find(link => link.id === linkId) ?? null;
  const endpointLeft: PartEndpoint | null = boardLeft && left ? { boardPath: boardLeft, ref: left } : null;
  const endpointRight: PartEndpoint | null = boardRight && right ? { boardPath: boardRight, ref: right } : null;
  const existing = endpointLeft && endpointRight ? saved.find(link => (sameEndpoint(link.a, endpointLeft) && sameEndpoint(link.b, endpointRight)) || (sameEndpoint(link.a, endpointRight) && sameEndpoint(link.b, endpointLeft))) ?? null : null;
  const sameLeftPart = viewLeft.data?.parts.find(part => part.ref === left), sameRightPart = viewRight.data?.parts.find(part => part.ref === right);
  const shownLink = selectedLink ?? existing;

  const showLink = (link: { a: PartEndpoint; b: PartEndpoint; id?: string }) => {
    setLeftPath(link.a.boardPath); setRightPath(link.b.boardPath);
    setLeft(link.a.ref); setRight(link.b.ref);
    setLinkId(link.id && saved.some(row => row.id === link.id) ? link.id : null);
    setError(null);
  };
  const focus = useUiStore(s => s.partLinkFocus);
  useEffect(() => {
    if (!focus || focus.projectId !== projectId || !links.data) return;
    const link = links.data.links.find(row => row.id === focus.linkId);
    useUiStore.getState().setPartLinkFocus(null);
    if (link) showLink(link);
  }, [focus, links.data, projectId]);

  const pick = (side: "left" | "right", ref: string | null) => {
    setError(null);
    const path = side === "left" ? boardLeft : boardRight;
    if (side === "left") setLeft(ref); else setRight(ref);
    if (!ref || !path) { setLinkId(null); return; }
    // Selecting a linked part brings up the part it connects to, on the other side.
    const found = partLinkPeer(saved, { boardPath: path, ref });
    if (!found) { setLinkId(null); return; }
    setLinkId(found.link.id);
    if (side === "left") { setRightPath(found.peer.boardPath); setRight(found.peer.ref); }
    else { setLeftPath(found.peer.boardPath); setLeft(found.peer.ref); }
  };
  const clear = () => {
    if (!left && !right && !linkId) return false;
    setLeft(null); setRight(null); setLinkId(null);
    return true;
  };
  const run = async (tool: string, args: Record<string, unknown>, after?: (result: Record<string, unknown>) => void) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      // Await first: an optional call would skip its arguments, and the action, with no callback.
      const result = await act<Record<string, unknown>>(tool, args);
      after?.(result);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "This change could not be saved."); }
    finally { setBusy(false); }
  };
  const nameOf = (path: string) => list.find(board => board.path === path)?.name ?? boardFileLabel(path);

  useAssistantSurface({ projectId, label: "Connections", priority: 10, details: JSON.stringify({ boards: [boardLeft, boardRight], selected: [endpointLeft, endpointRight], link: shownLink, linkCount: saved.length, limits: "Links record intent. Shared net names are hints. Nothing here verifies electrical compatibility or pin mapping." }) });

  if (boards.isError) return <div className="fd-board-workspace"><LoadError title="Could not list this project's boards" onRetry={() => void boards.refetch()} /></div>;
  if (boards.isPending || links.isPending) return <div className="fd-board-workspace fd-pair-state"><Spinner /></div>;
  if (links.isError) return <div className="fd-board-workspace"><LoadError title="Could not read part links" onRetry={() => void links.refetch()} /></div>;
  if (list.length < 2) return <div className="fd-board-workspace"><EmptyState title="Connections need at least two boards">{list.length ? "This project has one board. Add another KiCad board to link parts across them." : "Add KiCad boards to this project to link parts across them."}</EmptyState></div>;
  const panel = (view: typeof viewLeft, label: string, board: string | null, part: string | null, onBoard: (path: string) => void, side: "left" | "right") => ({
    header: <SidePicker label={label} boards={list} board={board} view={view.data} part={part} onBoard={onBoard} onPart={ref => pick(side, ref)} />,
    svg: view.data?.drawing,
    viewKey: `${side}:${view.data?.sha256 ?? ""}`,
    parts: view.data?.parts ?? [],
    selectedRef: part,
    loading: view.isPending,
    notice: part && view.data && !view.data.parts.some(row => row.ref === part) ? `${part} is not on this board` : view.isError ? "Could not read this board." : null,
  });
  return <div className="fd-board-workspace" data-testid="connections-workspace">
    <div className="fd-board-workspace-bar">
      <Button size="sm" variant={listOpen ? "secondary" : "ghost"} aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>Links {saved.length + declared.length}</Button>
      <Button size="sm" variant={suggesting ? "secondary" : "ghost"} aria-pressed={suggesting} onClick={() => { if (!suggesting) setListOpen(true); setSuggesting(!suggesting); }}>Suggest from net names</Button>
      <span className="fd-history-note">Click a part on each board to link them.</span>
      {error && <span className="fd-board-workspace-error" role="alert">{error}</span>}
    </div>
    <div className="fd-history-stage">
      {listOpen && <aside className="fd-connection-list" aria-label="Part links">
        {saved.map(link => <button key={link.id} type="button" aria-pressed={shownLink?.id === link.id} data-state={link.state} onClick={() => showLink(link)}>
          <strong>{link.a.ref} ↔ {link.b.ref}</strong>
          <small>{nameOf(link.a.boardPath)} ↔ {nameOf(link.b.boardPath)}</small>
          <em>{STATE_LABEL[link.state]}</em>
        </button>)}
        {declared.map(link => <button key={link.id} type="button" onClick={() => showLink(link)} data-state="declared">
          <strong>{link.a.ref} ↔ {link.b.ref}</strong>
          <small>{nameOf(link.a.boardPath)} ↔ {nameOf(link.b.boardPath)}</small>
          <em>{link.source === "mechanical" ? "From enclosure" : "From assembly"}</em>
        </button>)}
        {!saved.length && !declared.length && <p className="fd-history-note">No links yet.</p>}
        {suggesting && <div className="fd-connection-suggestions" aria-label="Suggested links">
          <h3>Suggestions</h3>
          {suggestions.isPending ? <Spinner /> : suggestions.isError ? <p role="alert">Could not read suggestions.</p> : (suggestions.data ?? []).length === 0 ? <p className="fd-history-note">No parts on these boards share a named net.</p> : suggestions.data!.map(row => <button key={`${row.a.ref}:${row.b.ref}`} type="button" onClick={() => showLink(row)}>
            <strong>{row.a.ref} ↔ {row.b.ref}</strong>
            <small title={row.sharedNets.map(net => net.net).join(", ")}>{row.sharedNets.slice(0, 3).map(net => net.net).join(", ")}{row.sharedNets.length > 3 ? ` +${row.sharedNets.length - 3}` : ""}</small>
          </button>)}
        </div>}
      </aside>}
      <BoardPairView
        leftLabel="Left board" rightLabel="Right board"
        left={panel(viewLeft, "Left", boardLeft, left, path => { setLeftPath(path); setLeft(null); setLinkId(null); }, "left")}
        right={panel(viewRight, "Right", boardRight, right, path => { setRightPath(path); setRight(null); setLinkId(null); }, "right")}
        onPick={pick}
        onClear={clear}
      />
    </div>
    {(left || right) && <div className="fd-history-selection" role="status">
      <strong>{left ?? "Choose a part"} ↔ {right ?? "Choose a part"}</strong>
      {shownLink ? <>
        <em data-state={shownLink.state}>{STATE_LABEL[shownLink.state]}</em>
        {shownLink.reasons.length > 0 && <span>{shownLink.reasons.join("; ")}</span>}
        <span>{sharedNetLabel(shownLink.sharedNets.length)}</span>
        {shownLink.sharedNets.length > 0 && <details className="fd-connection-nets"><summary>Pins</summary><table><thead><tr><th>Net</th><th>{shownLink.a.ref}</th><th>{shownLink.b.ref}</th></tr></thead><tbody>{shownLink.sharedNets.slice(0, 60).map(net => <tr key={net.net}><td>{net.net}</td><td>{net.aPin}</td><td>{net.bPin}</td></tr>)}</tbody></table></details>}
        {shownLink.state === "needs-review" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run("connection_review", { id: shownLink.id })}>Mark reviewed</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("connection_remove", { id: shownLink.id }, () => setLinkId(null))}>Remove link</Button>
      </> : <>
        {sameLeftPart && sameRightPart && <span>{sharedNetLabel(sameLeftPart.nets.filter(net => sameRightPart.nets.includes(net) && !/^(?:Net-\(|unconnected-)/.test(net)).length)}</span>}
        <Button size="sm" variant="primary" disabled={busy || !endpointLeft || !endpointRight || !sameLeftPart || !sameRightPart || sameEndpoint(endpointLeft, endpointRight)} onClick={() => void run("connection_add", { a: endpointLeft, b: endpointRight }, result => { const created = result.link as { id?: string } | undefined; if (created?.id) setLinkId(created.id); })}>Link these parts</Button>
      </>}
      <Button size="sm" variant="ghost" onClick={clear}>Clear</Button>
    </div>}
  </div>;
}
