import { useEffect, useMemo, useState } from "react";
import { checkPinMap, type BoardFile, type BoardPartSummary, type BoardView, type PartEndpoint, type ResolvedPartLink } from "@fabdesk/protocol";
import { boardFileLabel, connectionCandidates, hitTestBoardPad, linkPinMap, pairLinkLines, pairPinLines, partLinkPeer, partPins, pinCheckLabel, pinPairsForLink, sameEndpoint, sortedBoardParts, suggestPinMap, timelineEntryLabel, useBoardView, useBoardWorkspaceAction, usePartLinkSuggestions, usePartLinks, useProjectBoards } from "@fabdesk/client-core";
import { Button, EmptyState, LoadError, Select, Spinner } from "../components/ui";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { useUiStore } from "../stores/ui";
import { BoardLegend, BoardPairView, type BoardPoint } from "./BoardPairView";
import type { PartMarker, PinMarker } from "./PairOverlay";
import { ConnectPanel, LINK_STATE_LABEL } from "./ConnectPanel";

type Side = "left" | "right";
const partCenter = (part: BoardPartSummary) => ({ x: (part.bounds.minX + part.bounds.maxX) / 2, y: (part.bounds.minY + part.bounds.maxY) / 2 });

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
  // The first part chosen is what you are connecting from; the other side is where it goes.
  const [sourceSide, setSourceSide] = useState<Side>("left");
  const [linkId, setLinkId] = useState<string | null>(null);
  const [pinDraft, setPinDraft] = useState<Record<string, string> | null>(null);
  const [activePin, setActivePin] = useState<string | null>(null);
  // Small windows keep the room for the two boards until the list is asked for.
  const [listOpen, setListOpen] = useState(() => window.innerWidth >= 1200);
  const [suggesting, setSuggesting] = useState(false);
  const [showLines, setShowLines] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useBoardWorkspaceAction(projectId);

  // Open on boards that already have a link when there are any, so saved work is what you see first.
  const firstLink = links.data?.links.find(link => list.some(board => board.path === link.a.boardPath) && list.some(board => board.path === link.b.boardPath));
  const defaultLeft = firstLink?.a.boardPath ?? list.find(board => board.path === remembered)?.path ?? list[0]?.path ?? null;
  const defaultRight = firstLink?.b.boardPath ?? list.find(board => board.path !== defaultLeft)?.path ?? defaultLeft;
  const boardLeft = leftPath ?? defaultLeft, boardRight = rightPath ?? defaultRight;
  // The opening boards are chosen once. Saving or removing a link must not swap them under the selection.
  useEffect(() => {
    if (!boards.data || !links.data) return;
    if (!leftPath && defaultLeft) setLeftPath(defaultLeft);
    if (!rightPath && defaultRight) setRightPath(defaultRight);
  }, [boards.data, links.data, leftPath, rightPath, defaultLeft, defaultRight]);
  const viewLeft = useBoardView(projectId, boardLeft), viewRight = useBoardView(projectId, boardRight);
  const suggestions = usePartLinkSuggestions(projectId, boardLeft, boardRight, suggesting);
  const saved = links.data?.links ?? [], declared = links.data?.declared ?? [];

  const sourceIsLeft = sourceSide === "left";
  const sourceBoard = sourceIsLeft ? boardLeft : boardRight, targetBoard = sourceIsLeft ? boardRight : boardLeft;
  const sourceRef = sourceIsLeft ? left : right, targetRef = sourceIsLeft ? right : left;
  const sourceView = sourceIsLeft ? viewLeft : viewRight, targetView = sourceIsLeft ? viewRight : viewLeft;
  const sourcePart = sourceView.data?.parts.find(part => part.ref === sourceRef) ?? null;
  const targetPart = targetView.data?.parts.find(part => part.ref === targetRef) ?? null;
  const sourceEnd: PartEndpoint | null = sourceBoard && sourceRef ? { boardPath: sourceBoard, ref: sourceRef } : null;
  const targetEnd: PartEndpoint | null = targetBoard && targetRef ? { boardPath: targetBoard, ref: targetRef } : null;
  const between = sourceEnd && targetEnd ? saved.find(link => (sameEndpoint(link.a, sourceEnd) && sameEndpoint(link.b, targetEnd)) || (sameEndpoint(link.a, targetEnd) && sameEndpoint(link.b, sourceEnd))) ?? null : null;
  const shownLink = saved.find(link => link.id === linkId) ?? between;
  const sourceLinks = useMemo(() => sourceEnd ? saved.flatMap((link): Array<{ link: ResolvedPartLink; peerRef: string; peerBoard: string }> => sameEndpoint(link.a, sourceEnd) ? [{ link, peerRef: link.b.ref, peerBoard: link.b.boardPath }] : sameEndpoint(link.b, sourceEnd) ? [{ link, peerRef: link.a.ref, peerBoard: link.a.boardPath }] : []) : [], [saved, sourceEnd?.boardPath, sourceEnd?.ref]);
  const savedPins = shownLink && sourceEnd ? linkPinMap(shownLink, sourceEnd) : null;
  const pinMap = useMemo(() => pinDraft ?? (savedPins && Object.keys(savedPins).length ? savedPins : suggestPinMap(sourcePart, targetPart)), [pinDraft, savedPins, sourcePart, targetPart]);

  const pinPairs = useMemo(() => pinPairsForLink(pinMap, true), [pinMap]);
  const pinCheck = useMemo(() => checkPinMap(sourcePart?.pads, targetPart?.pads, pinPairs), [sourcePart, targetPart, pinPairs]);
  const lines = useMemo(() => {
    if (!showLines) return [];
    const partLines = pairLinkLines(saved, boardLeft, boardRight, viewLeft.data?.parts ?? [], viewRight.data?.parts ?? [], shownLink?.id);
    const pinLines = sourcePart && targetPart ? pairPinLines(pinCheck, sourceIsLeft, sourcePart, targetPart) : [];
    // A chosen pair not yet saved still shows where it would go.
    const draft = sourcePart && targetPart && !shownLink && !pinLines.length ? [{ id: "draft", tone: "draft" as const, left: partCenter(sourceIsLeft ? sourcePart : targetPart), right: partCenter(sourceIsLeft ? targetPart : sourcePart) }] : [];
    return [...partLines.filter(line => !(pinLines.length && line.id === shownLink?.id)), ...pinLines, ...draft];
  }, [showLines, saved, boardLeft, boardRight, viewLeft.data, viewRight.data, shownLink?.id, sourcePart, targetPart, pinCheck, sourceIsLeft]);
  const candidates = useMemo(() => sourcePart && !targetPart ? connectionCandidates(sourcePart, (targetView.data?.parts ?? []).filter(part => !(targetBoard === sourceBoard && part.ref === sourcePart.ref))) : new Map<string, number>(), [sourcePart, targetPart, targetView.data, targetBoard, sourceBoard]);
  const step = !sourcePart ? 1 : !targetPart ? 2 : !shownLink || pinDraft ? 3 : 4;

  const resetPins = () => { setPinDraft(null); setActivePin(null); };
  const setTargetRef = (ref: string | null) => { if (sourceIsLeft) setRight(ref); else setLeft(ref); };
  const showLink = (link: { a: PartEndpoint; b: PartEndpoint; id?: string }) => {
    setLeftPath(link.a.boardPath); setRightPath(link.b.boardPath);
    setLeft(link.a.ref); setRight(link.b.ref);
    setSourceSide("left");
    setLinkId(link.id && saved.some(row => row.id === link.id) ? link.id : null);
    resetPins(); setError(null);
  };
  const focus = useUiStore(s => s.partLinkFocus);
  useEffect(() => {
    if (!focus || focus.projectId !== projectId || !links.data) return;
    const link = links.data.links.find(row => row.id === focus.linkId);
    useUiStore.getState().setPartLinkFocus(null);
    if (link) showLink(link);
  }, [focus, links.data, projectId]);

  /** Starts from this part, and brings up what it already connects to on the other side. */
  const chooseSource = (side: Side, ref: string) => {
    const path = side === "left" ? boardLeft : boardRight;
    setSourceSide(side);
    if (side === "left") setLeft(ref); else setRight(ref);
    resetPins();
    const found = path ? partLinkPeer(saved, { boardPath: path, ref }) : null;
    setLinkId(found?.link.id ?? null);
    if (side === "left") { if (found) setRightPath(found.peer.boardPath); setRight(found?.peer.ref ?? null); }
    else { if (found) setLeftPath(found.peer.boardPath); setLeft(found?.peer.ref ?? null); }
  };
  const chooseTarget = (ref: string | null) => {
    setTargetRef(ref);
    resetPins();
    const match = ref && sourceEnd && targetBoard ? saved.find(link => (sameEndpoint(link.a, sourceEnd) && sameEndpoint(link.b, { boardPath: targetBoard, ref })) || (sameEndpoint(link.b, sourceEnd) && sameEndpoint(link.a, { boardPath: targetBoard, ref }))) : null;
    setLinkId(match?.id ?? null);
  };
  const editPin = (pin: string, to: string) => {
    const next = { ...pinMap };
    if (to) next[pin] = to; else delete next[pin];
    setPinDraft(next);
  };
  const pick = (side: Side, ref: string | null, point: BoardPoint, reach: number) => {
    setError(null);
    // Clicking empty board keeps your selection, so a slightly missed click loses nothing.
    if (!ref) return;
    const isSourceSide = side === sourceSide;
    if (sourcePart && isSourceSide && ref === sourcePart.ref) {
      const pin = hitTestBoardPad(sourcePart, point, reach);
      if (targetPart && pin) setActivePin(pin === activePin ? null : pin);
      return;
    }
    if (sourcePart && !isSourceSide && targetPart && ref === targetPart.ref) {
      const pin = hitTestBoardPad(targetPart, point, reach);
      if (!pin || !activePin) return;
      editPin(activePin, pin);
      // Move to the next unmapped pin, so a connector can be mapped click by click.
      const pins = partPins(sourcePart).map(row => row.pin);
      setActivePin(pins.slice(pins.indexOf(activePin) + 1).find(row => !pinMap[row]) ?? null);
      return;
    }
    if (sourcePart && !isSourceSide) { chooseTarget(ref); return; }
    chooseSource(side, ref);
  };
  const clear = () => {
    if (!left && !right && !linkId) return false;
    setLeft(null); setRight(null); setLinkId(null); resetPins();
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
  const save = () => {
    if (!sourceEnd || !targetEnd) return;
    if (shownLink) void run("connection_set_pins", { id: shownLink.id, pins: pinPairsForLink(pinMap, sameEndpoint(shownLink.a, sourceEnd)) }, () => resetPins());
    else void run("connection_add", { a: sourceEnd, b: targetEnd, pins: pinPairsForLink(pinMap, true) }, result => { const created = result.link as { id?: string } | undefined; if (created?.id) setLinkId(created.id); resetPins(); });
  };
  const nameOf = (path: string) => list.find(board => board.path === path)?.name ?? boardFileLabel(path);

  useAssistantSurface({ projectId, label: "Connections", priority: 10, details: JSON.stringify({ from: sourceEnd, to: targetEnd, pins: pinMap, link: shownLink, linkCount: saved.length, limits: "Links and pin maps record intent. Shared net names are hints. Nothing here verifies electrical compatibility." }) });

  if (boards.isError) return <div className="fd-board-workspace"><LoadError title="Could not list this project's boards" onRetry={() => void boards.refetch()} /></div>;
  if (boards.isPending || links.isPending) return <div className="fd-board-workspace fd-pair-state"><Spinner /></div>;
  if (links.isError) return <div className="fd-board-workspace"><LoadError title="Could not read part links" onRetry={() => void links.refetch()} /></div>;
  if (list.length < 2) return <div className="fd-board-workspace"><EmptyState title="Connections need at least two boards">{list.length ? "This project has one board. Add another KiCad board to link parts across them." : "Add KiCad boards to this project to link parts across them."}</EmptyState></div>;
  const markersFor = (view: typeof viewLeft, board: string | null, side: Side): PartMarker[] => (view.data?.parts ?? []).flatMap((part): PartMarker[] => {
    const onThisBoard = (end: PartEndpoint) => end.boardPath === board && end.ref === part.ref;
    const touching = saved.filter(link => onThisBoard(link.a) || onThisBoard(link.b));
    if (touching.length) {
      const worst = touching.some(link => link.state === "missing") ? "missing" : touching.some(link => link.state === "needs-review") ? "review" : "linked";
      const peer = onThisBoard(touching[0]!.a) ? touching[0]!.b : touching[0]!.a;
      const otherBoard = side === "left" ? boardRight : boardLeft;
      const more = touching.length > 1 ? ` +${touching.length - 1}` : "";
      return [{ ref: part.ref, tone: worst, chip: `→ ${peer.ref}${peer.boardPath === otherBoard ? "" : ` · ${nameOf(peer.boardPath)}`}${more}` }];
    }
    if (side !== sourceSide && candidates.has(part.ref)) return [{ ref: part.ref, tone: "candidate", chip: `${candidates.get(part.ref)} shared net${candidates.get(part.ref) === 1 ? "" : "s"}` }];
    return part.connector ? [{ ref: part.ref, tone: "connector" }] : [];
  });
  const pinsFor = (isSource: boolean): PinMarker[] => {
    if (!sourcePart || !targetPart) return [];
    const rows: PinMarker[] = pinCheck.rows.map(row => ({ ref: isSource ? sourcePart.ref : targetPart.ref, pin: isSource ? row.a : row.b, tone: row.kind }));
    const active = activePin ? isSource ? activePin : pinMap[activePin] : null;
    return active ? [...rows, { ref: isSource ? sourcePart.ref : targetPart.ref, pin: active, tone: "active" }] : rows;
  };
  const hintFor = (isSource: boolean) => (part: BoardPartSummary, pin: string | null) => {
    const name = [part.ref, part.value].filter(Boolean).join(" · ");
    const net = pin ? part.pads.find(row => row.pin === pin)?.net : undefined;
    if (sourcePart && targetPart && part.ref === (isSource ? sourcePart.ref : targetPart.ref)) {
      if (!pin) return name;
      const label = `${part.ref} pin ${pin}${net ? ` · ${net}` : ""}`;
      if (isSource) return `${label}: click to map this pin`;
      return activePin ? `${label}: click to connect pin ${activePin} here` : `${label}: pick a pin on ${sourcePart.ref} first`;
    }
    if (sourcePart && !isSource && part.ref !== targetPart?.ref) return `${name}: click to connect ${sourcePart.ref} here`;
    return `${name}: click to start here`;
  };
  const panel = (view: typeof viewLeft, label: string, board: string | null, part: string | null, onBoard: (path: string) => void, side: Side) => {
    const isSource = side === sourceSide;
    return {
      header: <SidePicker label={label} boards={list} board={board} view={view.data} part={part} onBoard={onBoard} onPart={ref => { if (!ref) { if (isSource) clear(); else chooseTarget(null); } else if (isSource || !sourceRef) chooseSource(side, ref); else chooseTarget(ref); }} />,
      svg: view.data?.drawing,
      viewKey: `${side}:${board ?? ""}`,
      parts: view.data?.parts ?? [],
      selectedRef: part,
      loading: view.isPending,
      notice: part && view.data && !view.data.parts.some(row => row.ref === part) ? `${part} is not on this board` : view.isError ? "Could not read this board." : null,
      markers: markersFor(view, board, side),
      pins: pinsFor(isSource),
      hint: hintFor(isSource),
    };
  };
  const changeBoard = (side: Side, path: string) => {
    if (side === "left") { setLeftPath(path); setLeft(null); } else { setRightPath(path); setRight(null); }
    setLinkId(null); resetPins();
    if (side === sourceSide) setSourceSide(side === "left" ? "right" : "left");
  };
  const baselineEntry = viewLeft.data?.baseline ?? viewRight.data?.baseline;
  const baseline = baselineEntry ? timelineEntryLabel({ kind: baselineEntry.ref.startsWith("export:") ? "export" : "git", title: baselineEntry.label }) : null;
  return <div className="fd-board-workspace" data-testid="connections-workspace">
    <div className="fd-board-workspace-bar">
      <Button size="sm" variant={listOpen ? "secondary" : "ghost"} aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>Links {saved.length + declared.length}</Button>
      <Button size="sm" variant={suggesting ? "secondary" : "ghost"} aria-pressed={suggesting} onClick={() => { if (!suggesting) setListOpen(true); setSuggesting(!suggesting); }}>Suggest from net names</Button>
      <Button size="sm" variant={showLines ? "secondary" : "ghost"} aria-pressed={showLines} onClick={() => setShowLines(!showLines)}>Lines</Button>
      <ol className="fd-connect-steps" aria-label="How to connect parts">
        {["Click a part", "Click where it connects", "Set the pins", "Saved"].map((label, index) => <li key={label} aria-current={step === index + 1 ? "step" : undefined}>{label}</li>)}
      </ol>
      {error && <span className="fd-board-workspace-error" role="alert">{error}</span>}
    </div>
    <BoardLegend items={[
      ...(baseline ? [{ tone: "new", label: "New", title: `Not on ${baseline}` }, { tone: "changed", label: "Changed", title: `Different from ${baseline}` }] : []),
      { tone: "existing", label: baseline ? "Existing" : "Part" },
      { tone: "connector", label: "Connector" },
      { tone: "candidate", label: "Likely match" },
      { tone: "linked", label: "Connected" },
      { tone: "review", label: "Needs review" },
      { tone: "missing", label: "Part missing" },
    ]} />
    <div className="fd-history-stage">
      {listOpen && <aside className="fd-connection-list" aria-label="Part links">
        {saved.map(link => <button key={link.id} type="button" aria-pressed={shownLink?.id === link.id} data-state={link.state} onClick={() => showLink(link)}>
          <strong>{link.a.ref} ↔ {link.b.ref}</strong>
          <small>{nameOf(link.a.boardPath)} ↔ {nameOf(link.b.boardPath)}</small>
          <em>{LINK_STATE_LABEL[link.state]}{link.pins?.length ? ` · ${link.pins.length} ${link.pins.length === 1 ? "pin" : "pins"}` : ""}</em>
          {link.check.status === "conflict" && <em data-check="conflict">{pinCheckLabel(link.check)}</em>}
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
        left={panel(viewLeft, "Left", boardLeft, left, path => changeBoard("left", path), "left")}
        right={panel(viewRight, "Right", boardRight, right, path => changeBoard("right", path), "right")}
        lines={lines}
        onPick={pick}
        onClear={clear}
      />
      {/* The panel keeps its place when empty, so choosing a part never resizes the boards under the pointer. */}
      {!(sourcePart && sourceBoard && targetBoard) && <aside className="fd-connect-panel" data-empty aria-label="Connect a part">
        <p className="fd-connect-hint">{sourceRef ? `${sourceRef} is not on this board.` : "Click a part on either board, then say where it connects."}</p>
      </aside>}
      {sourcePart && sourceBoard && targetBoard && <ConnectPanel
        key={`${sourceBoard}:${sourcePart.ref}`}
        source={sourcePart} sourceBoard={sourceBoard} boards={list}
        targetBoard={targetBoard} targetParts={targetView.data?.parts ?? []} targetLoading={targetView.isPending} target={targetPart}
        link={shownLink} sourceLinks={sourceLinks} pinMap={targetPart ? pinMap : {}} pinCheck={pinCheck} pinsEdited={pinDraft !== null} activePin={activePin} busy={busy} nameOf={nameOf}
        onClose={clear}
        onTargetBoard={path => { if (sourceIsLeft) setRightPath(path); else setLeftPath(path); setTargetRef(null); setLinkId(null); resetPins(); }}
        onTarget={chooseTarget}
        onOpenLink={link => { const peer = sameEndpoint(link.a, sourceEnd) ? link.b : link.a; if (sourceIsLeft) setRightPath(peer.boardPath); else setLeftPath(peer.boardPath); setTargetRef(peer.ref); setLinkId(link.id); resetPins(); }}
        onNewTarget={() => chooseTarget(null)}
        onActivePin={setActivePin}
        onPin={editPin}
        onSave={save}
        onReview={() => { if (shownLink) void run("connection_review", { id: shownLink.id }); }}
        onRemove={() => { if (shownLink) void run("connection_remove", { id: shownLink.id }, () => { setLinkId(null); setTargetRef(null); resetPins(); }); }}
      />}
    </div>
  </div>;
}
