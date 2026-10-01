import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFpPcbDesign } from "./fp-pcb-design";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { FpPcbSessions } from "./fp-pcb-session";
const url = process.env["FABDESK_FP_PCB_TEST_URL"];
const workspace = process.env["FABDESK_FP_PCB_TEST_WORKSPACE"];
test.skipIf(!url || !workspace)(
  "schematic edits report canonical IDs, preserve grid geometry and reject local failures without saved changes",
  async () => {
    const dir = await mkdtemp(join(workspace!, "schematic-contract-"));
    const bridge = new FpPcbBridgeClient({ url: url! });
    const sessions = new FpPcbSessions(() => bridge);
    const design = createFpPcbDesign({ bridge: () => bridge, sessions });
    try {
      const created = await design.schematicEdit(dir, {
        symbols: [
          {
            libId: "Device:R",
            reference: "R1",
            value: "1k",
            position: { x: 50.8, y: 50.8 },
            rotation: 90,
            mirrorX: true,
          },
          {
            libId: "Device:R",
            reference: "R2",
            value: "2k",
            position: { x: 101.6, y: 50.8 },
            rotation: 270,
            mirrorY: true,
          },
        ],
        connections: [
          {
            name: "A",
            nodes: [
              { reference: "R1", pin: "1" },
              { reference: "R2", pin: "1" },
            ],
          },
          {
            name: "B",
            nodes: [
              { reference: "R1", pin: "2" },
              { reference: "R2", pin: "2" },
            ],
          },
        ],
      });
      expect(created.revision).toBe(
        Number((await (await sessions.schematic(dir)).revision()) ?? 0n),
      );
      const snapshot = await design.schematicInspect(dir);
      const ids = new Set(
        [
          ...snapshot.symbols,
          ...snapshot.wires,
          ...snapshot.localLabels,
          ...snapshot.junctions,
        ].map((o) => o.id),
      );
      expect(created.changedObjectIds!.created.every((id) => ids.has(id))).toBe(true);
      const offGrid = { x: 120.01, y: 80.02 };
      const changed = await design.schematicEdit(dir, {
        sheet: snapshot.scope!.identity!,
        texts: [{ text: "grid probe", position: offGrid }],
      });
      expect(changed.gridProblems).toEqual([
        { object: "texts[0]", position: offGrid, gridSpacing: 1.27 },
      ]);
      expect(
        (await design.schematicInspect(dir)).texts.find((t) =>
          changed.changedObjectIds!.created.includes(t.id),
        )?.position,
      ).toEqual(offGrid);
      const paths = ["board.kicad_sch", "board.kicad_pro", "board.kicad_pcb"].map((f) =>
        join(dir, f),
      );
      const bytes = await Promise.all(paths.map((p) => readFile(p)));
      await expect(
        design.schematicEdit(dir, {
          symbolUpdates: [{ reference: "R1", position: { x: 152.4, y: 50.8 }, rotation: 180 }],
          deleteItemIds: ["missing-object"],
        }),
      ).rejects.toThrow("deleteItemIds: unknown object missing-object");
      expect(await Promise.all(paths.map((p) => readFile(p)))).toEqual(bytes);
      expect((await design.schematicInspect(dir)).symbols).toEqual(snapshot.symbols);
      await expect(
        design.schematicEdit(dir, { sheet: "missing-sheet", deleteItemIds: ["missing"] }),
      ).rejects.toThrow("sheet: expected one unambiguous");
      expect(await Promise.all(paths.map((p) => readFile(p)))).toEqual(bytes);
    } finally {
      await sessions.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
