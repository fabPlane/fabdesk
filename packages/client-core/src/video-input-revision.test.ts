import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CoreHttpError } from "./CoreClient";
import { inspectVideoInputRevision } from "./video-input-revision";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const files = new Map([["renders/board.glb", "model"], ["exports/product-video.mp4", "video"]]);
  const revision = { contract: "fabplane.video-input-revision.v1", inputs: [{ path: "renders/board.glb", sha256: hash("model") }], outputs: [{ path: "exports/product-video.mp4", sha256: hash("video") }] };
  const record = (value: unknown = revision) => files.set("exports/product-video.json", JSON.stringify({ revision: value }));
  const read = async (_id: string, path: string) => { const value = files.get(path); if (value === undefined) throw new CoreHttpError(404, path, "Missing"); return value; };
  const inspect = (path = "exports/product-video.mp4") => inspectVideoInputRevision({ readFile: read, readFileBlob: async (id, path) => new Blob([await read(id, path)]) }, "project", path);
  return { files, revision, record, inspect };
}
test("legacy or unsafe video provenance cannot certify inputs or read paths outside the project", async () => {
  const f = fixture();
  expect(await f.inspect()).toBe("untracked");
  f.files.set("exports/product-video.json", "{");
  expect(await f.inspect()).toBe("untracked");
  f.record({ ...f.revision, inputs: [{ path: "../secret.glb", sha256: hash("secret") }] });
  expect(await f.inspect()).toBe("untracked");
  f.record({ ...f.revision, outputs: [{ path: "unrelated.mp4", sha256: hash("video") }] });
  expect(await f.inspect()).toBe("untracked");
});
test("changing and restoring exact decoded mesh bytes updates video input status", async () => {
  const f = fixture(); f.record();
  expect(await f.inspect()).toBe("inputs-unchanged");
  f.files.set("renders/board.glb", "new model");
  expect(await f.inspect()).toBe("inputs-changed");
  f.files.set("renders/board.glb", "model");
  expect(await f.inspect()).toBe("inputs-unchanged");
  f.files.delete("renders/board.glb");
  expect(await f.inspect()).toBe("missing-input");
});
test("replaced, missing and unrecorded video formats never inherit another output's identity", async () => {
  const f = fixture(); f.record();
  expect(await f.inspect("exports/product-video.gif")).toBe("untracked");
  f.files.set("exports/product-video.mp4", "replacement");
  expect(await f.inspect()).toBe("artifact-changed");
  f.files.delete("exports/product-video.mp4");
  expect(await f.inspect()).toBe("missing-artifact");
});
test("duplicate input paths and transport errors do not become current", async () => {
  const f = fixture(); f.record({ ...f.revision, inputs: [...f.revision.inputs, ...f.revision.inputs] });
  expect(await f.inspect()).toBe("untracked");
  await expect(inspectVideoInputRevision({ readFile: async () => { throw Error("offline"); }, readFileBlob: async () => new Blob() }, "p", "exports/product-video.mp4")).rejects.toThrow("offline");
});
