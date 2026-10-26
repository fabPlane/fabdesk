import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, EmptyState, LoadError, Select, Spinner } from "../components/ui";
import { useProjectJson, useProjectText, useRunTool } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { SvgViewer } from "./SvgViewer";
import { cn } from "../util";
import { diffHeadline } from "./diff-copy";

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
      added: Array<{ name: string }>;
      removed: Array<{ name: string }>;
      changed: Array<{ name: string; addedNodes: unknown[]; removedNodes: unknown[] }>;
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
  return /^[0-9a-f]{7,40}$/i.test(ref) ? ref.slice(0, 8) : ref;
}

export function DiffTab() {
  const projectId = useUiStore((s) => s.activeProjectId);
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

  useEffect(() => {
    if (!projectId) return;
    void list.run("board_revision_list", { projectId, limit: 40 }).then((state) => {
      const next = revisionsFrom(state.result);
      if (next.length > 0) setRevisions(next);
    });
  }, [projectId, list.run]);

  useEffect(() => {
    if (report?.from?.ref) setFrom(report.from.ref);
    if (report?.to?.ref) setTo(report.to.ref);
  }, [report?.from?.ref, report?.to?.ref]);

  const fileKey = FILE_KEYS[surface][mode];
  const svgPath = report?.files?.[fileKey] ?? report?.files?.[FILE_KEYS[surface].structured];
  const svg = useProjectText(projectId, svgPath ?? null);

  const running = compare.state.status === "running" || list.state.status === "running";
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

  const onCompare = async () => {
    const result = await compare.run("board_revision_diff", { projectId, from, to });
    if (result.status === "done") {
      // All six view artifacts are overwritten. Invalidate inactive views too,
      // otherwise switching modes can resurrect an older comparison image.
      await queryClient.invalidateQueries({ queryKey: ["file", projectId] });
    }
  };

  const diff = report?.diff;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="board-diff">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <label className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
          From
          <Select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From revision" className="h-8 max-w-52 text-xs">
            {options.map((rev) => (
              <option key={`from-${rev.ref}`} value={rev.ref}>
                {shortRef(rev.ref)} · {rev.title}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 items-center gap-1 text-[11px] text-muted">
          To
          <Select value={to} onChange={(e) => setTo(e.target.value)} aria-label="To revision" className="h-8 max-w-52 text-xs">
            {options.map((rev) => (
              <option key={`to-${rev.ref}`} value={rev.ref}>
                {shortRef(rev.ref)} · {rev.title}
              </option>
            ))}
          </Select>
        </label>
        <Button size="sm" variant="primary" disabled={running} onClick={() => void onCompare()}>
          {running ? "Comparing…" : "Compare"}
        </Button>
        {running && <Spinner />}
        <span className="ml-auto text-[11px] text-muted">{diffHeadline(report)}</span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
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
            disabled={!report?.files?.[FILE_KEYS[surface][id]] && id !== "structured"}
            onClick={() => setMode(id)}
          >
            {id === "structured" ? "Highlights" : id === "overlay" ? "Overlay" : "Side by side"}
          </Button>
        ))}
        {mode !== "structured" && <span className="text-[11px] text-muted">Matching simplified drawings from both revisions</span>}
        {compare.state.error && <span className="text-xs text-danger">{compare.state.error}</span>}
      </div>
      {reportQuery.isError ? (
        <LoadError title="Could not load the last diff report" onRetry={() => void reportQuery.refetch()} />
      ) : !report ? (
        <div className="fd-canvas-empty h-full">
          <EmptyState title="No revision diff yet">
            Choose two git revisions (or HEAD and the current worktree) and compare. Added parts are green, removed are
            red, moved/changed are amber.
          </EmptyState>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            {svgPath && svg.data ? (
              <SvgViewer
                svg={svg.data}
                toolbar={<span className="text-[11px] text-muted">{svgPath}</span>}
              />
            ) : (
              <EmptyState title="No SVG for this view">
                Comparison drawings use the selected revisions’ design data. Run Compare again to refresh this view.
              </EmptyState>
            )}
          </div>
          <aside className="w-72 shrink-0 overflow-auto border-l border-border bg-panel-2/30 p-3 text-xs">
            <p className="mb-2 font-medium">
              {shortRef(report.from?.ref ?? from)} → {shortRef(report.to?.ref ?? to)}
            </p>
            <DiffGroup
              title="Added"
              tone="success"
              items={diff?.components.added.map((c) => `${c.ref}${c.value ? ` ${c.value}` : ""}`) ?? []}
            />
            <DiffGroup
              title="Removed"
              tone="danger"
              items={diff?.components.removed.map((c) => `${c.ref}${c.value ? ` ${c.value}` : ""}`) ?? []}
            />
            <DiffGroup
              title="Changed"
              tone="warning"
              items={
                diff?.components.changed.map((c) => `${c.ref} (${c.reasons.join(", ")})`) ?? []
              }
            />
            <DiffGroup title="Nets added" tone="success" items={diff?.nets.added.map((n) => n.name) ?? []} />
            <DiffGroup title="Nets removed" tone="danger" items={diff?.nets.removed.map((n) => n.name) ?? []} />
            <DiffGroup
              title="Nets changed"
              tone="warning"
              items={
                diff?.nets.changed.map(
                  (n) => `${n.name} (+${n.addedNodes.length}/−${n.removedNodes.length})`,
                ) ?? []
              }
            />
          </aside>
        </div>
      )}
    </div>
  );
}

function DiffGroup({ title, items, tone }: { title: string; items: string[]; tone: "success" | "danger" | "warning" }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center gap-1.5">
        <Badge tone={tone}>{items.length}</Badge>
        <span className={cn("font-medium")}>{title}</span>
      </div>
      <ul className="space-y-0.5 font-mono text-[11px]">
        {items.slice(0, 40).map((item) => (
          <li key={item}>{item}</li>
        ))}
        {items.length > 40 && <li className="text-muted">+{items.length - 40} more</li>}
      </ul>
    </div>
  );
}
