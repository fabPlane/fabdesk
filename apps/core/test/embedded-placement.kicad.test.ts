import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFpPcbDesign } from "../src/fp-pcb-design";
import type { FpPcbSessions } from "../src/fp-pcb-session";
import { Footprint, type Board } from "@fp-pcb/client";
import {
  haveKicad,
  startKiCad,
  type RunningKiCad,
} from "../../../vendor/fab_pcb/packages/client/test/kicad-server";

describe.skipIf(!haveKicad())("embedded placement against KiCad", () => {
  test("move, rotate, flip and save failure recovery work without source libraries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-embedded-placement-"));
    const path = join(dir, "board.kicad_pcb");
    await cp(join(import.meta.dir, "fixtures/embedded-placement.kicad_pcb"), path);
    let server: RunningKiCad | undefined;
    let failSave = false;
    let failFlip = false;
    const openBoard = async (): Promise<Board> => {
      if (!server) server = await startKiCad(path, "fabdesk-placement");
      const board = (await server.kicad.currentBoard())!;
      const nativeFlip = board.flip.bind(board);
      board.flip = async (...args) => {
        const result = await nativeFlip(...args);
        if (failFlip) throw new Error("injected failure after native flip");
        return result;
      };
      const save = board.save.bind(board);
      board.save = async () => {
        await save();
        if (failSave) {
          failSave = false;
          throw new Error("injected save failure after write");
        }
      };
      return board;
    };
    const release = async () => {
      await server?.stop();
      server = undefined;
    };
    const design = createFpPcbDesign({
      bridge: () => ({}) as never,
      sessions: {
        board: openBoard,
        release,
        assertSchematicSaved: async () => {},
      } as unknown as FpPcbSessions,
    });
    try {
      const original = (await (await openBoard()).getFootprints()).find(
        (f) => f.reference === "J13",
      )!;
      const originalPads = new Map(original.pads.map((pad) => [pad.number, pad.position]));
      expect(originalPads.size).toBe(14);
      const unsavedBoard = await openBoard();
      const unsavedFile = await readFile(path, "utf8");
      const unsavedFootprint = original.clone();
      unsavedFootprint.locked = true;
      await unsavedBoard.commit("unsaved GUI-like edit", (tx) => tx.update([unsavedFootprint]));
      await expect(
        design.placeFootprints(dir, [{ reference: "J13", rotation: 90 }]),
      ).rejects.toThrow("save the open PCB");
      expect(await readFile(path, "utf8")).toBe(unsavedFile);
      expect(
        (await (await openBoard()).getFootprints()).find((f) => f.reference === "J13")!.locked,
      ).toBe(true);
      await unsavedBoard.save();
      const moved = await design.placeFootprints(dir, [
        {
          reference: "J13",
          position: { x: 20, y: 30 },
          rotation: 90,
          referenceField: { position: { x: 21, y: 34 } },
        },
      ]);
      expect(moved.moved).toEqual(["J13"]);
      await release();
      let saved = (await (await openBoard()).getFootprints()).find((f) => f.reference === "J13")!;
      expect(saved.orientation).toBe(90);
      expect(saved.position).toEqual({ x: 20000000, y: 30000000 });
      expect(saved.pads).toHaveLength(originalPads.size);
      for (const pad of saved.pads) {
        const before = originalPads.get(pad.number)!;
        expect(pad.position).toEqual({ x: 30000000 - before.x, y: 50000000 - before.y });
      }
      expect(saved.referenceField!.position).toEqual({ x: 21000000, y: 34000000 });
      expect(saved.id).toBe(original.id);
      const beforeFailure = await readFile(path, "utf8");
      failFlip = true;
      await expect(
        design.placeFootprints(dir, [
          { reference: "J13", rotation: -90, flip: true },
          { reference: "U1", rotation: 90 },
        ]),
      ).rejects.toThrow("injected failure after native flip");
      failFlip = false;
      expect(await readFile(path, "utf8")).toBe(beforeFailure);
      saved = (await (await openBoard()).getFootprints()).find((f) => f.reference === "J13")!;
      expect(saved.orientation).toBe(90);
      failSave = true;
      await expect(
        design.placeFootprints(dir, [{ reference: "J13", rotation: -90 }]),
      ).rejects.toThrow("injected save failure");
      expect(await readFile(path, "utf8")).toBe(beforeFailure);
      saved = (await (await openBoard()).getFootprints()).find((f) => f.reference === "J13")!;
      expect(saved.orientation).toBe(90);
      const retry = await design.placeFootprints(dir, [{ reference: "J13", rotation: -90 }]);
      expect(retry.moved).toEqual(["J13"]);
      await release();
      saved = (await (await openBoard()).getFootprints()).find((f) => f.reference === "J13")!;
      expect(saved.orientation).toBe(-90);
      for (const pad of saved.pads) {
        const before = originalPads.get(pad.number)!;
        expect(pad.position).toEqual({ x: before.x + 10000000, y: before.y + 10000000 });
      }
      const beforeFlipPads = new Map(saved.pads.map((pad) => [pad.number, pad.position]));
      const flip = await design.placeFootprints(dir, [
        { reference: "J13", flip: true, rotation: 90 },
      ]);
      expect(flip.moved).toEqual(["J13"]);
      await release();
      saved = (await (await openBoard()).getFootprints()).find((f) => f.reference === "J13")!;
      expect(saved).toBeInstanceOf(Footprint);
      expect(saved.isFlipped).toBe(true);
      expect(saved.orientation).toBe(90);
      expect(saved.pads[0]!.layers).toContain(saved.layerId);
      // Native left-right flip mirrors X at the anchor; the requested angle then rotates 180°.
      expect(saved.pads).toHaveLength(beforeFlipPads.size);
      for (const pad of saved.pads) {
        const before = beforeFlipPads.get(pad.number)!;
        expect(pad.position).toEqual({ x: before.x, y: 2 * saved.position.y - before.y });
        expect(pad.layers).toContain(saved.layerId);
      }
    } finally {
      await release();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
