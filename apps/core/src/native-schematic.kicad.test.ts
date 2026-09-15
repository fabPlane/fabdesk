import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFpPcbDesign } from "./fp-pcb-design";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { FpPcbSessions } from "./fp-pcb-session";

const url = process.env["FABDESK_FP_PCB_TEST_URL"];
const workspace = process.env["FABDESK_FP_PCB_TEST_WORKSPACE"];

describe.skipIf(!url || !workspace)("optional native schematic capabilities", () => {
  let sessions: FpPcbSessions | undefined;
  let projectDir = "";

  afterAll(async () => {
    await sessions?.dispose();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  test("edit native schematic, ERC, forward annotate, outline and place", async () => {
    const bridge = new FpPcbBridgeClient({ url: url! });
    sessions = new FpPcbSessions(() => bridge, {
      clientName: "fabdesk/native-schematic-integration",
    });
    const design = createFpPcbDesign({ bridge: () => bridge, sessions });
    projectDir = await mkdtemp(join(workspace!, "traditional-"));
    const edited = await design.schematicEdit(projectDir, {
      symbols: [
        {
          libId: "Device:R",
          reference: "R1",
          value: "1k",
          footprint: "Resistor_SMD:R_0603_1608Metric",
          position: { x: 30.48, y: 25.4 },
        },
        {
          libId: "Device:R",
          reference: "R2",
          value: "2k2",
          footprint: "Resistor_SMD:R_0603_1608Metric",
          position: { x: 50.8, y: 25.4 },
        },
      ],
      connections: [
        {
          name: "LEFT",
          nodes: [
            { reference: "R1", pin: "1" },
            { reference: "R2", pin: "1" },
          ],
        },
        {
          name: "RIGHT",
          nodes: [
            { reference: "R1", pin: "2" },
            { reference: "R2", pin: "2" },
          ],
        },
      ],
      save: true,
    });
    expect(edited.created.symbols).toBe(2);
    expect(edited.created.wires).toBeGreaterThanOrEqual(2);

    const schematic = await design.schematicInspect(projectDir);
    expect(schematic.symbols.map((symbol) => symbol.reference).sort()).toEqual(["R1", "R2"]);
    expect(schematic.nets.map((net) => net.name)).toEqual(
      expect.arrayContaining(["/LEFT", "/RIGHT"]),
    );
    expect(schematic.erc.errors).toBe(0);

    const preview = await design.syncSchematicToPcb(projectDir, true);
    expect(preview.ok).toBe(true);
    expect(preview.saved).toBe(false);
    expect(preview.update.newFootprints).toBe(2);
    const applied = await design.syncSchematicToPcb(projectDir, false);
    expect(applied).toMatchObject({ ok: true, parity: 0, saved: true });

    const outline = await design.defineBoardOutline(
      projectDir,
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 15 },
        { x: 0, y: 15 },
      ],
      false,
    );
    expect(outline.created).toBe(4);
    const placed = await design.placeFootprints(projectDir, [
      { reference: "R1", position: { x: 8, y: 7.5 }, rotation: 90 },
      { reference: "R2", position: { x: 22, y: 7.5 } },
    ]);
    expect(placed.missing).toEqual([]);
    expect(placed.moved.sort()).toEqual(["R1", "R2"]);
    expect(placed.libraryNormalized).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
