import { AssemblyBoardModelRevision, AssemblySchematicPreviewRevision, BoardModelRevision, BoardSourceSelection, PcbPreviewRevision, RootSchematicPreviewRevision, type ProjectBoardSources } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";
import { pcbSelectionParts, schematicSelectionParts, type SelectablePart } from "./part-selection";

export type SelectionIndex = {
  pcb: { parts: SelectablePart[]; sha256: string } | null;
  model: { references: string[]; sha256: string } | null;
  sheets: { path: string; identity: string; name: string; sha256: string; parts: SelectablePart[] }[];
};
/** Read-only selection metadata. A stale/untracked preview never receives current-source markers. */
export async function inspectSelectionIndex(client: Pick<CoreClient, "readFileBlob" | "inspectBoardSources">, projectId: string, requested?: BoardSourceSelection): Promise<SelectionIndex> {
  const board = requested ? BoardSourceSelection.parse(requested) : null;
  const directory = (sources: ProjectBoardSources) => {
    if (sources.projectId !== projectId) throw new Error("Project changed during component inspection.");
    if (!board) { if (sources.mode !== "single") throw new Error("Select a board source first."); return "."; }
    const source = sources.sources.find(s => s.source.id === board.sourceId);
    if (sources.mode !== "assembly" || sources.manifestSha256 !== board.manifestSha256 || source?.status !== "available" || source.source.location !== "project") throw new Error("Board source changed. Select it again.");
    return source.source.directory;
  };
  const dir = directory(await client.inspectBoardSources(projectId)), prefix = dir === "." ? "" : `${dir}/`;
  const files = new Map<string, Blob | null>();
  const read = async (path: string) => {
    if (files.has(path)) return files.get(path)!;
    try { const blob = await client.readFileBlob(projectId, prefix + path); if (blob.size > 20_000_000) throw new Error("Design exceeds component selection limits."); files.set(path, blob); return blob; }
    catch (e) { if (e instanceof CoreHttpError && e.status === 404) { files.set(path, null); return null; } throw e; }
  };
  const json = async (path: string) => { const blob = await read(path); if (!blob || blob.size > 512 * 1024) return null; try { return JSON.parse(await blob.text()) as unknown; } catch { return null; } };
  const [pcb, pcbRaw, modelRaw, schRaw] = await Promise.all([read("board.kicad_pcb"), json("renders/pcb.svg.revision.json"), json("renders/board.glb.revision.json"), json("renders/schematic.revision.json")]);
  const result: SelectionIndex = { pcb: null, model: null, sheets: [] };
  const pcbHash = pcb ? await sha256Blob(pcb) : null;
  const pcbParts = pcb ? pcbSelectionParts(await pcb.text()) : [];
  const preview = PcbPreviewRevision.safeParse(pcbRaw);
  if (preview.success && preview.data.sourceSha256 === pcbHash) result.pcb = { parts: pcbParts, sha256: preview.data.artifactSha256 };
  const memberModel = AssemblyBoardModelRevision.safeParse(modelRaw);
  const model = BoardModelRevision.safeParse(modelRaw);
  if (model.success && model.data.sourceSha256 === pcbHash && (!board || memberModel.success && memberModel.data.boardSource.projectId === projectId && memberModel.data.boardSource.sourceId === board.sourceId && memberModel.data.boardSource.manifestSha256 === board.manifestSha256)) result.model = { references: pcbParts.map(p => p.ref), sha256: model.data.artifactSha256 };
  const schematic = board ? AssemblySchematicPreviewRevision.safeParse(schRaw) : RootSchematicPreviewRevision.safeParse(schRaw);
  if (schematic.success && (board ? "boardSource" in schematic.data && schematic.data.boardSource.projectId === projectId && schematic.data.boardSource.sourceId === board.sourceId && schematic.data.boardSource.manifestSha256 === board.manifestSha256 : "projectId" in schematic.data && schematic.data.projectId === projectId)) {
    let valid = true;
    for (const file of schematic.data.sourceFiles) { const blob = await read(file.path); if (!blob || await sha256Blob(blob) !== file.sha256) valid = false; }
    if (!schematic.data.sourceFiles.some(file => file.path === "board.kicad_pro") && await read("board.kicad_pro")) valid = false;
    const root = await read("board.kicad_sch");
    if (valid && root) for (const sheet of schematic.data.sheets) {
      const native = sheet.nativeSheet; if (!native) continue;
      const blob = await read(native.nativePath); if (!blob) continue;
      result.sheets.push({ path: sheet.path, identity: native.identity, name: native.hierarchyPath, sha256: sheet.sha256, parts: schematicSelectionParts(await blob.text(), native.identity, await root.text()) });
    }
  }
  // File watcher invalidation handles later saves; reject saves during this read too.
  for (const [path, before] of files) {
    let after: Blob | null;
    try { after = await client.readFileBlob(projectId, prefix + path); } catch (e) { if (e instanceof CoreHttpError && e.status === 404) after = null; else throw e; }
    if (!!before !== !!after || before && after && await sha256Blob(before) !== await sha256Blob(after)) throw new Error("Design changed while loading component selection. Try again.");
  }
  if (directory(await client.inspectBoardSources(projectId)) !== dir) throw new Error("Board source moved during inspection.");
  return result;
}
