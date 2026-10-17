import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runErc } from "@fabdesk/kicad";
import { createFpPcbDesign } from "./fp-pcb-design";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { FpPcbSessions } from "./fp-pcb-session";
const url = process.env["FABDESK_FP_PCB_TEST_URL"];
const workspace = process.env["FABDESK_FP_PCB_TEST_WORKSPACE"];
test.skipIf(!url || !workspace)(
  "cross-sheet multi-unit metadata rejection gives feasible guidance and preserves both files",
  async () => {
    const dir = await mkdtemp(join(workspace!, "multiunit-cross-sheet-"));
    const bridge = new FpPcbBridgeClient({ url: url! });
    const sessions = new FpPcbSessions(() => bridge);
    const design = createFpPcbDesign({ bridge: () => bridge, sessions });
    const unit = (number: number) => ({
      libId: "Amplifier_Operational:LM358",
      reference: "U7",
      unit: number,
      value: "LM358",
      position: { x: 50.8, y: 50.8 },
    });
    try {
      await design.schematicEdit(dir, { symbols: [unit(1)] });
      const schematic = await sessions.schematic(dir);
      await schematic.newSheet({
        name: "other-unit",
        filename: "other-unit.kicad_sch",
        position: { x: 150_000_000, y: 100_000_000 },
      });
      await schematic.save();
      const child = await design.schematicInspect(dir, "other-unit.kicad_sch");
      await design.schematicEdit(dir, { sheet: child.scope!.identity!, symbols: [unit(2)] });
      const paths = ["board.kicad_sch", "other-unit.kicad_sch"].map((name) => join(dir, name));
      const before = await Promise.all(paths.map((path) => readFile(path)));
      await expect(
        design.schematicEdit(dir, {
          symbolUpdates: [{ reference: "U7", unit: 1, value: "new value" }],
        }),
      ).rejects.toThrow("different sheets");
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
      for (const sheet of [undefined, "other-unit.kicad_sch"])
        expect((await design.schematicInspect(dir, sheet)).symbols[0]?.value).toBe("LM358");
      await design.schematicEdit(dir, {
        symbolUpdates: [{ reference: "U7", unit: 1, position: { x: 76.2, y: 50.8 } }],
      });
      expect((await design.schematicInspect(dir)).symbols[0]?.position.x).toBe(76.2);
      expect(
        (await design.schematicInspect(dir, "other-unit.kicad_sch")).symbols[0]?.position.x,
      ).toBe(50.8);
    } finally {
      await sessions.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

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
      ).rejects.toThrow("sheet: schematic sheet not found");
      expect(await Promise.all(paths.map((p) => readFile(p)))).toEqual(bytes);
      const added = await design.schematicEdit(dir, {
        symbols: [
          { libId: "Device:R", reference: "R3", value: "3k", position: { x: 152.4, y: 50.8 } },
        ],
      });
      expect(added.changedObjectIds!.updated).toEqual([]);
      expect(added.updated.symbols).toBe(0);
    } finally {
      await sessions.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);

test.skipIf(!url || !workspace || !process.env["KICAD_CLI"])(
  "sub-sheet power edits normalize their own native file and reject project-wide duplicate references",
  async () => {
    const dir = await mkdtemp(join(workspace!, "schematic-hierarchy-"));
    const bridge = new FpPcbBridgeClient({ url: url! }),
      sessions = new FpPcbSessions(() => bridge);
    const design = createFpPcbDesign({ bridge: () => bridge, sessions });
    try {
      await design.schematicEdit(dir, {
        symbols: [
          { libId: "Device:R", reference: "R1", value: "1k", position: { x: 50.8, y: 50.8 } },
        ],
      });
      const sch = await sessions.schematic(dir);
      await sch.newSheet({
        name: "power",
        filename: "power.kicad_sch",
        position: { x: 150_000_000, y: 100_000_000 },
      });
      await sch.save();
      const root = await design.schematicInspect(dir),
        child = await design.schematicInspect(dir, "power.kicad_sch");
      const paths = ["board.kicad_sch", "power.kicad_sch"].map((name) => join(dir, name));
      const before = await Promise.all(paths.map((path) => readFile(path)));
      await expect(
        design.schematicEdit(dir, {
          sheet: child.scope!.identity!,
          symbols: [
            { libId: "Device:R", reference: "R1", value: "2k", position: { x: 50.8, y: 50.8 } },
          ],
        }),
      ).rejects.toThrow("hierarchy already contains R1");
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(before);
      const edited = await design.schematicEdit(dir, {
        sheet: child.scope!.identity!,
        symbols: [
          { libId: "power:GND", reference: "#PWR01", value: "GND", position: { x: 50.8, y: 50.8 } },
          { libId: "Device:R", reference: "R2", value: "2k", position: { x: 76.2, y: 50.8 } },
        ],
      });
      expect(edited.changedObjectIds!.updated).toEqual([]);
      expect((await design.schematicInspect(dir)).symbols).toEqual(root.symbols);
      expect(await readFile(join(dir, "power.kicad_sch"), "utf8")).toMatch(
        /\(symbol "power:GND"\s+\(power\)/,
      );
      const result = await runErc(
        { path: process.env["KICAD_CLI"]!, version: "integration" },
        {
          schematic: join(dir, "board.kicad_sch"),
          outFile: join(dir, "hierarchy-erc.json"),
          severity: "all",
        },
      );
      expect(
        result.violations.filter((v) =>
          /lib_symbol_mismatch|library.*mismatch/i.test(JSON.stringify(v)),
        ),
      ).toEqual([]);
      const after = await Promise.all(paths.map((path) => readFile(path)));
      await expect(
        design.schematicEdit(dir, {
          sheet: child.scope!.identity!,
          symbolUpdates: [{ reference: "R2", newReference: "R1" }],
        }),
      ).rejects.toThrow("existing reference R1");
      expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(after);
    } finally {
      await sessions.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
