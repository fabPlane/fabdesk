import { useRef, useState } from "react";
import { useProjectBlobUrl } from "../hooks/queries";
import { Button } from "../components/ui";
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
  const retryButton = useRef<HTMLButtonElement>(null), retryRequested = useRef(false);
  const failed = (value: string) => {
    setFailedUrl(value);
    if (retryRequested.current) requestAnimationFrame(() => { if (currentScope.current === scope && document.activeElement === document.body) retryButton.current?.focus({ preventScroll: true }); });
    retryRequested.current = false;
  };
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [retryingScope, setRetryingScope] = useState<string | null>(null);
  const { url, scope, isLoading, isError, isFetching, data, refetch } = useProjectBlobUrl(projectId, path);
  const currentScope = useRef(scope); currentScope.current = scope;
  const playbackError = !!url && failedUrl === url, retrying = retryingScope === scope;
  const retry = async () => {
    retryRequested.current = true;
    setRetryingScope(scope);
    try { await refetch(); }
    finally {
      setFailedUrl(current => current === url ? null : current);
      setRetryingScope(current => current === scope ? null : current);
      requestAnimationFrame(() => { if (currentScope.current === scope && document.activeElement === document.body) retryButton.current?.focus({ preventScroll: true }); });
    }
  };
  if (!projectId) return <span className="text-xs text-muted">{path}</span>;
  if (retrying || isLoading || (!isError && data !== null && !url)) return <div role="status" aria-label="Loading video preview" className={cn("h-40 w-full animate-pulse rounded bg-panel-2", className)} />;
  if (isError || data === null || playbackError) {
    if (thumbnail) return <span className="text-xs text-muted">Preview unavailable</span>;
    return <div role="alert" className="space-y-2 text-xs text-danger">
      <p>{isError ? "Could not load video." : data === null ? "Video file unavailable." : "This file could not be played here. The saved file is unchanged."}</p>
      <p className="break-all text-muted">{path}</p>
      <div className="flex flex-wrap items-center gap-3"><Button ref={retryButton} size="sm" variant="ghost" disabled={isFetching} onClick={() => void retry()}>Retry video preview</Button>
        {url && <a className="underline" href={url} download={path.split("/").pop()}>Download video</a>}
      </div>
    </div>;
  }
  if (!url) return <span className="text-xs text-muted">Video file unavailable: {path}</span>;
  if (/\.gif$/i.test(path)) {
    return <img src={url} alt={path} onError={() => failed(url)} onLoad={() => { retryRequested.current = false; }} className={cn("max-h-80 w-full rounded border border-border object-contain", className)} />;
  }
  return <div className={thumbnail ? "fd-video-thumbnail" : undefined}>
    <video
      src={thumbnail ? `${url}#t=0.01` : url}
      controls={!thumbnail}
      loop={!thumbnail}
      muted={thumbnail}
      tabIndex={thumbnail ? -1 : undefined}
      aria-hidden={thumbnail || undefined}
      playsInline
      preload="metadata"
      onError={() => failed(url)}
      onLoadedData={() => { retryRequested.current = false; }}
      className={cn("max-h-80 w-full rounded border border-border bg-black", className)}
    />
  </div>;
}
