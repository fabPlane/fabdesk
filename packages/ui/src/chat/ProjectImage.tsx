import { useState } from "react";
import { useProjectBlobUrl } from "../hooks/queries";
import { Button } from "../components/ui";
import { cn } from "../util";

/** Renders a project file image via an authenticated fetch (a plain <img src> cannot carry the bearer token). */
export function ProjectImage({
  projectId,
  path,
  className,
  alt,
  retryable = false,
}: {
  projectId: string | null;
  path: string;
  className?: string;
  alt?: string;
  /** Opt in only outside another button/link, such as the selected Files preview. */
  retryable?: boolean;
}) {
  const { url, scope, isLoading, isError, isFetching, data, refetch } = useProjectBlobUrl(projectId, path);
  const [retryingScope, setRetryingScope] = useState<string | null>(null);
  const retrying = retryingScope === scope;
  const retry = async () => {
    setRetryingScope(scope);
    try { await refetch(); }
    finally { setRetryingScope(current => current === scope ? null : current); }
  };
  if (!projectId) return <span className="text-xs text-muted">{path}</span>;
  if (isError || data === null || retrying) {
    const message = retrying ? "Retrying image preview…" : isError ? "Could not load image." : "Image file unavailable.";
    return retryable ? <div role="alert" className="space-y-2 text-xs text-danger"><p>{message}</p><p className="break-all text-muted">{path}</p><Button size="sm" variant="ghost" aria-disabled={isFetching || retrying} className={isFetching || retrying ? "opacity-50" : ""} onClick={() => { if (!isFetching && !retrying) void retry(); }}>{isFetching || retrying ? "Retrying…" : "Retry image preview"}</Button></div> : <span role="alert" className="break-all text-xs text-muted">{message} {path}</span>;
  }
  if (isLoading || data && !url) return <div className={cn("h-24 w-32 animate-pulse rounded bg-panel-2", className)} />;
  if (!url) return <span className="break-all text-xs text-muted">Image file unavailable: {path}</span>;
  return <img src={url} alt={alt ?? path} className={cn("max-h-80 rounded border border-border", className)} />;
}
