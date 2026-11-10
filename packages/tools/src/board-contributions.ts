import { realpath } from "node:fs/promises";
import { EditableBoardFiles } from "@fabdesk/protocol";
import { inspectOwnedProjectFile, inspectProjectBoardSources } from "./assembly";

/** Inspect one explicitly chosen, project-owned board; never collect folders or arbitrary attachments. */
export async function prepareEditableBoard(project: { id: string; dir: string }, sourceId: string) {
  const scope = await inspectProjectBoardSources(project),
    root = await realpath(project.dir);
  const source = scope.sources.find((s) => s.source.id === sourceId);
  if (
    !source ||
    source.status !== "available" ||
    !source.pcbPath ||
    source.source.location !== "project"
  )
    throw new Error("Choose an available project-owned KiCad board.");
  const pcb = await inspectOwnedProjectFile(root, source.pcbPath, 10 * 1024 * 1024, true);
  const schematic = source.schematicPath
    ? await inspectOwnedProjectFile(root, source.schematicPath, 5 * 1024 * 1024, true)
    : null;
  if (pcb.sha256 !== source.pcbSha256)
    throw new Error("The board changed while preparing files. Try again.");
  const files = EditableBoardFiles.parse({
    pcb: pcb.text,
    ...(schematic ? { schematic: schematic.text } : {}),
  });
  return {
    files,
    async verify() {
      const next = await inspectProjectBoardSources(project);
      if (
        JSON.stringify({
          mode: next.mode,
          manifest: next.manifestSha256,
          sources: next.sources,
        }) !==
        JSON.stringify({ mode: scope.mode, manifest: scope.manifestSha256, sources: scope.sources })
      )
        throw new Error("Board sources changed while preparing files. Try again.");
      if (
        schematic &&
        (await inspectOwnedProjectFile(root, source.schematicPath!, 5 * 1024 * 1024)).sha256 !==
          schematic.sha256
      )
        throw new Error("The schematic changed while preparing files. Try again.");
    },
  };
}
