import { expect, test } from "bun:test";
import { projectBlobQueryKey, reuseUnchangedProjectBlob } from "./stable-project-blob";
const blob = (text: string, type = "video/mp4") => new Blob([text], { type });
test("an unchanged fetched asset keeps the prior Blob object used by its player", async () => {
  const previous = blob("clip");
  expect(await reuseUnchangedProjectBlob(previous, blob("clip"))).toBe(previous);
  expect(await reuseUnchangedProjectBlob(previous, blob("clip"))).toBe(previous);
});
test("same-size replacements and MIME corrections never reuse the prior binary", async () => {
  const previous = blob("clip"), replacement = blob("edit"), typeCorrection = blob("clip", "video/webm");
  expect(replacement.size).toBe(previous.size);
  expect(await reuseUnchangedProjectBlob(previous, replacement)).toBe(replacement);
  expect(await reuseUnchangedProjectBlob(previous, typeCorrection)).toBe(typeCorrection);
});
test("a missing file stays missing and a new scope does not borrow a cached asset", async () => {
  const previous = blob("clip"), restored = blob("clip");
  expect(await reuseUnchangedProjectBlob(previous, null)).toBeNull();
  expect(await reuseUnchangedProjectBlob(undefined, restored)).toBe(restored);
  expect(await reuseUnchangedProjectBlob(null, restored)).toBe(restored);
});
test("blob keys retain path-prefix invalidation and isolate endpoints/projects/files", () => {
  const key = projectBlobQueryKey("http://localhost:1", "p", "exports/video.mp4");
  expect(key.slice(0, 4)).toEqual(["file", "p", "exports/video.mp4", "blob"]);
  expect(key).not.toEqual(projectBlobQueryKey("http://localhost:2", "p", "exports/video.mp4"));
  expect(key).not.toEqual(projectBlobQueryKey("http://localhost:1", "other", "exports/video.mp4"));
  expect(key).not.toEqual(projectBlobQueryKey("http://localhost:1", "p", "other.mp4"));
});
test("a late comparison cannot replace a newer snapshot's identity", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class DelayedBlob extends Blob { override async arrayBuffer() { await gate; return super.arrayBuffer(); } }
  const previous = blob("clip"), late = reuseUnchangedProjectBlob(previous, new DelayedBlob(["clip"], { type: "video/mp4" }));
  const current = blob("edit");
  expect(await reuseUnchangedProjectBlob(previous, current)).toBe(current);
  release(); expect(await late).toBe(previous);
  expect(await reuseUnchangedProjectBlob(current, blob("edit"))).toBe(current);
});
