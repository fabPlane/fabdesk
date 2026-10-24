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
  onMakeVideo: () => void;
};

export function pickPreview(videos: FileEntry[]): FileEntry | undefined {
  return (
    videos.find((f) => f.path.endsWith(".mp4")) ??
    videos.find((f) => f.path.endsWith(".webm")) ??
    videos.find((f) => f.path.endsWith(".gif"))
  );
}

/** Presentational 3D-export + product-video surface. */
export function ProductVideoPanel({
  projectId,
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
  onMakeVideo,
}: ProductVideoPanelProps) {
  const preview = pickPreview(videos);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="product-video-panel">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="secondary" size="sm" disabled={exporting} onClick={onExportGlb}>
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
        <span className="text-[11px] text-muted">
          {glb
            ? `${glb.path} · ${(glb.size / 1024).toFixed(0)} KB`
            : "Needs renders/board.glb (exported automatically when you make a video)"}
        </span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-2">
        <form
          className="flex flex-col gap-3 border-b border-border p-3 lg:border-b-0 lg:border-r"
          onSubmit={(e) => {
            e.preventDefault();
            onMakeVideo();
          }}
        >
          <div>
            <div className="text-sm font-semibold">Make video</div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              A short turntable, exploded assembly, or top/bottom flip of this project — for design
              reviews, customer updates and launch pages. Saved under exports/.
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
          <div className="grid grid-cols-2 gap-2">
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
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={making} data-testid="make-video">
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
          {exportError && <div className="text-xs text-danger">{exportError}</div>}
          {makeError && <div className="text-xs text-danger">{makeError}</div>}
          {exportNote && !making && <div className="text-[11px] text-muted">{exportNote}</div>}
        </form>
        <div className="flex min-h-0 flex-col gap-2 p-3" data-testid="product-video-preview">
          {preview ? (
            <>
              <div className="text-sm font-semibold">Preview</div>
              <ProjectVideo projectId={projectId} path={preview.path} className="max-h-[52vh]" />
              <div className="text-[11px] text-muted">
                {videos.map((f) => `${basename(f.path)} (${(f.size / 1024).toFixed(0)} KB)`).join(" · ")}
              </div>
              <p className="text-[12px] text-muted">
                Files are in exports/. Attach the MP4 to a revision or drop the GIF/WebM on a launch page.
              </p>
            </>
          ) : poster ? (
            <>
              <div className="text-sm font-semibold">Poster</div>
              <ProjectImage projectId={projectId} path={poster.path} className="max-h-[52vh] w-full object-contain" />
            </>
          ) : (
            <div className="text-[12px] text-muted">
              The video lands here after you run Make video. MP4 and WebM need ffmpeg on this machine; GIF is always
              written.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
