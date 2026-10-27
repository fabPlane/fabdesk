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

test("outline replacement forwards the inspected revision without changing requested polygon points", async () => {
  const project = await tempProject("outline-source-guard"), base = mockServices([project]);
  let actual: unknown;
  const services = mockServices([project], { design: { ...base.design, defineBoardOutline: async (_dir, points, replace, options) => {
    actual = { points, replace, options }; return { created: 4, replaced: 4, revision: 3, saved: true };
  } } });
  const registry = createRegistry(), factory = contextFactory(services, project), expected = "b".repeat(64);
  const points = [{ x: 100, y: 95 }, { x: 120, y: 95 }, { x: 120, y: 110 }, { x: 100, y: 110 }];
  try {
    await registry.invoke("pcb_define_outline", { points, replace: true, expectedSourceSha256: expected }, ref => factory({ def: registry.get("pcb_define_outline")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    expect(actual).toEqual({ points, replace: true, options: { expectedSourceSha256: expected } });
  } finally { await rm(project.dir, { recursive: true, force: true }); }
});
test("malformed outline hashes fail before mutation context", async () => {
  const registry = createRegistry(); let entered = false;
  await expect(registry.invoke("pcb_define_outline", { widthMm: 20, heightMm: 10, expectedSourceSha256: "bad" }, () => { entered = true; throw Error("must not enter"); })).rejects.toThrow();
  expect(entered).toBe(false);
});
