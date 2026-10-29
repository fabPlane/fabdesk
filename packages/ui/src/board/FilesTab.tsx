import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ProjectImage } from "../chat/ProjectImage";
import { ProjectVideo } from "../chat/ProjectVideo";
import { Button, Dialog, EmptyState, IconButton, Input, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { editableSketchPaths, useBoardSources, usePcbPreviewRevision, useProject, useProjectText, useRunTool } from "@fabdesk/client-core";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { stencilThicknessMm } from "../stores/stencil-thickness";
import { cn } from "../util";
import { buildFileTree, fileAppearance, formatFileSize, type ExplorerNode } from "./file-explorer";
import { FileGlyph } from "./FileGlyph";
import { FileExportControls } from "./FileExportControls";
import { FILE_EXPORTS as EXPORTS, fileExportChoices, type FileExportKind as ExportKind } from "./file-exports";
import {
  DEFAULT_LASER_STENCIL_FORM,
  laserStencilToolArgs,
  type LaserStencilFormState,
} from "./LaserStencilPresetPanel";

const MAX_TEXT_BYTES = 1_000_000;

export function FilesTab({ exportFocus = false }: { exportFocus?: boolean } = {}) {
  const projectId = useUiStore((s) => s.activeProjectId);
  if (!projectId) return <EmptyState title="No project selected" />;
  // Selection, folder state and export errors belong to one project.
  return <ProjectFiles key={`${projectId}:${exportFocus}`} projectId={projectId} exportFocus={exportFocus} />;
}

function ProjectFiles({ projectId, exportFocus }: { projectId: string; exportFocus: boolean }) {
  const project = useProject(projectId);
  const sources = useBoardSources(projectId);
  const thicknessMm = useUiStore((s) => stencilThicknessMm(s.stencilThicknessByProject?.[projectId]));
  const setThickness = useUiStore((s) => s.setStencilThickness);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const fileToReveal = useUiStore((s) => s.fileToReveal);
  const fileTree = useRef<HTMLElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const revealFocus = useRef<{ intent: NonNullable<typeof fileToReveal>; previous: Element | null } | null>(null);
  useEffect(() => {
    if (fileToReveal?.projectId !== projectId) return;
    if (!exportFocus) revealFocus.current = { intent: fileToReveal, previous: document.activeElement };
    const path = fileToReveal.path;
    setSelected(path);
    setQuery("");
    const parts = path.split("/");
    setExpanded((previous) => {
      const next = new Set(previous);
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  }, [fileToReveal, projectId, exportFocus]);
  useLayoutEffect(() => {
    const pending = revealFocus.current;
    if (!pending || pending.intent !== fileToReveal || selected !== pending.intent.path || exportFocus) return;
    const row = [...(fileTree.current?.querySelectorAll<HTMLButtonElement>("[data-file-path]") ?? [])].find(element => element.dataset.filePath === selected);
    if (!row?.getClientRects().length) return;
    revealFocus.current = null;
    const ui = useUiStore.getState();
    if (ui.activeProjectId !== projectId || ui.fileToReveal !== pending.intent || document.activeElement !== document.body && document.activeElement !== pending.previous) return;
    row.scrollIntoView({ block: "nearest" }); row.focus({ preventScroll: true });
  }, [fileToReveal, selected, expanded, query, project.data, projectId, exportFocus]);
  const [exportOpen, setExportOpen] = useState(false);
  const [requestedExport, setExportKind] = useState<ExportKind>(exportFocus ? "export_gerbers" : "export_stencil");
  const [lastExport, setLastExport] = useState<ExportKind>(exportFocus ? "export_gerbers" : "export_stencil");
  const [laserForm, setLaserForm] = useState<LaserStencilFormState>(DEFAULT_LASER_STENCIL_FORM);
  const { run, state, manifest } = useRunTool();
  const availableExports = fileExportChoices(manifest);
  const exportChoices: ExportKind[] = exportFocus ? ["export_gerbers", "export_bom", ...availableExports.filter(kind => kind !== "export_gerbers" && kind !== "export_bom")] : availableExports;
  const exportKind = exportChoices.includes(requestedExport) ? requestedExport : "export_gerbers";
  const busy = state.status === "running";
  const files = project.data?.files ?? [];
  const assembly = sources.data?.mode === "assembly";
  const hasPcb = files.some(file => file.path === "board.kicad_pcb");
  const bomSource = files.some(file => ["project.parts.json", "circuit.netlist.json", "board.kicad_sch"].includes(file.path));
  const scopeReady = !!sources.data && !sources.isFetching && !sources.isError;
  const hasFabricationFiles = files.some(file => file.path.startsWith("exports/gerbers/") || ["exports/positions.csv", "exports/bom.csv"].includes(file.path));
  const canExport = scopeReady && (exportKind === "export_bom" ? bomSource : !assembly && (exportKind === "export_zip" ? hasFabricationFiles : hasPcb));
  const sourceNote = !scopeReady ? sources.isError ? "Board source scope could not be checked. Retry before exporting." : "Checking board sources…" : exportKind === "export_bom" ? !bomSource ? "Add a saved netlist, schematic or project parts list before exporting a BOM. Member-board BOMs are not included." : assembly ? "Project parts CSV includes saved root netlist and extras only; member-board BOMs are not included." : "Uses the saved netlist and project hardware, or schematic fallback. Component coverage and freshness are unverified." : assembly ? "Member-board manufacturing exports are not available here yet. Choose a board to inspect its source; project parts CSV remains separate." : exportKind === "export_zip" ? hasFabricationFiles ? "Packages existing Gerbers, drills, placements and BOM when present. Missing optional files are reported; nothing is regenerated or validated." : "Export Gerbers, drill files, placements or a BOM before creating a ZIP." : !hasPcb ? "Add a saved PCB in Board before creating manufacturing files." : exportKind === "export_dxf" ? "Exports F.Cu, B.Cu and Edge.Cuts in millimetres. Bottom layers use a top view. Review saved checks before fabrication." : "Exports use this project’s saved PCB. Review current checks, routing and clearances before fabrication.";
  const previewPresent = exportFocus && !assembly && files.some(file => file.path === "renders/pcb.svg");
  const previewRevision = usePcbPreviewRevision(projectId, previewPresent);
  const previewLabel = previewRevision.isFetching ? "Checking saved preview…" : previewRevision.isError ? "Preview source check unavailable" : previewRevision.data === "matches-source" ? "Preview matches saved PCB" : previewRevision.data === "source-changed" ? "PCB changed · Preview is older" : "Saved preview · Source unverified";
  const tree = useMemo(() => buildFileTree(files, query), [project.data?.files, query]);
  const file = files.find((f) => f.path === selected);
  const appearance = file ? fileAppearance(file.path) : null;
  const tooBig = !!file && file.size > MAX_TEXT_BYTES;
  const text = useProjectText(projectId, file && appearance?.preview === "text" && !tooBig ? file.path : null);
  const closeExport = () => { if (!busy) setExportOpen(false); };
  async function exportFiles() {
    if (!canExport || busy || useUiStore.getState().activeProjectId !== projectId) return;
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
          data-file-path={node.file?.path}
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
  const exportControls = { exportChoices, exportKind, setExportKind, thicknessMm, onThickness: (value: number) => setThickness(projectId, value), laserForm, setLaserForm, busy, canExport, sourceNote, ...(state.error && !exportFocus ? { error: `${EXPORTS[lastExport].title}: ${state.error}` } : {}), onExport: () => void exportFiles() };
  if (exportFocus) return <div className="fd-export-workspace">
    <header><h1>Export files</h1><p>Choose what you need for fabrication or your parts list.</p></header>
    <div className="fd-export-flow">
      <section className="fd-export-reference" aria-label="Export source reference">
        {previewPresent ? <><ProjectImage retryable projectId={projectId} path="renders/pcb.svg" alt="Saved PCB preview for export reference" /><p>{previewLabel}</p></> : <EmptyState title={assembly ? "Assembly source exports need board scope" : hasPcb ? "Saved PCB ready for export selection" : "Start with a saved PCB"} icon={<Icon name="pcb" width={48} height={48} />}><p>{assembly ? "This export screen cannot manufacture all member boards. Their individual previews remain available in Boards." : "Use Board to inspect your source. Exports do not establish that a design is ready to manufacture."}</p><Button className="mt-4" onClick={() => useUiStore.getState().setBoardTab("pcb")}>Open Board</Button></EmptyState>}
      </section>
      <section className="fd-export-config" aria-label="Export options"><FileExportControls {...exportControls} />{sources.isError && <Button size="sm" onClick={() => void sources.refetch()}>Retry source check</Button>}</section>
    </div>
    {state.status !== "idle" && <div className="fd-export-feedback" role={state.error ? "alert" : "status"}>{state.error ?? (busy ? `Exporting ${EXPORTS[lastExport].title.toLowerCase()}…` : `${EXPORTS[lastExport].title} saved in project outputs.`)}{state.note && <p>{state.note}</p>}{state.status === "done" && <ExportCompletionDetails kind={lastExport} result={state.result} />}{state.status === "done" && <Button size="sm" variant="ghost" onClick={() => { const ui = useUiStore.getState(); ui.setWorkspaceArea("outputs"); ui.setWorkspaceTab("renders"); }}>Open output library</Button>}</div>}
  </div>;
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
        {state.status === "done" && <ExportCompletionDetails kind={lastExport} result={state.result} />}
      </div>}
      <div className="fd-files-body flex min-h-0 flex-1">
        <nav ref={fileTree} aria-label="Project file explorer" className="fd-files-list flex w-72 shrink-0 flex-col border-r border-border bg-panel/40">
          <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
            <div className="relative min-w-0 flex-1">
              <Icon name="search" width={14} height={14} className="pointer-events-none absolute left-2 top-2 text-muted" />
              <Input ref={searchInput} aria-label="Find project files" placeholder="Find a file…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-7 pl-7 pr-7 text-xs" />
              {query && <button type="button" aria-label="Clear file search" className="absolute right-1 top-1 rounded-md p-0.5 text-muted hover:bg-panel-2 hover:text-fg" onClick={() => { setQuery(""); searchInput.current?.focus(); }}><Icon name="close" width={16} height={16} /></button>}
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
              {editableSketchPaths([file]).includes(file.path) && <Button size="sm" variant="ghost" onClick={() => {
                const ui = useUiStore.getState();
                if (ui.activeProjectId === projectId) ui.setSketchOpen(true, "draw", file.path);
              }}>Open drawing copy</Button>}
              {/\.(png|jpe?g)$/i.test(file.path) && <Button size="sm" variant="ghost" onClick={() => {
                const ui = useUiStore.getState();
                if (ui.activeProjectId !== projectId) return;
                const key = ui.activeThreadId ?? newChatDraftKey(projectId);
                if (!ui.attachments[key]?.some(item => item.path === file.path)) ui.addAttachment(key, { path: file.path, mime: /\.jpe?g$/i.test(file.path) ? "image/jpeg" : "image/png", label: file.path.split("/").pop() ?? file.path });
                ui.focusComposer();
              }}><Icon name="sparkles" width={14} height={14} />Use in conversation</Button>}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {appearance.preview === "image" && <ProjectImage retryable projectId={projectId} path={file.path} className="fd-file-image max-h-none max-w-full" />}
              {appearance.preview === "video" && <ProjectVideo projectId={projectId} path={file.path} className="max-h-[75vh] max-w-full" />}
              {appearance.preview === "none" && <EmptyState title={`${appearance.label} file`} icon={<FileGlyph kind={appearance.kind} className="!h-10 !w-10" />}>
                {appearance.kind === "model" ? "Open this file in a compatible 3D viewer or slicer." : "A preview for this format is not available here."}
                <p className="mt-2 break-all font-mono text-xs">{file.path}</p>
              </EmptyState>}
              {appearance.preview === "text" && (tooBig ? <p className="text-xs text-muted">This file is too large to preview. Limit: 1 MB.</p>
                : text.isError ? <div role="alert" className="space-y-2 text-xs text-danger"><p>Could not load this file.</p><Button size="sm" variant="ghost" disabled={text.isFetching} onClick={() => void text.refetch()}>{text.isFetching ? "Retrying…" : "Retry file preview"}</Button></div>
                : text.isLoading ? <Spinner />
                : text.data === null ? <p className="text-xs text-muted">This file is no longer available.</p>
                : <pre className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere]">{text.data || "(Empty file)"}</pre>)}
            </div>
          </>}
        </section>
      </div>
      <Dialog open={exportOpen} onClose={closeExport} title="Export project files" className={exportKind === "export_laser_stencil" ? "w-[560px]" : "w-[480px]"}>
        <FileExportControls {...exportControls} onClose={closeExport} />
        {sources.isError && <Button size="sm" onClick={() => void sources.refetch()}>Retry source check</Button>}
      </Dialog>
    </div>
  );
}


function ExportCompletionDetails({ kind, result }: { kind: ExportKind; result: unknown }) {
  if (kind !== "export_zip" || !result || typeof result !== "object" || !("json" in result)) return null;
  const json = result.json;
  if (!json || typeof json !== "object") return null;
  const files = "files" in json && Array.isArray(json.files) ? json.files.filter((file): file is string => typeof file === "string") : [];
  const missing = "missing" in json && Array.isArray(json.missing) ? json.missing.filter((file): file is string => typeof file === "string") : [];
  return <p>{files.length} saved files packaged{missing.length ? ` · Not included: ${missing.join(", ")}` : ""}</p>;
}
