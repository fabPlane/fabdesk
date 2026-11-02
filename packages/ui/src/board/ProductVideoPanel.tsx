import { ErrorNotice } from "../components/ErrorNotice";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { VideoSourceStatus } from "./VideoSourceStatus";
import { useEffect, useState, type ReactNode } from "react";
import type { FileEntry } from "@fabdesk/protocol";
import { Button, Select, Spinner } from "../components/ui";
import { ProjectImage } from "../chat/ProjectImage";
import { ProjectVideo } from "../chat/ProjectVideo";
import { basename } from "../util";

export const VIDEO_PRESETS = [
  { id: "review", label: "Review (title, orbit, flip, assemble)" },
  { id: "orbit", label: "Orbit" },
  { id: "explode", label: "Exploded → assembled" },
  { id: "flip", label: "Top / bottom" },
  { id: "push_in", label: "Push-in" },
] as const;

export const VIDEO_RESOLUTIONS = [
  { id: "720p", label: "720p" },
  { id: "1080p", label: "1080p" },
] as const;

export const VIDEO_ASPECTS = [
  { id: "landscape", label: "Landscape" },
  { id: "square", label: "Square" },
  { id: "vertical", label: "Vertical" },
] as const;

export const VIDEO_BACKGROUNDS = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "transparent", label: "Transparent (GIF)" },
] as const;

export const VIDEO_DURATIONS = [4, 6, 8, 12] as const;

export type ProductVideoForm = {
  preset: (typeof VIDEO_PRESETS)[number]["id"];
  resolution: (typeof VIDEO_RESOLUTIONS)[number]["id"];
  aspect: (typeof VIDEO_ASPECTS)[number]["id"];
  background: (typeof VIDEO_BACKGROUNDS)[number]["id"];
  durationSec: (typeof VIDEO_DURATIONS)[number];
  captions: boolean;
};

export type ProductVideoPanelProps = {
  modelStatus?: ReactNode;
  modelPreview?: ReactNode;
  activityStatus?: ReactNode;
  activityReady?: boolean;
  canGenerate?: boolean;
  checkingSources?: boolean;
  projectId: string;
  glb: FileEntry | undefined;
  videos: FileEntry[];
  poster: FileEntry | undefined;
  form: ProductVideoForm;
  onForm: (next: ProductVideoForm) => void;
  exporting: boolean;
  making: boolean;
  exportNote?: string;
  makeNote?: string;
  exportError?: string;
  makeError?: string;
  onExportGlb: () => void;
  onDownloadGlb?: () => void;
  onPreviewGlb?: () => void;
  downloading?: boolean;
  onDownloadVideo?: (path: string) => void;
  downloadingVideo?: string | null;
  onOpenVideoFile?: (path: string) => void;
  onMakeVideo: () => void;
};

export function pickPreview(videos: FileEntry[]): FileEntry | undefined {
  videos = videos.filter(file => file.size > 0);
  return (
    videos.find((f) => f.path.endsWith(".mp4")) ??
    videos.find((f) => f.path.endsWith(".webm")) ??
    videos.find((f) => f.path.endsWith(".gif"))
  );
}

/** Presentational 3D-export + product-video surface. */
export function ProductVideoPanel({
  projectId,
  modelStatus,
  modelPreview,
  activityStatus,
  activityReady = true,
  canGenerate = true,
  checkingSources = false,
  glb,
  videos,
  poster,
  form,
  onForm,
  exporting,
  making,
  exportNote,
  makeNote,
  exportError,
  makeError,
  onExportGlb,
  onDownloadGlb,
  onPreviewGlb,
  downloading,
  onDownloadVideo,
  downloadingVideo,
  onOpenVideoFile,
  onMakeVideo,
}: ProductVideoPanelProps) {
  const hasSavedVideo = videos.some(file => file.size > 0);
  const [setupOpen, setSetupOpen] = useState(() => !hasSavedVideo);
  // Saved files may arrive after mount during a cold project/core reopen.
  useEffect(() => { setSetupOpen(!hasSavedVideo); }, [hasSavedVideo]);
  const availableVideos = videos.filter(file => file.size > 0);
  const preview = making ? undefined : pickPreview(availableVideos);
  return (
    <div className="fd-video-workspace flex h-full min-h-0 flex-col" data-testid="product-video-panel">
      <div className="fd-video-model-tools flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="secondary" size="sm" disabled={exporting || making || !canGenerate || !activityReady} onClick={onExportGlb}>
          {exporting ? (
            <>
              <Spinner className="mr-1" /> Exporting GLB…
            </>
          ) : glb ? (
            "Regenerate 3D model"
          ) : (
            "Generate 3D model"
          )}
        </Button>
        {glb && onPreviewGlb && <Button size="sm" variant="ghost" onClick={onPreviewGlb}>View model</Button>}
        {glb && onDownloadGlb && <Button size="sm" variant="ghost" disabled={downloading || !!downloadingVideo || exporting || making} onClick={onDownloadGlb}>{downloading ? "Downloading…" : "Download GLB"}</Button>}
        <span className="text-[11px] text-muted">
          {glb
            ? `${glb.path} · ${(glb.size / 1024).toFixed(0)} KB`
            : "Making a video also creates its board model."}
        </span>
        {modelStatus}
      </div>
      {!canGenerate && !making && !exporting && <p role="status" className="text-xs text-muted">{checkingSources ? "Checking saved PCB sources…" : "Verify a saved PCB in Board before generating a model or video."}</p>}
      {activityStatus}
      {(making || exporting) && <p role="status" className="fd-video-job text-xs text-muted">{making ? "Making video…" : "Exporting model…"} {making ? makeNote : exportNote}</p>}
      {making && <p role="status" className="text-xs text-muted">The video is being encoded. Playback and downloads return when the export finishes. You can follow or cancel it in Project activity.</p>}
      {exportError && <ErrorNotice error={exportError} />}
      {makeError && <ErrorNotice error={makeError} />}
      <div className="fd-video-body min-h-0 flex-1">
        <details className="fd-video-setup" open={setupOpen} onToggle={event => setSetupOpen(event.currentTarget.open)}><DisclosureSummary icon="play" label="Make a product video" />
        <form
          className="flex flex-col gap-3 border-b border-border p-3 lg:border-b-0 lg:border-r"
          onSubmit={(e) => {
            e.preventDefault();
            if (canGenerate && activityReady && !making && !exporting) onMakeVideo();
          }}
        >
          <div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              Choose the camera motion and duration. An outdated board model is refreshed from the saved PCB first. The video stays in this project’s outputs.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-[12px]">
            <span className="font-medium">Preset</span>
            <Select
              data-testid="product-video-preset"
              value={form.preset}
              onChange={(e) => onForm({ ...form, preset: e.target.value as ProductVideoForm["preset"] })}
            >
              {VIDEO_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </label>
          <div className="fd-video-duration grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="font-medium">Duration</span>
              <Select
                value={String(form.durationSec)}
                onChange={(e) =>
                  onForm({ ...form, durationSec: Number(e.target.value) as ProductVideoForm["durationSec"] })
                }
              >
                {VIDEO_DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}s
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <details className="fd-video-output-settings"><DisclosureSummary icon="settings" label="Output settings" /><div className="mt-3 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="font-medium">Resolution</span>
              <Select
                value={form.resolution}
                onChange={(e) => onForm({ ...form, resolution: e.target.value as ProductVideoForm["resolution"] })}
              >
                {VIDEO_RESOLUTIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="font-medium">Aspect</span>
              <Select
                value={form.aspect}
                onChange={(e) => onForm({ ...form, aspect: e.target.value as ProductVideoForm["aspect"] })}
              >
                {VIDEO_ASPECTS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="font-medium">Background</span>
              <Select
                value={form.background}
                onChange={(e) => onForm({ ...form, background: e.target.value as ProductVideoForm["background"] })}
              >
                {VIDEO_BACKGROUNDS.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          <label className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={form.captions}
              onChange={(e) => onForm({ ...form, captions: e.target.checked })}
            />
            Title and spec captions (name, board size, layers, MCU)
          </label></details>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={!canGenerate || !activityReady || making || exporting} data-testid="make-video">
              {making ? (
                <>
                  <Spinner className="mr-1" /> Making video…
                </>
              ) : (
                "Make video"
              )}
            </Button>
            {making && makeNote && <span className="text-[11px] text-muted">{makeNote}</span>}
          </div>
          {exportNote && !making && <div className="text-[11px] text-muted">{exportNote}</div>}
        </form></details>
        <div className="fd-video-preview flex min-h-0 flex-col gap-2 p-3" data-testid="product-video-preview">
          {preview ? (
            <>
              <VideoSourceStatus projectId={projectId} path={preview.path} updating={making} />
              <div className="fd-video-player">
                <ProjectVideo projectId={projectId} path={preview.path} />
              </div>
              <div className="text-[11px] text-muted">
                {availableVideos.map((f) => `${basename(f.path)} (${(f.size / 1024).toFixed(0)} KB)`).join(" · ")}
              </div>
              <div className="flex flex-wrap items-center gap-2" aria-label="Download saved video formats">
                {availableVideos.map(file => <Button key={file.path} size="sm" variant="secondary" aria-label={`Download ${file.path.split(".").pop()?.toUpperCase()}`} disabled={!onDownloadVideo || downloading || !!downloadingVideo || making || exporting} onClick={() => onDownloadVideo?.(file.path)}>{downloadingVideo === file.path ? "Downloading…" : `Download ${file.path.split(".").pop()?.toUpperCase()}`}</Button>)}
                {onOpenVideoFile && <Button size="sm" variant="ghost" onClick={() => onOpenVideoFile(preview.path)}>Show exported file</Button>}
              </div>
            </>
          ) : poster ? (
            <>
              <div className="text-sm font-semibold">{making ? "Previous saved poster" : "Poster"}</div>
              <ProjectImage projectId={projectId} path={poster.path} className="max-h-[52vh] w-full object-contain" />
            </>
          ) : modelPreview ? <div className="fd-video-model-preview" aria-label="Saved board model reference">{modelPreview}</div> : (
            <div className="text-[12px] text-muted">
              <strong className="block text-sm font-medium text-fg">Your saved video appears here</strong>
              Open Make a product video to choose its motion and duration. Save an MP4, WebM or GIF for review; MP4 and WebM require ffmpeg.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
