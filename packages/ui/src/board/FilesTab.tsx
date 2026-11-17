import { useProjectExitGuard } from "../hooks/useProjectExitGuard";
import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { ErrorNotice } from "../components/ErrorNotice";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { useOutputSource } from "./useOutputSource";
import { boardFileDestination, sha256Blob, exportGerberPackage, gerberPackageFilename } from "@fabdesk/client-core";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ProjectImage } from "../chat/ProjectImage";
import { ProjectVideo } from "../chat/ProjectVideo";
import { Select, Button, EmptyState, IconButton, Input, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { editableSketchPaths, savedOutputs, useCoreClient, usePcbPreviewRevision, useProject, useProjectText, useRunTool } from "@fabdesk/client-core";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { stencilThicknessMm } from "../stores/stencil-thickness";
import { cn } from "../util";
import { buildFileTree, fileAppearance, formatFileSize, type ExplorerNode } from "./file-explorer";
import { FileGlyph } from "./FileGlyph";
import { FileExportControls } from "./FileExportControls";
import { ManufacturingHandoff } from "./ManufacturingHandoff";
import { OutputPreviewDialog } from "./OutputPreviewDialog";
import { ExportCompletionDetails } from "./ExportCompletionDetails";
import { FILE_EXPORTS as EXPORTS, fileExportChoices, type FileExportKind as ExportKind } from "./file-exports";
import {
  DEFAULT_LASER_STENCIL_FORM,
  laserStencilToolArgs,
  type LaserStencilFormState,
} from "./LaserStencilPresetPanel";

const ProjectPdf = lazy(() => import("./ProjectPdf"));
const ModelCanvas = lazy(() => import("./ModelCanvas"));

const MAX_TEXT_BYTES = 1_000_000;

export function FilesTab({ exportFocus = false }: { exportFocus?: boolean } = {}) {
  const projectId = useUiStore((s) => s.activeProjectId);
  if (!projectId) return <EmptyState title="No project selected" />;
  // Selection, folder state and export errors belong to one project.
  return <ProjectFiles key={`${projectId}:${exportFocus}`} projectId={projectId} exportFocus={exportFocus} />;
}

function ProjectFiles({ projectId, exportFocus }: { projectId: string; exportFocus: boolean }) {
  const client = useCoreClient();
  const project = useProject(projectId);
  const outputSource = useOutputSource(projectId), sources = outputSource.sources;
  const thicknessMm = useUiStore((s) => stencilThicknessMm(s.stencilThicknessByProject?.[projectId]));
  const setThickness = useUiStore((s) => s.setStencilThickness);
  const [selected, setSelected] = useState<string | null>(() => useUiStore.getState().selectedFileByProject[projectId] ?? null);
  const [modelPreviewPath, setModelPreviewPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [fileListOpen, setFileListOpen] = useState(true);
  useEffect(() => { if (selected) useUiStore.getState().rememberProjectFile(projectId, selected); }, [projectId, selected]);
  const [pdfToolbarHost, setPdfToolbarHost] = useState<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [downloadPath, setDownloadPath] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<{ path: string; message: string } | null>(null);
  const fileToReveal = useUiStore((s) => s.fileToReveal);
  const fileTree = useRef<HTMLElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const revealFocus = useRef<{ intent: NonNullable<typeof fileToReveal>; previous: Element | null } | null>(null);
  useEffect(() => {
    if (fileToReveal?.projectId !== projectId) return;
    if (!exportFocus) revealFocus.current = { intent: fileToReveal, previous: document.activeElement };
    const path = fileToReveal.path;
    setSelected(path);
    setFileListOpen(true);
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
  const [requestedExport, setExportKind] = useState<ExportKind>(exportFocus ? "export_gerbers" : "export_stencil");
  const [lastExport, setLastExport] = useState<ExportKind>(exportFocus ? "export_gerbers" : "export_stencil");
  const [packagePhase, setPackagePhase] = useState<string | null>(null);
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packageResult, setPackageResult] = useState<{ path: string; files: string[] } | null>(null);
  const [lastScope, setLastScope] = useState<string | null>(null);
  const [laserForm, setLaserForm] = useState<LaserStencilFormState>(DEFAULT_LASER_STENCIL_FORM);
  const { run, state, manifest } = useRunTool();
  const availableExports = fileExportChoices(manifest).filter(kind => kind !== "export_bom");
  const exportChoices: ExportKind[] = exportFocus ? ["export_gerbers", ...availableExports.filter(kind => kind !== "export_gerbers")] : availableExports;
  const exportKind = exportChoices.includes(requestedExport) ? requestedExport : "export_gerbers";
  useProjectExitGuard(projectId, packagePhase ? "The Gerber package sequence is running. Wait for its remaining export steps to finish." : null);
  const busy = state.status === "running" || packagePhase !== null;
  const files = project.data?.files ?? [];
  const { assembly, prefix, board, row: source, ready: sourceReady } = outputSource;
  const scopeKey = `${prefix}:${board?.sourceId ?? "root"}:${board?.manifestSha256 ?? ""}`;
  const hasPcb = files.some(file => file.path === `${prefix}board.kicad_pcb`) && (!assembly || source?.status === "available");
  const scopeReady = !!sources.data && !sources.isFetching && !sources.isError;
  const hasFabricationFiles = files.some(file => file.path.startsWith(`${prefix}exports/gerbers/`) || [`${prefix}exports/positions.csv`, `${prefix}exports/bom.csv`].includes(file.path));
  const packageToolsReady = !exportFocus || exportKind !== "export_gerbers" || ["export_gerbers", "export_drill", "export_zip"].every(name => manifest?.some(tool => tool.name === name));
  const canExport = scopeReady && sourceReady && packageToolsReady && (exportKind === "export_zip" ? hasFabricationFiles : hasPcb);
  const sourceNote = !manifest ? "Checking available export tools…" : !packageToolsReady ? "This core must provide Gerber, drill and ZIP exporters to create a package. Individual exports remain in Project files." : !scopeReady ? sources.isError ? "Board sources could not be checked. Retry before exporting." : "Checking board sources…" : assembly && !sourceReady ? "Choose an available board source before exporting. Changed source definitions must be selected again." : exportKind === "export_zip" ? hasFabricationFiles ? "Packages this board’s existing Gerbers, drills, placements and BOM when present. Missing files are reported; nothing is regenerated." : "Export Gerbers, drill files or placements before creating a ZIP." : !hasPcb ? "Add this board’s saved KiCad PCB before creating manufacturing files." : exportKind === "export_dxf" ? "F.Cu, B.Cu and Edge.Cuts in millimetres. Bottom layers use a top view." : "Uses the selected board’s saved PCB. Review checks, routing and clearances before fabrication.";
  const previewPresent = exportFocus && hasPcb && files.some(file => file.path === `${prefix}renders/pcb.svg`);
  const previewRevision = usePcbPreviewRevision(projectId, previewPresent && !assembly);
  const previewLabel = assembly ? "Saved PCB drawing · Review checks separately" : previewRevision.isFetching ? "Checking saved preview…" : previewRevision.isError ? "Preview source check unavailable" : previewRevision.data === "matches-source" ? "Preview matches saved PCB" : previewRevision.data === "source-changed" ? "PCB changed · Preview is older" : "Saved preview · Source unverified";
  const tree = useMemo(() => buildFileTree(files, query), [project.data?.files, query]);
  const matchingFileCount = query.trim() ? files.filter(file => file.path.replaceAll("\\", "/").toLowerCase().includes(query.trim().toLowerCase())).length : files.length;
  const file = files.find((f) => f.path === selected);
  const appearance = file ? fileAppearance(file.path) : null;
  const canPreviewModel = !!file && /\.(glb|stl|obj)$/i.test(file.path);
  const inlineModel = !!file && /\.stl$/i.test(file.path);
  const modelPreview = canPreviewModel && modelPreviewPath === file?.path ? {
    ...savedOutputs(files, assembly ? sources.data?.sources : []).find(output => output.path === modelPreviewPath),
    path: modelPreviewPath!, kind: "models" as const,
  } : null;
  const designDestination = file && scopeReady && sources.data ? boardFileDestination(sources.data, file.path) : null;
  const assistantSurface = { projectId, label: exportFocus ? "Outputs / Export files" : file ? `File · ${file.path.split("/").pop()}` : "Project files", priority: 10, details: JSON.stringify(exportFocus ? { board, source: source?.source, sourceReady, format: exportKind, outputDirectory: `${prefix}exports/`, busy, error: state.error } : { selectedFile: file?.path, format: appearance?.label, fileBytes: file?.size, preview: appearance?.preview }) };
  useAssistantSurface(assistantSurface);
  const tooBig = !!file && file.size > MAX_TEXT_BYTES;
  const text = useProjectText(projectId, file && appearance?.preview === "text" && !tooBig ? file.path : null);
  async function exportFiles() {
    if (!canExport || busy || useUiStore.getState().activeProjectId !== projectId) return;
    setLastExport(exportKind);
    setLastScope(scopeKey);
    setPackageError(null);
    setPackageResult(null);
    // The existing tools share source-bound guards. A manufacturing package needs
    // drills as well as layers; never describe a partial sequence as complete.
    if (exportFocus && exportKind === "export_gerbers") {
      const capturedBoard = board;
      try {
        setPackagePhase("Checking package source…");
        const capturedSha = source?.pcbSha256 ?? await sha256Blob(await client.readFileBlob(projectId, `${prefix}board.kicad_pcb`));
        const result = await exportGerberPackage({ projectId, sourceSha256: capturedSha,
          filename: gerberPackageFilename(source?.source.name ?? project.data?.name ?? "board"),
          ...(capturedBoard ? { board: capturedBoard } : {}), run,
          isCurrent: () => useUiStore.getState().activeProjectId === projectId, onPhase: setPackagePhase });
        setPackageResult({ path: `${prefix}exports/${result.filename}`, files: result.files });
        await project.refetch();
      } catch (failure) { setPackageError(failure instanceof Error ? failure.message : "Manufacturing package did not finish."); }
      finally { setPackagePhase(null); }
      return;
    }
    const extras =
      exportKind === "export_stencil"
        ? { thicknessMm }
        : exportKind === "export_laser_stencil"
          ? laserStencilToolArgs(laserForm)
          : {};
    const result = await run(exportKind, { projectId, ...(board && exportKind !== "export_bom" ? { board, expectedSourceSha256: source?.pcbSha256 } : {}), ...extras });
    if (result.status === "done") void project.refetch();
  }
  async function downloadFile(path: string) {
    if (downloadPath || useUiStore.getState().activeProjectId !== projectId) return;
    setDownloadPath(path); setDownloadError(null);
    try {
      const blob = await client.readFileBlob(projectId, path);
      if (useUiStore.getState().activeProjectId !== projectId) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = path.split("/").pop() || "project-file"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { setDownloadError({ path, message: "Could not download this file. Try again." }); }
    finally { setDownloadPath(null); }
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
  const exportControls = { gerberPackage: exportFocus, exportChoices, exportKind, setExportKind, thicknessMm, onThickness: (value: number) => setThickness(projectId, value), laserForm, setLaserForm, busy, canExport, sourceNote, ...(state.error && !exportFocus ? { error: `${EXPORTS[lastExport].title}: ${state.error}` } : {}), onExport: () => void exportFiles() };
  if (exportFocus) return <div className="fd-export-workspace">
    <header><div><h1>Export files</h1><p>{assembly ? "Choose a board, then select the files to export." : hasPcb ? "Choose the files to export from this board. Exported files appear in Library." : "Add a saved KiCad PCB to create manufacturing files."}</p></div><div className="fd-export-header-actions"><CanvasToolButton icon="sparkles" label="Ask about these export settings" onClick={() => askAboutSurface(assistantSurface, "Help me choose and export the files I need for this board. Review its saved source and existing outputs first.")} /><Button size="sm" variant="ghost" onClick={() => { const ui = useUiStore.getState(); ui.setWorkspaceArea("outputs"); ui.setWorkspaceTab("renders"); }}><Icon name="library" width={16} height={16} />Saved outputs</Button></div></header>
    {assembly && <label className="fd-export-board-scope">Board source<Select aria-label="Board source for exports" disabled={!scopeReady || busy} value={outputSource.sourceId ?? ""} onChange={event => outputSource.choose(event.target.value)}><option value="" disabled>Choose a board…</option>{!source && outputSource.sourceId && <option value={outputSource.sourceId} disabled>Source definition changed</option>}{sources.data?.sources.map(row => <option key={row.source.id} value={row.source.id}>{row.source.name}{row.status !== "available" ? " · source unavailable" : ""}</option>)}</Select></label>}
    <div className="fd-export-flow">
      <section className="fd-export-reference" aria-label="Export source reference">
        <h2>{source?.source.name ?? "Saved board"}</h2>
        {previewPresent ? <><ProjectImage retryable projectId={projectId} path={`${prefix}renders/pcb.svg`} alt="Saved PCB preview for export reference" /><p>{previewLabel}</p></> : <div className="fd-export-no-preview"><Icon name="pcb" width={48} height={48} /><p>{hasPcb ? "Saved native PCB" : "PCB source unavailable"}</p></div>}
        <p className="fd-export-path">{prefix}board.kicad_pcb</p>
        <Button disabled={busy || !sourceReady} size="sm" onClick={() => { const ui = useUiStore.getState(); if (assembly && outputSource.sourceId) outputSource.choose(outputSource.sourceId); ui.setBoardTab("pcb"); }}>Inspect board</Button>
        {assembly && !sourceReady && <Button size="sm" disabled={busy} onClick={() => source?.status === "available" && outputSource.sourceId ? outputSource.choose(outputSource.sourceId) : useUiStore.getState().openProjectFile("fabplane.assembly.json")}>{source?.status === "available" ? "Select source again" : "Review source files"}</Button>}
      </section>
      <section className="fd-export-config" aria-label="Export options">
        {scopeReady && !assembly && hasPcb && <ManufacturingHandoff projectId={projectId} disabled={busy}
          onChecks={() => { if (useUiStore.getState().activeProjectId === projectId) useUiStore.getState().setBoardTab("drc"); }}
          onOrder={() => { if (useUiStore.getState().activeProjectId === projectId) useUiStore.getState().setOrderFlowOpen(true); }} />}
        {assembly && sourceReady && <div className="fd-manufacturing-handoff"><h2>Review this board before ordering</h2><p>Exports use this selected source. They do not verify other boards, assembly connections or component stock.</p><Button size="sm" disabled={busy} onClick={() => { if (useUiStore.getState().activeProjectId === projectId) useUiStore.getState().setBoardTab("drc"); }}>Review board checks</Button></div>}
        <FileExportControls {...exportControls} />
        <details className="fd-export-assembly-guide"><DisclosureSummary icon="checklist" label="What do I need for an assembled order?" /><div><p><strong>Bare PCB:</strong> the Gerber package contains copper layers and drill files.</p><p><strong>Assembled PCB:</strong> also prepare a bill of materials (BOM) with manufacturer part IDs and a component placement list (CPL / pick and place). Review polarity, rotations, stock and Basic / Extended status with your manufacturer.</p><p>The design BOM CSV is a reference list, not a manufacturer-specific upload. A fabrication ZIP only includes saved files; it does not convert or approve them.</p><div className="fd-manufacturing-actions"><Button size="sm" disabled={busy} onClick={() => { if (useUiStore.getState().activeProjectId === projectId) useUiStore.getState().setBoardTab("bom"); }}>Parts & BOM</Button>{exportChoices.includes("export_pos") && <Button size="sm" disabled={busy} onClick={() => setExportKind("export_pos")}>Choose placement export</Button>}<Button size="sm" variant="ghost" disabled={busy} onClick={() => askAboutSurface(assistantSurface, "Help me prepare an assembled board order. Review this selected board’s saved checks, BOM, placements and manufacturing exports. Explain what is still missing, verify supplier IDs and immediate assembly stock for the intended quantity, and flag any required Basic / Extended exceptions. Do not place an order, upload files or change the design without review.")}>Ask about assembly files</Button></div></div></details>
        {sources.isError && <Button size="sm" onClick={() => void sources.refetch()}>Retry source check</Button>}
      </section>
    </div>
    {lastScope === scopeKey && (state.status !== "idle" || packagePhase || packageError) && <div className="fd-feedback fd-export-feedback" data-tone={state.error || packageError ? "error" : busy ? "progress" : "success"} role={state.error || packageError ? "alert" : "status"}>
      {packageError ? <p>{packageError}</p> : state.error ? <ErrorNotice error={state.error} /> : busy ? <p>{packagePhase ?? `Exporting ${EXPORTS[lastExport].title.toLowerCase()}…`}</p> : packageResult ? <p>Gerber package saved · {packageResult.files.length} files, including Gerber layers and drills. Review design checks before fabrication.</p> : <p>{EXPORTS[lastExport].title} saved under {prefix}exports/.</p>}
      {state.note && <p>{state.note}</p>}
      {!busy && !packageError && state.status === "done" && !packageResult && <ExportCompletionDetails kind={lastExport} result={state.result} />}
      {!busy && !packageError && packageResult && <Button size="sm" onClick={() => void downloadFile(packageResult.path)} disabled={!!downloadPath}><Icon name="download" />Download {packageResult.path.split("/").pop()}</Button>}
      {downloadError && <p role="alert">{downloadError.message}</p>}
      {!busy && state.status === "done" && <Button size="sm" variant="ghost" onClick={() => { const ui = useUiStore.getState(); ui.setWorkspaceArea("outputs"); ui.setWorkspaceTab("renders"); }}>Open output library</Button>}
    </div>}

  </div>;
  return (
    <div className="fd-files flex h-full min-h-0 flex-col">
      <div className="fd-files-body flex min-h-0 flex-1">
        <nav ref={fileTree} hidden={!fileListOpen} aria-label="Project file explorer" className="fd-files-list flex w-72 shrink-0 flex-col border-r border-border bg-panel/40">
          <div className="fd-files-list-heading"><h2>Project files</h2><output className="fd-file-count" aria-live="polite" title={query.trim() ? "Files matching your search out of all project files" : "Total saved files in this project"}>{query.trim() ? `${matchingFileCount} of ${files.length} files` : `${files.length} ${files.length === 1 ? "file" : "files"}`}</output><CanvasToolButton icon="library" label="Open saved outputs" onClick={() => { const ui = useUiStore.getState(); if (ui.activeProjectId !== projectId) return; ui.setWorkspaceArea("outputs"); ui.setWorkspaceTab("renders"); }} /></div>
          <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
            <div className="relative min-w-0 flex-1">
              <Icon name="search" width={14} height={14} className="pointer-events-none absolute left-2 top-2 text-muted" />
              <Input ref={searchInput} aria-label="Find project files" placeholder="Find a file…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-7 pl-7 pr-7 text-xs" />
              {query && <button type="button" aria-label="Clear file search" className="absolute right-1 top-1 rounded-md p-0.5 cursor-pointer text-fg hover:bg-panel-2" onClick={() => { setQuery(""); searchInput.current?.focus(); }}><Icon name="close" width={16} height={16} /></button>}
            </div>
            <IconButton title="Collapse all folders" size="sm" disabled={!!query.trim()} onClick={() => setExpanded(new Set())}><Icon name="minus" width={14} height={14} /></IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {tree.length ? renderNodes(tree) : <p className="px-3 py-6 text-xs text-muted">{query ? "No matching files." : "This project has no files yet."}</p>}
          </div>
        </nav>
        <section aria-label="File preview" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!file && <EmptyState title="Select a file" icon={<Icon name="folderOpen" width={32} height={32} />}>
            Choose a saved file to preview it here. Images, models and manufacturing files are collected in Outputs.
          </EmptyState>}
          {file && appearance && <>
            <div className="fd-file-preview-toolbar flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-panel/40 px-3 py-2">
              <IconButton title={fileListOpen ? "Hide file list" : "Show file list"} size="sm" aria-expanded={fileListOpen} onClick={() => setFileListOpen(value => !value)}><Icon name="sidebar" width={16} height={16} /></IconButton>
              <FileGlyph kind={appearance.kind} />
              <span className="fd-file-preview-path min-w-0 flex-1 truncate text-xs" title={file.path}>{file.path.replaceAll("\\", "/").split("/").join(" / ")}</span>
              <span className="fd-file-format rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">{appearance.label}</span>
              <span className="fd-file-bytes text-[10px] text-muted">{formatFileSize(file.size)}</span>
              {appearance.preview === "pdf" && <div ref={setPdfToolbarHost} className="fd-file-pdf-controls" />}
              <div role="group" aria-label="Selected file actions" className="flex max-w-full shrink-0 flex-wrap items-center gap-1">
              {designDestination && <Button size="sm" variant="ghost" onClick={() => {
                const ui = useUiStore.getState();
                if (ui.activeProjectId !== projectId || sources.isFetching || sources.isError || !sources.data || !file) return;
                const target = boardFileDestination(sources.data, file.path); if (!target) return;
                if (target.selection) ui.setAssemblyBoard(target.selection);
                ui.setBoardTab(target.tab);
              }}><Icon name={designDestination.tab === "pcb" ? "pcb" : "schematic"} width={16} height={16} />{designDestination.tab === "pcb" ? "Open board" : "Open schematic"}</Button>}
              <CanvasToolButton icon="sparkles" label="Ask about this file" onClick={() => askAboutSurface(assistantSurface, `Help me understand ${file.path.split("/").pop()} and how it relates to this project.`)} />
              <CanvasToolButton icon="download" label={downloadPath === file.path ? "Downloading…" : "Download file"} disabled={downloadPath !== null} onClick={() => void downloadFile(file.path)} />
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
            </div>
            <div className={cn("min-h-0 flex-1", inlineModel ? "fd-file-model-preview" : appearance.preview === "pdf" ? "fd-file-pdf-preview" : "overflow-auto p-4")}>
              {downloadError?.path === file.path && <p role="alert" className="mb-3 text-xs text-danger">{downloadError.message}</p>}
              {inlineModel && <>
                <p className="fd-file-model-status">Saved model · Source freshness and physical fit not checked</p>
                <Suspense fallback={<div role="status" className="flex items-center justify-center gap-2 p-4"><Spinner />Opening model…</div>}>
                  <ModelCanvas key={`${projectId}:${file.path}:${file.mtime}:${file.size}`} projectId={projectId} path={file.path} />
                </Suspense>
              </>}
              {appearance.preview === "pdf" && <Suspense fallback={<div className="fd-pdf-loading" role="status"><Spinner />Loading PDF reader…</div>}><ProjectPdf key={file.path} projectId={projectId} path={file.path} toolbarHost={pdfToolbarHost} /></Suspense>}
              {appearance.preview === "image" && <ProjectImage retryable projectId={projectId} path={file.path} className="fd-file-image max-h-none max-w-full" />}
              {appearance.preview === "video" && <ProjectVideo projectId={projectId} path={file.path} className="fd-file-video max-w-full" />}
              {appearance.preview === "none" && !inlineModel && <EmptyState title={`${appearance.label} file`} icon={<FileGlyph kind={appearance.kind} className="!h-10 !w-10" />} {...(canPreviewModel ? { action: <Button onClick={() => setModelPreviewPath(file.path)}><Icon name="cube" width={16} height={16} />Preview model</Button> } : {})}>
                {canPreviewModel ? "Inspect this saved model in fabPlane, or download it for your viewer or slicer." : appearance.kind === "model" ? "Open this file in a compatible 3D viewer or slicer." : "A preview for this format is not available here."}
                <p className="mt-2 break-all font-mono text-xs">{file.path}</p>
              </EmptyState>}
              {appearance.preview === "text" && (tooBig ? <p className="text-xs text-muted">This file is too large to preview. Limit: 1 MB.</p>
                : text.isError ? <div role="alert" className="space-y-2 text-xs text-danger"><p>Could not load this file.</p><Button size="sm" variant="ghost" disabled={text.isFetching} onClick={() => void text.refetch()}>{text.isFetching ? "Retrying…" : "Retry file preview"}</Button></div>
                : text.isLoading ? <Spinner />
                : text.data === null ? <p className="text-xs text-muted">This file is no longer available.</p>
                : <pre className="fd-file-text-preview whitespace-pre-wrap font-mono leading-relaxed [overflow-wrap:anywhere]" aria-label="Read-only file preview">{text.data || "(Empty file)"}</pre>)}
            </div>
          </>}
        </section>
      </div>
      {modelPreview && <OutputPreviewDialog projectId={projectId} output={modelPreview} status="Saved model file · Source freshness unverified" onClose={() => setModelPreviewPath(null)} />}

    </div>
  );
}
