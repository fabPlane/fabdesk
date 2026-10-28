import { AssemblyModels } from "./AssemblyBoardModel";
import { BoardModelStatus } from "./BoardModelStatus";
import { lazy, Suspense, useMemo, useState } from "react";
import { useBoardSources, useCoreClient, useProject, useRunTool, useRunsStore } from "@fabdesk/client-core";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
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

export function ThreeDTab() {
  const projectId = useUiStore(state => state.activeProjectId), sources = useBoardSources(projectId);
  if (!projectId) return <EmptyState title="No project selected" />;
  if (sources.isError && !sources.data) return <LoadError title="Could not inspect board sources" onRetry={() => void sources.refetch()} />;
  if (sources.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (sources.data?.mode === "assembly") return <AssemblyModels key={projectId} projectId={projectId} data={sources.data} checking={sources.isFetching} failed={sources.isError} onRetry={() => void sources.refetch()} />;
  return <SingleBoardThreeDTab />;
}

function SingleBoardThreeDTab() {
  const client = useCoreClient();
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const canvasMode = useUiStore((s) => s.canvasMode);
  const canvas = useUiStore((s) => s.canvasMode && s.workspaceArea === "boards");
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const glbRun = useRunTool();
  const videoRun = useRunTool();
  const glbJob = useRunsStore((s) => (glbRun.state.jobId ? s.jobs[glbRun.state.jobId] : undefined));
  const videoJob = useRunsStore((s) => (videoRun.state.jobId ? s.jobs[videoRun.state.jobId] : undefined));
  const [form, setForm] = useState<ProductVideoForm>(DEFAULT_FORM);

  const downloadGlb = async () => {
    if (!projectId || downloading) return;
    setDownloading(true); setDownloadError(null);
    try {
      const blob = await client.readFileBlob(projectId, GLB_PATH);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = "board.glb"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch { setDownloadError("Could not download the model. Try again."); }
    finally { setDownloading(false); }
  };
  const files = project.data?.files ?? [];
  const glb = files.find((f) => f.path === GLB_PATH);
  const videos = useMemo(
    () =>
      files
        .filter((f) => f.path.startsWith(VIDEO_PREFIX) && !f.path.endsWith(".json"))
        .sort((a, b) => b.mtime.localeCompare(a.mtime)),
    [files],
  );
  const poster = files.find((f) => f.path === "exports/product-video-poster.png");

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
    {glb ? <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}><ModelCanvas key={`${projectId}:${GLB_PATH}`} projectId={projectId} path={GLB_PATH} /></Suspense> : <EmptyState title="See your board in 3D" action={<Button disabled={glbRun.state.status === "running"} onClick={() => void glbRun.run("glb", { projectId })}>{glbRun.state.status === "running" ? "Generating model…" : "Generate 3D preview"}</Button>}>Generate a model from your saved KiCad PCB. Components with available 3D models appear in the preview.</EmptyState>}
    <BoardModelStatus projectId={projectId} present={!!glb} updating={glbRun.state.status === "running"} floating />
    <div className="fd-board-model-actions">
      {glb && <Button size="sm" disabled={glbRun.state.status === "running"} onClick={() => void glbRun.run("glb", { projectId })}>{glbRun.state.status === "running" ? "Updating…" : "Update model"}</Button>}
      <Button size="sm" onClick={() => { const ui = useUiStore.getState(); ui.setWorkspaceArea("outputs"); ui.setWorkspaceTab("3d"); }}>Video & downloads</Button>
    </div>
    {glbRun.state.error && <div className="fd-model-export-error" role="alert">{glbRun.state.error}</div>}
  </div>;

  return (
    <ProductVideoPanel
      projectId={projectId}
      modelStatus={<BoardModelStatus projectId={projectId} present={!!glb} updating={glbRun.state.status === "running"} />}
      glb={glb}
      videos={videos}
      poster={poster}
      form={form}
      onForm={setForm}
      exporting={glbRun.state.status === "running"}
      making={videoRun.state.status === "running"}
      {...(glbJob?.note ? { exportNote: glbJob.note } : {})}
      {...(videoJob?.note ? { makeNote: videoJob.note } : {})}
      {...((glbRun.state.error || downloadError) ? { exportError: glbRun.state.error || downloadError! } : {})}
      {...(videoRun.state.error ? { makeError: videoRun.state.error } : {})}
      onDownloadGlb={() => void downloadGlb()}
      downloading={downloading}
      {...(canvasMode ? { onPreviewGlb: () => useUiStore.getState().setBoardTab("3d") } : {})}
      onExportGlb={() => void glbRun.run("glb", { projectId })}
      onMakeVideo={() =>
        void videoRun.run("video", {
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
