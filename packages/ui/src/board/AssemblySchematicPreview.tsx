import { useRef, useState } from "react";
import type { ProjectBoardSources } from "@fabdesk/protocol";
import { assemblySelectionState, captureAssemblySchematicInspection, pcbToolJson, useAssemblySchematicPreview, useRunTool, type AssemblySceneSelection } from "@fabdesk/client-core";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { SvgViewer } from "./SvgViewer";
import { parseSvgViewBox } from "./svg-coords";

/** One source-bound, read-only sheet on the main canvas. Rendering is always explicit. */
export function AssemblySchematicPreview({ projectId, data, selection, enabled, onBusyChange, onFindSchematic }: { projectId: string; data: ProjectBoardSources; selection: AssemblySceneSelection; enabled: boolean; onBusyChange: (busy: boolean) => void; onFindSchematic: () => void }) {
  const board = { sourceId: selection.sourceId, manifestSha256: selection.manifestSha256 }, owned = assemblySelectionState(data, selection) === "owned";
  const [page, setPage] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false), running = useRef(false);
  const preview = useAssemblySchematicPreview(projectId, board, page, enabled && owned), tool = useRunTool();
  const source = data.sources.find(row => row.source.id === board.sourceId), state = preview.data?.state;
  const generate = async () => {
    if (running.current || !enabled || !owned || !source?.schematicPath || preview.isFetching || useUiStore.getState().activeProjectId !== projectId) return;
    running.current = true; setBusy(true); onBusyChange(true); setError(null);
    try {
      const inspected = await tool.run("schematic_inspect", { projectId, board: { ...board }, detail: "summary" });
      if (inspected.status !== "done") return;
      const snapshot = captureAssemblySchematicInspection(inspected.result, projectId, board);
      if (!snapshot.hierarchy.complete) throw new Error("The saved hierarchy is incomplete. Review its referenced sheets in Checks before rendering.");
      if (useUiStore.getState().activeProjectId !== projectId) return;
      const result = await tool.run("render_schematic_svg", { projectId, board: { ...board }, expectedHierarchyRevision: snapshot.hierarchy.aggregateRevision });
      if (result.status !== "done") return;
      const identity = pcbToolJson(result.result)._board as Record<string, unknown> | undefined;
      if (identity?.projectId !== projectId || identity.sourceId !== board.sourceId || identity.manifestSha256 !== board.manifestSha256) throw new Error("The preview result did not match the selected source. Recheck this board.");
      setPage(null); if (!page) await preview.refetch();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { running.current = false; setBusy(false); onBusyChange(false); }
  };
  if (!owned) return <EmptyState title="Schematic source changed or is unavailable">Select this board again before opening its saved schematic.</EmptyState>;
  if (preview.isError) return <LoadError title="Could not verify this source’s saved schematic preview" onRetry={() => { if (page) setPage(null); else void preview.refetch(); }} />;
  if (preview.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const drawing = preview.data?.svg && parseSvgViewBox(preview.data.svg) ? preview.data.svg : null;
  if (!source?.schematicPath && !drawing) return <div className="fd-assembly-schematic fd-assembly-schematic-empty"><EmptyState title="This board needs a schematic" action={<Button disabled={!enabled || busy} onClick={onFindSchematic}>Ask about missing files</Button>}>Add this board’s native KiCad schematic and referenced sheets to view them here.</EmptyState></div>;
  const pages = preview.data?.sheets ?? [], pageIndex = pages.findIndex(sheet => sheet.path === preview.data?.sheet?.path);
  const showPrimaryRender = state !== "source-unchanged" || busy;
  const renderAction = <Button size="sm" disabled={!enabled || busy || preview.isFetching || !source?.schematicPath} onClick={() => void generate()}>{busy ? "Rendering sheets…" : preview.data?.sheets.length ? "Update schematic preview" : "Create schematic preview"}</Button>;
  const label = !enabled ? "Checking source ownership…" : busy ? "Rendering the inspected hierarchy…" : preview.isFetching ? "Checking saved sheets and preview…" : state === "source-unchanged" ? "Saved source files match this preview" : state === "source-changed" ? "Schematic changed since preview · showing an earlier drawing" : state === "artifact-changed" ? "Preview file changed or is missing · source unverified" : state === "scope-unverified" ? "Preview ownership is unverified · render this source again" : "No saved schematic preview for this source";
  return <div className="fd-assembly-schematic" data-testid="assembly-schematic-preview">
    <div className="fd-assembly-model-status" role="status" data-warning={["source-changed", "artifact-changed", "scope-unverified"].includes(state ?? "")}><strong>{label}</strong><details className="fd-schematic-preview-details"><summary>Preview details</summary><span>Read-only native sheet · ERC, PCB parity, external symbol libraries and assembly compatibility are unverified.</span>{!showPrimaryRender && renderAction}</details></div>
    {(pages.length > 1 || showPrimaryRender) && <div className="fd-assembly-schematic-toolbar">
      {(preview.data?.sheets.length ?? 0) > 1 && <label>Sheet <Button size="sm" variant="ghost" aria-label="Previous schematic sheet" disabled={busy || pageIndex <= 0} onClick={() => setPage(pages[pageIndex - 1]!.path)}>←</Button><select aria-label="Schematic preview sheet" disabled={busy} value={preview.data?.sheet?.path ?? ""} onChange={event => setPage(event.target.value)}>{preview.data?.sheets.map((sheet, index) => <option key={sheet.path} value={sheet.path}>{index + 1} · {sheet.name.replace(/\.svg$/i, "")}</option>)}</select><Button size="sm" variant="ghost" aria-label="Next schematic sheet" disabled={busy || pageIndex < 0 || pageIndex >= pages.length - 1} onClick={() => setPage(pages[pageIndex + 1]!.path)}>→</Button></label>}
      {showPrimaryRender && renderAction}
    </div>}
    {drawing ? <SvgViewer svg={drawing} viewKey={`${projectId}/${board.sourceId}/${board.manifestSha256}/${preview.data?.sheet?.path}`} /> : <EmptyState title="See this board’s schematic">Create a preview of its saved native sheets to inspect them here.</EmptyState>}
    {(error || tool.state.error) && <p role="alert" className="fd-assembly-detail-error">{error ?? tool.state.error}</p>}
  </div>;
}
