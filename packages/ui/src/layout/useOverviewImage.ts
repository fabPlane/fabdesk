import { useEffect, useState } from "react";
import type { OverviewImage } from "@fabdesk/client-core";
import { useProjectBlobUrl } from "../hooks/queries";

/** Try the next saved candidate on fetch or browser decode failure. Never generate files. */
export function useOverviewImage(projectId: string, candidates: OverviewImage[]) {
  const scope = JSON.stringify([projectId, candidates]);
  const [failures, setFailures] = useState<{ scope: string; paths: string[] }>({ scope, paths: [] });
  const failed = failures.scope === scope ? failures.paths : [];
  const candidate = candidates.find(row => !failed.includes(row.path));
  const image = useProjectBlobUrl(projectId, candidate?.path ?? null);
  const fail = () => {
    if (!candidate) return;
    setFailures(previous => ({ scope, paths: [...new Set([...(previous.scope === scope ? previous.paths : []), candidate.path])] }));
  };
  useEffect(() => {
    if (candidate && !image.isFetching && (image.isError || image.data === null)) fail();
  }, [scope, candidate?.path, image.isFetching, image.isError, image.data]);
  return { candidate, url: image.isError ? null : image.url, loading: !!candidate && image.isLoading, onError: fail };
}
