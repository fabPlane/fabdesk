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
    let poisonSecond = false;
    const openBoard = async (): Promise<Board> => {
      if (!server) server = await startKiCad(path, "fabdesk-placement");
      const board = (await server.kicad.currentBoard())!;
      const getFootprints = board.getFootprints.bind(board);
      board.getFootprints = async () => {
        const footprints = await getFootprints();
        if (poisonSecond) {
          const second = footprints.find((f) => f.reference === "U1")!;
          second.proto.definition!.items.push({
            $typeName: "google.protobuf.Any",
            typeUrl: "type.googleapis.com/unknown.Child",
            value: new Uint8Array(),
          });
        }
        return footprints;
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
      sessions: { board: openBoard, release } as unknown as FpPcbSessions,
    });
    try {
      const original = (await (await openBoard()).getFootprints()).find(
        (f) => f.reference === "J13",
      )!;
      const originalPad = original.pads[0]!.position;
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
      expect(saved.pads[0]!.position).toEqual({
        x: 30000000 - originalPad.x,
        y: 50000000 - originalPad.y,
      });
      expect(saved.referenceField!.position).toEqual({ x: 21000000, y: 34000000 });
      expect(saved.id).toBe(original.id);
      const beforeFailure = await readFile(path, "utf8");
      poisonSecond = true;
      await expect(
        design.placeFootprints(dir, [
          { reference: "J13", rotation: -90, flip: true },
          { reference: "U1", rotation: 90 },
        ]),
      ).rejects.toThrow("unknown footprint child");
      poisonSecond = false;
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
      expect(saved.pads[0]!.position).toEqual({
        x: originalPad.x + 10000000,
        y: originalPad.y + 10000000,
      });
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
    } finally {
      await release();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
