import { BoardModelRevision, BOARD_MODEL_REVISION_PATH, type BoardSourceSelection } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { inspectAssemblyBoardModel } from "./assembly-board-model";
import { dependenciesMatch } from "./dependency-revision";
import { sha256Blob } from "./pcb-preview-revision";

export type BoardPreviewModel = { blob: Blob; warnings: string[]; pendingModels: number; digest: string };

export async function loadProgressiveBoardModel(client: CoreClient, projectId: string, hash: string, board: BoardSourceSelection | undefined,
  run: (options: { localModelsOnly?: boolean; completeLocalPreview?: string }) => Promise<void>,
  showLocal: (model: BoardPreviewModel) => void, online: () => boolean) {
  async function read(checkDependencies: boolean): Promise<BoardPreviewModel | null> {
    if (board) {
      const saved = await inspectAssemblyBoardModel(client, projectId, board);
      if (saved.sourceSha256 !== hash) throw new Error("Board changed while opening its model.");
      if (saved.state !== "source-unchanged" || !saved.model || !saved.artifactSha256) return null;
      return { blob: saved.model, warnings: saved.warnings, pendingModels: saved.pendingModels, digest: saved.artifactSha256 };
    }
    try {
      const parsed = BoardModelRevision.safeParse(JSON.parse(await client.readFile(projectId, BOARD_MODEL_REVISION_PATH)));
      if (!parsed.success || parsed.data.sourceSha256 !== hash) return null;
      const receipt = parsed.data;
      if (checkDependencies && !await dependenciesMatch(client, projectId, receipt.dependencySnapshot)) return null;
      const [blob, pcb] = await Promise.all([client.readFileBlob(projectId, "renders/board.glb"), client.readFileBlob(projectId, "board.kicad_pcb")]);
      if (await sha256Blob(pcb) !== hash) throw new Error("Board changed while opening its model.");
      if (receipt.artifactSha256 !== await sha256Blob(blob)) return null;
      return { blob, warnings: receipt.warnings ?? [], pendingModels: receipt.pendingModels ?? 0, digest: receipt.artifactSha256 };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof CoreHttpError && error.status === 404) return null;
      throw error;
    }
  }
  let model = await read(true);
  if (!model) {
    await run({ localModelsOnly: true });
    model = await read(false);
  }
  if (!model) throw new Error("Model does not match the saved board.");
  if (!model.pendingModels || !online()) return model;
  showLocal(model);
  await run({ completeLocalPreview: model.digest });
  const complete = await read(false);
  if (!complete) throw new Error("Board changed while loading component models.");
  if (complete.digest === model.digest) complete.blob = model.blob;
  return complete;
}
