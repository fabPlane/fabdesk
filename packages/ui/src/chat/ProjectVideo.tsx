import { useProjectBlobUrl } from "../hooks/queries";
import { cn } from "../util";

/** Plays a project video/GIF via an authenticated blob URL (a plain <video src> cannot carry the bearer). */
export function ProjectVideo({
  projectId,
  path,
  className,
}: {
  projectId: string | null;
  path: string;
  className?: string;
}) {
  const { url, isLoading, data } = useProjectBlobUrl(projectId, path);
  if (!projectId) return <span className="text-xs text-muted">{path}</span>;
  if (isLoading) return <div className={cn("h-40 w-full animate-pulse rounded bg-panel-2", className)} />;
  if (!url || data === null) return <span className="text-xs text-muted">missing: {path}</span>;
  if (/\.gif$/i.test(path)) {
    return <img src={url} alt={path} className={cn("max-h-80 w-full rounded border border-border object-contain", className)} />;
  }
  return (
    <video
      src={url}
      controls
      loop
      playsInline
      className={cn("max-h-80 w-full rounded border border-border bg-black", className)}
    />
  );
}
