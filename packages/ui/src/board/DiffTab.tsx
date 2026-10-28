import { useEffect, useMemo, useState } from "react";
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
  return /^[0-9a-f]{7,40}$/i.test(ref) ? ref.slice(0, 8) : ref;
}

export function DiffTab() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const sources = useBoardSources(projectId);
  const [changesOpen, setChangesOpen] = useState(false);
  const queryClient = useQueryClient();
  const list = useRunTool();
  const compare = useRunTool();
  const reportQuery = useProjectJson(projectId, "reports/board-diff.json");
  const report = asReport(reportQuery.data);
  const [from, setFrom] = useState("HEAD");
  const [to, setTo] = useState("worktree");
  const [revisions, setRevisions] = useState<Revision[]>([
    { ref: "worktree", title: "Current worktree" },
    { ref: "HEAD", title: "HEAD" },
  ]);
  const [surface, setSurface] = useState<Surface>("pcb");
  const [mode, setMode] = useState<Mode>("structured");
  const [blend, setBlend] = useState(50);
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  useEffect(() => setSelection(null), [projectId, reportQuery.dataUpdatedAt]);
  useEffect(() => {
    if (!selection) return;
    const clear = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, [selection]);

  useEffect(() => {
    if (!projectId || sources.isPending || sources.isError || sources.data?.mode === "assembly") return;
    void list.run("board_revision_list", { projectId, limit: 40 }).then((state) => {
      const next = revisionsFrom(state.result);
      if (next.length > 0) setRevisions(next);
    });
  }, [projectId, list.run, sources.isPending, sources.isError, sources.data?.mode]);

  useEffect(() => {
    if (report?.from?.ref) setFrom(report.from.ref);
    if (report?.to?.ref) setTo(report.to.ref);
  }, [report?.from?.ref, report?.to?.ref]);

  const fileKey = FILE_KEYS[surface][mode];
  const svgPath = report?.files?.[fileKey] ?? report?.files?.[FILE_KEYS[surface].structured];
  const svg = useProjectText(projectId, svgPath ?? null);
  const drawing = useMemo(() => selectDiffGeometry(svg.data ?? "", selection), [svg.data, selection]);
  const select = (next: DiffSelection) => setSelection(current =>
    current?.kind === next.kind && current.id === next.id ? null : next,
  );

  const running = compare.state.status === "running" || list.state.status === "running";
  const noHistory = list.state.status === "done" && revisions.every(revision => revision.ref === "worktree");
  const options = useMemo(() => {
    const seen = new Set<string>();
    const rows: Revision[] = [];
    for (const rev of revisions) {
      if (seen.has(rev.ref)) continue;
      seen.add(rev.ref);
      rows.push(rev);
    }
    for (const extra of [from, to, "HEAD", "worktree"]) {
      if (!seen.has(extra)) {
        seen.add(extra);
        rows.push({ ref: extra, title: extra });
      }
    }
    return rows;
  }, [revisions, from, to]);

  if (!projectId) return <EmptyState title="Pick a project to compare revisions" />;

  if (sources.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (sources.isError) return <LoadError title="Could not verify board scope for comparison" onRetry={() => void sources.refetch()} />;
  if (sources.data?.mode === "assembly") return <div className="fd-canvas-empty h-full"><EmptyState title="Member-board revision comparison is not available yet"><p>Changes currently compares a project’s root board. Choose a board to inspect its saved source; this view does not compare or synchronize assembly members.</p><Button className="mt-4" onClick={() => useUiStore.getState().setWorkspaceArea("boards")}>Open boards</Button></EmptyState></div>;

  if (noHistory && !report) return <div className="fd-canvas-empty h-full"><EmptyState title="No saved revision to compare yet"><p>This view uses Git history. Open a project with commits, or save its first commit with your Git tools, then reopen Changes.</p><Button className="mt-4" onClick={() => useUiStore.getState().setWorkspaceArea("files")}>Open project files</Button></EmptyState></div>;

  const onCompare = async () => {
    if (running || noHistory || sources.isFetching || sources.isError) return;
    const result = await compare.run("board_revision_diff", { projectId, from, to });
    if (result.status === "done") {
      // All six view artifacts are overwritten. Invalidate inactive views too,
      // otherwise switching modes can resurrect an older comparison image.
      await queryClient.invalidateQueries({ queryKey: ["file", projectId] });
    }
  };

  const diff = report?.diff;
  return (
    <div className="fd-diff-workspace flex h-full min-h-0 flex-col" data-testid="board-diff">
      <div className="fd-diff-revisions flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <label className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
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
        <Button size="sm" variant="primary" disabled={running || noHistory || sources.isFetching} onClick={() => void onCompare()}>
          {running ? "Comparing…" : "Compare"}
        </Button>
        {running && <Spinner />}
        <span className="ml-auto text-[11px] text-muted">{report ? "Saved comparison · " : ""}{diffHeadline(report)}</span>
      </div>
      <div className="fd-diff-views flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        {(["pcb", "schematic"] as const).map((id) => (
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
        {report && <Button size="sm" className="ml-auto" aria-expanded={changesOpen} aria-controls="revision-change-list" onClick={() => setChangesOpen(!changesOpen)}>Change list</Button>}
        {compare.state.error && <span className="text-xs text-danger">{compare.state.error}</span>}
      </div>
      {list.state.error && <p role="alert" className="px-3 text-xs text-warning">Could not load revision history. {list.state.error}</p>}
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
      {reportQuery.isError ? (
        <LoadError title="Could not load the last diff report" onRetry={() => void reportQuery.refetch()} />
      ) : !report ? (
        <div className="fd-canvas-empty h-full">
          <EmptyState title={noHistory ? "No saved revision to compare yet" : "Compare board revisions"}>
            {noHistory ? "This view uses Git history. Open a project with commits, or save a commit using your Git tools, then reopen Changes." : "Choose two saved revisions, or compare the latest commit with your current files. Added parts are green, removed are red, and moved or changed parts are amber."}
          </EmptyState>
        </div>
      ) : (
        <div className="fd-diff-content flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            {svgPath && svg.data ? (
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
          {changesOpen && <aside id="revision-change-list" aria-label="Revision changes" className="fd-diff-change-list w-72 shrink-0 overflow-auto border-l border-border bg-panel-2/30 p-3 text-xs">
            <p className="mb-2 font-medium">
              {shortRef(report.from?.ref ?? from)} → {shortRef(report.to?.ref ?? to)}
            </p>
            <DiffLegend mode={mode} />
            <p className="mb-3 text-[11px] text-muted">Click a change to highlight and zoom. Click again or press Esc to clear.</p>
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
    <section aria-label="Drawing color legend" className="mb-3 rounded border border-border bg-panel p-2">
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
