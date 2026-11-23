import { z } from "zod/v4";
import { AssemblyRelativePath, BoardSourceSelection } from "./assembly";

export const ProjectDependencySnapshot = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({ path: AssemblyRelativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()).max(4096),
  unresolved: z.array(z.string()).max(4096),
  external: z.array(z.object({ declared: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict()).max(4096).optional(),
}).strict();
export type ProjectDependencySnapshot = z.infer<typeof ProjectDependencySnapshot>;

/** Records the bytes used for a PCB SVG preview; it is not an electrical compatibility check. */
export const PcbPreviewRevision = z.object({
  contract: z.literal("fabplane.pcb-preview-revision.v1"),
  source: z.literal("board.kicad_pcb"),
  artifact: z.literal("renders/pcb.svg"),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  generatedAt: z.string().datetime(),
  dependencySnapshot: ProjectDependencySnapshot.optional(),
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
  dependencySnapshot: ProjectDependencySnapshot.optional(),
  dependencies: z.literal("unverified"),
  /** Recorded import directory used for KIPRJMOD; does not establish model coverage or freshness. */
  modelProjectDirectory: AssemblyRelativePath.optional(),
  pendingModels: z.number().int().positive().optional(),
  warnings: z.array(z.string()).optional(),
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
const SchematicPreviewContent = z.object({
  contract: z.literal("fabplane.schematic-preview-revision.v1"),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
  sourceFiles: z.array(SchematicSourceFile).min(1).max(257),
  sheets: z.array(z.object({ path: z.string().min(1), name: z.string().min(1).max(512), sha256: z.string().regex(/^[a-f0-9]{64}$/), nativeSheet: z.object({ identity: z.string().min(1).max(1024), hierarchyPath: z.string().min(1).max(1024), nativePath: AssemblyRelativePath.refine(path => path.endsWith(".kicad_sch")), pageNumber: z.number().int().positive() }).strict().optional() }).strict()).min(1).max(256),
  generatedAt: z.string().datetime(),
  dependencySnapshot: ProjectDependencySnapshot.optional(),
  dependencies: z.literal("unverified"),
}).strict();
const checkSchematicPreview = (value: z.infer<typeof SchematicPreviewContent>, ctx: z.RefinementCtx) => {
  const portable = (path: string) => !path.startsWith("/") && !path.includes("\\") && !path.includes(":") && !path.includes("\0") && path.split("/").every(part => part && part !== "." && part !== "..");
  const seen = new Set<string>();
  for (const [index, file] of value.sourceFiles.entries()) {
    if (!portable(file.path) || !/\.kicad_(sch|pro)$/.test(file.path) || seen.has(file.path)) ctx.addIssue({ code: "custom", path: ["sourceFiles", index, "path"], message: "Use distinct native source paths within the declared board directory" });
    seen.add(file.path);
  }
  if (!seen.has("board.kicad_sch")) ctx.addIssue({ code: "custom", path: ["sourceFiles"], message: "The native root schematic is required" });
  const sources = new Set(seen), identities = new Set<string>(), pages = new Set<number>();
  seen.clear();
  for (const [index, sheet] of value.sheets.entries()) {
    if (!portable(sheet.path) || !sheet.path.startsWith("renders/schematic/") || !sheet.path.endsWith(".svg") || seen.has(sheet.path)) ctx.addIssue({ code: "custom", path: ["sheets", index, "path"], message: "Use distinct versioned schematic SVG paths" });
    seen.add(sheet.path);
    if (sheet.nativeSheet) {
      if (!sources.has(sheet.nativeSheet.nativePath) || identities.has(sheet.nativeSheet.identity) || pages.has(sheet.nativeSheet.pageNumber)) ctx.addIssue({ code: "custom", path: ["sheets", index, "nativeSheet"], message: "Every circuit page needs one distinct native sheet instance from the captured sources" });
      identities.add(sheet.nativeSheet.identity); pages.add(sheet.nativeSheet.pageNumber);
    }
  }
};
export const AssemblySchematicPreviewRevision = SchematicPreviewContent.extend({ boardSource: BoardSourceSelection.extend({ projectId: z.string().min(1) }).strict() }).superRefine(checkSchematicPreview);
export const RootSchematicPreviewRevision = SchematicPreviewContent.extend({ projectId: z.string().min(1) }).superRefine(checkSchematicPreview).refine(value => value.sheets.every(sheet => !!sheet.nativeSheet), "Working circuit sheets require captured native identities");
export type RootSchematicPreviewRevision = z.infer<typeof RootSchematicPreviewRevision>;
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
