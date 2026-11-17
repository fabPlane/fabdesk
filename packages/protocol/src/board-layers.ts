import { z } from "zod/v4";

export const BOARD_LAYERS_PATH = "renders/board-layers.json";
export const BoardLayers = z.object({
  version: z.literal(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  layers: z.array(z.object({ name: z.string().max(80), svg: z.string() })).min(1).max(64),
});
export type BoardLayers = z.infer<typeof BoardLayers>;
