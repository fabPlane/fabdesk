import { dependenciesMatch } from "./dependency-revision";
import { RootSchematicPreviewRevision, AssemblySchematicPreviewRevision, BoardSourceSelection, ProjectBoardSources, SCHEMATIC_PREVIEW_REVISION_PATH } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";

/** Inspect the selected saved page's exact bytes and all recorded native sources; never inherit a root preview. */
export function inspectAssemblySchematicPreview(client: Pick<CoreClient, "inspectBoardSources" | "readFileBlob">, projectId: string, requested: BoardSourceSelection, selectedPath?: string | null) {
  return inspectSchematicPreview(client, projectId, Object.freeze(BoardSourceSelection.parse(requested)), selectedPath);
}
export function inspectRootSchematicPreview(client: Pick<CoreClient, "inspectBoardSources" | "readFileBlob">, projectId: string, selectedPath?: string | null) {
  return inspectSchematicPreview(client, projectId, null, selectedPath);
}
async function inspectSchematicPreview(client: Pick<CoreClient, "inspectBoardSources" | "readFileBlob">, projectId: string, board: BoardSourceSelection | null, selectedPath?: string | null) {
  const owned = (raw: ProjectBoardSources) => {
    const data = ProjectBoardSources.parse(raw);
    if (!board) {
      if (data.projectId !== projectId || data.mode !== "single") throw new Error("The root schematic source changed. Reopen the selected board.");
      return { directory: "." };
    }
    const row = data.sources.find(row => row.source.id === board.sourceId);
    if (data.projectId !== projectId || data.mode !== "assembly" || data.manifestSha256 !== board.manifestSha256 || row?.status !== "available" || row.source.location !== "project") throw new Error("Schematic source changed or is unavailable. Select this board again.");
    return row.source;
  };
  const before = owned(await client.inspectBoardSources(projectId)), prefix = before.directory === "." ? "" : `${before.directory}/`;
  const optional = async (path: string) => { try { return await client.readFileBlob(projectId, prefix + path); } catch (error) { if (error instanceof CoreHttpError && error.status === 404) return null; throw error; } };
  const pointer = await optional(SCHEMATIC_PREVIEW_REVISION_PATH); let text: string | null = null, raw: unknown = null;
  if (pointer && pointer.size <= 512 * 1024) { text = await pointer.text(); try { raw = JSON.parse(text); } catch { /* Unverified receipt is never a current preview. */ } }
  const root = !board ? RootSchematicPreviewRevision.safeParse(raw) : null, member = board ? AssemblySchematicPreviewRevision.safeParse(raw) : null;
  const receipt = root?.success && root.data.projectId === projectId ? root.data : board && member?.success && member.data.boardSource.projectId === projectId && member.data.boardSource.sourceId === board.sourceId && member.data.boardSource.manifestSha256 === board.manifestSha256 ? member.data : null;
  const sheet = receipt ? (selectedPath ? receipt.sheets.find(sheet => sheet.path === selectedPath) : receipt.sheets[0]) ?? null : null;
  if (receipt && selectedPath && !sheet) throw new Error("The saved schematic pages changed. Select a page again.");
  let sourceChanged = false, artifactChanged = false, svg: string | null = null, next = 0, stopped = false;
  const checkSources = async () => {
    if (!receipt) return; next = 0; stopped = false;
    if (!await dependenciesMatch(client, projectId, receipt.dependencySnapshot, prefix)) sourceChanged = true;
    const reads = await Promise.allSettled(Array.from({ length: Math.min(4, receipt.sourceFiles.length) }, async () => {
      for (;;) {
        if (stopped) return; const file = receipt.sourceFiles[next++]; if (!file) return;
        try { const blob = await optional(file.path); if (!blob || await sha256Blob(blob) !== file.sha256) sourceChanged = true; }
        catch (error) { stopped = true; throw error; }
      }
    }));
    const failed = reads.find(read => read.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
    if (!receipt.sourceFiles.some(file => file.path === "board.kicad_pro") && await optional("board.kicad_pro")) sourceChanged = true;
  };
  if (receipt) {
    await checkSources();
    if (sheet) { const blob = await optional(sheet.path); artifactChanged = !blob || await sha256Blob(blob) !== sheet.sha256; svg = blob ? await blob.text() : null; }
  }
  // A source save during a slower page download must not return a current-looking drawing.
  await checkSources();
  const after = owned(await client.inspectBoardSources(projectId));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Schematic source directory or provenance changed during inspection.");
  // Re-read only the small atomic pointer. Never return an obsolete page selection after publication.
  const currentPointer = await optional(SCHEMATIC_PREVIEW_REVISION_PATH), currentText = currentPointer && currentPointer.size <= 512 * 1024 ? await currentPointer.text() : null;
  if (text !== currentText || !!pointer !== !!currentPointer) throw new Error("Schematic previews changed during inspection. Recheck this source.");
  const state = !pointer ? "missing-preview" : !receipt ? "scope-unverified" : artifactChanged ? "artifact-changed" : sourceChanged ? "source-changed" : "source-unchanged";
  return { board, sourceRevision: receipt?.sourceRevision ?? null, sheets: receipt?.sheets ?? [], sheet, svg, state, dependencies: "unverified" as const };
}
