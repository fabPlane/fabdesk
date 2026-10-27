import { expect, test } from "bun:test";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";
import { rm } from "node:fs/promises";

test("placement forwards the inspected source hash to the native transaction", async () => {
  const project = await tempProject("placement-source-guard"), base = mockServices([project]);
  let actual: unknown;
  const services = mockServices([project], { design: { ...base.design, placeFootprints: async (_dir, _placements, options) => {
    actual = options; return { moved: ["R1"], missing: [], revision: 2, saved: true };
  } } });
  const registry = createRegistry(), factory = contextFactory(services, project), expected = "a".repeat(64);
  try {
    await registry.invoke("pcb_place", { placements: [{ reference: "R1", position: { x: 5, y: 7 } }], expectedSourceSha256: expected }, (ref) => factory({ def: registry.get("pcb_place")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    expect(actual).toEqual({ staleCopper: "keep", expectedSourceSha256: expected });
  } finally { await rm(project.dir, { recursive: true, force: true }); }
});

test("malformed source hashes fail before constructing a mutation context", async () => {
  const registry = createRegistry(); let entered = false;
  await expect(registry.invoke("pcb_place", { placements: [{ reference: "R1", rotation: 90 }], expectedSourceSha256: "not-a-sha" }, () => { entered = true; throw new Error("must not mutate"); })).rejects.toThrow();
  expect(entered).toBe(false);
});
