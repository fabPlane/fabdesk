import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { NativeRevisionConflict } from "@fabdesk/tools";
import { createFpPcbDesign } from "./fp-pcb-design";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

test("a stale inspected PCB is rejected before opening a native session or mutating files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pcb-stale-placement-")); let opened = false;
  const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { board: async () => { opened = true; throw new Error("must not open"); } } as never });
  try {
    await writeFile(join(dir, "board.kicad_pcb"), "changed PCB");
    await expect(design.placeFootprints(dir, [{ reference: "R1", position: { x: 1, y: 2 } }], { expectedSourceSha256: hash("old PCB") })).rejects.toBeInstanceOf(NativeRevisionConflict);
    expect(opened).toBe(false);
    expect(await Bun.file(join(dir, "board.kicad_pcb")).text()).toBe("changed PCB");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a source changed during placement preflight is rejected before the native commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pcb-preflight-placement-")); let committed = false;
  const footprint = { reference: "R1", position: { x: 0, y: 0 }, orientation: 0, isFlipped: false, clone() { return this; } };
  const board = {
    getFootprints: async () => [footprint],
    modified: async () => { await writeFile(join(dir, "board.kicad_pcb"), "external edit"); return false; },
    commit: async () => { committed = true; },
  };
  const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { board: async () => board, assertSchematicSaved: async () => {} } as never });
  try {
    await writeFile(join(dir, "board.kicad_pcb"), "original PCB");
    await expect(design.placeFootprints(dir, [{ reference: "R1", lock: true }], { expectedSourceSha256: hash("original PCB") })).rejects.toBeInstanceOf(NativeRevisionConflict);
    expect(committed).toBe(false);
    expect(await Bun.file(join(dir, "board.kicad_pcb")).text()).toBe("external edit");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
