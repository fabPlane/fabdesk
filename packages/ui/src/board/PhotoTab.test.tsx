import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { emptyPhotoSteps, type PhotoSighting } from "@fabdesk/protocol";
import { CoreClient, CoreProvider, nullHost } from "@fabdesk/client-core";
import { PhotoTab } from "./PhotoTab";
import { WhatISeeTable } from "./WhatISeeTable";
import { useUiStore } from "../stores/ui";
import { PhotoPipelinePanel } from "../chat/PhotoPipelinePanel";

const sighting: PhotoSighting = {
  schema: 1,
  photos: [{ path: "sketches/front.png", side: "front", widthPx: 80, heightPx: 50 }],
  items: [
    {
      id: "usb1",
      kind: "connector",
      label: "USB-C",
      side: "front",
      box: { x: 0.1, y: 0.4, w: 0.1, h: 0.2 },
      confidence: 0.9,
    },
  ],
  outline: {
    polygon: [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 20 },
      { x: 0, y: 20 },
    ],
    source: "silhouette",
  },
  scale: {
    method: "known_part",
    knownPart: "usb_c",
    assumedMmPerPx: 0.2,
    boardWidthMm: 40,
    boardHeightMm: 20,
    note: "USB-C scale",
    confidence: 0.7,
  },
  mountingHoles: [],
  notes: [],
  equivalentDisclaimer: "functional equivalent",
};

test("what I see table lists confidence and side", () => {
  const html = renderToStaticMarkup(<WhatISeeTable sighting={sighting} onChange={() => {}} />);
  expect(html).toContain("data-testid=\"what-i-see\"");
  expect(html).toContain("USB-C");
  expect(html).toContain("90%");
  expect(html).toContain("front");
});

test("photo pipeline checklist renders live steps", () => {
  const html = renderToStaticMarkup(
    <PhotoPipelinePanel
      session={{
        id: "ph_1",
        projectId: "p1",
        status: "running",
        currentStep: "read",
        steps: emptyPhotoSteps().map((s) =>
          s.id === "read" ? { ...s, status: "running", note: "3 items" } : s,
        ),
        error: null,
        startedAt: "2026-11-02T00:00:00.000Z",
        endedAt: null,
      }}
    />,
  );
  expect(html).toContain("data-testid=\"photo-pipeline-panel\"");
  expect(html).toContain("Read the photos");
  expect(html).toContain("3 items");
});

test("photo tab shows reference vs draft copy when a sighting is cached", () => {
  const initial = useUiStore.getInitialState();
  const previous = { ...initial };
  const qc = new QueryClient();
  qc.setQueryData(["photo", "project-a"], {
    session: null,
    sighting,
    intent: null,
    draft: null,
  });
  Object.assign(initial, { activeProjectId: "project-a" });
  try {
    const html = renderToStaticMarkup(
      <CoreProvider client={new CoreClient({ baseUrl: "http://test.invalid", token: "t" })} host={nullHost} queryClient={qc}>
        <PhotoTab />
      </CoreProvider>,
    );
    expect(html).toContain("data-testid=\"photo-tab\"");
    expect(html).toContain("Reference photo vs draft board");
    expect(html).toContain("functional equivalent");
    expect(html).toContain("What I see");
  } finally {
    Object.assign(initial, previous);
    qc.clear();
  }
});
