import { useQuery } from "@tanstack/react-query";
import { useCoreClient } from "./provider";
export type WorkingDesign = {
  sourcePath: string | null;
  requestStartedAt?: number;
  sourceRevision?: string;
  board?: string | null;
  schematic?: string | null;
  inputCount?: number;
};
export type NativeViewKind = "pcb" | "schematic" | "3d";
export type WorkingDesignRender = {
  path: string;
  artifactSha256: string;
  sourcePath: string;
  sourceRevision: string;
  kind: NativeViewKind;
  sourceBinding: {
    status: string;
    artifactSha256?: string;
    checkedAt?: string;
    source?: string;
    sourceRevision?: string;
    warnings?: string[];
    dependencies?: string;
  };
};
export function useWorkingDesign(projectId: string | null, threadId: string | null) {
  const client = useCoreClient();
  return useQuery<WorkingDesign>({
    queryKey: ["working-design", client.baseUrl, projectId, threadId],
    enabled: !!projectId,
    queryFn: ({ signal }) =>
      client.request(
        `/projects/${encodeURIComponent(projectId!)}/working-design${threadId ? `?threadId=${encodeURIComponent(threadId)}` : ""}`,
        { signal },
      ),
    refetchInterval: 2000,
    retry: false,
  });
}
export function useWorkingDesignRender(
  projectId: string,
  threadId: string | null,
  design: WorkingDesign | undefined,
  kind: NativeViewKind,
  enabled = true,
) {
  const client = useCoreClient();
  return useQuery<WorkingDesignRender>({
    queryKey: [
      "working-design-render",
      client.baseUrl,
      projectId,
      threadId,
      design?.sourcePath,
      design?.sourceRevision,
      kind,
    ],
    enabled: enabled && !!design?.sourceRevision,
    queryFn: ({ signal }) =>
      client.request(`/projects/${encodeURIComponent(projectId)}/working-design/render`, {
        method: "POST",
        signal,
        json: { ...(threadId ? { threadId } : {}), sourceRevision: design!.sourceRevision, kind },
      }),
    staleTime: Infinity,
    retry: false,
  });
}
