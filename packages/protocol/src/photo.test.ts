import { describe, expect, test } from "bun:test";
import { CoreEvent } from "./events";
import {
  PHOTO_PIPELINE_STEPS,
  PhotoPipelineSession,
  PhotoSighting,
  emptyPhotoSteps,
} from "./photo";

const sighting = {
  schema: 1 as const,
  photos: [{ path: "sketches/front.png", side: "front" as const, widthPx: 200, heightPx: 120 }],
  items: [
    {
      id: "led1",
      kind: "led" as const,
      label: "LED",
      side: "front" as const,
      box: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 },
      confidence: 0.8,
    },
  ],
  outline: {
    polygon: [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 20 },
      { x: 0, y: 20 },
    ],
    source: "silhouette" as const,
  },
  scale: {
    method: "known_part" as const,
    knownPart: "usb_c" as const,
    assumedMmPerPx: 0.2,
    boardWidthMm: 40,
    boardHeightMm: 20,
    note: "USB-C receptacle is 8.94 mm wide.",
    confidence: 0.7,
  },
  mountingHoles: [],
  notes: [],
};

describe("photo protocol", () => {
  test("sighting and pipeline session parse", () => {
    expect(PhotoSighting.parse(sighting).items[0]?.id).toBe("led1");
    const session = PhotoPipelineSession.parse({
      id: "ph_1",
      projectId: "p1",
      status: "running",
      currentStep: "read",
      steps: emptyPhotoSteps(),
      error: null,
      startedAt: "2026-11-02T00:00:00.000Z",
      endedAt: null,
    });
    expect(session.steps.map((s) => s.id)).toEqual([...PHOTO_PIPELINE_STEPS]);
    expect(CoreEvent.parse({ ts: 1, topic: "photo.started", session }).topic).toBe("photo.started");
    expect(
      CoreEvent.parse({ ts: 1, topic: "photo.progress", session, step: "infer", note: "blocks" }).topic,
    ).toBe("photo.progress");
    expect(CoreEvent.parse({ ts: 1, topic: "photo.failed", session, error: "nope" }).topic).toBe(
      "photo.failed",
    );
  });
});
