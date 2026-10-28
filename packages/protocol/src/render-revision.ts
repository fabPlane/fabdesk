import { z } from "zod/v4";
import { BoardSourceSelection } from "./assembly";

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
