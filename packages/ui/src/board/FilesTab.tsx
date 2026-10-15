import { useState } from "react";
import { ProjectImage } from "../chat/ProjectImage";
import { Button, EmptyState, LoadError, Select, Spinner } from "../components/ui";
import { useProject, useProjectText, useRunTool } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { STENCIL_THICKNESSES_MM, DEFAULT_STENCIL_THICKNESS_MM, stencilThicknessMm } from "../stores/stencil-thickness";
import { cn, isImagePath } from "../util";

const MAX_TEXT_BYTES = 1_000_000;

export function FilesTab() {
  const projectId = useUiStore((s) => s.activeProjectId);
  if (!projectId) return <EmptyState title="No project selected" />;
  // File selection and export status belong to one project. Remount on a switch
  // so a previous project's error (or late export completion) cannot leak here.
  return <ProjectFiles key={projectId} projectId={projectId} />;
}

function ProjectFiles({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const thicknessMm = useUiStore((s) => stencilThicknessMm(s.stencilThicknessByProject?.[projectId]));
  const setThickness = useUiStore((s) => s.setStencilThickness);
  const [selected, setSelected] = useState<string | null>(null);
  const { run, state } = useRunTool();
  const busy = state.status === "running";
  const files = [...(project.data?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const file = files.find((f) => f.path === selected);
  const isImage = !!file && isImagePath(file.path) && !file.path.endsWith(".svg");
  const tooBig = !!file && file.size > MAX_TEXT_BYTES;
  const text = useProjectText(projectId, file && !isImage && !tooBig ? file.path : null);

  if (project.isError) return <LoadError title="Could not load project files" onRetry={() => void project.refetch()} />;
  if (project.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="fd-files flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
        <Button size="sm" disabled={busy} onClick={() => void run("export_gerbers", { projectId })}>
          Export gerbers
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void run("export_bom", { projectId })}>
          Export BOM
        </Button>
        <span className="ml-auto text-[11px] text-muted">Writes under exports/</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-2">
        <label className="flex items-center gap-2 text-xs">
          Stencil thickness
          <Select aria-label="Stencil thickness" className="h-8" value={thicknessMm} disabled={busy}
            onChange={(e) => setThickness(projectId, Number(e.target.value))}>
            {STENCIL_THICKNESSES_MM.map((mm) => (
              <option key={mm} value={mm}>{mm.toFixed(2)} mm{mm === DEFAULT_STENCIL_THICKNESS_MM ? " (default)" : ""}</option>
            ))}
          </Select>
        </label>
        <Button size="sm" disabled={busy} onClick={() => void run("stencil", { projectId, thicknessMm })}>
          {busy ? "Exporting…" : "Export stencil"}
        </Button>
        <p className="w-full text-[11px] text-muted">Total thickness, not layer height. Thicker stencils hold more paste. Match your slicer's total layer thickness.</p>
        {state.error && <span className="text-xs text-danger">{state.error}</span>}
        {state.note && <span role="status" className="text-xs text-muted">{state.note}</span>}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="fd-files-list w-56 shrink-0 overflow-auto border-r border-border py-1">
        {files.length === 0 && <div className="px-3 py-4 text-xs text-muted">Empty project.</div>}
        {files.map((f) => (
          <button
            key={f.path}
            onClick={() => setSelected(f.path)}
            className={cn(
              "flex w-full items-center justify-between gap-2 px-3 py-1 text-left font-mono text-[11.5px] hover:bg-panel-2/60",
              selected === f.path && "bg-panel-2",
            )}
            title={`${f.path} (${f.size} bytes)`}
            aria-pressed={selected === f.path}
          >
            <span className="truncate">{f.path}</span>
            <span className="shrink-0 text-[10px] text-muted">{f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(0)}K`}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3">
        {text.isError && <div role="alert" className="text-xs text-danger">Could not load this file.</div>}
        {!file && <div className="text-xs text-muted">Select a file to view it.</div>}
        {file && isImage && <ProjectImage projectId={projectId} path={file.path} className="max-h-none" />}
        {file && tooBig && <div className="text-xs text-muted">File is too large to preview ({(file.size / 1024).toFixed(0)} KB).</div>}
        {file && !isImage && !tooBig && (
          text.isLoading ? (
            <Spinner />
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere]">{text.data ?? ""}</pre>
          )
        )}
      </div>
      </div>
    </div>
  );
}
