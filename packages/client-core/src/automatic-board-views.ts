import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BoardLayers, BOARD_LAYERS_PATH, BoardModelRevision, BOARD_MODEL_REVISION_PATH, type BoardSourceSelection } from "@fabdesk/protocol";
import { useCoreClient } from "./provider";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";
import { inspectBoardModelRevision } from "./board-model-revision";
import { inspectAssemblyBoardModel } from "./assembly-board-model";

export async function runPreviewTool(client: Pick<CoreClient, "callTool" | "waitJob">, name: string, args: Record<string, unknown>) {
  const response = await client.callTool(name, args);
  if (response.jobId) {
    const job = await client.waitJob(response.jobId);
    if (job.status !== "done") throw new Error(job.error ?? "Preview preparation stopped. Try again.");
  }
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
  const model = useQuery({ queryKey: ["automatic-board-model", ...scope, hash], enabled: enabled && !!hash,
    retry: false, staleTime: Infinity, gcTime: 5 * 60_000,
    queryFn: async () => {
      if (board) {
        let saved = await inspectAssemblyBoardModel(client, projectId, board);
        if (saved.sourceSha256 !== hash) throw new Error("Board changed. Waiting for its latest saved version.");
        if (saved.state !== "source-unchanged") {
          await runPreviewTool(client, "render_glb", args);
          saved = await inspectAssemblyBoardModel(client, projectId, board);
        }
        if (saved.sourceSha256 !== hash || saved.state !== "source-unchanged" || !saved.model) throw new Error("Model does not match this board. Retry preparation.");
        return { blob: saved.model, warnings: saved.warnings };
      }
      if (await inspectBoardModelRevision(client, projectId) !== "source-unchanged") await runPreviewTool(client, "render_glb", args);
      if (await sha256Blob(await client.readFileBlob(projectId, "board.kicad_pcb")) !== hash) throw new Error("Board changed while preparing its model.");
      const [blob, text] = await Promise.all([client.readFileBlob(projectId, "renders/board.glb"), client.readFile(projectId, BOARD_MODEL_REVISION_PATH)]);
      const receipt = BoardModelRevision.parse(JSON.parse(text));
      if (receipt.sourceSha256 !== hash || receipt.artifactSha256 !== await sha256Blob(blob)) throw new Error("Model changed while opening it. Retry preparation.");
      return { blob, warnings: receipt.warnings ?? [] };
    },
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
  return { source, model, layers, path: prefix + "renders/board.glb" };
}
