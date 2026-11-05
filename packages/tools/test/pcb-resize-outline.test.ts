import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";
test("native rectangle resize forwards explicit IDs, dimensions and source revision into the captured project", async () => {
  const project = await tempProject("native-outline-id-update"), base = mockServices([project]);let actual: unknown;
  const services = mockServices([project], { design: { ...base.design, resizeBoardOutline: async (dir, request) => { actual = { dir, request };return { saved: true, changed: true, edgeIds: request.edgeIds, revision: 2, bounds: { minX: 100, minY: 95, maxX: 122, maxY: 111 } }; } } });
  const registry = createRegistry(), factory = contextFactory(services, project), request = { edgeIds: ["native-rectangle"], widthMm: 22, heightMm: 16, expectedSourceSha256: "a".repeat(64) };
  try { await registry.invoke("pcb_resize_outline", request, ref => factory({ def: registry.get("pcb_resize_outline")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));expect(actual).toEqual({ dir: project.dir, request }); }
  finally { await rm(project.dir, { recursive: true, force: true }); }
});
test("invalid selection, dimensions and missing/malformed revision fail before mutation context", async () => {
  const registry = createRegistry(), valid = { edgeIds: ["native-rectangle"], widthMm: 20, heightMm: 15, expectedSourceSha256: "a".repeat(64) };
  for (const input of [{ ...valid, expectedSourceSha256: undefined }, { ...valid, expectedSourceSha256: "bad" }, { ...valid, widthMm: .0000001 }, { ...valid, heightMm: 1001 }, { ...valid, edgeIds: [] }, { ...valid, edgeIds: ["a", "b"] }, { ...valid, edgeIds: ["a", "a", "b", "c"] }]) {
    let entered = false;await expect(registry.invoke("pcb_resize_outline", input, () => { entered = true;throw Error("must not enter"); })).rejects.toThrow();expect(entered).toBe(false);
  }
});
