import { assemblySelectionState,useAssemblySchematicPreview,useCoreClient,useLivePreview,type AssemblySceneSelection } from "@fabdesk/client-core";
import { type ProjectBoardSources } from "@fabdesk/protocol";
import { useEffect,useRef } from "react";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { Button,EmptyState,LoadError,Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { MissingNativeSource } from "./MissingNativeSource";
import { SchematicFocusView } from "./SchematicFocusView";
import { SchematicSheetNav } from "./SchematicSheetNav";
import { SelectableSvgViewer } from "./SelectableSvgViewer";
import { parseSvgViewBox } from "./svg-coords";

/** Source-bound native sheet. Open missing previews automatically; source edits remain agent requests. */
export function AssemblySchematicPreview(props: Parameters<typeof AssemblySchematicContent>[0]) {
  const focus = useUiStore(s => s.schematicFocus);
  const showing = focus?.focus.projectId === props.projectId && focus.focus.board?.sourceId === props.selection.sourceId;
  return <div className="relative h-full min-h-0"><div className="h-full" style={showing ? { visibility: "hidden" } : undefined} inert={showing || undefined}><AssemblySchematicContent {...props} enabled={props.enabled && !showing} /></div>{showing && <SchematicFocusView key={focus.focus.id} focus={focus.focus} endpoint={focus.endpoint} />}</div>;
}
function AssemblySchematicContent({ projectId, data, selection, enabled }: { projectId: string; data: ProjectBoardSources; selection: AssemblySceneSelection; enabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const client = useCoreClient();

  const board = { sourceId: selection.sourceId, manifestSha256: selection.manifestSha256 }, owned = assemblySelectionState(data, selection) === "owned";
  const pageKey = JSON.stringify([client.baseUrl, projectId, board.sourceId, board.manifestSha256]);
  const page = useUiStore(s => s.schematicPageBySource[pageKey] ?? null);
  const setPage = (path: string | null) => useUiStore.getState().setSchematicPage(pageKey, path);

  const preview = useAssemblySchematicPreview(projectId, board, page, enabled && owned);
  const source = data.sources.find(row => row.source.id === board.sourceId), state = preview.data?.state;
  const livePreview = useLivePreview("schematic", { projectId, board, directory: source?.source.location === "project" ? source.source.directory : ".", enabled: enabled && owned });
  const generate = () => livePreview.retry();
  const busy = livePreview.updating, error = livePreview.error?.message;
  const nativeSheet = preview.data?.sheet?.nativeSheet;
  const selectedSheetIdentity = useRef<string | undefined>(undefined);
  if (nativeSheet) selectedSheetIdentity.current = nativeSheet.identity;
  useEffect(() => {
    const sheets = livePreview.data?.sheets;
    if (!page || !sheets || sheets.some(sheet => sheet.path === page)) return;
    setPage(sheets.find(sheet => sheet.nativeSheet?.identity === selectedSheetIdentity.current)?.path ?? null);
  }, [livePreview.data?.sheets, page, pageKey]);
  useAssistantSurface(enabled && nativeSheet ? { projectId, label: `Schematic · ${source?.source.name ?? "Board"} · ${nativeSheet.hierarchyPath === "/" ? "Root circuit" : nativeSheet.hierarchyPath}`, priority: 8, details: JSON.stringify({ board, sheet: nativeSheet, sourceRevision: preview.data?.sourceRevision, previewState: preview.data?.state, instruction: "Use this exact member source and native sheet instance. Inspect the current files before editing or making electrical claims." }) } : null);
  const drawing = preview.data?.svg && parseSvgViewBox(preview.data.svg) ? preview.data.svg : null;
  if (!owned) return <EmptyState title="Schematic source changed or is unavailable">Select this board again before opening its saved schematic.</EmptyState>;
  if (preview.isError) return <LoadError title="Could not verify this source’s saved schematic preview" onRetry={() => { if (page) setPage(null); else void preview.refetch(); }} />;
  if (preview.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (!source?.schematicPath && !drawing) return <MissingNativeSource key={`${projectId}/${board.sourceId}/${board.manifestSha256}`} projectId={projectId} kind="schematic" enabled={enabled && !busy} selection={selection} membership={data} directory={source?.source.location === "project" ? source.source.directory : "."} name={source?.source.name ?? "Selected board"} />;
  const pages = preview.data?.sheets ?? [];
  const circuitView = !!drawing?.includes('data-fabplane-schematic-view="circuit');
  const showPrimaryRender = !circuitView || state !== "source-unchanged" || busy;
  const renderAction = error ? <Button size="sm" onClick={() => void generate()}>Retry preview</Button> : <span role="status">{busy ? "Updating preview automatically…" : "Preview follows saved source"}</span>;
  const label = !enabled ? "Checking source ownership…" : busy ? "Rendering the inspected hierarchy…" : preview.isFetching ? "Checking saved sheets and preview…" : state === "source-unchanged" ? "Saved source files match this preview" : state === "source-changed" ? "Schematic changed since preview · showing an earlier drawing" : state === "artifact-changed" ? "Preview file changed or is missing · source unverified" : state === "scope-unverified" ? "Preview ownership is unverified · render this source again" : "No saved schematic preview for this source";
  if (!drawing) return <div className="fd-assembly-schematic fd-assembly-schematic-empty"><EmptyState title={busy ? "Opening schematic…" : "Open this board’s schematic"} action={!busy ? renderAction : undefined}>The native KiCad files were found. fabPlane creates the drawing here without changing your circuit.</EmptyState>{(error) && <p role="alert" className="fd-assembly-detail-error">{error}</p>}</div>;
  return <div className="fd-assembly-schematic" data-testid="assembly-schematic-preview">
    <div className="fd-assembly-model-status" role="status" data-warning={["source-changed", "artifact-changed", "scope-unverified"].includes(state ?? "")}><strong>{label}</strong><details className="fd-schematic-preview-details"><DisclosureSummary icon="image" label="Preview details" variant="compact" /><span>Read-only native sheet · ERC, PCB parity, external symbol libraries and assembly compatibility are unverified.</span>{!showPrimaryRender && renderAction}</details></div>
    {(pages.length > 1 || showPrimaryRender) && <div className="fd-assembly-schematic-toolbar">
      <SchematicSheetNav sheets={pages} selected={preview.data?.sheet?.path} busy={busy} onSelect={setPage} />
      {showPrimaryRender && renderAction}
    </div>}
    {drawing ? <SelectableSvgViewer selectionSource={{ projectId, board, enabled: enabled && !busy }} selectionView="schematic" sheetPath={preview.data?.sheet?.path} onSelectionSheet={setPage} viewportKey={JSON.stringify([client.baseUrl, projectId, board.sourceId, board.manifestSha256, nativeSheet?.identity ?? preview.data?.sheet?.path])} svg={drawing} initialFit={circuitView ? "sheet" : "width"} viewKey={`${projectId}/${board.sourceId}/${board.manifestSha256}/${preview.data?.sheet?.path}`} /> : <EmptyState title="See this board’s schematic">Create a preview of its saved native sheets to inspect them here.</EmptyState>}
    {(error) && <p role="alert" className="fd-assembly-detail-error">{error}</p>}
  </div>;
}
