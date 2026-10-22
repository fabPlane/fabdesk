/** Deterministic picture → silkscreen / Gerber. No model, no kicad-cli. */
import { readFile, readdir } from "node:fs/promises";
import { z } from "zod/v4";
import {
  ART_LAYERS,
  ART_STYLES,
  BOARD_COLORS,
  DEFAULT_HEIGHT_MM,
  DEFAULT_WIDTH_MM,
  OUTLINE_KINDS,
  buildBoardArt,
  decodeGray,
  type ArtLayer,
  type ArtOptions,
} from "@fabdesk/board-art";
import { PROJECT_FILES, ensureDir, jailPath, writeAtomic, writeJson } from "../fs";
import { ToolError, defineTool } from "../registry";
import { ok, p } from "./common";

const Layer = z.enum(ART_LAYERS);

export const silk_art = defineTool({
  name: "silk_art",
  toolset: "export",
  title: "Picture to silkscreen",
  description:
    "Turn a PNG, JPEG, WebP or GIF (photo, drawing or logo) into manufacturing-ready Gerbers with the picture printed on a real board. Styles: realistic = halftone dots, retro = line hatch, poster = one-cut threshold. Previewing is free and uses no AI credit. Writes board.kicad_pcb, exports/gerbers/, exports/fabrication.zip and renders/board-art.svg. Typical fab silkscreen floor is 0.15 mm. Does not need kicad-cli.",
  inputSchema: {
    image: z
      .string()
      .min(1)
      .optional()
      .describe("Project-relative image path. Defaults to the first file in sketches/."),
    placement: z
      .object({
        centerXmm: z.number().finite(),
        centerYmm: z.number().finite(),
        widthMm: z.number().positive().max(800),
        heightMm: z.number().positive().max(800),
        rotationDeg: z.number().finite(),
      })
      .optional()
      .describe(
        "Artwork centre X/Y and dimensions in millimetres, clockwise rotation in degrees. Defaults to centred fit.",
      ),
    style: z.enum(ART_STYLES).default("realistic"),
    widthMm: z.number().positive().max(400).default(DEFAULT_WIDTH_MM),
    heightMm: z.number().positive().max(400).default(DEFAULT_HEIGHT_MM),
    color: z.enum(BOARD_COLORS).default("green"),
    outline: z.enum(OUTLINE_KINDS).default("rectangle"),
    invert: z.boolean().default(false),
    minFeatureMm: z.number().min(0.15).max(2).default(0.2),
    pitchMm: z.number().positive().max(5).optional(),
    threshold: z.number().min(0).max(1).default(0.5),
    layers: z.array(Layer).min(1).default(["silk"]),
    fillCopper: z.boolean().default(true),
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
    ctx.progress(0.1, "loading image");
    const imageRel = await resolveImageRel(project.dir, args.image);
    const imagePath = await jailPath(project.dir, imageRel);
    const bytes = new Uint8Array(await readFile(imagePath));
    let gray;
    try {
      gray = await decodeGray(bytes);
    } catch (e) {
      throw new ToolError(e instanceof Error ? e.message : String(e), "invalid_args");
    }
    ctx.progress(0.4, "converting");
    const options: ArtOptions = {
      ...(args.placement ? { placement: args.placement } : {}),
      style: args.style,
      widthMm: args.widthMm,
      heightMm: args.heightMm,
      color: args.color,
      outline: args.outline,
      invert: args.invert,
      minFeatureMm: args.minFeatureMm,
      threshold: args.threshold,
      layers: args.layers as ArtLayer[],
      fillCopper: args.fillCopper,
      ...(args.pitchMm !== undefined ? { pitchMm: args.pitchMm } : {}),
    };
    const job = buildBoardArt(gray, options);
    ctx.progress(0.7, "writing board and gerbers");
    await writeAtomic(p(project, PROJECT_FILES.boardPcb), job.kicadPcb);
    await writeAtomic(p(project, PROJECT_FILES.boardPro), job.kicadPro);
    const gerberDir = await ensureDir(p(project, PROJECT_FILES.exports, "gerbers"));
    const gerberRel: string[] = [];
    for (const file of job.gerbers) {
      const abs = `${gerberDir}/${file.name}`;
      await writeAtomic(abs, file.body);
      gerberRel.push(`${PROJECT_FILES.exports}/gerbers/${file.name}`);
    }
    const zipPath = p(project, PROJECT_FILES.exports, "fabrication.zip");
    await writeAtomic(zipPath, job.zip);
    const previewPath = p(project, PROJECT_FILES.renders, "board-art.svg");
    await writeAtomic(previewPath, job.previewSvg);
    await writeJson(p(project, PROJECT_FILES.reports, "board-art.json"), {
      style: job.options.style,
      widthMm: job.options.widthMm,
      heightMm: job.options.heightMm,
      color: job.options.color,
      outline: job.options.outline,
      layers: job.options.layers,
      placement: job.options.placement,
      primitives: job.stats.primitives,
      minFeatureMm: job.stats.minFeatureMm,
      pitchMm: job.stats.pitchMm,
      image: imageRel,
    });
    await project.updateManifest({
      board: {
        ...project.manifest().board,
        widthMm: job.options.widthMm,
        heightMm: job.options.heightMm,
      },
    });
    ctx.progress(1, "done");
    const text = [
      `Board art (${job.options.style}) ${job.options.widthMm}×${job.options.heightMm} mm, ${job.options.color} ${job.options.outline}.`,
      `${job.stats.primitives} primitives, min feature ${job.stats.minFeatureMm} mm.`,
      `Wrote board.kicad_pcb, ${gerberRel.length} gerbers, exports/fabrication.zip (${job.stats.zipBytes} bytes).`,
      "No AI credit spent.",
    ].join("\n");
    return ok(
      text,
      {
        style: job.options.style,
        widthMm: job.options.widthMm,
        heightMm: job.options.heightMm,
        color: job.options.color,
        outline: job.options.outline,
        layers: [...job.options.layers],
        placement: job.options.placement,
        primitives: job.stats.primitives,
        minFeatureMm: job.stats.minFeatureMm,
        pitchMm: job.stats.pitchMm,
        zipBytes: job.stats.zipBytes,
        files: {
          board: PROJECT_FILES.boardPcb,
          zip: `${PROJECT_FILES.exports}/fabrication.zip`,
          preview: `${PROJECT_FILES.renders}/board-art.svg`,
          gerbers: gerberRel,
        },
      },
      { images: [{ path: previewPath, mime: "image/svg+xml" }] },
    );
  },
});

async function resolveImageRel(projectDir: string, image: string | undefined): Promise<string> {
  if (image) return image.replace(/^\//, "");
  const names = (await readdir(`${projectDir}/${PROJECT_FILES.sketches}`).catch(() => [])).filter(
    (f) => /\.(png|jpe?g|webp|gif)$/i.test(f),
  );
  const first = names.sort()[0];
  if (!first)
    throw new ToolError(
      "no image: pass image= or add a PNG/JPEG/WebP/GIF under sketches/",
      "precondition",
    );
  return `${PROJECT_FILES.sketches}/${first}`;
}
