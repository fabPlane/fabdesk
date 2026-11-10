import { useEffect, useMemo, useState } from "react";
import type { BoardPartChangeRow, BoardPartSummary, BoardTimelineEntry } from "@fabdesk/protocol";
import { boardPickerLabel, boardFileLabel, changeDescription, defaultTimelineIndex, timelineEntryLabel, timelineIndexForCard, timelinePair, timelineStep, useBoardComparison, useBoardTimeline, useBoardWorkspaceAction, usePartLinks, usePrefetchBoardComparisons, useProjectBoards } from "@fabdesk/client-core";
import { Button, EmptyState, LoadError, Select, Spinner } from "../components/ui";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { Icon } from "../components/Icon";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { useUiStore } from "../stores/ui";
import { BoardLegend, BoardPairView } from "./BoardPairView";
import type { PartMarker } from "./PairOverlay";

type ChangeKind = BoardPartChangeRow["kind"];
const CHANGE_FILTERS: ReadonlyArray<{ kind: ChangeKind; label: string; mark: string }> = [
  { kind: "added", label: "Added", mark: "+" },
  { kind: "removed", label: "Removed", mark: "−" },
  { kind: "moved", label: "Moved", mark: "↔" },
  { kind: "changed", label: "Changed", mark: "~" },
  { kind: "renamed", label: "Renamed", mark: "≈" },
];
const drawingRoles = (kind: ChangeKind): string[] => kind === "renamed" ? ["changed"] : [kind];
const dateLabel = (value?: string) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
const sizeLabel = (size: { width: number; height: number } | null) => size ? `${Number(size.width.toFixed(2))} × ${Number(size.height.toFixed(2))} mm` : "No outline";
const changeRef = (change: BoardPartChangeRow) => change.toRef ?? change.fromRef ?? "";

function PartFacts({ part }: { part: BoardPartSummary | null | undefined }) {
  if (!part) return null;
  return <span className="fd-history-part-facts">{[part.value, part.footprint?.split(":").at(-1), part.layer].filter(Boolean).join(" · ")}{part.nets.length ? ` · ${part.nets.length} nets` : ""}</span>;
}

function TimelineCard({ entry, side, onSelect }: { entry: BoardTimelineEntry; side: "older" | "newer" | null; onSelect: () => void }) {
  const counts = entry.changes;
  return <li>
    <button type="button" className="fd-history-card" aria-current={side ? "true" : undefined} data-side={side ?? undefined} onClick={onSelect} title={entry.ref}>
      <strong>{timelineEntryLabel(entry)}</strong>
      {side && <b className="fd-history-card-side">{side === "older" ? "Older" : "Newer"}</b>}
      <small>{entry.kind === "worktree" ? "Now" : dateLabel(entry.date) || entry.kind}</small>
      {counts ? <span className="fd-history-counts">
        {counts.added > 0 && <i data-kind="added">+{counts.added}</i>}
        {counts.removed > 0 && <i data-kind="removed">−{counts.removed}</i>}
        {counts.moved > 0 && <i data-kind="moved">↔{counts.moved}</i>}
        {counts.changed + counts.renamed > 0 && <i data-kind="changed">~{counts.changed + counts.renamed}</i>}
        {counts.added + counts.removed + counts.moved + counts.changed + counts.renamed === 0 && <i>No part changes</i>}
      </span> : <span className="fd-history-counts"><i>First revision</i></span>}
    </button>
  </li>;
}

export function HistoryWorkspace({ projectId }: { projectId: string }) {
  const boards = useProjectBoards(projectId);
  const remembered = useUiStore(s => s.boardWorkspacePaths[projectId]);
  const list = boards.data ?? [];
  const pcbPath = list.find(board => board.path === remembered)?.path ?? list.find(board => board.path === "board.kicad_pcb")?.path ?? list[0]?.path ?? null;
  const timeline = useBoardTimeline(projectId, pcbPath);
  const entries = timeline.data?.entries ?? [];
  const [picked, setPicked] = useState<number | null>(null);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [filter, setFilter] = useState<ChangeKind | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const act = useBoardWorkspaceAction(projectId);
  useEffect(() => { setPicked(null); setCustom(null); setFilter(null); setSelected(null); setSaveError(null); setSaveNote(null); }, [pcbPath]);
  const index = picked !== null && picked < entries.length ? picked : defaultTimelineIndex(entries);
  const pair = timelinePair(entries, index);
  const from = custom?.from ?? pair?.from.ref ?? null, to = custom?.to ?? pair?.to.ref ?? null;
  const comparison = useBoardComparison(projectId, pcbPath, from, to);
  const data = comparison.data;
  // A selected part stays selected while stepping, so one part can be followed through its history.
  useEffect(() => { if (filter && data && data.summary[filter] === 0) setFilter(null); }, [data, filter]);
  const stepTo = (next: number | null) => { if (next !== null) { setCustom(null); setPicked(next); } };
  useEffect(() => {
    if (custom) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
      // Arrow keys already belong to form fields, and pan a drawing only once it is zoomed in enough to pan.
      if (event.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable], [role=dialog], .fd-assistant-dock")) return;
      const drawing = event.target instanceof Element ? event.target.closest(".fd-svg-viewport") : null;
      if (drawing && (drawing.scrollWidth > drawing.clientWidth + 1 || drawing.scrollHeight > drawing.clientHeight + 1)) return;
      const next = timelineStep(entries, index, event.key === "ArrowLeft" ? -1 : 1);
      if (next === null) return;
      event.preventDefault();
      stepTo(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [custom, entries, index]);
  const neighbours = custom ? [] : [-1, 1].flatMap(direction => {
    const next = timelineStep(entries, index, direction as -1 | 1), step = next === null ? null : timelinePair(entries, next);
    return step ? [{ from: step.from.ref, to: step.to.ref }] : [];
  });
  usePrefetchBoardComparisons(projectId, pcbPath, neighbours);
  const links = usePartLinks(projectId);
  const visibleChanges = useMemo(() => (data?.changes ?? []).filter(change => !filter || change.kind === filter), [data, filter]);
  const selectedChange = data?.changes.find(change => selected !== null && (change.toRef === selected || change.fromRef === selected));
  // A rename carries its old reference on the older side, so one selection follows the same part.
  const leftRef = selectedChange ? selectedChange.fromRef ?? null : selected;
  const rightRef = selectedChange ? selectedChange.toRef ?? null : selected;
  const leftPart = data?.from.parts.find(part => part.ref === leftRef), rightPart = data?.to.parts.find(part => part.ref === rightRef);
  const impacts = data?.impacts ?? [];
  const boardName = pcbPath ? list.find(board => board.path === pcbPath)?.name ?? boardFileLabel(pcbPath) : "";
  const connectorMarkers = (parts: readonly BoardPartSummary[]): PartMarker[] => parts.filter(part => part.connector).map(part => ({ ref: part.ref, tone: "connector" }));
  const hintFor = (side: "left" | "right") => (part: BoardPartSummary) => {
    const change = data?.changes.find(row => (side === "left" ? row.fromRef : row.toRef) === part.ref);
    return `${[part.ref, part.value].filter(Boolean).join(" · ")}: ${change ? changeDescription(change) : "unchanged"}`;
  };
  const revisionName = (ref: string | null | undefined, label?: string) => {
    const entry = entries.find(row => row.ref === ref);
    if (entry) return timelineEntryLabel(entry);
    return label ? timelineEntryLabel({ kind: ref?.startsWith("file:") || ref?.startsWith("export:") ? "export" : "git", title: label }) : null;
  };
  const moreRefs = [...entries.map(entry => ({ value: entry.ref, label: timelineEntryLabel(entry) })), ...list.filter(board => board.path !== pcbPath).map(board => ({ value: `file:${board.path}`, label: `Other board: ${boardPickerLabel(board, list)}` }))];

  useAssistantSurface(pcbPath ? { projectId, label: `History · ${boardName}`, priority: 10, details: JSON.stringify({ board: pcbPath, from, to, summary: data?.summary ?? null, selected, changes: data?.changes.slice(0, 40) ?? null, limits: "Part comparison from saved KiCad files. Not a DRC or electrical check." }) } : null);

  const save = async () => {
    if (!pcbPath || saving) return;
    setSaving(true); setSaveError(null); setSaveNote(null);
    try { const point = await act<{ created: boolean }>("board_revision_save", { pcbPath, label: `Saved ${new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` }); setSaveNote(point.created ? "Saved this revision." : "This exact revision was already saved."); }
    catch (error) { setSaveError(error instanceof Error ? error.message : "Could not save this revision."); }
    finally { setSaving(false); }
  };
  const openLink = (linkId: string) => {
    const ui = useUiStore.getState();
    ui.setPartLinkFocus({ projectId, linkId });
    ui.setWorkspaceArea("connections");
  };

  if (boards.isError) return <div className="fd-board-workspace"><LoadError title="Could not list this project's boards" onRetry={() => void boards.refetch()} /></div>;
  if (boards.isPending) return <div className="fd-board-workspace fd-pair-state"><Spinner /></div>;
  if (!pcbPath) return <div className="fd-board-workspace"><EmptyState title="No boards to compare yet">Add a KiCad board to this project to see its history.</EmptyState></div>;
  return <div className="fd-board-workspace" data-testid="history-workspace">
    <div className="fd-workspace-intro"><h2>Board history</h2><p>Choose a board, then step through its saved revisions. Older is on the left; newer is on the right.</p></div>
    <div className="fd-board-workspace-bar">
      <label className="fd-board-picker"><span>Board</span>
        <Select disabled={saving} aria-label="Board" value={pcbPath} onChange={event => useUiStore.getState().setBoardWorkspacePath(projectId, event.target.value)}>
          {list.map(board => <option key={board.path} value={board.path} title={board.path}>{boardPickerLabel(board, list)}</option>)}
        </Select>
      </label>
      <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save this revision"}</Button>
      <details className="fd-history-compare">
        <DisclosureSummary icon="more" label="Choose revisions" variant="compact" />
        <div className="fd-history-compare-body">
          <label><span>Older</span><Select aria-label="Older revision" value={from ?? ""} onChange={event => setCustom({ from: event.target.value, to: to ?? "worktree" })}>{moreRefs.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></label>
          <label><span>Newer</span><Select aria-label="Newer revision" value={to ?? ""} onChange={event => setCustom({ from: from ?? "worktree", to: event.target.value })}>{moreRefs.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></label>
          {custom && <Button size="sm" variant="ghost" onClick={() => setCustom(null)}>Back to timeline</Button>}
        </div>
      </details>
      {saveNote && <span className="fd-history-note" role="status">{saveNote}</span>}
      {saveError && <span className="fd-board-workspace-error" role="alert">{saveError}</span>}
    </div>
    {timeline.isError ? <LoadError title="Could not read this board's revisions" onRetry={() => void timeline.refetch()} /> : timeline.isPending ? <div className="fd-pair-state"><Spinner /></div> : <>
      {timeline.data?.truncated && <p className="fd-history-note" role="status">Showing the latest {entries.length} revisions. Older history is not included.</p>}
      <ol className="fd-history-timeline" aria-label="Board revisions, oldest first">
        {entries.map((entry, position) => <TimelineCard key={entry.ref} entry={entry} side={custom ? null : position === index ? "newer" : position === index - 1 ? "older" : null} onSelect={() => stepTo(timelineIndexForCard(entries, position))} />)}
      </ol>
      {entries.length < 2 && !custom
        ? <EmptyState title="Only one revision so far">Save this revision now. After the board changes, its differences appear here. Git commits and export bundles of this board also count.</EmptyState>
        : comparison.isError ? <LoadError title="Could not compare these revisions" onRetry={() => void comparison.refetch()} /> : <>
          <div className="fd-history-filters" role="group" aria-label="Filter changes">
            {!custom && <span className="fd-history-step" role="group" aria-label="Move through revisions">
              <Button size="sm" aria-label="Step to older revision" title="Older revision (Left arrow)" disabled={timelineStep(entries, index, -1) === null} onClick={() => stepTo(timelineStep(entries, index, -1))}><Icon name="chevronLeft" width={16} height={16} /></Button>
              <span aria-live="polite">Step {index} of {entries.length - 1}</span>
              <Button size="sm" aria-label="Step to newer revision" title="Newer revision (Right arrow)" disabled={timelineStep(entries, index, 1) === null} onClick={() => stepTo(timelineStep(entries, index, 1))}><Icon name="chevronRight" width={16} height={16} /></Button>
            </span>}
            {CHANGE_FILTERS.filter(item => (data?.summary[item.kind] ?? 0) > 0).map(item => <Button key={item.kind} size="sm" variant={filter === item.kind ? "secondary" : "ghost"} aria-pressed={filter === item.kind} data-kind={item.kind} onClick={() => setFilter(filter === item.kind ? null : item.kind)}>{item.mark}{data?.summary[item.kind]} {item.label}</Button>)}
            {data && data.changes.length === 0 && <span className="fd-history-note">No part changes{data.copper.tracksAdded + data.copper.tracksRemoved > 0 ? ` · copper changed (+${data.copper.tracksAdded} −${data.copper.tracksRemoved} tracks)` : ""}</span>}
            {data && data.changes.length > 0 && data.copper.tracksAdded + data.copper.tracksRemoved > 0 && <span className="fd-history-note">+{data.copper.tracksAdded} −{data.copper.tracksRemoved} tracks</span>}
            {impacts.length > 0 && <span className="fd-history-impacts">{impacts.slice(0, 3).map(impact => <Button key={`${impact.linkId}:${impact.changedRef}`} size="sm" variant="secondary" onClick={() => openLink(impact.linkId)}>{impact.changedRef} affects {impact.peer.ref} on {boardFileLabel(impact.peer.boardPath)}</Button>)}</span>}
            {(data?.changes.length ?? 0) > 0 && <Button size="sm" className="fd-history-list-toggle" variant={listOpen ? "secondary" : "ghost"} aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>Change list</Button>}
          </div>
          <BoardLegend items={[{ tone: "new", label: "Added" }, { tone: "removed", label: "Removed" }, { tone: "changed", label: "Moved or changed" }, { tone: "existing", label: "Unchanged" }, { tone: "connector", label: "Connector" }]} />
          <div className="fd-history-stage">
            <BoardPairView
              leftLabel="Older revision" rightLabel="Newer revision"
              left={{ header: <><strong>{revisionName(from, data?.from.label) ?? "Older"}</strong><small>{data ? sizeLabel(data.from.size) : ""}</small></>, svg: data?.from.drawing, viewKey: `older:${pcbPath}`, parts: data?.from.parts ?? [], markers: connectorMarkers(data?.from.parts ?? []), hint: hintFor("left"), selectedRef: leftRef, loading: comparison.isPending, notice: selected && !leftPart ? `${selected} is not on this revision` : null }}
              right={{ header: <><strong>{revisionName(to, data?.to.label) ?? "Newer"}</strong><small>{data ? sizeLabel(data.to.size) : ""}</small></>, svg: data?.to.drawing, viewKey: `newer:${pcbPath}`, parts: data?.to.parts ?? [], markers: connectorMarkers(data?.to.parts ?? []), hint: hintFor("right"), selectedRef: rightRef, loading: comparison.isPending, notice: selected && !rightPart ? `${selected} is not on this revision` : null }}
              roles={filter ? drawingRoles(filter) : undefined}
              updating={comparison.isPlaceholderData}
              onPick={(side, ref) => {
                if (!ref) { setSelected(null); return; }
                const next = (() => { const change = data?.changes.find(row => (side === "left" ? row.fromRef : row.toRef) === ref); return change ? changeRef(change) : ref; })();
                setSelected(selected === next ? null : next);
              }}
              onClear={() => { if (!selected) return false; setSelected(null); return true; }}
            />
            {listOpen && <aside className="fd-history-list" aria-label="Part changes">
              {visibleChanges.map(change => <button key={`${change.kind}:${changeRef(change)}`} type="button" aria-pressed={selected === changeRef(change)} data-kind={change.kind} onClick={() => setSelected(selected === changeRef(change) ? null : changeRef(change))}><strong>{changeRef(change)}</strong><small>{changeDescription(change)}</small></button>)}
            </aside>}
          </div>
          {/* Always present, so selecting a part never resizes the boards under the pointer. */}
          <div className="fd-history-selection" role="status">
            {selected ? <>
              <strong>{selected}</strong>
              <span>{selectedChange ? changeDescription(selectedChange) : "Unchanged between these revisions"}</span>
              <PartFacts part={rightPart ?? leftPart} />
              <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Clear</Button>
            </> : <span className="fd-history-note">Click a part to see what changed.</span>}
          </div>
        </>}
    </>}
    {links.isError && <span className="fd-board-workspace-error" role="alert">Linked parts could not be checked.</span>}
  </div>;
}
