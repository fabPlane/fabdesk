import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFpPcbDesign } from "./fp-pcb-design";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { FpPcbSessions } from "./fp-pcb-session";

const url = process.env["FABDESK_FP_PCB_TEST_URL"],
  workspace = process.env["FABDESK_FP_PCB_TEST_WORKSPACE"];
const fixtures = [
  ["Amplifier_Operational:LM358", 3, [[1, 2], [1, 3], [2, 3], [1, 2, 3], [1]]],
  ["Amplifier_Operational:LM324", 5, [[1, 3, 5]]],
  ["Timer:NE556", 2, [[1, 2]]],
  ["Comparator:LM393", 3, [[1, 2, 3]]],
  ["74xx:74HC00", 5, [[1, 2, 5]]],
] as const;

for (const [libId, count, selections] of fixtures)
  test.skipIf(!url || !workspace)(
    `native bulk instance transforms and metadata: ${libId}`,
    async () => {
      const dir = await mkdtemp(join(workspace!, "multiunit-edit-"));
      const bridge = new FpPcbBridgeClient({ url: url! }),
        sessions = new FpPcbSessions(() => bridge);
      const design = createFpPcbDesign({ bridge: () => bridge, sessions });
      try {
        await design.schematicEdit(dir, {
          symbols: Array.from({ length: count }, (_, index) => ({
            reference: "U7",
            unit: index + 1,
            libId,
            value: "part",
            fields: { TestNote: "before" },
            position: { x: 50.8 + index * 40.64, y: 50.8 },
          })),
        });
        const graph = async () =>
          (await (await sessions.ensureProject(dir)).schematic.netlist())
            .map((net) => ({
              name: net.name,
              ids: net.sheets.flatMap((sheet) => sheet.items.map((id) => id.value)).sort(),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        const beforeGraph = await graph();
        const root = await (await sessions.ensureProject(dir)).schematic.rootSheet();
        const pinIds = (await root.getSymbols())
          .flatMap((symbol) => symbol.pins.map((pin) => pin.id))
          .sort();
        for (const units of selections) {
          await design.schematicEdit(dir, {
            symbolUpdates: units.map((unit) => ({
              reference: "U7",
              unit,
              position: { x: 50.8 + unit * 40.64, y: 76.2 },
              rotation: 90,
              mirrorX: true,
            })),
          });
          expect(await graph()).toEqual(beforeGraph);
          expect(
            (await root.getSymbols()).flatMap((symbol) => symbol.pins.map((pin) => pin.id)).sort(),
          ).toEqual(pinIds);
          const snapshot = await design.schematicInspect(dir);
          for (const unit of units) {
            const position = snapshot.symbols.find((symbol) => symbol.unit === unit)?.position;
            expect(position?.x).toBeCloseTo(50.8 + unit * 40.64, 6);
            expect(position?.y).toBe(76.2);
          }
        }
        await expect(
          design.schematicEdit(dir, {
            symbolUpdates: [{ reference: "U7", unit: 1, value: "partial" }],
          }),
        ).rejects.toThrow("include every affected unit");
        await expect(
          design.schematicEdit(dir, {
            symbolUpdates: [{ reference: "U7", unit: 1, fields: { Value: "bypass" } }],
          }),
        ).rejects.toThrow("use newReference");
        await design.schematicEdit(dir, {
          symbolUpdates: Array.from({ length: count }, (_, index) => ({
            reference: "U7",
            unit: index + 1,
            value: "updated",
            fields: { TestNote: "after" },
            mirrorY: true,
          })),
        });
        expect(await graph()).toEqual(beforeGraph);
        for (const symbol of await root.getSymbols()) {
          expect(symbol.value).toBe("updated");
          expect(symbol.field("TestNote")?.text).toBe("after");
        }
      } finally {
        await sessions.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    },
    120000,
  );
