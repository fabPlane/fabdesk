/** Saved-file regressions for the native authoring path behind schematic_edit. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LibSymbol, mm, placeNativeSymbol } from "@fp-pcb/client";
import { runErc, runKicadCli } from "@fabdesk/kicad";
import type { NativeSchematicConnectionInput, NativeSchematicSymbolInput } from "@fabdesk/tools";
import { createFpPcbDesign } from "./fp-pcb-design";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { FpPcbSessions } from "./fp-pcb-session";

const url = process.env["FABDESK_FP_PCB_TEST_URL"];
const workspace = process.env["FABDESK_FP_PCB_TEST_WORKSPACE"];
const cliPath = process.env["KICAD_CLI"];
const cli = { path: cliPath!, version: "integration" };

async function savedNets(projectDir: string) {
  const output = join(projectDir, "saved.xml");
  await runKicadCli(cli, [
    "sch",
    "export",
    "netlist",
    "--format",
    "kicadxml",
    "-o",
    output,
    join(projectDir, "board.kicad_sch"),
  ]);
  const xml = await readFile(output, "utf8");
  const nets: Record<string, string[]> = {};
  const attribute = (text: string, name: string) =>
    new RegExp(`\\b${name}="([^"]*)"`).exec(text)![1]!;
  for (const match of xml.matchAll(/<net\b([^>]*)>([\s\S]*?)<\/net>/g))
    nets[attribute(match[1]!, "name").replace(/^\//, "")] = [
      ...match[2]!.matchAll(/<node\b([^>]*)\/?\s*>/g),
    ]
      .map((node) => `${attribute(node[1]!, "ref")}:${attribute(node[1]!, "pin")}`)
      .sort();
  return nets;
}

async function savedErc(projectDir: string) {
  const report = await runErc(cli, {
    schematic: join(projectDir, "board.kicad_sch"),
    outFile: join(projectDir, "saved-erc.json"),
    severity: "all",
  });
  expect(report.counts, JSON.stringify(report.violations)).toEqual({ errors: 0, warnings: 0 });
}

async function fixture(
  run: (
    design: ReturnType<typeof createFpPcbDesign>,
    sessions: FpPcbSessions,
    dir: string,
  ) => Promise<void>,
) {
  const dir = await mkdtemp(join(workspace!, "native-connectivity-"));
  const bridge = new FpPcbBridgeClient({ url: url! });
  const sessions = new FpPcbSessions(() => bridge, {
    clientName: "fabdesk/saved-native-connectivity",
  });
  try {
    await run(createFpPcbDesign({ bridge: () => bridge, sessions }), sessions, dir);
  } finally {
    await sessions.dispose();
    if (process.env["FABDESK_KEEP_TEST_PROJECT"] !== "1")
      await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!url || !workspace || !cliPath)("native saved connectivity", () => {
  test(
    "reopened symbols retain exact net endpoints through combined move/rotate/mirror/connect",
    async () =>
      fixture(async (design, sessions, dir) => {
        const symbols: NativeSchematicSymbolInput[] = [];
        const connections: NativeSchematicConnectionInput[] = [];
        const expected: Record<string, string[]> = {};
        const transforms: Array<{
          rotation: 0 | 90 | 180 | 270;
          mirrorX: boolean;
          mirrorY: boolean;
        }> = [];
        for (const rotation of [0, 90, 180, 270] as const)
          for (const mirrorX of [false, true])
            for (const mirrorY of [false, true]) {
              const index = transforms.length;
              transforms.push({ rotation, mirrorX, mirrorY });
              for (let member = 0; member < 2; member++)
                symbols.push({
                  libId: "Connector_Generic:Conn_01x02",
                  reference: `J${index * 2 + member + 1}`,
                  value: "probe",
                  position: {
                    x: 30.48 + (index % 4) * 60.96 + member * 25.4,
                    y: 30.48 + Math.floor(index / 4) * 30.48,
                  },
                });
              for (const pin of ["1", "2"]) {
                const name = `CASE_${index}_PIN_${pin}`;
                const references = [`J${index * 2 + 1}`, `J${index * 2 + 2}`];
                connections.push({
                  name,
                  nodes: references.map((reference) => ({ reference, pin })),
                });
                expected[name] = references.map((reference) => `${reference}:${pin}`).sort();
              }
            }
        await design.schematicEdit(dir, { symbols, connections, save: true });
        await sessions.restart(dir);
        const before = await savedNets(dir);
        expect(before).toEqual(expected);
        await savedErc(dir);
        const snapshot = await design.schematicInspect(dir);
        await design.schematicEdit(dir, {
          symbolUpdates: symbols.map((symbol, index) => ({
            reference: symbol.reference,
            position: { x: symbol.position.x + 5.08, y: symbol.position.y + 7.62 },
            ...transforms[Math.floor(index / 2)]!,
          })),
          deleteItemIds: [...snapshot.wires, ...snapshot.localLabels, ...snapshot.globalLabels].map(
            (item) => item.id,
          ),
          connections,
          save: true,
        });
        await sessions.restart(dir);
        expect(await savedNets(dir)).toEqual(before);
        await savedErc(dir);
        // Inspection must give sheet endpoints: each reported pin starts one saved authoring wire.
        const after = await design.schematicInspect(dir);
        for (const symbol of after.symbols)
          for (const pin of symbol.pins)
            expect(
              after.wires.some(
                (wire) => wire.start.x === pin.position.x && wire.start.y === pin.position.y,
              ),
            ).toBe(true);
        // A newly placed pin and existing pins in one edit must share the same coordinate convention.
        await design.schematicEdit(dir, {
          symbols: [
            {
              libId: "Connector_Generic:Conn_01x02",
              reference: "J33",
              value: "mixed",
              position: { x: 30.48, y: 177.8 },
              rotation: 270,
              mirrorX: true,
            },
          ],
          connections: ["1", "2"].map((pin) => ({
            name: `CASE_0_PIN_${pin}`,
            nodes: [
              { reference: "J1", pin },
              { reference: "J33", pin },
            ],
          })),
        });
        for (const pin of ["1", "2"]) expected[`CASE_0_PIN_${pin}`]!.push(`J33:${pin}`);
        for (const nodes of Object.values(expected)) nodes.sort();
        await sessions.restart(dir);
        expect(await savedNets(dir)).toEqual(expected);
        await savedErc(dir);
      }),
    120_000,
  );

  test(
    "direct existing-symbol connections use sheet endpoints after reopen",
    async () =>
      fixture(async (design, sessions, dir) => {
        await design.schematicEdit(dir, {
          symbols: [1, 2].map((index) => ({
            libId: "Connector_Generic:Conn_01x02",
            reference: `J${index}`,
            value: "direct",
            position: { x: 30.48 + index * 25.4, y: 50.8 },
          })),
        });
        await sessions.restart(dir);
        await design.schematicEdit(dir, {
          symbolUpdates: [
            { reference: "J1", position: { x: 55.88, y: 76.2 } },
            { reference: "J2", position: { x: 81.28, y: 76.2 } },
          ],
          connections: ["1", "2"].map((pin) => ({
            name: `P${pin}`,
            label: "none" as const,
            nodes: [
              { reference: "J1", pin },
              { reference: "J2", pin },
            ],
          })),
        });
        await sessions.restart(dir);
        expect(Object.values(await savedNets(dir)).sort()).toEqual([
          ["J1:1", "J2:1"],
          ["J1:2", "J2:2"],
        ]);
        await savedErc(dir);
      }),
    60_000,
  );

  test(
    "multi-unit and alternate-body symbols connect only their selected pins after reopen",
    async () =>
      fixture(async (design, sessions, dir) => {
        const children: string[] = [];
        for (const unit of [1, 2])
          for (const style of [1, 2]) {
            const x = (unit === 1 ? -1 : 1) * (style === 1 ? 5.08 : 7.62);
            const y = style === 1 ? 2.54 : 5.08;
            children.push(`(symbol "Dual_${unit}_${style}"
        (pin passive line (at ${x} ${y} 0) (length 2.54) (name "PIN" (effects (font (size 1.27 1.27)))) (number "${unit * 2 - 1}" (effects (font (size 1.27 1.27)))))
        (pin passive line (at ${x} ${-y} 0) (length 2.54) (name "PIN" (effects (font (size 1.27 1.27)))) (number "${unit * 2}" (effects (font (size 1.27 1.27))))))`);
          }
        const library = join(dir, "Probe.kicad_sym");
        await writeFile(
          library,
          `(kicad_symbol_lib (version 20250114) (generator "kicad_symbol_editor")
      (symbol "Dual" (body_styles "Standard" "Alternate") (pin_names (offset 0)) (in_bom yes) (on_board yes)
        (property "Reference" "U" (at 0 10.16 0) (effects (font (size 1.27 1.27))))
        (property "Value" "Dual" (at 0 -10.16 0) (effects (font (size 1.27 1.27))))
        ${children.join("\n")}))`,
        );
        let project = await sessions.ensureProject(dir);
        await project.session.kicad.libraries.addTableRow("symbol", "project", {
          nickname: "Probe",
          uri: library,
          type: "KiCad",
          enabled: true,
        });
        await design.schematicEdit(dir, {
          symbols: [
            {
              libId: "Probe:Dual",
              reference: "U1",
              value: "Dual",
              unit: 2,
              bodyStyle: 2,
              rotation: 90,
              mirrorY: true,
              position: { x: 101.6, y: 60.96 },
            },
            {
              libId: "Connector_Generic:Conn_01x02",
              reference: "J1",
              value: "unit2",
              position: { x: 152.4, y: 60.96 },
            },
          ],
          connections: ["3", "4"].map((pin, index) => ({
            name: `UNIT2_PIN${pin}`,
            nodes: [
              { reference: "U1", pin },
              { reference: "J1", pin: String(index + 1) },
            ],
          })),
        });
        project = await sessions.ensureProject(dir);
        const definition = await project.session.kicad.libraries.symbols.get("Probe:Dual");
        if (!(definition instanceof LibSymbol))
          throw new Error("multi-unit definition unavailable");
        // Seed the companion unit through native IPC: the high-level create API rejects repeated
        // references, but connections must work with ordinary existing multi-unit KiCad schematics.
        const companion = placeNativeSymbol(definition, {
          reference: "U1",
          value: "Dual",
          footprint: "",
          unit: 1,
          bodyStyle: 2,
          rotation: 270,
          mirrorX: true,
          position: { x: mm(50.8), y: mm(60.96) },
        });
        await (
          await project.schematic.rootSheet()
        ).commit("test companion unit", (tx) => tx.create([companion.symbol]));
        await project.schematic.save();
        await sessions.restart(dir);
        await design.schematicEdit(dir, {
          symbols: [
            {
              libId: "Connector_Generic:Conn_01x02",
              reference: "J2",
              value: "unit1",
              position: { x: 25.4, y: 60.96 },
            },
          ],
          connections: ["1", "2"].map((pin) => ({
            name: `UNIT1_PIN${pin}`,
            nodes: [
              { reference: "U1", pin },
              { reference: "J2", pin },
            ],
          })),
        });
        await sessions.restart(dir);
        expect(await savedNets(dir)).toEqual({
          UNIT1_PIN1: ["J2:1", "U1:1"],
          UNIT1_PIN2: ["J2:2", "U1:2"],
          UNIT2_PIN3: ["J1:1", "U1:3"],
          UNIT2_PIN4: ["J1:2", "U1:4"],
        });
        await savedErc(dir);
      }),
    90_000,
  );

  test(
    "the advertised inherited timer pins survive native creation and reopen",
    async () =>
      fixture(async (design, sessions, dir) => {
        const { session } = await sessions.ensureProject(dir);
        const discovered = await session.kicad.libraries.symbols.get("Timer:TLC555xD");
        if (!(discovered instanceof LibSymbol))
          throw new Error("timer library definition unavailable");
        expect(discovered.pins.map((pin) => pin.number).sort()).toEqual([
          "1",
          "2",
          "3",
          "4",
          "5",
          "6",
          "7",
          "8",
        ]);
        // A timer with its inputs driven by its own output and power driven by flags makes the
        // isolated pin-resolution fixture electrically checkable without modelling a complete timer.
        const connections: NativeSchematicConnectionInput[] = [
          {
            name: "VCC",
            nodes: [
              { reference: "U1", pin: "8" },
              { reference: "C1", pin: "1" },
            ],
          },
          {
            name: "GND",
            nodes: [
              { reference: "C1", pin: "2" },
              { reference: "U1", pin: "1" },
              { reference: "R1", pin: "2" },
            ],
          },
          {
            name: "CONTROL",
            nodes: [
              { reference: "U1", pin: "5" },
              { reference: "R1", pin: "1" },
            ],
          },
          {
            name: "SIGNAL",
            nodes: ["2", "3", "4", "6", "7"].map((pin) => ({ reference: "U1", pin })),
          },
        ];
        await design.schematicEdit(dir, {
          symbols: [
            { libId: "Device:C", reference: "C1", value: "100n", position: { x: 127, y: 101.6 } },
            { libId: "Device:R", reference: "R1", value: "10k", position: { x: 101.6, y: 50.8 } },
            {
              libId: "Timer:TLC555xD",
              reference: "U1",
              value: "TLC555ID",
              position: { x: 76.2, y: 76.2 },
            },
            {
              libId: "power:PWR_FLAG",
              reference: "#FLG01",
              value: "PWR_FLAG",
              position: { x: 78.74, y: 30.48 },
            },
            {
              libId: "power:PWR_FLAG",
              reference: "#FLG02",
              value: "PWR_FLAG",
              position: { x: 76.2, y: 96.52 },
            },
          ],
          connections,
          wires: [
            { start: { x: 78.74, y: 30.48 }, end: { x: 78.74, y: 66.04 } },
            { start: { x: 76.2, y: 96.52 }, end: { x: 76.2, y: 86.36 } },
          ],
        });
        await sessions.restart(dir);
        expect(Object.values(await savedNets(dir)).sort()).toEqual(
          [
            ["C1:1", "U1:8"],
            ["C1:2", "R1:2", "U1:1"],
            ["R1:1", "U1:5"],
            ["U1:2", "U1:3", "U1:4", "U1:6", "U1:7"],
          ].sort(),
        );
        expect(
          (await design.schematicInspect(dir)).symbols
            .find((symbol) => symbol.reference === "U1")!
            .pins.map((pin) => pin.number)
            .sort(),
        ).toEqual(discovered!.pins.map((pin) => pin.number).sort());
        await savedErc(dir);
      }),
    60_000,
  );
});
