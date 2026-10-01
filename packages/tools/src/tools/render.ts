/** Render toolset: schematic/PCB images and GLB from native KiCad files. */
import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { z } from "zod/v4";
import { PROJECT_FILES, ensureDir } from "../fs";
import { ToolError, defineTool } from "../registry";
import { fileUrl, ok, p, requireBoard, requireKicad, requireSchematic } from "./common";
import { rowPoints } from "./spatial";

async function fileRevision(
  path: string,
): Promise<{ sha256: string; bytes: number; mtime: string }> {
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
  description:
    "Export board.kicad_sch as SVG and return PNG image pixels bound to the source file revision.",
  inputSchema: {
    maxWidth: z.number().int().min(320).max(4096).default(1600),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async ({ maxWidth }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const schematic = await requireSchematic(project);
    const before = await fileRevision(schematic);
    const outDir = await ensureDir(p(project, PROJECT_FILES.renders, "schematic"));
    ctx.progress(0.2, "exporting svg");
    const { paths } = await ctx.services.kicad.exportSchematicSvg(cli, {
      schematic,
      outDir,
      signal: ctx.signal,
    });
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
      const pngPath = p(
        project,
        PROJECT_FILES.renders,
        "schematic",
        `${revisionPrefix}-sheet-${index + 1}.png`,
      );
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
      { images: imagePaths.map((path) => ({ path, mime: "image/png", requiredInline: true })) },
    );
  },
});

export const render_pcb_svg = defineTool({
  name: "render_pcb_svg",
  toolset: "render",
  title: "Render PCB SVG",
  description: "Render board.kicad_pcb copper, silkscreen, and edge cuts to renders/pcb.svg.",
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
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
    return ok(
      `Rendered PCB to ${PROJECT_FILES.renders}/pcb.svg. Browser URL: ${url}`,
      { path: output, url, fileUrl: url },
      { images: [{ path: output, mime: "image/svg+xml" }] },
    );
  },
});

export const render_glb = defineTool({
  name: "render_glb",
  toolset: "render",
  title: "Export 3D GLB",
  description:
    "Export a 3D model (GLB) of the KiCad board to renders/board.glb for the app's 3D tab. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
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
    return ok(
      `Exported ${PROJECT_FILES.renders}/board.glb${res.fused ? " (fused shapes)" : ""}. Browser URL: ${url}${res.warnings.length ? `\nWarnings:\n${res.warnings.map((w) => `- ${w}`).join("\n")}` : ""}`,
      { path: output, url, fileUrl: url, ...res },
    );
  },
});

const ViewRegion = z.object({
  minX: z.number().finite(),
  minY: z.number().finite(),
  maxX: z.number().finite(),
  maxY: z.number().finite(),
});

export const render_view = defineTool({
  name: "render_view",
  toolset: "render",
  title: "Render a focused design view",
  description:
    "Render the saved schematic or an auto-fitted/cropped PCB view. PCB views can highlight component references and nets and return inline PNG pixels bound to the source revision.",
  inputSchema: {
    document: z.enum(["schematic", "pcb"]).default("pcb"),
    region: ViewRegion.optional().describe(
      "PCB crop rectangle in millimetres; omitted auto-fits the board",
    ),
    layers: z
      .array(z.string().min(1))
      .min(1)
      .max(32)
      .optional()
      .describe("KiCad layers; defaults to copper, silkscreen, and Edge.Cuts"),
    highlightReferences: z.array(z.string().min(1)).max(100).optional(),
    highlightNets: z.array(z.string().min(1)).max(100).optional(),
    maxWidth: z.number().int().min(320).max(4096).default(1600),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async (
    { document, region, layers, highlightReferences, highlightNets, maxWidth },
    ctx,
  ) => {
    if (document === "schematic") {
      if (region || layers?.length || highlightReferences?.length || highlightNets?.length)
        throw new ToolError(
          "schematic crop/layers/highlight is not available yet; render the complete schematic",
          "invalid_args",
        );
      return render_schematic_svg.handler({ maxWidth }, ctx);
    }
    if (region && (region.maxX <= region.minX || region.maxY <= region.minY))
      throw new ToolError(
        "region max coordinates must be greater than min coordinates",
        "invalid_args",
      );
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const before = await fileRevision(board);
    await ensureDir(p(project, PROJECT_FILES.renders));
    const rawPath = p(project, PROJECT_FILES.renders, "pcb-view-source.svg");
    ctx.progress(0.2, "exporting svg");
    await ctx.services.kicad.exportPcbSvg(cli, {
      board,
      output: rawPath,
      ...(layers ? { layers } : {}),
      signal: ctx.signal,
    });
    const [boardGeometry, footprintGeometry, components, pads, tracks, vias] = await Promise.all([
      ctx.services.design.query(project.dir, "board_geometry"),
      ctx.services.design.query(project.dir, "footprint_geometry"),
      ctx.services.design.query(project.dir, "components"),
      ctx.services.design.query(project.dir, "pads"),
      ctx.services.design.query(project.dir, "tracks"),
      ctx.services.design.query(project.dir, "vias"),
    ]);
    const autoPoints = [...boardGeometry, ...footprintGeometry, ...components, ...pads].flatMap(
      rowPoints,
    );
    const fitted = region ?? boundsWithMargin(autoPoints, 2);
    let svg = await readFile(rawPath, "utf8");
    if (fitted) {
      const width = fitted.maxX - fitted.minX,
        height = fitted.maxY - fitted.minY;
      svg = svg
        .replace(/width="[^"]+"\s+height="[^"]+"/, `width="${width}mm" height="${height}mm"`)
        .replace(/viewBox="[^"]+"/, `viewBox="${fitted.minX} ${fitted.minY} ${width} ${height}"`);
    }
    const refs = new Set((highlightReferences ?? []).map((value) => value.toLowerCase()));
    const nets = new Set((highlightNets ?? []).map((value) => value.toLowerCase()));
    const overlayRows = [
      ...components.filter((row) =>
        refs.has(String(row["ref"] ?? row["reference"] ?? "").toLowerCase()),
      ),
      ...pads.filter(
        (row) =>
          refs.has(String(row["component"] ?? "").toLowerCase()) ||
          nets.has(String(row["net"] ?? "").toLowerCase()),
      ),
      ...tracks.filter((row) => nets.has(String(row["net"] ?? "").toLowerCase())),
      ...vias.filter((row) => nets.has(String(row["net"] ?? "").toLowerCase())),
    ];
    const overlay = overlayRows.map(highlightShape).filter(Boolean).join("\n");
    if (overlay)
      svg = svg.replace(
        "</svg>",
        `<g id="fabdesk-highlights" fill="none" stroke="#00e5ff" stroke-width="0.45" stroke-opacity="0.95">\n${overlay}\n</g>\n</svg>`,
      );
    const svgPath = p(project, PROJECT_FILES.renders, "pcb-view.svg");
    const pngPath = p(project, PROJECT_FILES.renders, "pcb-view.png");
    await Bun.write(svgPath, svg);
    const raster = await ctx.services.kicad.rasterizeSvg(Buffer.from(svg), { maxWidth });
    await Bun.write(pngPath, raster.png);
    const after = await fileRevision(board);
    if (after.sha256 !== before.sha256) {
      await Promise.all([svgPath, pngPath].map((path) => rm(path, { force: true })));
      throw new ToolError("PCB changed during rendering", "precondition");
    }
    ctx.progress(1, "done");
    return ok(
      `Rendered focused PCB view at revision ${before.sha256}.`,
      {
        path: svgPath,
        pngPath,
        width: raster.width,
        height: raster.height,
        region: fitted,
        layers: layers ?? null,
        highlighted: overlayRows.length,
        pcbRevision: before,
      },
      { images: [{ path: pngPath, mime: "image/png", requiredInline: true }] },
    );
  },
});

function boundsWithMargin(
  points: Array<{ x: number; y: number }>,
  margin: number,
): z.infer<typeof ViewRegion> | undefined {
  if (!points.length) return undefined;
  return {
    minX: Math.min(...points.map((point) => point.x)) - margin,
    minY: Math.min(...points.map((point) => point.y)) - margin,
    maxX: Math.max(...points.map((point) => point.x)) + margin,
    maxY: Math.max(...points.map((point) => point.y)) + margin,
  };
}

function highlightShape(row: Record<string, unknown>): string {
  const points = rowPoints(row);
  if (!points.length) return "";
  if (points.length >= 2) {
    const [start, end] = points;
    return `<line x1="${start!.x}" y1="${start!.y}" x2="${end!.x}" y2="${end!.y}" />`;
  }
  const point = points[0]!;
  const radius = Math.max(0.8, Number(row["diameter"] ?? row["width"] ?? 1) / 2 + 0.5);
  return `<circle cx="${point.x}" cy="${point.y}" r="${radius}" />`;
}

export const renderTools = [render_schematic_svg, render_pcb_svg, render_view, render_glb];
