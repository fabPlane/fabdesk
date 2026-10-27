import { z } from "zod/v4";

/** A saved PCB footprint identified by its native reference, not a screen hitbox. */
export const PcbPartPosition = z.object({
  ref: z.string().min(1).max(80),
  value: z.string(),
  footprint: z.string(),
  x: z.number().finite(),
  y: z.number().finite(),
  rotation: z.number().finite(),
  locked: z.boolean(),
  flipped: z.boolean(),
});
export type PcbPartPosition = z.infer<typeof PcbPartPosition>;
export type PcbPartInspection = { sourceSha256: string; parts: PcbPartPosition[]; truncated: boolean };

export const PcbOutlineSegment = z.object({
  id: z.string().min(1),
  owner: z.literal("board"),
  kind: z.string(),
  locked: z.boolean(),
  toolOwnedOutline: z.boolean(),
  start: z.object({ x: z.number().finite(), y: z.number().finite() }),
  end: z.object({ x: z.number().finite(), y: z.number().finite() }),
});
export type PcbOutlineInspection = {
  sourceSha256: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  editable: boolean;
  reason: string | null;
};
