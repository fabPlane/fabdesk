/** Web-only query hooks. Everything platform-agnostic lives in `@fabdesk/client-core`. */
import { CoreHttpError, useCoreClient } from "@fabdesk/client-core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/** Object URL for a binary project file, revoked on unmount. */
export function useProjectBlobUrl(projectId: string | null, path: string | null) {
  const client = useCoreClient();
  const q = useQuery<Blob | null>({
    queryKey: ["file", projectId, path, "blob"],
    queryFn: async () => {
      try {
        return await client.readFileBlob(projectId!, path!);
      } catch (e) {
        if (e instanceof CoreHttpError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: !!projectId && !!path,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(q.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [q.data]);
  return { ...q, url };
}
