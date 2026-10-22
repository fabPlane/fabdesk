import { useEffect, useMemo, useState } from "react";
import { ProjectImage } from "../chat/ProjectImage";
import { Button, Dialog, EmptyState, IconButton, Input, LoadError, Select, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { useProject, useProjectText, useRunTool } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { STENCIL_THICKNESSES_MM, DEFAULT_STENCIL_THICKNESS_MM, stencilThicknessMm } from "../stores/stencil-thickness";
import { cn } from "../util";
import { buildFileTree, fileAppearance, formatFileSize, type ExplorerNode } from "./file-explorer";
import { FileGlyph } from "./FileGlyph";
import { FILE_EXPORTS as EXPORTS, fileExportChoices, type FileExportKind as ExportKind } from "./file-exports";
import {
  DEFAULT_LASER_STENCIL_FORM,
  LaserStencilPresetPanel,
  laserStencilToolArgs,
  type LaserStencilFormState,
} from "./LaserStencilPresetPanel";

const MAX_TEXT_BYTES = 1_000_000;

export function FilesTab() {
  const projectId = useUiStore((s) => s.activeProjectId);
  if (!projectId) return <EmptyState title="No project selected" />;
  // Selection, folder state and export errors belong to one project.
  return <ProjectFiles key={projectId} projectId={projectId} />;
}

function ProjectFiles({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const thicknessMm = useUiStore((s) => stencilThicknessMm(s.stencilThicknessByProject?.[projectId]));
  const setThickness = useUiStore((s) => s.setStencilThickness);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const fileToReveal = useUiStore((s) => s.fileToReveal);
  useEffect(() => {
    if (fileToReveal?.projectId !== projectId) return;
    const path = fileToReveal.path;
    setSelected(path);
    setQuery("");
    const parts = path.split("/");
    setExpanded((previous) => {
      const next = new Set(previous);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, [fileToReveal, projectId]);
  const [exportOpen, setExportOpen] = useState(false);
  const [requestedExport, setExportKind] = useState<ExportKind>("export_stencil");
  const [lastExport, setLastExport] = useState<ExportKind>("export_stencil");
  const [laserForm, setLaserForm] = useState<LaserStencilFormState>(DEFAULT_LASER_STENCIL_FORM);
  const { run, state, manifest } = useRunTool();
  const exportChoices = fileExportChoices(manifest);
  const exportKind = exportChoices.includes(requestedExport) ? requestedExport : "export_gerbers";
  const busy = state.status === "running";
  const files = project.data?.files ?? [];
  const tree = useMemo(() => buildFileTree(files, query), [project.data?.files, query]);
  const file = files.find((f) => f.path === selected);
  const appearance = file ? fileAppearance(file.path) : null;
  const tooBig = !!file && file.size > MAX_TEXT_BYTES;
  const text = useProjectText(projectId, file && appearance?.preview === "text" && !tooBig ? file.path : null);
  const closeExport = () => { if (!busy) setExportOpen(false); };
  async function exportFiles() {
    setLastExport(exportKind);
    const extras =
      exportKind === "export_stencil"
        ? { thicknessMm }
        : exportKind === "export_laser_stencil"
          ? laserStencilToolArgs(laserForm)
          : {};
    const result = await run(exportKind, { projectId, ...extras });
    if (result.status === "done") { setExportOpen(false); void project.refetch(); }
  }
  function toggleFolder(path: string) {
    setExpanded((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  }
  function renderNodes(nodes: ExplorerNode[], depth = 0) {
    return <ul className="m-0 list-none p-0">{nodes.map((node) => {
      const open = !!query.trim() || expanded.has(node.path);
      const info = node.file ? fileAppearance(node.path) : null;
      return <li key={`${node.file ? "file" : "folder"}:${node.path}`}>
        <button type="button" className={cn("fd-file-row", node.file?.path === selected && "is-selected")}
          style={{ paddingLeft: 10 + depth * 16 }} title={node.file ? `${node.file.path} · ${formatFileSize(node.file.size)}` : node.path}
          aria-label={node.file ? `Open ${node.file.path}` : `${open ? "Collapse" : "Expand"} folder ${node.path}`}
          {...(node.file ? { "aria-pressed": selected === node.file.path } : { "aria-expanded": open })}
          onClick={() => node.file ? setSelected(node.file.path) : toggleFolder(node.path)}>
          {node.file ? <span className="w-3 shrink-0" /> : <Icon name={open ? "chevronDown" : "chevronRight"} width={12} height={12} className="shrink-0 text-muted" />}
          {info ? <FileGlyph kind={info.kind} /> : <Icon name={open ? "folderOpen" : "folder"} width={17} height={17} className="shrink-0 text-warning" />}
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          <span className="fd-file-kind">{info?.label ?? "Folder"}</span>
        </button>
        {!node.file && open && renderNodes(node.children, depth + 1)}
      </li>;
    })}</ul>;
  }

  if (project.isError) return <LoadError title="Could not load project files" onRetry={() => void project.refetch()} />;
  if (project.isLoading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  return (
    <div className="fd-files flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="folderOpen" className="text-muted" />
        <span className="text-xs font-semibold">Project files</span>
        <span className="text-[11px] text-muted">{files.length}</span>
        <Button size="sm" className="ml-auto" aria-label="Export project files" onClick={() => setExportOpen(true)} disabled={busy}>
          {busy ? <Spinner /> : <Icon name="export" width={16} height={16} />} {busy ? "Exporting…" : "Export"}
        </Button>
      </div>
      {state.status !== "idle" && !exportOpen && <div role={state.error ? "alert" : "status"} className={cn("border-b border-border px-3 py-2 text-xs", state.error ? "text-danger" : "text-muted")}>
        {state.error ?? (busy ? `Exporting ${EXPORTS[lastExport].title.toLowerCase()}…` : `${EXPORTS[lastExport].title} exported to exports/.`)}
        {state.note && <p className="mt-1">{state.note}</p>}
      </div>}
      <div className="fd-files-body flex min-h-0 flex-1">
        <nav aria-label="Project file explorer" className="fd-files-list flex w-72 shrink-0 flex-col border-r border-border bg-panel/40">
          <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
            <div className="relative min-w-0 flex-1">
              <Icon name="search" width={14} height={14} className="pointer-events-none absolute left-2 top-2 text-muted" />
              <Input aria-label="Find project files" placeholder="Find a file…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-7 pl-7 pr-7 text-xs" />
              {query && <button type="button" aria-label="Clear file search" className="absolute right-1 top-1 rounded-md p-0.5 text-muted hover:bg-panel-2 hover:text-fg" onClick={() => setQuery("")}><Icon name="close" width={16} height={16} /></button>}
            </div>
            <IconButton title="Collapse all folders" size="sm" disabled={!!query.trim()} onClick={() => setExpanded(new Set())}><Icon name="minus" width={14} height={14} /></IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {tree.length ? renderNodes(tree) : <p className="px-3 py-6 text-xs text-muted">{query ? "No matching files." : "This project has no files yet."}</p>}
          </div>
        </nav>
        <section aria-label="File preview" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!file && <EmptyState title="Select a file" icon={<Icon name="folderOpen" width={32} height={32} />}>
            Browse the folders to preview a file. Use Export to create a stencil, Gerbers or a component list.
          </EmptyState>}
          {file && appearance && <>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-panel/40 px-3 py-2">
              <FileGlyph kind={appearance.kind} />
              <span className="min-w-0 flex-1 break-all text-xs" title={file.path}>{file.path.replaceAll("\\", "/").split("/").join(" / ")}</span>
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">{appearance.label}</span>
              <span className="text-[10px] text-muted">{formatFileSize(file.size)}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {appearance.preview === "image" && <ProjectImage projectId={projectId} path={file.path} className="fd-file-image max-h-none max-w-full" />}
              {appearance.preview === "none" && <EmptyState title={`${appearance.label} file`} icon={<FileGlyph kind={appearance.kind} className="!h-10 !w-10" />}>
                {appearance.kind === "model" ? "Open this file in a compatible 3D viewer or slicer." : "A preview for this format is not available here."}
                <p className="mt-2 break-all font-mono text-xs">{file.path}</p>
              </EmptyState>}
              {appearance.preview === "text" && (tooBig ? <p className="text-xs text-muted">This file is too large to preview. Limit: 1 MB.</p>
                : text.isError ? <div role="alert" className="text-xs text-danger">Could not load this file.</div>
                : text.isLoading ? <Spinner />
                : text.data === null ? <p className="text-xs text-muted">This file is no longer available.</p>
                : <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere]">{text.data || "(Empty file)"}</pre>)}
            </div>
          </>}
        </section>
      </div>
      <Dialog open={exportOpen} onClose={closeExport} title="Export project files" className={exportKind === "export_laser_stencil" ? "w-[560px]" : "w-[480px]"}>
        <fieldset disabled={busy}>
          <legend className="mb-3 text-xs text-muted">What would you like to make?</legend>
          <div className="space-y-2">
            {exportChoices.map((kind) => <label key={kind} className={cn("flex cursor-pointer items-center gap-3 rounded-lg border p-3", exportKind === kind ? "border-accent bg-accent/10" : "border-border hover:bg-panel-2/50")}>
              <input type="radio" name="project-export" value={kind} checked={exportKind === kind} onChange={() => setExportKind(kind)} className="accent-[var(--fd-accent)]" />
              <FileGlyph kind={EXPORTS[kind].kind} />
              <span><span className="block text-[13px] font-medium">{EXPORTS[kind].title}</span><span className="block text-xs text-muted">{EXPORTS[kind].detail}</span></span>
            </label>)}
          </div>
          {exportKind === "export_stencil" && <div className="mt-4 rounded-lg border border-border bg-bg/40 p-3">
            <label className="flex items-center justify-between gap-3 text-xs font-medium">Stencil thickness
              <Select aria-label="Stencil thickness" value={thicknessMm} onChange={(e) => setThickness(projectId, Number(e.target.value))}>
                {STENCIL_THICKNESSES_MM.map((mm) => <option key={mm} value={mm}>{mm.toFixed(2)} mm{mm === DEFAULT_STENCIL_THICKNESS_MM ? " (default)" : ""}</option>)}
              </Select>
            </label>
            <p className="mt-2 text-xs leading-5 text-muted">Total stencil thickness. Match this to the total printed layer thickness in your slicer. Thicker stencils hold more paste.</p>
          </div>}
          {exportKind === "export_laser_stencil" && <LaserStencilPresetPanel form={laserForm} onChange={setLaserForm} />}
        </fieldset>
        {state.error && <p role="alert" className="mt-3 break-words text-xs text-danger">{EXPORTS[lastExport].title}: {state.error}</p>}
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          <span className="mr-auto text-[11px] text-muted">Saved under exports/</span>
          <Button size="sm" variant="ghost" onClick={closeExport} disabled={busy}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void exportFiles()}>{busy ? <><Spinner /> Exporting…</> : EXPORTS[exportKind].action}</Button>
        </div>
      </Dialog>
    </div>
  );
}
