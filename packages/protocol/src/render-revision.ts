import { z } from "zod/v4";

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
