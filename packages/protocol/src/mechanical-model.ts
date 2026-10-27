import { z } from "zod/v4";

export const MechanicalModelFormat = z.enum(["stl", "glb", "obj", "step", "stp"]);
export type MechanicalModelFormat = z.infer<typeof MechanicalModelFormat>;
export const MechanicalModelUnits = z.enum(["mm", "cm", "m", "in", "file"]);
export type MechanicalModelUnits = z.infer<typeof MechanicalModelUnits>;
export const ImportedMechanicalModel = z.object({
  contract: z.literal("fabplane.imported-mechanical-model.v1"),
  id: z.string().uuid(),
  originalName: z.string().min(1).max(255),
  path: z.string().regex(/^mechanical\/imports\/[a-f0-9-]{36}\/[^/\\]+\.(stl|glb|obj|step|stp)$/i),
  format: MechanicalModelFormat,
  units: MechanicalModelUnits,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
  importedAt: z.string().datetime(),
  placement: z.literal("unplaced"),
}).refine((model) => model.path.startsWith(`mechanical/imports/${model.id}/`), { message: "Model path must belong to this import." })
  .refine((model) => model.format === "glb" ? model.units === "m" : model.format === "step" || model.format === "stp" ? model.units === "file" : model.units !== "file", { message: "Units must match the model format." });
export type ImportedMechanicalModel = z.infer<typeof ImportedMechanicalModel>;
