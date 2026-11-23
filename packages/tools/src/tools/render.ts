import { nativeViewRevision, assertNativeViewRevision, recordNativeView } from "../native-view";
import { renderRootCircuitPreview } from "../schematic-circuit-preview";
import { expectedPcbSource } from "../pcb-output";
import { renderMemberSchematicPreview } from "../member-schematic-preview";
/** Render toolset: schematic/PCB images, GLB, and product videos. */
import { createHash } from "node:crypto";
import { AssemblyBoardModelRevision, BoardModelRevision, BOARD_MODEL_REVISION_PATH, PCB_PREVIEW_REVISION_PATH } from "@fabdesk/protocol";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { z } from "zod/v4";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  extractSpecs,
  renderProductVideo,
  VIDEO_ASPECTS,
  VIDEO_BACKGROUNDS,
  VIDEO_FORMATS,
  VIDEO_PRESETS,
  VIDEO_RESOLUTIONS,
} from "@fabdesk/product-video";
import { PROJECT_FILES, ensureDir, exists, jailPath, writeAtomic, writeJson } from "../fs";
import { ToolError, defineTool } from "../registry";
import { fileUrl, loadNetlist, ok, p, requireBoard, requireKicad, requireSchematic } from "./common";
import { pcbPreviewFileHash, recordPcbPreviewRevision } from "../pcb-preview-revision";
import { rowPoints } from "./spatial";
import { pcbModelReadiness, renderPcbDisplay } from "./pcb-display";

export const render_pcb_readiness = defineTool({
  name: "render_pcb_readiness",
  assemblyWide: true,
  toolset: "render",
  title: "Check PCB model setup",
  description:
    "Check the selected boards' saving versions against the local KiCad exporter and suggest an installed compatible version. Does not edit files or settings; export remains the final compatibility check.",
  inputSchema: { boardPaths: z.array(z.string()).min(1).max(64) },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: ({ boardPaths }, ctx) => pcbModelReadiness(ctx, boardPaths),
});

/** Display caches are project-owned and never replace a canonical/member model receipt. */
export const render_pcb_display = defineTool({
  name: "render_pcb_display",
  toolset: "render",
  assemblyWide: true,
  title: "Display a selected PCB model",
  description: "Create an isolated display model for an explicit project-relative PCB path and captured PCB revision. Does not infer assembly membership, replace the saved board model, edit sources, or verify physical fit.",
  inputSchema: {
    boardPath: z.string().min(1),
    expectedPcbRevision: z.string().regex(/^[a-f0-9]{64}$/),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  longRunning: true,
  handler: ({ boardPath, expectedPcbRevision }, ctx) => renderPcbDisplay(ctx, boardPath, expectedPcbRevision),
});

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
  boardScoped: true,
  toolset: "render",
  title: "Render schematic",
  description:
    "Export schematic SVG previews. Single-board projects also receive PNG pixels. Assembly members require expectedHierarchyRevision from schematic_inspect and publish all captured sheets with a source-qualified receipt; maxWidth only affects single-board PNGs.",
  inputSchema: {
    expectedHierarchyRevision: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Required for an assembly member: aggregate revision from its saved schematic inspection"),
    circuit: z.boolean().default(false).describe("Working circuit view: omit paper framing and fit actual circuit geometry, preserving native sources and document exports."),
    maxWidth: z.number().int().min(320).max(4096).default(1600),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async ({ maxWidth, expectedHierarchyRevision, circuit }, ctx) => {
    if (ctx.board) return renderMemberSchematicPreview(ctx, expectedHierarchyRevision, circuit);
    if (circuit) return renderRootCircuitPreview(ctx, maxWidth, expectedHierarchyRevision);
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const schematic = await requireSchematic(project);
    const nativeRevision = await nativeViewRevision();
    const before = await fileRevision(schematic);
    const outDir = await ensureDir(p(project, PROJECT_FILES.renders, "schematic"));
    ctx.progress(0.2, "exporting svg");
    const { paths } = await ctx.services.kicad.exportSchematicSvg(cli, {
      schematic,
      outDir,
      signal: ctx.signal,
    });
    if (!paths.length) throw new ToolError("schematic export produced no sheets", "internal");
    const rootPage = basename(schematic).replace(/\.kicad_sch$/i, ".svg");
    paths.sort((a, b) => Number(basename(b) === rootPage) - Number(basename(a) === rootPage));
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
    await assertNativeViewRevision(nativeRevision);
    const firstSvg = paths[0]!;
    const output = p(project, PROJECT_FILES.renders, "schematic.svg");
    const pngOutput = p(project, PROJECT_FILES.renders, "schematic.png");
    await Bun.write(output, await readFile(firstSvg));
    await Bun.write(pngOutput, await readFile(imagePaths[0]!));
    await recordNativeView("schematic", output, nativeRevision);
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
  boardScoped: true,
  toolset: "render",
  title: "Render PCB SVG",
  description: "Render board.kicad_pcb copper, silkscreen, and edge cuts to renders/pcb.svg.",
  inputSchema: { expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Captured saved PCB hash; reject if a queued preview would render newer bytes") },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async ({ expectedSourceSha256 }, ctx) => {
    const project = ctx.requireProject();
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const output = await jailPath(project.dir, `${PROJECT_FILES.renders}/pcb.svg`);
    await jailPath(project.dir, PCB_PREVIEW_REVISION_PATH);
    ctx.progress(0.2, "exporting svg");
    const nativeRevision = await nativeViewRevision();
    const sourceBytes = await readFile(board);
    const sourceRevision = createHash("sha256").update(sourceBytes).digest("hex");
    if (expectedSourceSha256 && sourceRevision !== expectedSourceSha256) throw new ToolError("PCB changed before preview rendering. Review the latest source and try again.", "precondition");
    const scratch = await mkdtemp(join(tmpdir(), "fabplane-pcb-preview-"));
    try {
      // Render immutable input; a live edit cannot mix source revisions in one SVG.
      const snapshot = join(scratch, "board.kicad_pcb");
      const svg = join(scratch, "pcb.svg");
      await writeFile(snapshot, sourceBytes);
      await ctx.services.kicad.exportPcbSvg(cli, { board: snapshot, output: svg, signal: ctx.signal });
      if (await pcbPreviewFileHash(board) !== sourceRevision) {
        throw new ToolError("PCB changed while rendering. Review the saved board and render the preview again.", "precondition");
      }
      const artifactBytes = await readFile(svg);
      // A queued/exporting member must retain its original source ownership and output jail.
      await jailPath(project.dir, `${PROJECT_FILES.renders}/pcb.svg`);
      await jailPath(project.dir, PCB_PREVIEW_REVISION_PATH);
      await ctx.runInScope?.(async () => {});
      await assertNativeViewRevision(nativeRevision);
      await writeAtomic(output, artifactBytes);
      await recordNativeView("pcb", output, nativeRevision);
      await recordPcbPreviewRevision(project.dir, sourceRevision, createHash("sha256").update(artifactBytes).digest("hex"));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
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
  boardScoped: true,
  toolset: "render",
  title: "Export 3D GLB",
  description:
    "Export a 3D model (GLB) of the KiCad board to renders/board.glb for the app's 3D tab. Requires kicad-cli and board.kicad_pcb.",
  inputSchema: {
    expectedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Required for an assembly member: hash of its inspected saved PCB"),
    boardPath: z.string().optional(),
    expectedPcbRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async (args, ctx) => {
    const { expectedSourceSha256 } = args;
    if (args.boardPath || args.expectedPcbRevision) {
      if (!args.boardPath || !args.expectedPcbRevision)
        throw new ToolError("Provide both boardPath and expectedPcbRevision.", "invalid_args");
      return renderPcbDisplay(ctx, args.boardPath, args.expectedPcbRevision);
    }
    const project = ctx.requireProject();
    if (ctx.board && !expectedSourceSha256) throw new ToolError("Inspect the selected member PCB and provide expectedSourceSha256 before exporting its model.", "precondition");
    const cli = await requireKicad(ctx);
    const board = await requireBoard(project);
    const output = await jailPath(project.dir, `${PROJECT_FILES.renders}/board.glb`);
    const receiptPath = await jailPath(project.dir, BOARD_MODEL_REVISION_PATH);
    ctx.progress(0.2, "exporting glb");
    const nativeRevision = await nativeViewRevision();
    const sourceSha256 = await pcbPreviewFileHash(board);
    if (expectedSourceSha256 && sourceSha256 !== expectedSourceSha256) throw new ToolError("The saved PCB changed since inspection. Inspect the selected source again before exporting its model.", "precondition");
    // The editable PCB is copied to the root during import. Its project-relative
    // component models still belong to the explicitly selected repository directory.
    const imported = !ctx.board ? project.manifest().importedBoard : undefined;
    const modelProjectDir = imported ? dirname(await jailPath(project.dir, imported.path)) : project.dir;
    if (!(await stat(modelProjectDir).catch(() => null))?.isDirectory()) throw new ToolError("The imported board's component-model directory is missing. Restore that source folder before exporting the model.", "precondition");
    const modelProjectDirectory = relative(project.dir, modelProjectDir).split(sep).join("/");
    const scratch = await mkdtemp(join(tmpdir(), "fabplane-board-model-"));
    let res: { fused: boolean; warnings: string[] };
    try {
      // Keep the source in its real project so relative component models/project variables
      // resolve normally. Only publish a newly written export, after rechecking saved PCB bytes.
      const temporary = join(scratch, "board.glb");
      res = await ctx.services.kicad.exportGlb(cli, { board, output: temporary, ...(modelProjectDirectory ? { modelProjectDir } : {}), signal: ctx.signal });
      if (await pcbPreviewFileHash(board) !== sourceSha256)
        throw new ToolError("PCB changed while exporting the model. The previous model was kept; review the saved PCB and try again.", "precondition");
      const bytes = await readFile(temporary);
      const receipt = (ctx.board ? AssemblyBoardModelRevision : BoardModelRevision).parse({ contract: "fabplane.board-model-revision.v1", source: "board.kicad_pcb", artifact: "renders/board.glb", sourceSha256, artifactSha256: createHash("sha256").update(bytes).digest("hex"), generatedAt: new Date().toISOString(), dependencies: "unverified", warnings: res.warnings, ...(modelProjectDirectory ? { modelProjectDirectory } : {}), ...(ctx.board ? { boardSource: { projectId: project.id, ...ctx.board } } : {}) });
      await jailPath(project.dir, `${PROJECT_FILES.renders}/board.glb`);
      await jailPath(project.dir, BOARD_MODEL_REVISION_PATH);
      await ctx.runInScope?.(async () => {});
      ctx.signal.throwIfAborted();
      await assertNativeViewRevision(nativeRevision);
      await writeAtomic(output, bytes);
      await recordNativeView("3d", output, nativeRevision);
      await writeJson(receiptPath, receipt);
    } finally { await rm(scratch, { recursive: true, force: true }); }
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
      return render_schematic_svg.handler({ maxWidth, circuit: false }, ctx);
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

const activeMemberVideos = new Set<string>();

export const render_product_video = defineTool({
  name: "render_product_video",
  boardScoped: true,
  toolset: "render",
  title: "Make a product video",
  description:
    "Render a short product video of the project's 3D scene (board GLB plus enclosure/mechanical meshes when present) for design reviews, customer updates and launch pages. Presets: orbit, explode (exploded → assembled), flip (top/bottom), push_in, review (title + orbit + flip + assemble + specs). Writes exports/product-video.mp4 / .webm / .gif plus a poster PNG. MP4 and WebM need ffmpeg on PATH (or FABDESK_FFMPEG); GIF is always produced. If renders/board.glb is missing, exports it first when a board exists.",
  inputSchema: {
    expectedSourceSha256: expectedPcbSource,
    preset: z.enum(VIDEO_PRESETS).default("review"),
    durationSec: z.number().min(2).max(20).default(6),
    resolution: z.enum(VIDEO_RESOLUTIONS).default("720p"),
    aspect: z.enum(VIDEO_ASPECTS).default("landscape"),
    background: z.enum(VIDEO_BACKGROUNDS).default("light"),
    captions: z.boolean().default(true),
    formats: z.array(z.enum(VIDEO_FORMATS)).min(1).default(["mp4", "webm", "gif"]),
    fps: z.number().int().min(8).max(30).default(24),
    width: z.number().int().min(64).max(1920).optional().describe("Override frame width (CI / preview)"),
    height: z.number().int().min(64).max(1920).optional().describe("Override frame height (CI / preview)"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  longRunning: true,
  handler: async (args, ctx) => {
    const project = ctx.requireProject();
    if (ctx.board) {
      if (activeMemberVideos.has(project.dir)) throw new ToolError("A video export is already running for this source. Wait for it to finish.", "precondition");
      activeMemberVideos.add(project.dir);
      try {
      if (!args.expectedSourceSha256) throw new ToolError("Inspect the selected saved PCB before making a video.", "precondition");
      const board = await requireBoard(project), sourceHash = await pcbPreviewFileHash(board);
      if (sourceHash !== args.expectedSourceSha256) throw new ToolError("PCB changed before video generation. Recheck this source.", "precondition");
      const modelPath = await jailPath(project.dir, "renders/board.glb"), receiptPath = await jailPath(project.dir, BOARD_MODEL_REVISION_PATH);
      let receipt: unknown; try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); } catch { receipt = null; }
      const parsed = AssemblyBoardModelRevision.safeParse(receipt);
      const current = parsed.success && parsed.data.boardSource.projectId === project.id && parsed.data.boardSource.sourceId === ctx.board.sourceId && parsed.data.boardSource.manifestSha256 === ctx.board.manifestSha256 && parsed.data.sourceSha256 === sourceHash && await exists(modelPath) && await pcbPreviewFileHash(modelPath) === parsed.data.artifactSha256;
      if (!current) await render_glb.handler({ expectedSourceSha256: sourceHash }, { ...ctx, progress: (fraction, note) => ctx.progress(fraction * .1, note) });
      const model = await readFile(modelPath), modelHash = createHash("sha256").update(model).digest("hex");
      const scratch = await mkdtemp(join(tmpdir(), "fabplane-member-video-"));
      try {
        // A board video contains this source's board only; unrelated meshes and parent metadata are not inferred.
        await ensureDir(join(scratch, "renders")); await writeFile(join(scratch, "renders/board.glb"), model);
        const { width, height, ...options } = args;
        const result = await renderProductVideo({ ...options, ...(width ? { width } : {}), ...(height ? { height } : {}), projectDir: scratch, outputDir: join(scratch, "exports"), specs: extractSpecs({ name: project.name }), signal: ctx.signal, progress: (fraction, note) => ctx.progress(.1 + fraction * .85, note) });
        const paths = [...Object.values(result.files).filter((path): path is string => !!path), result.poster, result.manifest];
        const recorded = JSON.parse(await readFile(result.manifest, "utf8")) as Record<string, unknown>;
        recorded.boardSource = { projectId: project.id, ...ctx.board };
        await writeFile(result.manifest, JSON.stringify(recorded, null, 2) + "\n");
        const publications = await Promise.all(paths.map(async path => ({ target: await jailPath(project.dir, path.slice(scratch.length + 1)), data: path === result.manifest ? Buffer.from((await readFile(path, "utf8")).replaceAll(scratch, project.dir)) : await readFile(path) })));
        const publish = async () => {
          ctx.signal.throwIfAborted();
          if (await pcbPreviewFileHash(board) !== sourceHash || await pcbPreviewFileHash(modelPath) !== modelHash) throw new ToolError("PCB or model changed while rendering. Previous videos were kept; review inputs and try again.", "precondition");
          for (const file of publications) await jailPath(project.dir, file.target);
          for (const file of publications) await writeAtomic(file.target, file.data);
        };
        await ctx.runInScope!(publish);
        const files = Object.fromEntries(Object.entries(result.files).map(([format, path]) => [format, path?.replace(scratch, project.dir)])), poster = result.poster.replace(scratch, project.dir);
        return ok(`Saved a ${args.preset} video of this board (${result.width}×${result.height}, ${result.frameCount} frames). Component-model dependencies and captions remain unverified.${result.skipped.length ? ` Skipped: ${result.skipped.map(item => `${item.format} (${item.reason})`).join("; ")}` : ""}`, { ...result, files, poster, manifest: result.manifest.replace(scratch, project.dir), url: fileUrl(files.mp4 ?? files.gif ?? poster) }, { images: [{ path: poster, mime: "image/png" }] });
      } finally { await rm(scratch, { recursive: true, force: true }); }
      } finally { activeMemberVideos.delete(project.dir); }
    }
    const boardGlb = p(project, PROJECT_FILES.renders, "board.glb");
    const board = p(project, PROJECT_FILES.boardPcb);
    if (await exists(board)) {
      // Reuse the guarded exporter and its source receipt. File timestamps cannot establish
      // whether an imported/restored PCB matches a saved model.
      let receipt: unknown;
      try {
        const text = await readFile(p(project, BOARD_MODEL_REVISION_PATH), "utf8");
        try { receipt = JSON.parse(text); } catch { receipt = null; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parsed = BoardModelRevision.safeParse(receipt);
      const current = parsed.success && await exists(boardGlb)
        && await pcbPreviewFileHash(board) === parsed.data.sourceSha256
        && await pcbPreviewFileHash(boardGlb) === parsed.data.artifactSha256;
      if (!current) {
        await render_glb.handler({}, { ...ctx, progress: (fraction, note) => ctx.progress(fraction * .1, note) });
      }
    }
    const manifest = project.manifest();
    let components: Array<{ ref: string; value: string; footprint?: string }> = [];
    try {
      const netlist = await loadNetlist(project);
      components = netlist.netlist.components.map((c) => ({
        ref: c.ref,
        value: c.value,
        ...(c.footprint ? { footprint: c.footprint } : {}),
      }));
    } catch {
      /* captions still work from the manifest */
    }
    const specs = extractSpecs({
      name: manifest.name,
      board: {
        layers: manifest.board.layers,
        ...(manifest.board.widthMm !== undefined ? { widthMm: manifest.board.widthMm } : {}),
        ...(manifest.board.heightMm !== undefined ? { heightMm: manifest.board.heightMm } : {}),
      },
      components,
    });
    const outputDir = await ensureDir(p(project, PROJECT_FILES.exports));
    ctx.progress(0.1, "rendering frames");
    let result;
    try {
      result = await renderProductVideo({
        projectDir: project.dir,
        outputDir,
        preset: args.preset,
        durationSec: args.durationSec,
        fps: args.fps,
        resolution: args.resolution,
        aspect: args.aspect,
        background: args.background,
        captions: args.captions,
        formats: args.formats,
        specs,
        ...(args.width ? { width: args.width } : {}),
        ...(args.height ? { height: args.height } : {}),
        signal: ctx.signal,
        progress: (fraction, note) => ctx.progress(0.1 + fraction * 0.9, note),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message === "cancelled") throw new ToolError("cancelled", "cancelled");
      throw new ToolError(message, "precondition");
    }
    const files = Object.values(result.files).filter((path): path is string => Boolean(path));
    const urls = files.map(fileUrl);
    const skipNote = result.skipped.length
      ? `\nSkipped: ${result.skipped.map((s) => `${s.format} (${s.reason})`).join("; ")}`
      : "";
    const posterUrl = fileUrl(result.poster);
    return ok(
      `Wrote product video (${args.preset}, ${result.width}×${result.height}, ${result.frameCount} frames) to ${files.map((f) => f.slice(project.dir.length + 1)).join(", ") || "exports/"}.${skipNote}`,
      {
        ...result,
        url: result.files.mp4 ? fileUrl(result.files.mp4) : result.files.gif ? fileUrl(result.files.gif) : posterUrl,
        fileUrl: result.files.mp4 ? fileUrl(result.files.mp4) : result.files.gif ? fileUrl(result.files.gif) : posterUrl,
        urls,
      },
      {
        images: [
          { path: result.poster, mime: "image/png", requiredInline: true },
          ...(result.files.gif ? [{ path: result.files.gif, mime: "image/gif" }] : []),
        ],
      },
    );
  },
});

export const renderTools = [
  render_pcb_readiness,
  render_pcb_display,
  render_schematic_svg,
  render_pcb_svg,
  render_view,
  render_glb,
  render_product_video,
];
