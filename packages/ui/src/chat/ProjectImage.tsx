import { useProjectBlobUrl } from "../hooks/queries";
import { cn } from "../util";

/** Renders a project file image via an authenticated fetch (a plain <img src> cannot carry the bearer token). */
export function ProjectImage({
  projectId,
  path,
  className,
  alt,
}: {
  projectId: string | null;
  path: string;
  className?: string;
  alt?: string;
}) {
  const { url, isLoading, data } = useProjectBlobUrl(projectId, path);
  if (!projectId) return <span className="text-xs text-muted">{path}</span>;
  if (isLoading) return <div className={cn("h-24 w-32 animate-pulse rounded bg-panel-2", className)} />;
  if (!url || data === null) return <span className="text-xs text-muted">missing: {path}</span>;
  return <img src={url} alt={alt ?? path} className={cn("max-h-80 rounded border border-border", className)} />;
}
