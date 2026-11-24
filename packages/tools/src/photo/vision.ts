import { decodeGray } from "@fabdesk/board-art";
import type {
  PhotoSighting,
  PhotoSide,
  SightedItem,
} from "@fabdesk/protocol";
import { PhotoSighting as PhotoSightingSchema } from "@fabdesk/protocol";
import { fitOutlineFromMask, maskFromGray } from "./outline";
import { inferScale, type ScaleHint } from "./scale";

export type { ScaleHint };

export type VisionPhoto = {
  path: string;
  bytes: Uint8Array;
  mime: string;
  side?: PhotoSide;
};

export type VisionAnalyzeInput = {
  photos: VisionPhoto[];
  description?: string;
  hint?: ScaleHint;
  /** Agent-supplied items; used when the provider does not invent a list. */
  items?: SightedItem[];
  openSourceSuspected?: boolean;
};

export interface VisionProvider {
  analyze(input: VisionAnalyzeInput): Promise<PhotoSighting>;
}

/**
 * Deterministic provider: outline + scale from the photo, items from the caller
 * or from a sidecar `.sighting.json` next to the first image (tests).
 */
export class HeuristicVisionProvider implements VisionProvider {
  constructor(private readonly sidecars?: Record<string, PhotoSighting>) {}

  async analyze(input: VisionAnalyzeInput): Promise<PhotoSighting> {
    if (input.photos.length === 0) throw new Error("at least one photo is required");
    const first = input.photos[0]!;
    const gray = await decodeGray(first.bytes);
    const mask = maskFromGray(gray.width, gray.height, gray.pixels);
    const sidecar = this.sidecars?.[basename(first.path)];
    const items = input.items ?? sidecar?.items ?? [];
    const scale = inferScale({
      photoWidthPx: gray.width,
      photoHeightPx: gray.height,
      items,
      ...(input.hint ? { hint: input.hint } : {}),
    });
    const outline = fitOutlineFromMask(mask, scale.assumedMmPerPx);
    const photos = await Promise.all(
      input.photos.map(async (p) => {
        const g = p === first ? gray : await decodeGray(p.bytes).catch(() => gray);
        return {
          path: p.path,
          side: p.side ?? "unknown",
          widthPx: g.width,
          heightPx: g.height,
        };
      }),
    );
    const holes = items
      .filter((i) => i.kind === "mounting_hole")
      .map((i) => ({
        x: (i.box.x + i.box.w / 2) * scale.boardWidthMm,
        y: (i.box.y + i.box.h / 2) * scale.boardHeightMm,
        diameterMm: 2.2,
        confidence: i.confidence,
      }));
    const sighting: PhotoSighting = {
      schema: 1,
      photos,
      items,
      outline,
      scale,
      mountingHoles: holes,
      notes: [
        scale.note,
        input.description?.trim() ? `User asked: ${input.description.trim()}` : "",
      ].filter(Boolean),
      equivalentDisclaimer:
        "This is a working functional equivalent drafted from the photos, not a pixel-for-pixel copy of the original artwork or traces.",
      ...(input.openSourceSuspected || sidecar?.openSourceNote
        ? {
            openSourceNote:
              sidecar?.openSourceNote ?? { suspected: true, attribution: "Attribute the original authors if this is a known open-source board." },
          }
        : {}),
    };
    return PhotoSightingSchema.parse(sighting);
  }
}

/** Test helper: always returns the given sighting after filling outline/scale from the photo. */
export class FakeVisionProvider implements VisionProvider {
  constructor(private readonly items: SightedItem[]) {}

  async analyze(input: VisionAnalyzeInput): Promise<PhotoSighting> {
    return new HeuristicVisionProvider().analyze({ ...input, items: input.items ?? this.items });
  }
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}
