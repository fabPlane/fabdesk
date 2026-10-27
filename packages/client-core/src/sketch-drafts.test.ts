import { describe, expect, test } from "bun:test";
import { editableSketchPaths, createSketchDraftSession, newChatDraftKey } from "./sketch-drafts";
import type { CoreClient } from "./CoreClient";

function fixture(projectId: string | null = null) {
  let creates = 0;
  let uploads = 0;
  let failCreate = false;
  let failUpload = false;
  const destinations: string[] = [];
  const adopted: string[] = [];
  const client = {
    async createProject() {
      creates++;
      if (failCreate) throw new Error("create failed");
      return { id: "draft-project" } as Awaited<ReturnType<CoreClient["createProject"]>>;
    },
    async uploadSketch(id: string, file: Blob, name: string) {
      uploads++; destinations.push(id);
      if (failUpload) throw new Error("upload failed");
      return { path: `sketches/${name}`, absolutePath: `/project/sketches/${name}`, size: file.size };
    },
  };
  const session = createSketchDraftSession({ client, projectId, onProjectCreated: (id) => adopted.push(id) });
  return { session, adopted, destinations, get creates() { return creates; }, get uploads() { return uploads; }, failCreate: (value: boolean) => { failCreate = value; }, failUpload: (value: boolean) => { failUpload = value; } };
}

describe("sketch draft ownership", () => {
  test("opening/canceling has no side effects; first save creates one destination", async () => {
    const f = fixture();
    expect(f.creates).toBe(0);
    expect(f.uploads).toBe(0);
    const blob = new Blob(["original bytes"]);
    const saved = await f.session.save(blob, "sensor.jpg");
    expect(saved).toMatchObject({ projectId: "draft-project", path: "sketches/sensor.jpg", size: blob.size });
    expect(f.adopted).toEqual(["draft-project"]);
  });
  test("a failed upload retries into the created project, never a second one", async () => {
    const f = fixture(); f.failUpload(true);
    await expect(f.session.save(new Blob(), "a.png")).rejects.toThrow("upload failed");
    f.failUpload(false);
    await f.session.save(new Blob(), "a.png");
    expect(f.creates).toBe(1);
    expect(f.destinations).toEqual(["draft-project", "draft-project"]);
  });
  test("failed creation can retry without uploading to a missing project", async () => {
    const f = fixture(); f.failCreate(true);
    await expect(f.session.save(new Blob(), "a.png")).rejects.toThrow("create failed");
    expect(f.uploads).toBe(0);
    f.failCreate(false); await f.session.save(new Blob(), "a.png");
    expect(f.creates).toBe(2);
    expect(f.adopted).toEqual(["draft-project"]);
  });
  test("concurrent saves share creation and existing projects never create", async () => {
    const f = fixture();
    await Promise.all([f.session.save(new Blob(), "a.png"), f.session.save(new Blob(), "b.png")]);
    expect(f.creates).toBe(1);
    const existing = fixture("existing");
    await existing.session.save(new Blob(), "a.png");
    expect(existing.creates).toBe(0);
    expect(existing.destinations).toEqual(["existing"]);
    expect(existing.adopted).toEqual([]);
  });
  test("unsent drafts from different projects cannot share a slot", () => {
    expect(newChatDraftKey(null)).toBe("__new__");
    expect(newChatDraftKey("a")).not.toBe(newChatDraftKey("b"));
  });
});

test("editable drawing picker excludes ordinary references, unrelated files and nested paths", () => {
  expect(editableSketchPaths(["sketches/sketch-2.excalidraw.png", "sketches/sketch-1.excalidraw.png", "sketches/sketch-2.excalidraw-2.png", "sketches/photo.png", "sketches/photo.jpg", "renders/sketch.excalidraw.png", "sketches/nested/sketch.excalidraw.png", "sketches/..\\sketch.excalidraw.png"].map(path => ({ path })))).toEqual(["sketches/sketch-2.excalidraw.png", "sketches/sketch-2.excalidraw-2.png", "sketches/sketch-1.excalidraw.png"]);
});
