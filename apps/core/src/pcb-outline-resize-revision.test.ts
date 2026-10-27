import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createBoardGraphic } from "@fp-pcb/client";
import { BoardLayer } from "@fp-pcb/proto";
import { createFpPcbDesign } from "./fp-pcb-design";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const edge = () => createBoardGraphic({ id: "human-edge", layer: BoardLayer.BL_Edge_Cuts, geometry: { kind: "rectangle", topLeft: { x: 100_000_000, y: 95_000_000 }, bottomRight: { x: 115_000_000, y: 110_000_000 } } });
async function fixture(run: (dir: string) => Promise<void>) { const dir = await mkdtemp(join(tmpdir(), "pcb-resize-source-"));try { await writeFile(join(dir, "board.kicad_pcb"), "original"); await run(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
const request = { edgeIds: ["human-edge"], widthMm: 22, heightMm: 16, expectedSourceSha256: hash("original") };
test("a stale inspected outline cannot open or alter the native board", async () => fixture(async dir => {
  let opened = false;
  const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { board: async () => { opened = true; throw Error("must not open"); } } as never });
  await expect(design.resizeBoardOutline(dir, { ...request, expectedSourceSha256: hash("old") })).rejects.toThrow("changed since");expect(opened).toBe(false);
}));
for (const scenario of ["external", "partial", "unsaved", "grouped"] as const) test(`native outline resize rejects ${scenario} state before committing`, async () => fixture(async dir => {
  let committed = false;
  const board = { getGroups: async () => scenario === "grouped" ? [{ id: "group", items: ["human-edge"], locked: true }] : [], getShapes: async () => scenario === "partial" ? [edge(), createBoardGraphic({ id: "cutout", layer: BoardLayer.BL_Edge_Cuts, geometry: { kind: "circle", center: { x: 0, y: 0 }, radiusPoint: { x: 1, y: 0 } } })] : [edge()], modified: async () => { if (scenario === "external") await writeFile(join(dir, "board.kicad_pcb"), "external"); return scenario === "unsaved"; }, commit: async () => { committed = true; } };
  const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { board: async () => board, assertSchematicSaved: async () => {} } as never });
  await expect(design.resizeBoardOutline(dir, request)).rejects.toThrow(scenario === "external" ? "changed since" : scenario === "partial" ? "complete" : scenario === "grouped" ? "locked group" : "Save the open PCB");expect(committed).toBe(false);expect(await readFile(join(dir, "board.kicad_pcb"), "utf8")).toBe(scenario === "external" ? "external" : "original");
}));
test("native resize updates the same primitives without creating or deleting source objects", async () => fixture(async dir => {
  const original = edge(); let updated: unknown[] = [], saved = false;
  const board = { getGroups: async () => [], getShapes: async () => [original], modified: async () => false, commit: async (_label: string, fn: (tx: unknown) => Promise<void>) => fn({ update: async (items: unknown[]) => { updated = items; } }), save: async () => { saved = true; }, revision: async () => 2n };
  const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { board: async () => board, assertSchematicSaved: async () => {} } as never });
  expect(await design.resizeBoardOutline(dir, request)).toMatchObject({ saved: true, changed: true, edgeIds: [original.id], bounds: { minX: 100, minY: 95, maxX: 122, maxY: 111 } });expect(saved).toBe(true);expect(updated).toHaveLength(1);expect((updated[0] as typeof original).id).toBe(original.id);expect(original.end).toEqual({ x: 115_000_000, y: 110_000_000 });
}));

test("an unchanged native size returns without committing or saving", async () => fixture(async dir => {
  const original = edge(); let committed = false, saved = false;
  const board = { getGroups: async () => [], getShapes: async () => [original], modified: async () => false, commit: async () => { committed = true; }, save: async () => { saved = true; }, revision: async () => 2n };
  const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { board: async () => board, assertSchematicSaved: async () => {} } as never });
  expect(await design.resizeBoardOutline(dir, { ...request, widthMm: 15, heightMm: 15 })).toMatchObject({ saved: true, changed: false, edgeIds: [original.id] });expect(committed).toBe(false);expect(saved).toBe(false);
}));
