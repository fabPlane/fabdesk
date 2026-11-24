import { expect, test } from "bun:test";
import { emptyPhotoSteps } from "@fabdesk/protocol";
import { photoActive, photoSummary } from "./photo-view";
import { imageFilesFromList, isSketchPath } from "./composer-photos";

test("photo checklist helpers", () => {
  const session = {
    id: "ph_1",
    projectId: "p1",
    status: "running" as const,
    currentStep: "read" as const,
    steps: emptyPhotoSteps().map((s) => (s.id === "read" ? { ...s, status: "running" as const, note: "3 items" } : s)),
    error: null,
    startedAt: "2026-11-02T00:00:00.000Z",
    endedAt: null,
  };
  expect(photoActive(session)).toBe(true);
  expect(photoSummary(session)).toBe("3 items");
  expect(photoSummary({ ...session, status: "completed", currentStep: null })).toContain("Photo board tab");
});

test("image drop helper keeps photos and sketch paths", () => {
  const png = new File([new Uint8Array([1])], "front.png", { type: "image/png" });
  const txt = new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" });
  expect(imageFilesFromList([png, txt]).map((f) => f.name)).toEqual(["front.png"]);
  expect(isSketchPath("sketches/front.png")).toBe(true);
  expect(isSketchPath("/tmp/other.png")).toBe(false);
});
