import { AssemblyPcbCheckReceipt, BoardSourceSelection, ProjectBoardSources } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";
export type AssemblyCheckState = "missing-report" | "scope-unverified" | "source-changed" | "source-unchanged";
/** Resolve only the captured source; a legacy/root report cannot supply member findings. */
export async function inspectAssemblyPcbCheck(client: Pick<CoreClient, "inspectBoardSources" | "readFile" | "readFileBlob">, projectId: string, requested: BoardSourceSelection) {
  const board = Object.freeze(BoardSourceSelection.parse(requested));
  const ownedSource = (raw: ProjectBoardSources) => {
    const data = ProjectBoardSources.parse(raw);
    const source = data.sources.find(row => row.source.id === board.sourceId);
    if (data.projectId !== projectId || data.mode !== "assembly" || data.manifestSha256 !== board.manifestSha256 || source?.status !== "available" || source.source.location !== "project" || !source.pcbSha256) throw new Error("Board source changed or is unavailable. Select it again.");
    return { directory: source.source.directory, sha256: source.pcbSha256 };
  };
  const before = ownedSource(await client.inspectBoardSources(projectId)), prefix = before.directory === "." ? "" : `${before.directory}/`;
  let text: string | null;
  try { text = await client.readFile(projectId, prefix + "reports/drc.json"); }
  catch (error) { if (error instanceof CoreHttpError && error.status === 404) text = null; else throw error; }
  const bytes = await client.readFileBlob(projectId, prefix + "board.kicad_pcb"), sourceSha256 = await sha256Blob(bytes);
  const after = ownedSource(await client.inspectBoardSources(projectId));
  if (before.directory !== after.directory || before.sha256 !== sourceSha256 || after.sha256 !== sourceSha256) throw new Error("PCB changed while checking the report. Recheck sources before running DRC.");
  let report: unknown = null, state: AssemblyCheckState = "missing-report";
  if (text !== null) {
    let raw: unknown; try { raw = JSON.parse(text); } catch { raw = null; }
    const receipt = AssemblyPcbCheckReceipt.safeParse(raw);
    if (!receipt.success || receipt.data.boardSource.projectId !== projectId || receipt.data.boardSource.sourceId !== board.sourceId || receipt.data.boardSource.manifestSha256 !== board.manifestSha256) state = "scope-unverified";
    else { report = raw; state = receipt.data.pcbRevision.sha256 === sourceSha256 ? "source-unchanged" : "source-changed"; }
  }
  return { board, projectId, sourceSha256, state, report };
}
