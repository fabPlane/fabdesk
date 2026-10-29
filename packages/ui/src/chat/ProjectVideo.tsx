import { useEffect, useState } from "react";
import { useProjectBlobUrl } from "../hooks/queries";
import { cn } from "../util";

/** Plays a project video/GIF via an authenticated blob URL (a plain <video src> cannot carry the bearer). */
export function ProjectVideo({
  projectId,
  path,
  className,
  thumbnail = false,
}: {
  projectId: string | null;
  path: string;
  className?: string;
  thumbnail?: boolean;
}) {
  const [playbackError, setPlaybackError] = useState(false);
  const { url, isLoading, isError, data } = useProjectBlobUrl(projectId, path);
  useEffect(() => setPlaybackError(false), [url]);
  if (!projectId) return <span className="text-xs text-muted">{path}</span>;
  if (isLoading || (!isError && data !== null && !url)) return <div role="status" aria-label="Loading video preview" className={cn("h-40 w-full animate-pulse rounded bg-panel-2", className)} />;
  if (isError) return <span role="alert" className="text-xs text-danger">Could not load {path}. Try opening it from Files.</span>;
  if (!url || data === null) return <span className="text-xs text-muted">missing: {path}</span>;
  if (thumbnail && playbackError) return <span className="text-xs text-muted">Preview unavailable</span>;
  if (/\.gif$/i.test(path)) {
    return <img src={url} alt={path} className={cn("max-h-80 w-full rounded border border-border object-contain", className)} />;
  }
  return (
    <div className={thumbnail ? "fd-video-thumbnail" : undefined}>
    <video
      src={thumbnail ? `${url}#t=0.01` : url}
      controls={!thumbnail}
      loop={!thumbnail}
      muted={thumbnail}
      tabIndex={thumbnail ? -1 : undefined}
      aria-hidden={thumbnail || undefined}
      playsInline
      preload="metadata"
      onError={() => setPlaybackError(true)}
      className={cn("max-h-80 w-full rounded border border-border bg-black", className)}
    />
    {playbackError && (
      <div role="alert" className="mt-2 text-xs text-danger">
        Preview unavailable. <a className="underline" href={url} download={path.split("/").pop()}>Download video</a> to open it in another player.
      </div>
    )}
    </div>
  );
}
