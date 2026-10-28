import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CoreHttpError } from "./CoreClient";
import { inspectVideoInputRevision, videoInputsNeedReview } from "./video-input-revision";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture() {
  const modelReceipt = { contract: "fabplane.board-model-revision.v1", source: "board.kicad_pcb", artifact: "renders/board.glb", sourceSha256: hash("pcb"), artifactSha256: hash("model"), dependencies: "unverified", generatedAt: "2026-10-28T00:00:00Z" };
  const files = new Map([["renders/board.glb", "model"], ["exports/product-video.mp4", "video"], ["board.kicad_pcb", "pcb"], ["renders/board.glb.revision.json", JSON.stringify(modelReceipt)]]);
  const revision = { contract: "fabplane.video-input-revision.v1", inputs: [{ path: "renders/board.glb", sha256: hash("model") }], outputs: [{ path: "exports/product-video.mp4", sha256: hash("video") }] };
  const record = (value: unknown = revision) => files.set("exports/product-video.json", JSON.stringify({ revision: value }));
  const read = async (_id: string, path: string) => { const value = files.get(path); if (value === undefined) throw new CoreHttpError(404, path, "Missing"); return value; };
  const inspect = (path = "exports/product-video.mp4") => inspectVideoInputRevision({ readFile: read, readFileBlob: async (id, path) => new Blob([await read(id, path)]) }, "project", path);
  return { files, revision, record, inspect, modelReceipt };
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

test("a PCB change propagates through the recorded board model without replacing any media", async () => {
  const f = fixture(); f.record();
  f.files.set("board.kicad_pcb", "new pcb");
  expect(await f.inspect()).toBe("board-source-changed");
  expect(videoInputsNeedReview(await f.inspect())).toBe(true);
  expect(f.files.get("renders/board.glb")).toBe("model");
  expect(f.files.get("exports/product-video.mp4")).toBe("video");
  f.files.set("board.kicad_pcb", "pcb");
  expect(await f.inspect()).toBe("inputs-unchanged");
});
test("a recorded root board model with missing or inconsistent PCB provenance stays unverified", async () => {
  const f = fixture(); f.record();
  f.files.delete("renders/board.glb.revision.json");
  expect(await f.inspect()).toBe("board-source-unverified");
  expect(videoInputsNeedReview(await f.inspect())).toBe(true);
  f.files.set("renders/board.glb.revision.json", JSON.stringify({ ...f.modelReceipt, artifactSha256: hash("other model") }));
  expect(await f.inspect()).toBe("board-source-unverified");
  f.files.set("renders/board.glb.revision.json", JSON.stringify(f.modelReceipt)); f.files.delete("board.kicad_pcb");
  expect(await f.inspect()).toBe("board-source-unverified");
});
test("an unrelated imported mesh never inherits the root PCB's provenance", async () => {
  const f = fixture(); f.files.delete("board.kicad_pcb"); f.files.delete("renders/board.glb.revision.json");
  f.files.set("models/reference.glb", "reference");
  f.record({ ...f.revision, inputs: [{ path: "models/reference.glb", sha256: hash("reference") }] });
  expect(await f.inspect()).toBe("inputs-unchanged");
});
