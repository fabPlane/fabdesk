import { z } from "zod/v4";
import { AssemblyRelativePath, BoardSourceSelection } from "./assembly";

/** Recorded exporter inputs only. This never establishes electrical checks or external dependency freshness. */
export const OutputRevision = z.object({
  contract: z.literal("fabplane.output-revision.v1"),
  projectId: z.string().min(1),
  board: BoardSourceSelection.optional(),
  artifact: AssemblyRelativePath,
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  basis: z.enum(["pcb", "schematic", "saved-files"]),
  inputs: z.array(z.object({ path: AssemblyRelativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(1024),
  generatedAt: z.string().datetime(),
  dependencies: z.literal("unverified"),
}).strict().superRefine((value, ctx) => {
  if (!/^(renders|exports)\//.test(value.artifact)) ctx.addIssue({ code: "custom", path: ["artifact"], message: "Use a saved output path" });
  if (value.basis === "pcb" && (value.inputs.length !== 1 || value.inputs[0]?.path !== "board.kicad_pcb")) ctx.addIssue({ code: "custom", path: ["inputs"], message: "PCB exports require the captured native PCB" });
  if (value.basis === "schematic" && (!value.inputs.some(input => input.path === "board.kicad_sch") || value.inputs.some(input => !/\.(kicad_sch|kicad_pro)$/i.test(input.path)))) ctx.addIssue({ code: "custom", path: ["inputs"], message: "Schematic exports require the captured root and native hierarchy inputs" });
  if (value.basis === "saved-files" && value.inputs.some(input => !input.path.startsWith("exports/") || input.path === value.artifact || input.path.endsWith(".revision.json"))) ctx.addIssue({ code: "custom", path: ["inputs"], message: "Packaging records the saved manufacturing inputs" });
  if (new Set(value.inputs.map(input => input.path)).size !== value.inputs.length) ctx.addIssue({ code: "custom", path: ["inputs"], message: "Use distinct input files" });
});
export type OutputRevision = z.infer<typeof OutputRevision>;
