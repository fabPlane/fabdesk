/** Web-only query hooks. Everything platform-agnostic lives in `@fabdesk/client-core`. */
import { CoreHttpError, projectBlobQueryKey, reuseUnchangedProjectBlob, useCoreClient } from "@fabdesk/client-core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/** Object URL for a binary project file, revoked on unmount. */
export function useProjectBlobUrl(projectId: string | null, path: string | null) {
  const client = useCoreClient(), qc = useQueryClient();
  const queryKey = projectBlobQueryKey(client.baseUrl, projectId, path);
  const scope = JSON.stringify(queryKey);
  const q = useQuery<Blob | null>({
    queryKey,
    queryFn: async () => {
      try {
        const previous = qc.getQueryData<Blob | null>(queryKey);
        const fresh = await client.readFileBlob(projectId!, path!);
        return await reuseUnchangedProjectBlob(previous, fresh);
      } catch (e) {
        if (e instanceof CoreHttpError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: !!projectId && !!path,
  });
  const [objectUrl, setObjectUrl] = useState<{ scope: string; blob: Blob; url: string } | null>(null);
  useEffect(() => {
    if (!q.data) {
      setObjectUrl(null);
      return;
    }
    const u = URL.createObjectURL(q.data);
    setObjectUrl({ scope, blob: q.data, url: u });
    return () => URL.revokeObjectURL(u);
  }, [q.data, scope]);
  const url = objectUrl?.scope === scope && objectUrl.blob === q.data ? objectUrl.url : null;
  return { ...q, url };
}
