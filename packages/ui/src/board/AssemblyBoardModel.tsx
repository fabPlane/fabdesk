import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { ErrorNotice } from "../components/ErrorNotice";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { lazy, Suspense, useState } from "react";
import type { ProjectBoardSources } from "@fabdesk/protocol";
import { assemblySelectionState, captureAssemblySelection, pcbToolJson, restoreAssemblySelection, useAssemblyBoardModel, useRunTool, type AssemblySceneSelection } from "@fabdesk/client-core";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
const ModelCanvas = lazy(() => import("./ModelCanvas"));

/** Source-qualified model preview; assembly placement, fit and member video generation are separate workflows. */
export function AssemblyBoardModel({ projectId, data, selection, enabled }: { projectId: string; data: ProjectBoardSources; selection: AssemblySceneSelection; enabled: boolean }) {
  const owned = assemblySelectionState(data, selection) === "owned", board = { sourceId: selection.sourceId, manifestSha256: selection.manifestSha256 };
  const model = useAssemblyBoardModel(projectId, board, enabled && owned), tool = useRunTool(), busy = tool.state.status === "running";
  const [error, setError] = useState<string | null>(null);
  const source = data.sources.find(row => row.source.id === selection.sourceId), state = model.data?.state;
  const assistantSurface = { projectId, label: `3D / ${source?.source.name ?? selection.sourceId}`, priority: 15, details: JSON.stringify({ board, instanceId: selection.instanceId, source: source?.source, path: model.data?.path, sourceSha256: model.data?.sourceSha256, modelState: state, checking: !enabled || model.isFetching, generating: busy, warnings: model.data?.warnings, instruction: "Individual board model; assembly alignment, external component models and fit are not established." }) };
  useAssistantSurface(assistantSurface);
  const run = async () => {
    const snapshot = model.data;
    if (!snapshot || !enabled || !owned || model.isFetching || model.isError || busy || useUiStore.getState().activeProjectId !== projectId) return;
    setError(null);
    const result = await tool.run("render_glb", { projectId, board: { ...board }, expectedSourceSha256: snapshot.sourceSha256 });
    if (result.status === "done") {
      try {
        const identity = pcbToolJson(result.result)._board as Record<string, unknown> | undefined;
        if (identity?.projectId !== projectId || identity.sourceId !== board.sourceId || identity.manifestSha256 !== board.manifestSha256) throw new Error("The export did not match this board source. Recheck sources before continuing.");
        await model.refetch();
      } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    }
  };
  const download = () => {
    if (!owned || !enabled || !model.data?.model || model.isFetching || model.isError) return;
    const url = URL.createObjectURL(model.data.model), link = document.createElement("a"); link.href = url; link.download = `${selection.sourceId}-board.glb`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  if (!owned) return <EmptyState title="Board source changed or is unavailable">Select the board again before opening its model.</EmptyState>;
  if (model.isError) return <LoadError title="Could not verify this source’s 3D model" onRetry={() => void model.refetch()} />;
  if (model.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const label = !enabled ? "Project ownership is being checked" : busy ? "Exporting this board’s model…" : model.isFetching ? "Checking saved model and source…" : state === "source-unchanged" ? "PCB unchanged since this model export" : state === "source-changed" ? "PCB changed since model export" : state === "artifact-changed" ? "Model file changed · Source unverified" : state === "scope-unverified" ? "Model ownership unverified · Review or export this source again" : "No saved 3D model for this source";
  return <div className="fd-assembly-model" data-testid="assembly-board-model">
    <div className="fd-assembly-model-status" data-warning={["source-changed", "artifact-changed", "scope-unverified"].includes(state ?? "")} role="status"><strong>{source?.source.name} · {label}</strong><span>Component-model dependencies, physical placement and enclosure fit are unverified.</span></div>
    {model.data?.model ? <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}><ModelCanvas projectId={projectId} path={model.data.path} blob={model.data.model} /></Suspense> : <EmptyState title="See this board in 3D">Export a model from its saved KiCad PCB. Components appear when their model files are available.</EmptyState>}
    <div className="fd-assembly-model-actions"><Button size="sm" disabled={!enabled || busy || model.isFetching || !model.data} onClick={() => void run()}>{busy ? "Exporting model…" : model.data?.model ? "Update this model" : "Generate 3D preview"}</Button>{model.data?.model && <Button size="sm" variant="ghost" disabled={!enabled || busy || model.isFetching} onClick={download}>Download GLB</Button>}<Button size="sm" variant="ghost" disabled={!enabled || busy} onClick={() => { const ui = useUiStore.getState(); if (ui.activeProjectId !== projectId) return; ui.setAssemblyBoard(selection); ui.setWorkspaceArea("outputs"); ui.setWorkspaceTab("3d"); }}>Make board video</Button><CanvasToolButton icon="sparkles" label="Ask about this 3D model" onClick={() => askAboutSurface(assistantSurface, "Review this board’s 3D model and its saved source. Explain missing component models or outdated inputs, and propose the next step before regenerating anything.")} /></div>
    {!!model.data?.warnings.length && <details className="fd-assembly-model-warnings"><DisclosureSummary icon="warning" label="Export notes" badge={model.data.warnings.length} warning variant="compact" /><ul>{model.data.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    {(error || tool.state.error) && <ErrorNotice error={error ?? tool.state.error} />}
  </div>;
}

/** Outputs never fall back to the root board for an assembly model. */
export function AssemblyModels({ projectId, data, checking, failed, onRetry }: { projectId: string; data: ProjectBoardSources; checking: boolean; failed: boolean; onRetry: () => void }) {
  const [selection, setSelection] = useState<AssemblySceneSelection | null>(() => restoreAssemblySelection(data, useUiStore.getState().assemblyBoardByProject[projectId]));
  const owned = selection && assemblySelectionState(data, selection) === "owned";
  const choose = (sourceId: string) => {
    const ui = useUiStore.getState(); if (ui.activeProjectId !== projectId || checking || failed) return;
    const instance = data.assembly?.instances.find(row => row.sourceId === sourceId), next = instance ? captureAssemblySelection(data, instance.id) : null;
    if (next && assemblySelectionState(data, next) !== "owned") return;
    setSelection(next); ui.setAssemblyBoard(next);
  };
  return <div className="fd-assembly-models">
    <header><div><h2>Board models</h2><p>Choose a source design. Shared physical boards use one exported model.</p></div><label>Board source<select aria-label="Board source for 3D model" disabled={checking || failed} value={selection?.sourceId ?? ""} onChange={event => choose(event.target.value)}><option value="">Choose a board source…</option>{data.sources.map(row => <option key={row.source.id} value={row.source.id} disabled={row.status !== "available"}>{row.source.name}{row.status !== "available" ? " · unavailable" : ""}</option>)}</select></label></header>
    {failed ? <LoadError title="Board sources could not be verified" onRetry={onRetry} /> : checking ? <p role="status"><Spinner />Checking sources…</p> : !selection ? <EmptyState title="Choose a board to see its model" /> : !owned ? <EmptyState title="Board definition changed">Select the source again to continue.<div className="mt-3"><Button size="sm" disabled={!data.manifestSha256 || data.sources.find(row => row.source.id === selection.sourceId)?.status !== "available"} onClick={() => choose(selection.sourceId)}>Select source again</Button></div></EmptyState> : <AssemblyBoardModel key={`${selection.sourceId}/${selection.manifestSha256}`} projectId={projectId} data={data} selection={selection} enabled />}
    <p className="fd-assembly-models-note">Models are viewed individually. Create board videos in Outputs. Assembly alignment and enclosure fit remain unverified.</p>
  </div>;
}
