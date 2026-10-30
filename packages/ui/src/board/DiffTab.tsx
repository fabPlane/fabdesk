import { useAssistantSurface } from "../chat/useAssistantSurface";
import { captureAssemblySourceSelection, diffPreviewSvg, pcbToolJson, restoreAssemblySelection } from "@fabdesk/client-core";
import type { BoardSourceSelection } from "@fabdesk/protocol";
import { ReviewScope } from "./ReviewUpdateLayout";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, EmptyState, LoadError, Select, Spinner } from "../components/ui";
import { useBoardSources, useProjectJson, useProjectText, useRunTool } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { SvgViewer } from "./SvgViewer";
import { cn } from "../util";
import { diffHeadline } from "./diff-copy";
import { selectDiffGeometry, type DiffSelection } from "./diff-selection";
import { blendDiffOverlay } from "./diff-blend";

export { diffHeadline } from "./diff-copy";

type Revision = { ref: string; title: string; date?: string; commit?: string };

type ComponentChange = {
  ref: string;
  reasons: string[];
  before?: { value?: string; footprint?: string };
  after?: { value?: string; footprint?: string };
};

type BoardDiffReport = {
  documents?: { pcb: boolean; schematic: boolean };
  boardSource?: BoardSourceSelection & { projectId: string };
  from?: { ref: string; commit?: string };
  to?: { ref: string; commit?: string };
  summary?: {
    added: number;
    removed: number;
    moved: number;
    changed: number;
    netsAdded: number;
    netsRemoved: number;
    netsChanged: number;
    tracksAdded: number;
    tracksRemoved: number;
  };
  text?: string;
  files?: Record<string, string>;
  diff?: {
    components: {
      added: Array<{ ref: string; value?: string }>;
      removed: Array<{ ref: string; value?: string }>;
      changed: ComponentChange[];
    };
    nets: {
      added: Array<{ name: string; nodes?: Array<{ ref: string }> }>;
      removed: Array<{ name: string; nodes?: Array<{ ref: string }> }>;
      changed: Array<{ name: string; addedNodes: unknown[]; removedNodes: unknown[]; before?: { nodes: Array<{ ref: string }> }; after?: { nodes: Array<{ ref: string }> } }>;
    };
  };
};

type Surface = "pcb" | "schematic";
type Mode = "structured" | "overlay" | "side-by-side";

const FILE_KEYS: Record<Surface, Record<Mode, string>> = {
  pcb: { structured: "pcbStructured", overlay: "pcbOverlay", "side-by-side": "pcbSideBySide" },
  schematic: {
    structured: "schematicStructured",
    overlay: "schematicOverlay",
    "side-by-side": "schematicSideBySide",
  },
};

function asReport(value: unknown): BoardDiffReport | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as BoardDiffReport) : null;
}

function revisionsFrom(result: unknown): Revision[] {
  const json = result && typeof result === "object" && "json" in result ? (result as { json?: unknown }).json : result;
  const rec = json && typeof json === "object" ? (json as { revisions?: Revision[] }) : null;
  return Array.isArray(rec?.revisions) ? rec.revisions : [];
}

function shortRef(ref: string): string {
  if (ref === "HEAD") return "Latest commit";
  if (ref === "worktree") return "Current files";
  if (ref.startsWith("saved:")) return `Saved point · ${ref.slice(6, 14)}`;
  return /^[0-9a-f]{7,40}$/i.test(ref) ? ref.slice(0, 8) : ref;
}

export function DiffTab() {
  const projectId = useUiStore(s => s.activeProjectId), saved = useUiStore(s => projectId ? s.assemblyBoardByProject[projectId] : null);
  const sources = useBoardSources(projectId), [requested, setRequested] = useState<string | null>(null);
  if (!projectId) return <EmptyState title="Pick a project to compare revisions" />;
  if (sources.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (sources.isError && !sources.data) return <LoadError title="Could not verify board scope for comparison" onRetry={() => void sources.refetch()} />;
  const data = sources.data, assembly = data?.mode === "assembly";
  const sourceId = assembly ? requested ?? restoreAssemblySelection(data, saved)?.sourceId ?? data.sources.find(row => row.status === "available")?.source.id ?? data.sources[0]?.source.id : null;
  const source = assembly ? data.sources.find(row => row.source.id === sourceId) : null;
  const board = assembly && data.manifestSha256 && source ? { sourceId: source.source.id, manifestSha256: data.manifestSha256 } : undefined;
  const prefix = source?.source.location === "project" && source.source.directory !== "." ? `${source.source.directory}/` : "";
  const ready = !sources.isFetching && !sources.isError && (!assembly || source?.status === "available");
  return <>
    {assembly && <ReviewScope><select aria-label="Board for Changes" value={sourceId ?? ""} disabled={sources.isFetching} onChange={event => {
      const id = event.target.value; setRequested(id);
      const selection = captureAssemblySourceSelection(data, id, useUiStore.getState().assemblyBoardByProject[projectId]);
      if (selection && data.sources.find(row => row.source.id === id)?.status === "available") useUiStore.getState().setAssemblyBoard(selection);
    }}>{!source && <option value={sourceId ?? ""} disabled>Source definition changed · choose a board</option>}{data.sources.map(row => <option key={row.source.id} value={row.source.id}>{row.source.name}{row.status !== "available" ? " · source unavailable" : ""}</option>)}</select></ReviewScope>}
    {assembly && source?.status !== "available" ? <EmptyState title="Add this board’s source to compare changes"><p>{source?.reason ?? "Choose an imported board source, or locate this board’s native files."}</p><Button onClick={() => useUiStore.getState().openProjectFile("fabplane.assembly.json")}>Review source definition</Button></EmptyState> : <BoardRevisionDiff key={`${projectId}:${board?.sourceId ?? "root"}:${board?.manifestSha256 ?? ""}`} projectId={projectId} prefix={prefix} {...(board ? { board } : {})} sourceLabel={source?.source.name ?? "Main board"} scopeReady={ready} />}
  </>;
}

function BoardRevisionDiff({ projectId, prefix, board, sourceLabel, scopeReady }: { projectId: string; prefix: string; board?: BoardSourceSelection; sourceLabel: string; scopeReady: boolean }) {
  const [changesOpen, setChangesOpen] = useState(false);
  const [checkpointNotice, setCheckpointNotice] = useState(false);
  const changesTrigger = useRef<HTMLButtonElement>(null), changesPanel = useRef<HTMLElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const list = useRunTool();
  const compare = useRunTool();
  const checkpoint = useRunTool();
  const reportQuery = useProjectJson(projectId, `${prefix}reports/board-diff.json`);
  const candidate = asReport(reportQuery.data);
  const report = candidate && (!board || candidate.boardSource?.projectId === projectId && candidate.boardSource.sourceId === board.sourceId && candidate.boardSource.manifestSha256 === board.manifestSha256) ? candidate : null;
  const [from, setFrom] = useState("HEAD");
  const [to, setTo] = useState("worktree");
  const [revisions, setRevisions] = useState<Revision[]>([
    { ref: "worktree", title: "Current worktree" },
  ]);
  const [surface, setSurface] = useState<Surface>("pcb");
  const [mode, setMode] = useState<Mode>("structured");
  const [blend, setBlend] = useState(50);
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  useAssistantSurface({ projectId, label: "Review / Changes", priority: 10, details: JSON.stringify({ board, source: sourceLabel, from, to, drawing: surface, display: mode, selection, reportPath: `${prefix}reports/board-diff.json`, reportAvailable: !!report, reportFreshness: "Saved comparison snapshot. Later edits are not included automatically; re-run Compare to include current files.", scopeReady }) });
  useEffect(() => setSelection(null), [projectId, reportQuery.dataUpdatedAt]);
  useEffect(() => {
    if (!selection && !changesOpen) return;
    const clear = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Node && event.target !== document.body && !workspace.current?.contains(event.target)) return;
      event.preventDefault();
      if (selection) setSelection(null);
      else { setChangesOpen(false); changesTrigger.current?.focus(); }
    };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, [selection, changesOpen]);
  useEffect(() => {
    if (!changesOpen) return;
    const frame = requestAnimationFrame(() => {
      if (useUiStore.getState().activeProjectId === projectId && document.activeElement === changesTrigger.current) changesPanel.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [changesOpen, projectId]);

  useEffect(() => {
    if (!scopeReady) return;
    void list.run("board_revision_list", { projectId, limit: 40, ...(board ? { board } : {}) }).then(state => {
      const next = revisionsFrom(state.result);
      if (next.length > 0) {
        setRevisions(next);
        if (!report?.from?.ref) setFrom(next.find(revision => revision.ref !== "worktree")?.ref ?? "worktree");
      }
    });
  }, [projectId, list.run, scopeReady, board?.sourceId, board?.manifestSha256]);

  useEffect(() => {
    if (report?.from?.ref) setFrom(report.from.ref);
    if (report?.to?.ref) setTo(report.to.ref);
  }, [report?.from?.ref, report?.to?.ref]);

  useEffect(() => { if (report?.documents?.[surface] === false) setSurface(report.documents.pcb ? "pcb" : "schematic"); }, [report?.documents?.pcb, report?.documents?.schematic, surface]);
  const fileKey = FILE_KEYS[surface][mode];
  const svgPath = report?.files?.[fileKey] ?? report?.files?.[FILE_KEYS[surface].structured];
  const svg = useProjectText(projectId, svgPath ? `${prefix}${svgPath}` : null);
  const drawing = useMemo(() => selectDiffGeometry(diffPreviewSvg(svg.data ?? ""), selection), [svg.data, selection]);
  const select = (next: DiffSelection) => setSelection(current =>
    current?.kind === next.kind && current.id === next.id ? null : next,
  );

  const running = compare.state.status === "running" || list.state.status === "running" || checkpoint.state.status === "running";
  const noHistory = list.state.status === "done" && revisions.every(revision => revision.ref === "worktree");
  const options = useMemo(() => {
    const seen = new Set<string>();
    const rows: Revision[] = [];
    for (const rev of revisions) {
      if (seen.has(rev.ref)) continue;
      seen.add(rev.ref);
      rows.push(rev);
    }
    for (const extra of [from, to, "worktree"]) {
      if (!seen.has(extra)) {
        seen.add(extra);
        rows.push({ ref: extra, title: extra });
      }
    }
    return rows;
  }, [revisions, from, to]);

  const savePoint = async () => {
    if (running || !scopeReady || useUiStore.getState().activeProjectId !== projectId) return;
    const result = await checkpoint.run("board_revision_checkpoint", { projectId, label: `${sourceLabel} · before next edit`, ...(board ? { board } : {}) });
    if (result.status !== "done" || useUiStore.getState().activeProjectId !== projectId) return;
    const point = pcbToolJson(result.result).revision as Revision | undefined;
    if (point?.ref) { setRevisions(previous => [{ ref: "worktree", title: "Current files" }, point, ...previous.filter(row => row.ref !== point.ref && row.ref !== "worktree")]); setFrom(point.ref); setTo("worktree"); setCheckpointNotice(true); }
  };

  const onCompare = async () => {
    if (running || noHistory || !scopeReady || useUiStore.getState().activeProjectId !== projectId) return;
    setCheckpointNotice(false);
    const result = await compare.run("board_revision_diff", { projectId, from, to, ...(board ? { board } : {}) });
    if (result.status === "done") {
      // All six view artifacts are overwritten. Invalidate inactive views too,
      // otherwise switching modes can resurrect an older comparison image.
      await queryClient.invalidateQueries({ queryKey: ["file", projectId] });
    }
  };

  const diff = report?.diff;
  const hasChanges = !!diff && [diff.components.added, diff.components.removed, diff.components.changed, diff.nets.added, diff.nets.removed, diff.nets.changed].some(items => items.length > 0);
  return (
    <div ref={workspace} className="fd-diff-workspace flex h-full min-h-0 flex-col" data-testid="board-diff">
      <div className="fd-diff-toolbar" aria-label="Comparison controls">
      <div className="fd-diff-revisions flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        {!noHistory && <><label className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
          From
          <Select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From revision" className="h-8 max-w-52 text-xs">
            {options.map((rev) => (
              <option key={`from-${rev.ref}`} value={rev.ref}>
                {shortRef(rev.ref)}{rev.ref === "HEAD" || rev.ref === "worktree" ? "" : ` · ${rev.title}`}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
          To
          <Select value={to} onChange={(e) => setTo(e.target.value)} aria-label="To revision" className="h-8 max-w-52 text-xs">
            {options.map((rev) => (
              <option key={`to-${rev.ref}`} value={rev.ref}>
                {shortRef(rev.ref)}{rev.ref === "HEAD" || rev.ref === "worktree" ? "" : ` · ${rev.title}`}
              </option>
            ))}
          </Select>
        </label>
        <Button size="sm" variant="primary" disabled={running || noHistory || !scopeReady} onClick={() => void onCompare()}>
          {compare.state.status === "running" ? "Comparing…" : "Compare"}
        </Button></>}
        <Button size="sm" variant={noHistory ? "primary" : "secondary"} disabled={running || !scopeReady} onClick={() => void savePoint()}>{checkpoint.state.status === "running" ? "Saving point…" : "Save comparison point"}</Button>
        {running && <Spinner />}
        <span className="ml-auto text-[11px] text-muted">{report ? "Saved comparison · " : ""}{diffHeadline(report)}</span>
      </div>
      {report && <div className="fd-diff-views flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        {(["pcb", "schematic"] as const).filter(id => report.documents?.[id] !== false).map((id) => (
          <Button key={id} size="sm" variant={surface === id ? "primary" : "ghost"} onClick={() => setSurface(id)}>
            {id === "pcb" ? "PCB" : "Schematic"}
          </Button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        {(["structured", "overlay", "side-by-side"] as const).map((id) => (
          <Button
            key={id}
            size="sm"
            variant={mode === id ? "secondary" : "ghost"}
            aria-pressed={mode === id}
            disabled={id !== "structured" && !report?.files?.[FILE_KEYS[surface][id]]}
            onClick={() => setMode(id)}
          >
            {id === "structured" ? "Highlights" : id === "overlay" ? "Overlay" : "Side by side"}
          </Button>
        ))}
        {report && <Button ref={changesTrigger} size="sm" className="ml-auto" aria-expanded={changesOpen} aria-controls="revision-change-list" onClick={() => setChangesOpen(!changesOpen)}>Change list</Button>}
        </div>}
      {compare.state.error && <p role="alert" className="text-xs text-danger">{compare.state.error}</p>}
      </div>
      {checkpoint.state.error && <p role="alert" className="px-3 text-xs text-warning">{checkpoint.state.error}</p>}
      {checkpointNotice && <p role="status" className="px-3 text-xs text-muted">Comparison point saved. Make a change, then compare it with Current files.</p>}
      {list.state.error && <p role="alert" className="px-3 text-xs text-warning">Could not load revision history. {list.state.error}</p>}
      {report && <p className="px-1 text-[11px] text-muted">Saved comparison snapshot. After editing, choose Compare again to include your latest files.</p>}
      {mode === "overlay" && report && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
          <span className="text-muted">Compare revisions</span>
          {([{ label: "Before", value: 0 }, { label: "Both", value: 50 }, { label: "After", value: 100 }]).map(({ label, value }) => (
            <Button key={label} size="sm" variant={blend === value ? "secondary" : "ghost"} aria-pressed={blend === value} onClick={() => setBlend(value)}>{label}</Button>
          ))}
          <label className="flex items-center gap-2">
            <span>From</span>
            <input type="range" min={0} max={100} value={blend} aria-label="Revision blend" aria-valuetext={`${100 - blend}% From, ${blend}% To`}
              onChange={(event) => setBlend(Number(event.target.value))} className="w-36 accent-accent" />
            <span>To</span>
          </label>
          <span className="text-[11px] text-muted">{100 - blend}% From / {blend}% To · position and zoom stay fixed</span>
        </div>
      )}
      {report && <DiffLegend mode={mode} />}
      {reportQuery.isError ? (
        <LoadError title="Could not load the last diff report" onRetry={() => void reportQuery.refetch()} />
      ) : !report ? (
        <div className="fd-canvas-empty h-full">
          <EmptyState title={noHistory ? "No saved revision to compare yet" : "Compare board revisions"}>
            {noHistory ? "Save a comparison point before making a change. After editing, compare that point with Current files. Existing Git revisions are also available when this project has history." : "Choose a saved comparison point or Git revision to compare with your current files. Added parts are green, removed are red, and moved or changed parts are amber."}
          </EmptyState>
        </div>
      ) : (
        <div className="fd-diff-content flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            {svgPath && svg.isLoading ? <div className="flex h-full items-center justify-center gap-2" role="status"><Spinner />Loading comparison…</div> : svg.isError ? <LoadError title="Could not load this comparison drawing" onRetry={() => void svg.refetch()} /> : svgPath && svg.data ? (
              <SvgViewer
                svg={mode === "overlay" ? blendDiffOverlay(drawing.svg, blend) : drawing.svg}
                viewKey={`${projectId}:${svgPath}:${reportQuery.dataUpdatedAt}:${selection?.kind ?? ""}:${selection?.id ?? ""}`}
                toolbar={selection ? <>
                  <span role="status" className="text-[11px] text-muted">{drawing.found ? `Selected ${selection.id}` : `${selection.id}: no geometry in this view`}</span>
                  <Button size="sm" onClick={() => setSelection(null)}>Clear selection</Button>
                </> : <span className="text-[11px] text-muted">Click a change to locate it</span>}
              />
            ) : (
              <EmptyState title="No SVG for this view">
                Comparison drawings use the selected revisions’ design data. Run Compare again to refresh this view.
              </EmptyState>
            )}
          </div>
          {changesOpen && <aside ref={changesPanel} tabIndex={-1} id="revision-change-list" aria-label="Revision changes" className="fd-diff-change-list w-72 shrink-0 overflow-auto border-l border-border bg-panel-2/30 p-3 text-xs">
            <p className="mb-2 font-medium">
              {shortRef(report.from?.ref ?? from)} → {shortRef(report.to?.ref ?? to)}
            </p>
            <p className="mb-3 text-[11px] text-muted">{hasChanges ? "Click a change to highlight and zoom. Click again or press Esc to clear." : "No part or net changes in this comparison. This does not check electrical rules or manufacturing readiness."}</p>
            <DiffGroup
              selection={selection} onSelect={select}
              title="Added"
              tone="success"
              items={diff?.components.added.map((c) => ({ label: `${c.ref}${c.value ? ` ${c.value}` : ""}`, target: { kind: "part" as const, id: c.ref } })) ?? []}
            />
            <DiffGroup
              selection={selection} onSelect={select}
              title="Removed"
              tone="danger"
              items={diff?.components.removed.map((c) => ({ label: `${c.ref}${c.value ? ` ${c.value}` : ""}`, target: { kind: "part" as const, id: c.ref } })) ?? []}
            />
            <DiffGroup
              selection={selection} onSelect={select}
              title="Changed"
              tone="warning"
              items={
                diff?.components.changed.map((c) => ({ label: `${c.ref} (${c.reasons.join(", ")})`, target: { kind: "part" as const, id: c.ref } })) ?? []
              }
            />
            <DiffGroup selection={selection} onSelect={select} title="Nets added" tone="success" items={diff?.nets.added.map((n) => ({ label: n.name, target: { kind: "net" as const, id: n.name, refs: (n.nodes ?? []).map(node => node.ref) } })) ?? []} />
            <DiffGroup selection={selection} onSelect={select} title="Nets removed" tone="danger" items={diff?.nets.removed.map((n) => ({ label: n.name, target: { kind: "net" as const, id: n.name, refs: (n.nodes ?? []).map(node => node.ref) } })) ?? []} />
            <DiffGroup
              selection={selection} onSelect={select}
              title="Nets changed"
              tone="warning"
              items={
                diff?.nets.changed.map(
                  (n) => ({ label: `${n.name} (+${n.addedNodes.length}/−${n.removedNodes.length})`, target: { kind: "net" as const, id: n.name, refs: [...(n.before?.nodes ?? []), ...(n.after?.nodes ?? [])].map(node => node.ref) } }),
                ) ?? []
              }
            />
          </aside>}
        </div>
      )}
    </div>
  );
}

function DiffLegend({ mode }: { mode: Mode }) {
  const entries = mode === "structured"
    ? [
        { color: "#16a34a", label: "Added" },
        { color: "#dc2626", label: "Removed" },
        { color: "#d97706", label: "Moved / changed" },
        { color: "#64748b", label: "Unchanged" },
      ]
    : mode === "overlay"
      ? [
          { color: "#dc2626", label: "From revision" },
          { color: "#16a34a", label: "To revision" },
        ]
      : [{ color: "#64748b", label: "Revision geometry" }];
  return (
    <section aria-label="Drawing color legend" className="fd-diff-legend">
      <p className="mb-1.5 text-[11px] font-medium">Drawing colors</p>
      <ul className="space-y-1 text-[11px]">
        {[...entries, { color: "#2563eb", label: "Selected item" }].map(({ color, label }) => (
          <li key={label} className="flex items-center gap-2">
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: color }} />
            {label}
          </li>
        ))}
      </ul>
      {mode === "overlay" && <p className="mt-2 text-[11px] text-muted">Both drawings are transparent. Matching geometry blends; separated edges show differences.</p>}
      {mode === "side-by-side" && <p className="mt-2 text-[11px] text-muted">From is on the left; To is on the right.</p>}
    </section>
  );
}

function DiffGroup({ title, items, tone, selection, onSelect }: {
  title: string;
  items: Array<{ label: string; target: DiffSelection }>;
  tone: "success" | "danger" | "warning";
  selection: DiffSelection | null;
  onSelect: (target: DiffSelection) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center gap-1.5">
        <Badge tone={tone}>{items.length}</Badge>
        <span className={cn("font-medium")}>{title}</span>
      </div>
      <ul className="space-y-0.5 font-mono text-[11px]">
        {items.slice(0, 40).map((item) => (
          <li key={item.target.id}>
            <button type="button" aria-label={`Highlight ${item.label}`} aria-pressed={selection?.kind === item.target.kind && selection.id === item.target.id}
              onClick={() => onSelect(item.target)}
              className="w-full rounded border border-transparent px-2 py-1.5 text-left hover:bg-panel-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent aria-pressed:border-accent aria-pressed:bg-panel-2 aria-pressed:font-semibold">
              {item.label}
            </button>
          </li>
        ))}
        {items.length > 40 && <li className="text-muted">+{items.length - 40} more</li>}
      </ul>
    </div>
  );
}
