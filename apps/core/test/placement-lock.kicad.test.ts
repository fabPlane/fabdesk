import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BoardGroup } from "@fp-pcb/client";
import { createFpPcbDesign } from "../src/fp-pcb-design";
import { haveKicad, startKiCad, type RunningKiCad } from "../../../vendor/fab_pcb/packages/client/test/kicad-server";

describe.skipIf(!haveKicad())("native placement group locks", () => {
  test("a saved locked group protects an otherwise unlocked footprint in inspection and placement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabplane-placement-lock-")), path = join(dir, "board.kicad_pcb");
    let server: RunningKiCad | undefined;
    try {
      await cp(join(import.meta.dir, "../../../packages/kicad/test/fixtures/mini-two-layer.kicad_pcb"), path);
      server = await startKiCad(path, "fabplane-placement-lock");
      const board = (await server.kicad.currentBoard())!;
      const part = (await board.getFootprints()).find(part => part.reference === "R1")!;
      expect(part.locked).toBe(false);
      const group = new BoardGroup(); group.id = randomUUID(); group.name = "Protected placement"; group.items = [part.id]; group.locked = true;
      await board.commit("Fixture: lock placement group", async tx => { await tx.create([group]); }); await board.save();
      const saved = await readFile(path);
      expect((await board.getGroups()).find(item => item.id === group.id)?.locked).toBe(true);
      const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { board: async () => board } as never });
      expect((await design.query(dir, "components")).find(row => row.ref === "R1")?.locked).toBe(true);
      for (const unlock of [false, true]) {
        await expect(design.placeFootprints(dir, [{ reference: "R1", position: { x: 106, y: 100 }, ...(unlock ? { lock: false } : {}) }])).rejects.toThrow("locked group");
        expect(await readFile(path)).toEqual(saved);
        const unchanged = (await board.getFootprints()).find(item => item.id === part.id)!;
        expect(unchanged.position).toEqual(part.position); expect(unchanged.locked).toBe(false);
      }
    } finally { await server?.stop(); await rm(dir, { recursive: true, force: true }); }
  }, 120_000);
});
