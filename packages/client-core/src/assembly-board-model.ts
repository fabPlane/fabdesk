import { AssemblyBoardModelRevision,BOARD_MODEL_REVISION_PATH,BoardSourceSelection,ProjectBoardSources } from "@fabdesk/protocol";
import { CoreHttpError,type CoreClient } from "./CoreClient";
import { dependenciesMatch } from "./dependency-revision";
import { sha256Blob } from "./pcb-preview-revision";
/** Read and return the exact model bytes whose status was inspected. No root fallback or second viewer fetch. */
export async function inspectAssemblyBoardModel(client: Pick<CoreClient, "inspectBoardSources" | "readFile" | "readFileBlob">, projectId: string, requested: BoardSourceSelection) {
  const board = Object.freeze(BoardSourceSelection.parse(requested));
  const owned = (raw: ProjectBoardSources) => {
    const data = ProjectBoardSources.parse(raw), row = data.sources.find(row => row.source.id === board.sourceId);
    if (data.projectId !== projectId || data.mode !== "assembly" || data.manifestSha256 !== board.manifestSha256 || row?.status !== "available" || row.source.location !== "project" || !row.pcbSha256) throw new Error("Board source changed or is unavailable. Select it again.");
    return { directory: row.source.directory, sha256: row.pcbSha256 };
  };
  const before = owned(await client.inspectBoardSources(projectId)), prefix = before.directory === "." ? "" : `${before.directory}/`, path = prefix + "renders/board.glb";
  const optional = async <T>(read: () => Promise<T>): Promise<T | null> => { try { return await read(); } catch (error) { if (error instanceof CoreHttpError && error.status === 404) return null; throw error; } };
  const [model, text, pcb] = await Promise.all([optional(() => client.readFileBlob(projectId, path)), optional(() => client.readFile(projectId, prefix + BOARD_MODEL_REVISION_PATH)), client.readFileBlob(projectId, prefix + "board.kicad_pcb")]);
  const [sourceSha256, artifactSha256] = await Promise.all([sha256Blob(pcb), model ? sha256Blob(model) : Promise.resolve(null)]), after = owned(await client.inspectBoardSources(projectId));
  if (before.directory !== after.directory || before.sha256 !== sourceSha256 || after.sha256 !== sourceSha256) throw new Error("PCB changed while checking its model. Recheck this source.");
  let raw: unknown = null; try { raw = JSON.parse(text ?? ""); } catch { /* Unverified legacy model. */ }
  const receipt = AssemblyBoardModelRevision.safeParse(raw);
  const scoped = receipt.success && receipt.data.boardSource.projectId === projectId && receipt.data.boardSource.sourceId === board.sourceId && receipt.data.boardSource.manifestSha256 === board.manifestSha256;
  const state = !model ? "missing-model" : !scoped ? "scope-unverified" : artifactSha256 !== receipt.data.artifactSha256 ? "artifact-changed" : receipt.data.sourceSha256 !== sourceSha256 || !await dependenciesMatch(client, projectId, receipt.data.dependencySnapshot, prefix) ? "source-changed" : "source-unchanged";
  return { projectId, board, sourceSha256, path, model, state, warnings: scoped ? receipt.data.warnings : [], pendingModels: scoped ? receipt.data.pendingModels ?? 0 : 0, artifactSha256 };
}
