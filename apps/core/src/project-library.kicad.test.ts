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
  } finally { await sessions.dispose(); await rm(dir, { recursive: true, force: true }); }
}, 120_000);
