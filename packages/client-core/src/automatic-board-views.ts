import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BoardLayers, BOARD_LAYERS_PATH, type BoardSourceSelection } from "@fabdesk/protocol";
import { useCoreClient } from "./provider";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";
import { loadProgressiveBoardModel, type BoardPreviewModel } from "./progressive-board-model";

export async function runPreviewTool(client: Pick<CoreClient, "callTool" | "waitJob">, name: string, args: Record<string, unknown>) {
  const response = await client.callTool(name, args);
  let result: unknown = "result" in response ? response.result : response;
  if (response.jobId) {
    const job = await client.waitJob(response.jobId);
    if (job.status !== "done") throw new Error(job.error ?? "Preview preparation stopped. Try again.");
    result = job.result;
  }
  const envelope = result as { isError?: boolean; ok?: boolean; text?: string } | null;
  if (envelope?.isError || envelope?.ok === false) throw new Error(envelope.text ?? "Preview preparation failed.");
}

export async function readBoardLayers(client: Pick<CoreClient, "readFile">, projectId: string, path: string, hash: string) {
  try {
    const parsed = BoardLayers.safeParse(JSON.parse(await client.readFile(projectId, path)));
    return parsed.success && parsed.data.sourceSha256 === hash ? parsed.data : null;
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof CoreHttpError && error.status === 404) return null;
    throw error;
  }
}

/** Queries coalesce concurrent viewers by endpoint, source identity and exact saved bytes.
 * Failed exports stay failed until Retry or a source edit; changing tabs never starts a retry loop. */
export function useAutomaticBoardViews({ projectId, directory = ".", board, sourceStamp, enabled }: {
  projectId: string; directory?: string; board?: BoardSourceSelection; sourceStamp: string; enabled: boolean;
}) {
  const client = useCoreClient(), prefix = directory === "." ? "" : `${directory}/`;
  const scope = [client.baseUrl, projectId, board?.sourceId ?? "root", board?.manifestSha256 ?? "", directory];
  const [settled, setSettled] = useState(sourceStamp);
  useEffect(() => { const timer = setTimeout(() => setSettled(sourceStamp), 600); return () => clearTimeout(timer); }, [sourceStamp]);
  const source = useQuery({ queryKey: ["board-view-source", ...scope, sourceStamp], enabled: enabled && settled === sourceStamp, retry: false,
    queryFn: async () => sha256Blob(await client.readFileBlob(projectId, prefix + "board.kicad_pcb")),
  });
  const hash = source.data;
  const args = { projectId, ...(board ? { board } : {}), expectedSourceSha256: hash };
  const queries = useQueryClient(), modelKey = ["automatic-board-model", ...scope, hash];
  const model = useQuery<BoardPreviewModel>({ queryKey: modelKey, enabled: enabled && !!hash,
    retry: false, staleTime: Infinity, gcTime: 5 * 60_000,
    refetchOnReconnect: query => query.state.data?.pendingModels ? "always" : false,
    queryFn: () => loadProgressiveBoardModel(client, projectId, hash!, board,
      options => runPreviewTool(client, "render_glb", { ...args, ...options }),
      local => queries.setQueryData(modelKey, local), () => globalThis.navigator?.onLine !== false),
  });
  const layers = useQuery({ queryKey: ["automatic-board-layers", ...scope, hash], enabled: enabled && !!hash,
    retry: false, staleTime: Infinity, gcTime: 5 * 60_000,
    queryFn: async () => {
      const path = prefix + BOARD_LAYERS_PATH;
      const saved = await readBoardLayers(client, projectId, path, hash!);
      if (saved) return saved;
      await runPreviewTool(client, "render_board_layers", args);
      const result = await readBoardLayers(client, projectId, path, hash!);
      if (!result) throw new Error("Layer preview does not match this board. Retry preparation.");
      return result;
    },
  });
  const refreshModel = useMutation({ mutationKey: ["refresh-board-model", ...scope, hash], networkMode: "always", mutationFn: async () => {
    if (!hash || !enabled) throw new Error("Wait for the saved board before refreshing its preview.");
    if (!model.data?.pendingModels) await runPreviewTool(client, "render_glb", args);
    await model.refetch({ throwOnError: true });
  } });
  return { source, model, layers, refreshModel, path: prefix + "renders/board.glb" };
}
