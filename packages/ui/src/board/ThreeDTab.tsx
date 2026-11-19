import { useBoardSources,useCoreClient,useLivePreview,useModelOutputActivity,useProject,useRunsStore,useRunTool } from "@fabdesk/client-core";
import { lazy,Suspense,useMemo,useState } from "react";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { Button,EmptyState,LoadError,Spinner } from "../components/ui";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { useUiStore } from "../stores/ui";
import { AssemblyModels } from "./AssemblyBoardModel";
import { AutomaticPreviewStatus } from "./AutomaticPreviewStatus";
import { BoardModelStatus } from "./BoardModelStatus";
import { MemberOutputStudio } from "./MemberOutputStudio";
import {
ProductVideoPanel,
type ProductVideoForm,
} from "./ProductVideoPanel";

const ModelCanvas = lazy(() => import("./ModelCanvas"));

const GLB_PATH = "renders/board.glb";
const VIDEO_PREFIX = "exports/product-video.";

const DEFAULT_FORM: ProductVideoForm = {
  preset: "review",
  resolution: "720p",
  aspect: "landscape",
  background: "light",
  durationSec: 6,
  captions: true,
};

export function ThreeDTab({ compact = false, active = true }: { compact?: boolean; active?: boolean }) {
  const projectId = useUiStore(state => state.activeProjectId), outputs = useUiStore(state => state.workspaceArea === "outputs"), sources = useBoardSources(projectId);
  if (!projectId) return <EmptyState title="No project selected" />;
  if (sources.isError && !sources.data) return <LoadError title="Could not inspect board sources" onRetry={() => void sources.refetch()} />;
  if (sources.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (sources.data?.mode === "assembly" && outputs) return <MemberOutputStudio key={projectId} projectId={projectId} />;
  if (sources.data?.mode === "assembly") return <AssemblyModels key={projectId} projectId={projectId} data={sources.data} checking={sources.isFetching} failed={sources.isError} onRetry={() => void sources.refetch()} />;
  return <SingleBoardThreeDTab compact={compact} active={active} key={projectId} checkingSources={sources.isFetching} scopeReady={!sources.isFetching && !sources.isError && sources.data?.mode === "single"} />;
}

function SingleBoardThreeDTab({ scopeReady, checkingSources, compact, active }: { scopeReady: boolean; checkingSources: boolean; compact: boolean; active: boolean }) {
  const client = useCoreClient();
  const [downloadPath, setDownloadPath] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const canvasMode = useUiStore((s) => s.canvasMode);
  const canvas = useUiStore((s) => s.canvasMode && s.workspaceArea === "boards");
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const automatic = useLivePreview("model", { projectId: projectId ?? "", enabled: scopeReady });
  const glbRun = useRunTool();
  const videoRun = useRunTool();
  const glbJob = useRunsStore((s) => (glbRun.state.jobId ? s.jobs[glbRun.state.jobId] : undefined));
  const videoJob = useRunsStore((s) => (videoRun.state.jobId ? s.jobs[videoRun.state.jobId] : undefined));
  const activity = useModelOutputActivity(projectId);
  const exporting = automatic.updating || !!activity.model;
  const making = videoRun.state.status === "running" || !!activity.video;
  const activityNotice = activity.isError ? <LoadError title="Could not check export tasks" onRetry={() => void activity.refetch()} /> : !activity.ready ? <p role="status" className="text-xs text-muted">Checking export tasks…</p> : null;
  const [form, setForm] = useState<ProductVideoForm>(DEFAULT_FORM);

  const downloadOutput = async (path: string) => {
    if (!projectId || downloadPath || exporting || making || useUiStore.getState().activeProjectId !== projectId || !project.data?.files.some(file => file.path === path)) return;
    setDownloadPath(path); setDownloadError(null);
    try {
      const blob = await client.readFileBlob(projectId, path);
      if (useUiStore.getState().activeProjectId !== projectId) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = path.split("/").pop() ?? "output"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { setDownloadError(`Could not download ${path.split("/").pop()}. Try again.`); }
    finally { setDownloadPath(null); }
  };
  const files = project.data?.files ?? [];
  const glb = files.find((f) => f.path === GLB_PATH);
  const canGenerate = scopeReady && files.some(file => file.path === "board.kicad_pcb");
  const videos = useMemo(
    () =>
      files
        .filter((f) => f.path.startsWith(VIDEO_PREFIX) && /\.(?:mp4|webm|gif)$/i.test(f.path))
        .sort((a, b) => b.mtime.localeCompare(a.mtime)),
    [files],
  );
  const poster = files.find((f) => f.path === "exports/product-video-poster.png");
  useAssistantSurface(projectId && active ? { projectId, label: canvas ? "Board / 3D" : "Outputs / Models & video", priority: 10, details: JSON.stringify({ model: glb?.path, videos: videos.map(file => file.path), videoSettings: form, sourceReady: canGenerate, exportingModel: exporting, makingVideo: making }) } : null);

  if (!projectId) return <EmptyState title="No project selected" />;
  if (project.isError) return <LoadError title="Could not load 3D export" onRetry={() => void project.refetch()} />;
  if (project.isLoading) {
    return (
      <EmptyState title="Loading 3D export">
        <Spinner />
      </EmptyState>
    );
  }

  if (canvas) return <div className="fd-board-model-view">
    {glb ? <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}><ModelCanvas key={`${projectId}:${GLB_PATH}`} projectId={projectId} path={GLB_PATH} selectionSource={{ projectId, enabled: scopeReady }} /></Suspense> : <EmptyState title="Preparing your board in 3D…"><AutomaticPreviewStatus kind="model" projectId={projectId} /></EmptyState>}
    <BoardModelStatus projectId={projectId} present={!!glb} updating={exporting} floating={!compact} />
    {compact ? <WorkspaceMenu className="fd-comparison-model-menu" label={<span aria-label="3D model tools">···</span>}>
      <AutomaticPreviewStatus kind="model" projectId={projectId} />
      <Button size="sm" onClick={() => { const ui = useUiStore.getState(); ui.setWorkspaceArea("outputs"); ui.setWorkspaceTab("3d"); }}>Video & downloads</Button>
</WorkspaceMenu> : <div className="fd-board-model-actions">
      <AutomaticPreviewStatus kind="model" projectId={projectId} />
      <Button size="sm" onClick={() => { const ui = useUiStore.getState(); ui.setWorkspaceArea("outputs"); ui.setWorkspaceTab("3d"); }}>Video & downloads</Button>
    </div>}
    {glbRun.state.error && <div className="fd-model-export-error" role="alert">{glbRun.state.error}</div>}
    {activityNotice && <div className="fd-model-export-error">{activityNotice}</div>}
  </div>;

  return (
    <ProductVideoPanel
      projectId={projectId}
      canGenerate={canGenerate}
      checkingSources={checkingSources || project.isFetching}
      modelStatus={<AutomaticPreviewStatus kind="model" projectId={projectId} />}
      {...(canvasMode && glb ? { modelPreview: <Suspense fallback={<Spinner />}><ModelCanvas key={`${projectId}:${GLB_PATH}`} projectId={projectId} path={GLB_PATH} selectionSource={{ projectId, enabled: scopeReady }} /></Suspense> } : {})}
      glb={glb}
      videos={videos}
      poster={poster}
      form={form}
      onForm={setForm}
      exporting={exporting}
      making={making}
      activityReady={activity.ready}
      activityStatus={activityNotice}
      {...((activity.model?.note || glbJob?.note) ? { exportNote: activity.model?.note || glbJob!.note! } : {})}
      {...((activity.video?.note || videoJob?.note) ? { makeNote: activity.video?.note || videoJob!.note! } : {})}
      {...((glbRun.state.error || downloadError) ? { exportError: glbRun.state.error || downloadError! } : {})}
      {...(videoRun.state.error ? { makeError: videoRun.state.error } : {})}
      onDownloadGlb={() => void downloadOutput(GLB_PATH)}
      downloading={downloadPath === GLB_PATH}
      onDownloadVideo={path => void downloadOutput(path)}
      downloadingVideo={downloadPath !== GLB_PATH ? downloadPath : null}
      onOpenVideoFile={path => { if (useUiStore.getState().activeProjectId === projectId) useUiStore.getState().openProjectFile(path); }}
      {...(canvasMode ? { onPreviewGlb: () => useUiStore.getState().setBoardTab("3d") } : {})}
      onExportGlb={() => { if (activity.ready && !exporting && !making) void glbRun.run("glb", { projectId }); }}
      onMakeVideo={() =>
        activity.ready && !exporting && !making && void videoRun.run("video", {
          projectId,
          preset: form.preset,
          durationSec: form.durationSec,
          resolution: form.resolution,
          aspect: form.aspect,
          background: form.background,
          captions: form.captions,
          formats: ["mp4", "webm", "gif"],
        })
      }
    />
  );
}
