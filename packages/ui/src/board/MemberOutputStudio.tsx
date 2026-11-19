import { useAssemblyBoardModel,useCoreClient,useModelOutputActivity,useProject,useRunTool } from "@fabdesk/client-core";
import type { BoardSourceSelection } from "@fabdesk/protocol";
import { lazy,Suspense,useState } from "react";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { Button,EmptyState,LoadError,Select,Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { AutomaticPreviewStatus } from "./AutomaticPreviewStatus";
import { ProductVideoPanel,type ProductVideoForm } from "./ProductVideoPanel";
import { useOutputSource } from "./useOutputSource";
const ModelCanvas = lazy(() => import("./ModelCanvas"));

/** Shared output tools, scoped to one source; assembly position and fit are separate. */
export function MemberOutputStudio({ projectId }: { projectId: string }) {
  const scope = useOutputSource(projectId);
  const owned = scope.board && scope.board.manifestSha256 === scope.data?.manifestSha256 && scope.row?.status === "available" && !!scope.row.pcbSha256;
  return <div className="fd-member-output-studio">
    <header><div><h2>Models & video</h2><p>Create outputs for one board source. Assembly position and fit stay separate.</p></div><label>Board source<Select aria-label="Board source for models and video" disabled={scope.sources.isFetching} value={scope.sourceId ?? ""} onChange={event => scope.choose(event.target.value)}><option value="" disabled>Choose a board…</option>{!scope.row && scope.sourceId && <option value={scope.sourceId} disabled>Source definition changed</option>}{scope.data?.sources.map(row => <option key={row.source.id} value={row.source.id}>{row.source.name}{row.status !== "available" ? " · unavailable" : ""}</option>)}</Select></label></header>
    {!scope.data ? <div role="status"><Spinner />Checking sources…</div> : !owned || !scope.board || !scope.row?.pcbSha256 ? <EmptyState title="Select an available board source"><p>{scope.sources.isError ? "Board sources could not be verified. Recheck before creating outputs." : "Missing or changed source definitions must be resolved before generation."}</p><Button onClick={() => scope.sourceId && scope.row?.status === "available" ? scope.choose(scope.sourceId) : void scope.sources.refetch()}>{scope.row?.status === "available" ? "Select source again" : "Recheck sources"}</Button><Button onClick={() => useUiStore.getState().openProjectFile("fabplane.assembly.json")}>Review source files</Button></EmptyState> : <MemberStudio key={`${scope.board.sourceId}:${scope.board.manifestSha256}`} projectId={projectId} board={scope.board} prefix={scope.prefix} sourceSha256={scope.row.pcbSha256} enabled={scope.ready} />}
  </div>;
}

function MemberStudio({ projectId, board, prefix, sourceSha256, enabled }: { projectId: string; board: BoardSourceSelection; prefix: string; sourceSha256: string; enabled: boolean }) {
  const client = useCoreClient(), project = useProject(projectId), model = useAssemblyBoardModel(projectId, board), glbRun = useRunTool(), videoRun = useRunTool();
  const activity = useModelOutputActivity(projectId, board);
  const exporting = glbRun.state.status === "running" || !!activity.model;
  const making = videoRun.state.status === "running" || !!activity.video;
  const [form, setForm] = useState<ProductVideoForm>({ preset: "review", resolution: "720p", aspect: "landscape", background: "light", durationSec: 6, captions: true });
  const [downloadPath, setDownloadPath] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const files = project.data?.files ?? [], path = `${prefix}renders/board.glb`, glb = model.data?.model ? files.find(file => file.path === path) : undefined;
  const videos = files.filter(file => file.path.startsWith(`${prefix}exports/product-video.`) && /\.(mp4|webm|gif)$/i.test(file.path)), poster = files.find(file => file.path === `${prefix}exports/product-video-poster.png`);
  useAssistantSurface({ projectId, label: "Outputs / Models & video", priority: 10, details: JSON.stringify({ board, sourceSha256, model: path, modelState: model.data?.state, videoSettings: form, savedVideos: videos.map(file => file.path), sourceCheckPending: !enabled || model.isFetching, exportingModel: exporting, makingVideo: making }) });
  const generate = async (kind: "render_glb" | "render_product_video") => {
    if (!enabled || !activity.ready || exporting || making || useUiStore.getState().activeProjectId !== projectId || model.isFetching || model.isError) return;
    const tool = kind === "render_glb" ? glbRun : videoRun;
    const result = await tool.run(kind, { projectId, board, expectedSourceSha256: sourceSha256, ...(kind === "render_product_video" ? { ...form } : {}) });
    if (result.status === "done") await Promise.all([project.refetch(), model.refetch()]);
  };
  const download = async (selected: string) => {
    if (downloadPath || exporting || making || useUiStore.getState().activeProjectId !== projectId) return;
    setDownloadPath(selected); setError(null);
    try {
      const blob = await client.readFileBlob(projectId, selected);
      if (useUiStore.getState().activeProjectId !== projectId) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = `${board.sourceId}-${selected.split("/").pop()}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch { setError("Could not download this output. Try again."); } finally { setDownloadPath(null); }
  };
  return <ProductVideoPanel projectId={projectId} glb={glb} videos={videos} poster={poster} form={form} onForm={setForm} exporting={exporting} making={making}
    activityReady={activity.ready}
    activityStatus={activity.isError ? <LoadError title="Could not check export tasks" onRetry={() => void activity.refetch()} /> : !activity.ready ? <p role="status" className="text-xs text-muted">Checking export tasks…</p> : null}
    {...(activity.model?.note ? { exportNote: activity.model.note } : {})}
    {...(activity.video?.note ? { makeNote: activity.video.note } : {})}
    canGenerate={enabled && !model.isFetching && !model.isError && !!model.data} checkingSources={!enabled || model.isFetching}
    modelStatus={<AutomaticPreviewStatus kind="model" projectId={projectId} board={board} directory={prefix ? prefix.slice(0, -1) : "."} enabled={enabled} />}
    {...(model.data?.model ? { modelPreview: <Suspense fallback={<Spinner />}><ModelCanvas projectId={projectId} path={path} blob={model.data.model} /></Suspense> } : {})}
    {...((glbRun.state.error || error) ? { exportError: glbRun.state.error ?? error! } : {})}
    {...(videoRun.state.error ? { makeError: videoRun.state.error } : {})}
    onExportGlb={() => void generate("render_glb")} onMakeVideo={() => void generate("render_product_video")}
    onDownloadGlb={() => void download(path)} downloading={downloadPath === path}
    onDownloadVideo={selected => void download(selected)} downloadingVideo={downloadPath !== path ? downloadPath : null}
    onOpenVideoFile={selected => useUiStore.getState().openProjectFile(selected)} />;
}
