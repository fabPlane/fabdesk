import { useMemo, useState } from "react";
import { useProject, useRunTool, useRunsStore } from "@fabdesk/client-core";
import { EmptyState, LoadError, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import {
  ProductVideoPanel,
  type ProductVideoForm,
} from "./ProductVideoPanel";

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
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const glbRun = useRunTool();
  const videoRun = useRunTool();
  const glbJob = useRunsStore((s) => (glbRun.state.jobId ? s.jobs[glbRun.state.jobId] : undefined));
  const videoJob = useRunsStore((s) => (videoRun.state.jobId ? s.jobs[videoRun.state.jobId] : undefined));
  const [form, setForm] = useState<ProductVideoForm>(DEFAULT_FORM);

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

  return (
    <ProductVideoPanel
      projectId={projectId}
      glb={glb}
      videos={videos}
      poster={poster}
      form={form}
      onForm={setForm}
      exporting={glbRun.state.status === "running"}
      making={videoRun.state.status === "running"}
      {...(glbJob?.note ? { exportNote: glbJob.note } : {})}
      {...(videoJob?.note ? { makeNote: videoJob.note } : {})}
      {...(glbRun.state.error ? { exportError: glbRun.state.error } : {})}
      {...(videoRun.state.error ? { makeError: videoRun.state.error } : {})}
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
