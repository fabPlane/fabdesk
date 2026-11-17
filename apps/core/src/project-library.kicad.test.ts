import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFpPcbDesign } from "./fp-pcb-design";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { FpPcbSessions } from "./fp-pcb-session";

const url = process.env["FABDESK_FP_PCB_TEST_URL"];
test.skipIf(!url)("real project library registration survives bundled table rewrites and resolves in the live session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "library-persistence-"));
  const bridge = new FpPcbBridgeClient({ url: url! });
  const sessions = new FpPcbSessions(() => bridge);
  const design = createFpPcbDesign({ bridge: () => bridge, sessions });
  try {
    await mkdir(join(dir, "SHT31Pilot.pretty"));
    await writeFile(join(dir, "SHT31Pilot.pretty/Sensor.kicad_mod"), '(footprint "Sensor" (version 20241229) (generator "pcbnew") (layer "F.Cu") (attr smd) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))');
    await design.registerLibrary!(dir, "footprint", "SHT31Pilot", "SHT31Pilot.pretty");
    const session = await sessions.session(dir);
    await sessions.preservingProjectLibraries(dir, session, () => bridge.registerBundledLibraries(session.id));
    expect(await readFile(join(dir, "fp-lib-table"), "utf8")).toContain("SHT31Pilot");
    expect(await design.describePart("footprint", "SHT31Pilot:Sensor", dir)).toMatchObject({ pads: [{ number: "1" }] });
    expect((await design.searchFootprints("Sensor", 10, dir)).some(hit => hit.libId === "SHT31Pilot:Sensor")).toBe(true);
    await mkdir(join(dir,"Updated.pretty"));
    await writeFile(join(dir,"Updated.pretty/Sensor.kicad_mod"), '(footprint "Sensor" (version 20241229) (generator "pcbnew") (layer "F.Cu") (attr smd) (pad "1" smd rect (at 0 0) (size 3 1) (layers "F.Cu" "F.Paste" "F.Mask")))');
    const tablePath=join(dir,"fp-lib-table");await writeFile(tablePath,(await readFile(tablePath,"utf8")).replaceAll("SHT31Pilot.pretty","Updated.pretty"));
    expect((await design.describePart("footprint","SHT31Pilot:Sensor",dir)).pads?.[0]?.size.x).toBe(3);
    const updated = join(dir,"Updated.pretty/Sensor.kicad_mod"); await writeFile(updated,(await readFile(updated,"utf8")).replace("(size 3 1)","(size 4 1)"));
    expect((await design.describePart("footprint","SHT31Pilot:Sensor",dir)).pads?.[0]?.size.x).toBe(4);

  } finally { await sessions.dispose(); await rm(dir, { recursive: true, force: true }); }
}, 120_000);

test.skipIf(!url)("compile uses project symbol and footprint overrides of bundled nicknames, including after reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "library-compile-override-"));
  const bridge = new FpPcbBridgeClient({ url: url! }), sessions = new FpPcbSessions(() => bridge);
  const design = createFpPcbDesign({ bridge: () => bridge, sessions });
  try {
    await mkdir(join(dir, "Override.pretty"));
    await writeFile(join(dir, "Override.pretty/R_0603_1608Metric.kicad_mod"), '(footprint "R_0603_1608Metric" (version 20241229) (generator "pcbnew") (layer "F.Cu") (attr smd) (pad "1" smd rect (at -3 0) (size 1.73 1.91) (layers "F.Cu" "F.Paste" "F.Mask")) (pad "2" smd rect (at 3 0) (size 1.73 1.91) (layers "F.Cu" "F.Paste" "F.Mask")))');
    await design.registerLibrary!(dir, "footprint", "Resistor_SMD", "Override.pretty");
    const session = await sessions.session(dir);
    const bundledDevice = (await session.kicad.libraries.tables("symbol", "project")).find(row => row.nickname === "Device")!;
    const symbolText = (await readFile(bundledDevice.uri, "utf8")).replaceAll('(name "~"', '(name "AUDIT_PIN"');
    expect(symbolText).toContain('name "AUDIT_PIN"');
    await writeFile(join(dir, "Device.kicad_sym"), symbolText);
    await design.registerLibrary!(dir, "symbol", "Device", "Device.kicad_sym");
    // Project URI overrides remain project-owned even with the bundled description.
    await session.kicad.libraries.addTableRow("symbol", "project", { nickname: "Device", uri: "${KIPRJMOD}/Device.kicad_sym", description: "Bundled KiCad symbol library", enabled: true }, true);

    const source = { netlist: { components: [{ ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0603_1608Metric", libSource: { lib: "Device", part: "R" } }], nets: [{ name: "TEST", nodes: [{ ref: "R1", pin: "1" }, { ref: "R1", pin: "2" }] }] }, board: { widthMm: 30, heightMm: 20 } };
    const text = JSON.stringify(source); await writeFile(join(dir, "circuit.netlist.json"), text);
    const built = await design.build({ projectDir: dir });
    expect(built.errors).toEqual([]); expect(built.ok).toBe(true);
    const widths = (await design.query(dir, "pads")).map(pad => pad["width"]);
    expect(widths).toEqual([1.73, 1.73]);
    expect(await readFile(join(dir, "board.kicad_sch"), "utf8")).toContain("AUDIT_PIN");
    await sessions.release(dir);
    expect((await design.describePart("footprint", "Resistor_SMD:R_0603_1608Metric", dir)).pads?.map(pad => pad.size.x)).toEqual([1.73, 1.73]);
    expect(await readFile(join(dir, "circuit.netlist.json"), "utf8")).toBe(text);
    await design.schematicEdit(dir, { symbolUpdates: [{ reference: "R1", fields: { Manufacturer: "AUDIT_FIELD", MPN: "AUDIT-ORDER-CODE" } }] });
    expect(await readFile(join(dir, "board.kicad_sch"), "utf8")).toContain("AUDIT_FIELD");
    await design.syncSchematicToPcb(dir, false);
    expect(await readFile(join(dir, "board.kicad_pcb"), "utf8")).toContain("AUDIT-ORDER-CODE");

  } finally { await sessions.dispose(); await rm(dir, { recursive: true, force: true }); }
}, 120_000);
