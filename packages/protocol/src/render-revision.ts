import { z } from "zod/v4";
import { AssemblyRelativePath, BoardSourceSelection } from "./assembly";

/** Records the bytes used for a PCB SVG preview; it is not an electrical compatibility check. */
export const PcbPreviewRevision = z.object({
  contract: z.literal("fabplane.pcb-preview-revision.v1"),
  source: z.literal("board.kicad_pcb"),
  artifact: z.literal("renders/pcb.svg"),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime(),
});
export type PcbPreviewRevision = z.infer<typeof PcbPreviewRevision>;
export const PCB_PREVIEW_REVISION_PATH = "renders/pcb.svg.revision.json";

export const PCB_SVG_COORDINATE_SYSTEM = "kicad-pcb-mm-v1";

/** Existing saved DRC reports record the checked PCB bytes, independently of findings. */
export const PcbCheckSourceReceipt = z.object({
  pcbRevision: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative() }),
});


/** A member report belongs to one captured declaration and saved PCB, never an implicit root board. */
export const AssemblyPcbCheckReceipt = PcbCheckSourceReceipt.extend({
  boardSource: BoardSourceSelection.extend({ projectId: z.string().min(1) }).strict(),
});
export type AssemblyPcbCheckReceipt = z.infer<typeof AssemblyPcbCheckReceipt>;


/** GLB source identity checked before/after live export; external model dependencies are unverified. */
export const BoardModelRevision = z.object({
  contract: z.literal("fabplane.board-model-revision.v1"),
  source: z.literal("board.kicad_pcb"),
  artifact: z.literal("renders/board.glb"),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime(),
  dependencies: z.literal("unverified"),
});
export type BoardModelRevision = z.infer<typeof BoardModelRevision>;
export const BOARD_MODEL_REVISION_PATH = "renders/board.glb.revision.json";

/** A model exported from one captured assembly source, never an inferred project-root board. */
export const AssemblyBoardModelRevision = BoardModelRevision.extend({
  boardSource: BoardSourceSelection.extend({ projectId: z.string().min(1) }).strict(),
  warnings: z.array(z.string()).default([]),
});
export type AssemblyBoardModelRevision = z.infer<typeof AssemblyBoardModelRevision>;

/** Member schematic preview pointer. Versioned SVGs are immutable; publication replaces only this receipt. */
export const SCHEMATIC_PREVIEW_REVISION_PATH = "renders/schematic.revision.json";
const SchematicSourceFile = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const AssemblySchematicPreviewRevision = z.object({
  contract: z.literal("fabplane.schematic-preview-revision.v1"),
  boardSource: BoardSourceSelection.extend({ projectId: z.string().min(1) }).strict(),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFiles: z.array(SchematicSourceFile).min(1).max(257),
  sheets: z.array(z.object({ path: z.string().min(1), name: z.string().min(1).max(512), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(256),
  generatedAt: z.string().datetime(),
  dependencies: z.literal("unverified"),
}).strict().superRefine((value, ctx) => {
  const portable = (path: string) => !path.startsWith("/") && !path.includes("\\") && !path.includes(":") && !path.includes("\0") && path.split("/").every(part => part && part !== "." && part !== "..");
  const seen = new Set<string>();
  for (const [index, file] of value.sourceFiles.entries()) {
    if (!portable(file.path) || !/\.kicad_(sch|pro)$/.test(file.path) || seen.has(file.path)) ctx.addIssue({ code: "custom", path: ["sourceFiles", index, "path"], message: "Use distinct native source paths within the declared board directory" });
    seen.add(file.path);
  }
  if (!seen.has("board.kicad_sch")) ctx.addIssue({ code: "custom", path: ["sourceFiles"], message: "The native root schematic is required" });
  seen.clear();
  for (const [index, sheet] of value.sheets.entries()) {
    if (!portable(sheet.path) || !sheet.path.startsWith("renders/schematic/") || !sheet.path.endsWith(".svg") || seen.has(sheet.path)) ctx.addIssue({ code: "custom", path: ["sheets", index, "path"], message: "Use distinct versioned schematic SVG paths" });
    seen.add(sheet.path);
  }
});
export type AssemblySchematicPreviewRevision = z.infer<typeof AssemblySchematicPreviewRevision>;

/** Recorded mesh bytes consumed by the video renderer. Does not establish PCB/model parity or caption freshness. */
const VideoInput = z.object({ path: AssemblyRelativePath.refine(path => /\.(?:glb|stl|obj)$/i.test(path)), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const VideoOutput = z.object({ path: z.enum(["exports/product-video.mp4", "exports/product-video.webm", "exports/product-video.gif"]), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const ProductVideoInputRevision = z.object({
  contract: z.literal("fabplane.video-input-revision.v1"),
  inputs: z.array(VideoInput).min(1).max(256),
  outputs: z.array(VideoOutput).min(1).max(3),
}).strict().refine(value => new Set(value.inputs.map(row => row.path)).size === value.inputs.length && new Set(value.outputs.map(row => row.path)).size === value.outputs.length, "Revision paths must be distinct");
export const PRODUCT_VIDEO_MANIFEST_PATH = "exports/product-video.json";
