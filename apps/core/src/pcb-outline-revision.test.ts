import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardLayer } from "@fp-pcb/proto";
import { createBoardGraphic } from "@fp-pcb/client";
import { createFpPcbDesign } from "./fp-pcb-design";
const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const edge = (owned = true) => {
  const shape = createBoardGraphic({ geometry: { kind: "segment", start: { x: 0, y: 0 }, end: { x: 10_000_000, y: 0 } }, layer: BoardLayer.BL_Edge_Cuts });
  if (owned) shape.setCustomProperty("fabdesk.generated-outline", "native-atomic-edit");
  return shape;
};
async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pcb-outline-guard-"));
  try { await writeFile(join(dir, "board.kicad_pcb"), "original PCB"); await run(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test("stale outline source is rejected before opening a native document", async () => fixture(async dir => {
  let opened = false;
  const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { ensureProject: async () => { opened = true; throw Error("must not open"); } } as never });
  await expect(design.defineBoardOutline(dir, points, true, { expectedSourceSha256: hash("old") })).rejects.toThrow("changed since");
  expect(opened).toBe(false);
  expect(await readFile(join(dir, "board.kicad_pcb"), "utf8")).toBe("original PCB");
}));
for (const kind of ["mixed", "curved", "locked", "external-preflight", "unsaved"] as const) {
  test(`outline replacement refuses ${kind} geometry/state without committing`, async () => fixture(async dir => {
    let committed = false;
    const generated = edge();
    if (kind === "locked") generated.locked = true;
    const arc = createBoardGraphic({ geometry: { kind: "circle", center: { x: 0, y: 0 }, radiusPoint: { x: 2_000_000, y: 0 } }, layer: BoardLayer.BL_Edge_Cuts });
    const board = {
      getShapes: async () => {
        if (kind === "external-preflight") await writeFile(join(dir, "board.kicad_pcb"), "external edit");
        return kind === "mixed" ? [generated, edge(false)] : kind === "curved" ? [generated, arc] : [generated];
      },
      modified: async () => kind === "unsaved",
      commit: async () => { committed = true; },
    };
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { ensureProject: async () => ({ board }), assertSchematicSaved: async () => {} } as never });
    const reason = { mixed: "human-authored", curved: "non-segment", locked: "locked edges", "external-preflight": "changed since", unsaved: "Save the open PCB" }[kind];
    await expect(design.defineBoardOutline(dir, points, true, kind === "mixed" ? {} : { expectedSourceSha256: hash("original PCB") })).rejects.toThrow(reason);
    expect(committed).toBe(false);
    expect(await readFile(join(dir, "board.kicad_pcb"), "utf8")).toBe(kind === "external-preflight" ? "external edit" : "original PCB");
  }));
}
for (const authored of [false, true]) test(`${authored ? "reviewed human" : "owned"} unlocked segment outline is replaced in the native commit`, async () => fixture(async dir => {
  const generated = edge(!authored), unrelated = createBoardGraphic({ geometry: { kind: "segment", start: { x: 0, y: 0 }, end: { x: 5, y: 5 } }, layer: BoardLayer.BL_F_SilkS });
  let deleted: unknown, created: unknown[] = [], saved = false;
  const board = {
    getShapes: async () => [generated, unrelated], modified: async () => false,
    commit: async (_label: string, fn: (tx: unknown) => Promise<void>) => fn({ delete: async (items: unknown) => { deleted = items; }, create: async (items: unknown[]) => { created = items; } }),
    save: async () => { saved = true; }, revision: async () => 2n,
  };
  const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { ensureProject: async () => ({ board }), assertSchematicSaved: async () => {} } as never });
  const result = await design.defineBoardOutline(dir, points, true, { expectedSourceSha256: hash("original PCB") });
  expect(result).toEqual({ created: 4, replaced: 1, saved: true, revision: 2 });
  expect(deleted).toEqual([generated]); expect(created).toHaveLength(4); expect(saved).toBe(true);
}));
