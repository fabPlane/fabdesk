import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sha256Blob, useCoreClient } from "@fabdesk/client-core";
/** Observe the normal renderer's loaded bytes; never choose content or navigate the UI. */
export function useNativeViewObservation(
  projectId: string | null,
  path: string,
  data: string | Blob | null | undefined,
) {
  const client = useCoreClient();
  const [digest, setDigest] = useState<{ data: typeof data; sha: string } | null>(null);
  const [paint, setPaint] = useState<{ data: typeof data; status: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (data)
      void sha256Blob(typeof data === "string" ? new Blob([data]) : data).then((sha) => {
        if (active) setDigest({ data, sha });
      });
    return () => {
      active = false;
    };
  }, [data]);
  const onState = useCallback(
    (status: "loading" | "ready" | "failed") => setPaint({ data, status }),
    [data],
  );
  const binding = useQuery({
    queryKey: ["native-view-observation", client.baseUrl, projectId, path, digest?.sha],
    enabled: !!projectId && !!client.nativeSource && !!data,
    queryFn: () =>
      client.request(
        `/projects/${encodeURIComponent(projectId!)}/presentation-binding?path=${encodeURIComponent(path)}`,
      ),
    refetchInterval: 2000,
    retry: false,
  });
  return {
    onState,
    attributes: {
      "data-workspace-artifact": path,
      "data-workspace-sha256": digest?.data === data ? digest?.sha : undefined,
      "data-workspace-status":
        paint?.data === data && digest?.data === data ? paint?.status : "loading",
      "data-workspace-freshness": JSON.stringify(
        binding.isError || binding.isFetching
          ? { status: "unknown" }
          : (binding.data ?? { status: "unknown" }),
      ),
    },
  };
}
