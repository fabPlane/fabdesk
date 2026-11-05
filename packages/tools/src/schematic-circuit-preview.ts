import { RootSchematicPreviewRevision, SCHEMATIC_PREVIEW_REVISION_PATH } from "@fabdesk/protocol";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { exists, jailPath, writeAtomic, writeJson } from "./fs";
import { ToolError, type ToolContext } from "./registry";
import { fileUrl, ok, requireKicad } from "./tools/common";

const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
/** Circuit presentation uses the existing immutable native renderer; document exports stay separate. */
export async function renderRootCircuitPreview(ctx: ToolContext, maxWidth: number, expectedHierarchyRevision?: string) {
  const project = ctx.requireProject(), cli = await requireKicad(ctx);
  const schematic = await jailPath(project.dir, "board.kicad_sch"), metadata = await jailPath(project.dir, "board.kicad_pro");
  const inspect = () => ctx.services.kicad.inspectSchematicHierarchy(cli, { projectDir: project.dir, rootSchematic: schematic, ownedFilesOnly: true, signal: ctx.signal });
  const hierarchy = await inspect();
  if (!hierarchy.complete || expectedHierarchyRevision && expectedHierarchyRevision !== hierarchy.aggregateRevision) throw new ToolError("Circuit view needs the current complete native hierarchy. Resolve missing or changed sheets first.", "precondition");
  ctx.progress(.2, "rendering captured native circuitry");
  const captured = await ctx.services.kicad.exportOwnedSchematicSvg(cli, { projectDir: project.dir, hierarchy, circuit: true, signal: ctx.signal });
  if (captured.sheets.some(sheet => !new TextDecoder().decode(sheet.svg).includes('data-fabplane-schematic-view="circuit'))) throw new ToolError("The exporter did not produce circuit-framed drawings. The previous preview was kept.", "precondition");
  const expected = new Set([...hierarchy.referencedFiles, ...(hierarchy.projectFile ? [hierarchy.projectFile] : [])]);
  if (captured.sourceRevision !== hierarchy.aggregateRevision || captured.sheets.length !== hierarchy.sheets.length || captured.sourceFiles.length !== expected.size || captured.sourceFiles.some(file => !expected.delete(file.path)) || expected.size) throw new ToolError("Circuit rendering did not capture the complete inspected hierarchy.", "precondition");
  const version = `renders/schematic/${randomUUID()}`, versionPath = await jailPath(project.dir, version);
  let published = false;
  const artifacts: RootSchematicPreviewRevision["sheets"] = [];
  const sheets: string[] = [], images: Array<{ sheet: number; path: string; width: number; height: number; sha256: string; bytes: number; schematicRevision: string }> = [];
  try {
    for (const [index, sheet] of captured.sheets.entries()) {
      ctx.signal.throwIfAborted();
      const svgPath = await jailPath(project.dir, `${version}/sheet-${index + 1}.svg`), pngPath = await jailPath(project.dir, `${version}/sheet-${index + 1}.png`);
      const native = hierarchy.sheets.find(candidate => candidate.identity === sheet.nativeSheet?.identity);
      if (!native || native.nativePath !== sheet.nativeSheet?.nativePath || native.hierarchyPath !== sheet.nativeSheet?.hierarchyPath || native.pageNumber !== sheet.nativeSheet?.pageNumber) throw new ToolError("The circuit page is not bound to its inspected native instance.", "precondition");
      artifacts.push({ path: `${version}/sheet-${index + 1}.svg`, name: sheet.name, sha256: sha(sheet.svg), nativeSheet: sheet.nativeSheet! });
      const raster = await ctx.services.kicad.rasterizeSvg(sheet.svg, { maxWidth });
      await writeAtomic(svgPath, sheet.svg); await writeAtomic(pngPath, raster.png);
      sheets.push(svgPath); images.push({ sheet: index + 1, path: pngPath, width: raster.width, height: raster.height, sha256: sha(raster.png), bytes: raster.png.byteLength, schematicRevision: hierarchy.aggregateRevision });
    }
    for (const file of captured.sourceFiles) if (sha(await readFile(await jailPath(project.dir, file.path))) !== file.sha256) throw new ToolError("A native sheet changed during circuit rendering. The previous preview was kept.", "precondition");
    if (!hierarchy.projectFile && await exists(metadata)) throw new ToolError("Native project metadata appeared during circuit rendering. Reinspect this design.", "precondition");
    ctx.signal.throwIfAborted();
    if (!sheets[0] || !images[0]) throw new ToolError("Circuit export produced no sheets.", "internal");
    const receipt = RootSchematicPreviewRevision.parse({ contract: "fabplane.schematic-preview-revision.v1", projectId: project.id, sourceRevision: hierarchy.aggregateRevision, sourceFiles: captured.sourceFiles, sheets: artifacts, generatedAt: new Date().toISOString(), dependencies: "unverified" });
    const output = await jailPath(project.dir, "renders/schematic.svg"), pngOutput = await jailPath(project.dir, "renders/schematic.png");
    await writeAtomic(pngOutput, await readFile(images[0].path)); await writeAtomic(output, await readFile(sheets[0]));
    await writeJson(await jailPath(project.dir, SCHEMATIC_PREVIEW_REVISION_PATH), receipt);
    published = true; ctx.progress(1, "done");
    return ok(`Opened ${sheets.length} circuit sheet(s) from the captured native hierarchy. This is presentation only; document exports retain paper metadata. ERC and PCB parity remain separate checks.`, { path: output, pngPath: pngOutput, url: fileUrl(output), sheets, images, sourceRevision: captured.sourceRevision, sourceFiles: captured.sourceFiles, presentation: "circuit", preview: receipt }, { images: images.map(image => ({ path: image.path, mime: "image/png", requiredInline: true })) });
  } finally {
    if (!published && await jailPath(project.dir, version).catch(() => null) === versionPath) await rm(versionPath, { recursive: true, force: true });
  }
}
