/** Photo → editable KiCad project: structured sighting, circuit intent, and draft metadata. */
import { z } from "zod/v4";

export const PhotoSide = z.enum(["front", "back", "unknown"]);
export type PhotoSide = z.infer<typeof PhotoSide>;

export const SightedKind = z.enum([
  "ic",
  "connector",
  "switch",
  "led",
  "battery",
  "display",
  "encoder",
  "passive",
  "mounting_hole",
  "other",
]);
export type SightedKind = z.infer<typeof SightedKind>;

export const KnownScalePart = z.enum([
  "usb_c",
  "usb_a",
  "aa_holder",
  "aaa_holder",
  "18650",
  "rj45",
  "hdmi",
  "microsd",
  "pin_header_2_54",
]);
export type KnownScalePart = z.infer<typeof KnownScalePart>;

export const PhotoBox = z.object({
  /** Normalised 0–1 box relative to the photo, origin top-left. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().positive().max(1),
  h: z.number().positive().max(1),
});
export type PhotoBox = z.infer<typeof PhotoBox>;

export const SightedItem = z.object({
  id: z.string().min(1),
  kind: SightedKind,
  label: z.string().min(1),
  markings: z.string().optional(),
  mpn: z.string().optional(),
  side: PhotoSide.default("front"),
  box: PhotoBox,
  rotationDeg: z.number().optional(),
  confidence: z.number().min(0).max(1),
  notes: z.string().optional(),
});
export type SightedItem = z.infer<typeof SightedItem>;

export const ScaleAssumption = z.object({
  method: z.enum(["user_dimension", "known_part", "unscaled"]),
  knownPart: KnownScalePart.optional(),
  userDimensionMm: z.number().positive().optional(),
  userDimensionOf: z.enum(["width", "height", "diagonal", "part"]).optional(),
  assumedMmPerPx: z.number().nonnegative(),
  boardWidthMm: z.number().positive(),
  boardHeightMm: z.number().positive(),
  note: z.string(),
  confidence: z.number().min(0).max(1),
});
export type ScaleAssumption = z.infer<typeof ScaleAssumption>;

export const PhotoOutline = z.object({
  /** Board-frame millimetres, origin top-left, +y down. */
  polygon: z.array(z.object({ x: z.number(), y: z.number() })).min(3),
  source: z.enum(["silhouette", "user", "bbox"]),
});
export type PhotoOutline = z.infer<typeof PhotoOutline>;

export const PhotoRef = z.object({
  path: z.string().min(1),
  side: PhotoSide.default("unknown"),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
});
export type PhotoRef = z.infer<typeof PhotoRef>;

export const OpenSourceHint = z.object({
  suspected: z.boolean(),
  projectName: z.string().optional(),
  attribution: z.string().optional(),
});
export type OpenSourceHint = z.infer<typeof OpenSourceHint>;

export const PhotoSighting = z.object({
  schema: z.literal(1),
  photos: z.array(PhotoRef).min(1),
  items: z.array(SightedItem),
  outline: PhotoOutline,
  scale: ScaleAssumption,
  mountingHoles: z.array(
    z.object({
      x: z.number(),
      y: z.number(),
      diameterMm: z.number().positive(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  openSourceNote: OpenSourceHint.optional(),
  notes: z.array(z.string()).default([]),
  equivalentDisclaimer:
    z.string().default(
      "This is a working functional equivalent drafted from the photos, not a pixel-for-pixel copy of the original artwork or traces.",
    ),
});
export type PhotoSighting = z.infer<typeof PhotoSighting>;

export const CircuitBlock = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  itemIds: z.array(z.string()),
});
export type CircuitBlock = z.infer<typeof CircuitBlock>;

export const CircuitIntent = z.object({
  equivalent: z.literal(true),
  disclaimer: z.string(),
  blocks: z.array(CircuitBlock),
  nets: z.array(
    z.object({
      name: z.string(),
      purpose: z.string(),
      nodes: z.array(z.object({ itemId: z.string(), pin: z.string().optional() })),
    }),
  ),
});
export type CircuitIntent = z.infer<typeof CircuitIntent>;

export const PickedPart = z.object({
  itemId: z.string(),
  ref: z.string(),
  value: z.string(),
  footprint: z.string(),
  symbol: z.string(),
  mpn: z.string().optional(),
  inStock: z.boolean().optional(),
  source: z.enum(["marking", "search", "default"]),
});
export type PickedPart = z.infer<typeof PickedPart>;

export const PhotoPlacement = z.object({
  ref: z.string(),
  x: z.number(),
  y: z.number(),
  rotation: z.number().default(0),
  layer: z.enum(["F", "B"]).default("F"),
});
export type PhotoPlacement = z.infer<typeof PhotoPlacement>;

export const PhotoPipelineStepId = z.enum([
  "read",
  "infer",
  "parts",
  "draft",
  "verify",
]);
export type PhotoPipelineStepId = z.infer<typeof PhotoPipelineStepId>;

export const PHOTO_PIPELINE_STEPS: readonly PhotoPipelineStepId[] = [
  "read",
  "infer",
  "parts",
  "draft",
  "verify",
] as const;

export const PHOTO_PIPELINE_LABELS: Record<PhotoPipelineStepId, string> = {
  read: "Read the photos",
  infer: "Infer a functional circuit",
  parts: "Pick real parts",
  draft: "Draft schematic and board",
  verify: "Route and check ERC/DRC",
};

export const PhotoPipelineStepState = z.enum(["pending", "running", "done", "failed"]);
export type PhotoPipelineStepState = z.infer<typeof PhotoPipelineStepState>;

export const PhotoPipelineStep = z.object({
  id: PhotoPipelineStepId,
  label: z.string(),
  status: PhotoPipelineStepState,
  note: z.string().optional(),
  artifact: z.string().optional(),
});
export type PhotoPipelineStep = z.infer<typeof PhotoPipelineStep>;

export const PhotoPipelineStatus = z.enum(["running", "completed", "failed"]);
export type PhotoPipelineStatus = z.infer<typeof PhotoPipelineStatus>;

export const PhotoPipelineSession = z.object({
  id: z.string(),
  projectId: z.string(),
  status: PhotoPipelineStatus,
  currentStep: PhotoPipelineStepId.nullable(),
  steps: z.array(PhotoPipelineStep),
  error: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type PhotoPipelineSession = z.infer<typeof PhotoPipelineSession>;

export const PhotoPublishMeta = z.object({
  startedFromPhoto: z.literal(true),
  referencePhotos: z.array(
    z.object({
      path: z.string(),
      side: PhotoSide.optional(),
      alt: z.string().optional(),
    }),
  ),
  equivalentDisclaimer: z.string(),
  openSourceNote: OpenSourceHint.optional(),
});
export type PhotoPublishMeta = z.infer<typeof PhotoPublishMeta>;

export function emptyPhotoSteps(): PhotoPipelineStep[] {
  return PHOTO_PIPELINE_STEPS.map((id) => ({
    id,
    label: PHOTO_PIPELINE_LABELS[id],
    status: "pending" as const,
  }));
}
