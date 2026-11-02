import { z } from "zod/v4";
import { AssemblyRelativePath } from "./assembly";

/** Saved-source navigation request. No claim that a client displayed or validated the design. */
export const SchematicFocus = z.object({
  id: z.string().uuid(), projectId: z.string().min(1), requestedAt: z.number(),
  reference: z.string().min(1).max(128), value: z.string().max(1000),
  sourcePath: z.literal("board.kicad_sch"), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  svgPath: AssemblyRelativePath, svgSha256: z.string().regex(/^[a-f0-9]{64}$/),
  points: z.array(z.object({ x: z.number().finite(), y: z.number().finite(), unit: z.number().int().positive() })).min(1).max(32),
  page: z.object({ width: z.number().positive(), height: z.number().positive() }),
}).strict();
export type SchematicFocus = z.infer<typeof SchematicFocus>;
