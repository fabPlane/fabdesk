import { randomUUID, createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { AssemblySchematicPreviewRevision, SCHEMATIC_PREVIEW_REVISION_PATH } from "@fabdesk/protocol";
import { jailPath, writeAtomic, writeJson } from "./fs";
import { ToolError, type ToolContext } from "./registry";
import { inspectSavedHierarchy, ok, requireKicad } from "./tools/common";

/** Immutable member SVG versions plus one atomic receipt pointer; never replace earlier preview files. */
export async function renderMemberSchematicPreview(ctx: ToolContext, expectedHierarchyRevision?: string, circuit = false) {
  const project = ctx.requireProject();
  if (!ctx.board || !expectedHierarchyRevision) throw new ToolError("Inspect the member schematic and provide its expectedHierarchyRevision before rendering.", "precondition");
  const cli = await requireKicad(ctx), hierarchy = await inspectSavedHierarchy(ctx, project, cli);
  if (!hierarchy.complete || hierarchy.aggregateRevision !== expectedHierarchyRevision) throw new ToolError("The complete saved schematic changed or is unavailable. Inspect its referenced sheets before rendering.", "precondition");
  await jailPath(project.dir, SCHEMATIC_PREVIEW_REVISION_PATH);
  ctx.progress(.2, "rendering captured native sheets");
  const result = await ctx.services.kicad.exportOwnedSchematicSvg(cli, { projectDir: project.dir, hierarchy, ...(circuit ? { circuit: true } : {}), signal: ctx.signal });
  if (result.sourceRevision !== expectedHierarchyRevision || result.sheets.length !== hierarchy.sheets.length) throw new ToolError("Schematic export did not match the inspected hierarchy.", "precondition");
  const version = `renders/schematic/${randomUUID()}`, artifacts: AssemblySchematicPreviewRevision["sheets"] = [];
  let committed = false;
  try {
    for (const [index, sheet] of result.sheets.entries()) {
      const path = `${version}/sheet-${index + 1}.svg`, absolute = await jailPath(project.dir, path);
      await writeAtomic(absolute, sheet.svg);
      if (circuit) {
        const native = hierarchy.sheets.find(candidate => candidate.identity === sheet.nativeSheet?.identity);
        if (!native || native.nativePath !== sheet.nativeSheet?.nativePath || native.hierarchyPath !== sheet.nativeSheet?.hierarchyPath || native.pageNumber !== sheet.nativeSheet?.pageNumber) throw new ToolError("The circuit page is not bound to its inspected native instance.", "precondition");
      }
      artifacts.push({ path, name: sheet.name, ...(sheet.nativeSheet ? { nativeSheet: sheet.nativeSheet } : {}), sha256: createHash("sha256").update(sheet.svg).digest("hex") });
    }
    const current = await inspectSavedHierarchy(ctx, project, cli);
    if (!current.complete || current.aggregateRevision !== expectedHierarchyRevision) throw new ToolError("A referenced schematic changed during rendering. The previous preview was kept.", "precondition");
    const receipt = AssemblySchematicPreviewRevision.parse({ contract: "fabplane.schematic-preview-revision.v1", boardSource: { projectId: project.id, ...ctx.board }, sourceRevision: result.sourceRevision, sourceFiles: result.sourceFiles, sheets: artifacts, generatedAt: new Date().toISOString(), dependencies: "unverified" });
    const expectedFiles = new Set([...current.referencedFiles, ...(current.projectFile ? [current.projectFile] : [])]);
    if (receipt.sourceFiles.length !== expectedFiles.size || receipt.sourceFiles.some(file => !expectedFiles.has(file.path))) throw new ToolError("The preview did not capture every referenced native source file.", "precondition");
    for (const file of receipt.sourceFiles) {
      const path = await jailPath(project.dir, file.path);
      if (createHash("sha256").update(await readFile(path)).digest("hex") !== file.sha256) throw new ToolError("A schematic source changed before publication. The previous preview was kept.", "precondition");
    }
    for (const sheet of receipt.sheets) {
      const path = await jailPath(project.dir, sheet.path);
      if (createHash("sha256").update(await readFile(path)).digest("hex") !== sheet.sha256) throw new ToolError("A rendered preview changed before publication. The previous preview was kept.", "precondition");
    }
    const pointer = await jailPath(project.dir, SCHEMATIC_PREVIEW_REVISION_PATH);
    await ctx.runInScope!(async () => {}); ctx.signal.throwIfAborted();
    await writeJson(pointer, receipt); committed = true;
    ctx.progress(1, "done");
    return ok(`Rendered ${receipt.sheets.length} source-qualified schematic sheet(s). External symbol libraries, ERC and PCB parity remain unverified.`, { receiptPath: pointer, revision: receipt.sourceRevision, sheets: receipt.sheets, preview: receipt });
  } finally {
    if (!committed) {
      // Only remove this invocation's unreferenced UUID directory, after checking its current jail.
      const path = await jailPath(project.dir, version).catch(() => null);
      if (path) await rm(path, { recursive: true, force: true });
    }
  }
}
