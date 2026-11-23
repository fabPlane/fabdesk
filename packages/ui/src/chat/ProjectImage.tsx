import { useEffect, useRef, useState, type ReactNode } from "react";
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
  observe = false,
  fallback,
}: {
  projectId: string | null;
  path: string;
  className?: string;
  alt?: string;
  /** Opt in only outside another button/link, such as the selected Files preview. */
  retryable?: boolean;
  observe?: boolean;
  /** Compact decorative previews may supply an icon instead of an error paragraph. */
  fallback?: ReactNode;
}) {
  const { url, scope, isLoading, isError, isFetching, data, refetch } = useProjectBlobUrl(projectId, path);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<{ blob: Blob; sha: string } | null>(null);
  useEffect(() => {
    let canceled = false;
    if (observe && data) void data.arrayBuffer().then(bytes => crypto.subtle.digest("SHA-256", bytes)).then(bytes => {
      if (!canceled) setFingerprint({ blob: data, sha: Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("") });
    }).catch(() => {});
    return () => { canceled = true; };
  }, [observe, data]);
  const [retryingScope, setRetryingScope] = useState<string | null>(null);
  const currentScope = useRef(scope); currentScope.current = scope;
  const retryButton = useRef<HTMLButtonElement>(null), retryRequested = useRef(false);
  const failed = (value: string) => {
    setFailedUrl(value);
    if (retryRequested.current) requestAnimationFrame(() => { if (currentScope.current === scope && document.activeElement === document.body) retryButton.current?.focus({ preventScroll: true }); });
    retryRequested.current = false;
  };
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const unreadable = !!url && failedUrl === url;
  const retrying = retryingScope === scope;
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
  if (isError || data === null || retrying || unreadable) {
    if (!retryable && fallback !== undefined) return <>{fallback}</>;
    const message = retrying ? "Retrying image preview…" : isError ? "Could not load image." : unreadable ? "This file could not be displayed as an image. The saved file is unchanged." : "Image file unavailable.";
    return retryable ? <div data-workspace-artifact={observe ? path : undefined} data-workspace-status={observe ? retrying ? "loading" : "error" : undefined} role="alert" className="space-y-2 text-xs text-danger"><p>{message}</p><p className="break-all text-muted">{path}</p><Button ref={retryButton} size="sm" variant="ghost" aria-disabled={isFetching || retrying} className={isFetching || retrying ? "opacity-50" : ""} onClick={() => { if (!isFetching && !retrying) void retry(); }}>{isFetching || retrying ? "Retrying…" : "Retry image preview"}</Button></div> : <span role="alert" className="break-all text-xs text-muted">{message} {path}</span>;
  }
  if (isLoading || data && !url) return <div className={cn("h-24 w-32 animate-pulse rounded bg-panel-2", className)} />;
  if (!url) return fallback !== undefined ? <>{fallback}</> : <span className="break-all text-xs text-muted">Image file unavailable: {path}</span>;
  return <img data-workspace-artifact={observe ? path : undefined} data-workspace-sha256={observe && fingerprint && fingerprint.blob === data ? fingerprint.sha : undefined} data-workspace-status={observe ? unreadable ? "error" : loadedUrl === url && fingerprint?.blob === data && !isFetching ? "ready" : "loading" : undefined} src={url} alt={alt ?? path} onError={() => failed(url)} onLoad={() => { setLoadedUrl(url); retryRequested.current = false; }} className={cn("max-h-80 rounded border border-border", className)} />;
}
