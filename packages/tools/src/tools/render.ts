/** Render toolset: schematic/PCB images and GLB from native KiCad files. */
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { z } from "zod/v4";
import { PROJECT_FILES, ensureDir } from "../fs";
import { ToolError, defineTool } from "../registry";
import { fileUrl, ok, p, requireBoard, requireKicad, requireSchematic } from "./common";

async function fileRevision(path: string): Promise<{ sha256: string; bytes: number; mtime: string }> {
  const [data, metadata] = await Promise.all([readFile(path), stat(path)]);
  return {
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.byteLength,
    mtime: metadata.mtime.toISOString(),
  };
}

async function fileIdentity(path: string): Promise<{ sha256: string; bytes: number }> {
  const data = await readFile(path);
  return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.byteLength };
}

export const render_schematic_svg = defineTool({
  name: "render_schematic_svg",
  toolset: "render",
  title: "Render schematic",
  description: "Export board.kicad_sch as SVG and return PNG image pixels bound to the source file revision.",
  inputSchema: {
    maxWidth: z.number().int().min(320).max(4096).default(1600),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  longRunning: true,
  handler: async ({ maxWidth }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const schematic = await requireSchematic(project);
    const before = await fileRevision(schematic);
    const outDir = await ensureDir(p(project, PROJECT_FILES.renders, "schematic"));
    ctx.progress(0.2, "exporting svg");
    const { paths } = await ctx.services.kicad.exportSchematicSvg(cli, { schematic, outDir, signal: ctx.signal });
    if (!paths.length) throw new ToolError("schematic export produced no sheets", "internal");
    const revisionPrefix = before.sha256.slice(0, 16);
    const images: Array<{
      sheet: number;
      path: string;
      width: number;
      height: number;
      sha256: string;
      bytes: number;
      schematicRevision: string;
    }> = [];
    const imagePaths: string[] = [];
    for (const [index, path] of paths.entries()) {
      const raster = await ctx.services.kicad.rasterizeSvg(await readFile(path), { maxWidth });
      const pngPath = p(project, PROJECT_FILES.renders, "schematic", `${revisionPrefix}-sheet-${index + 1}.png`);
      await Bun.write(pngPath, raster.png);
      imagePaths.push(pngPath);
      images.push({
        sheet: index + 1,
        path: pngPath,
        width: raster.width,
        height: raster.height,
        ...(await fileIdentity(pngPath)),
        schematicRevision: before.sha256,
      });
    }
    const after = await fileRevision(schematic);
    if (after.sha256 !== before.sha256) {
      await Promise.all(imagePaths.map((path) => rm(path, { force: true })));
      throw new ToolError(
        `schematic changed during rendering: started at ${before.sha256}, ended at ${after.sha256}`,
        "precondition",
      );
    }
    const firstSvg = paths[0]!;
    const output = p(project, PROJECT_FILES.renders, "schematic.svg");
    const pngOutput = p(project, PROJECT_FILES.renders, "schematic.png");
    await Bun.write(output, await readFile(firstSvg));
    await Bun.write(pngOutput, await readFile(imagePaths[0]!));
    ctx.progress(1, "done");
    const url = fileUrl(output);
    return ok(
      `Rendered ${paths.length} schematic sheet(s) at revision ${before.sha256}.`,
      {
        path: output,
        pngPath: pngOutput,
        url,
        fileUrl: url,
        sheets: paths,
        schematicRevision: before,
        images,
      },
      { images: imagePaths.map((path) => ({ path, mime: "image/png" })) },
    );
  },
});

export const render_pcb_svg = defineTool({
  name: "render_pcb_svg",
  toolset: "render",
  title: "Render PCB SVG",
  description: "Render board.kicad_pcb copper, silkscreen, and edge cuts to renders/pcb.svg.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  longRunning: true,
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    await ensureDir(p(project, PROJECT_FILES.renders));
    const output = p(project, PROJECT_FILES.renders, "pcb.svg");
    ctx.progress(0.2, "exporting svg");
    await ctx.services.kicad.exportPcbSvg(cli, { board, output, signal: ctx.signal });
    ctx.progress(1, "done");
    const url = fileUrl(output);
    return ok(`Rendered PCB to ${PROJECT_FILES.renders}/pcb.svg. Browser URL: ${url}`, { path: output, url, fileUrl: url }, { images: [{ path: output, mime: "image/svg+xml" }] });
  },
});

export const render_glb = defineTool({
  name: "render_glb",
  toolset: "render",
  title: "Export 3D GLB",
  description: "Export a 3D model (GLB) of the KiCad board to renders/board.glb for the app's 3D tab. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  longRunning: true,
  handler: async (_args, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const output = p(project, PROJECT_FILES.renders, "board.glb");
    ctx.progress(0.2, "exporting glb");
    const res = await ctx.services.kicad.exportGlb(cli, { board, output, signal: ctx.signal });
    ctx.progress(1, "done");
    const url = fileUrl(output);
    return ok(`Exported ${PROJECT_FILES.renders}/board.glb${res.fused ? " (fused shapes)" : ""}. Browser URL: ${url}${res.warnings.length ? `\nWarnings:\n${res.warnings.map((w) => `- ${w}`).join("\n")}` : ""}`, { path: output, url, fileUrl: url, ...res });
  },
});

export const renderTools = [render_schematic_svg, render_pcb_svg, render_glb];
