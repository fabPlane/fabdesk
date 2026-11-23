import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { boardFileRows, boardLayerId } from "../src/board-file-rows";
import type { DesignSelect } from "../src/services";
import { contextFactory, mockServices, tempProject } from "./mock-services";

/** What the bridge answers for a board saved by KiCad nightly (as seen in held-out eval runs). */
const TOO_NEW =
  "FabPlane PCB bridge 502 on /sessions: socket connection was closed by peer --- kicad-cli output --- Failed to load board: KiCad was unable to open this file because it was created with a more recent version than the one you are running. To open it you will need to upgrade KiCad to version 10.99 or later (file format dated 20261025 or later).";

/** A small board in the nightly format: `transform` poses, nets by name, no net table. */
const NIGHTLY_BOARD = `(kicad_pcb
	(version 20261025)
	(generator "pcbnew")
	(generator_version "10.99")
	(layers
		(0 "F.Cu" signal)
		(2 "B.Cu" signal)
		(5 "F.SilkS" user "F.Silkscreen")
		(25 "Edge.Cuts" user)
		(31 "F.CrtYd" user "F.Courtyard")
	)
	(footprint "Resistor_SMD:R_0603_1608Metric"
		(layer "F.Cu")
		(uuid "fp-r1")
		(transform
			(translate 10 20)
			(rotate 90)
			(scale 1 1)
		)
		(property "Reference" "R1" (at 0 -1.4 90) (layer "F.SilkS") (uuid "r1-ref"))
		(property "Value" "10k" (at 0 1.4 90) (layer "F.Fab") (uuid "r1-val"))
		(fp_line (start -1.5 -0.7) (end 1.5 -0.7) (stroke (width 0.05) (type solid)) (layer "F.CrtYd") (uuid "r1-crt"))
		(pad "1" smd roundrect (at -0.8 0 90) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net "VIN") (uuid "r1-p1"))
		(pad "2" smd roundrect (at 0.8 0 90) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net "GND") (uuid "r1-p2"))
	)
	(footprint "Connector:Header_1x02"
		(layer "B.Cu")
		(locked yes)
		(uuid "fp-j1")
		(transform
			(translate 30 20)
			(rotate 0)
			(scale 1 1)
		)
		(property "Reference" "J1" (at 0 -2 0) (layer "B.SilkS") (uuid "j1-ref"))
		(property "Value" "CONN" (at 0 2 0) (layer "B.Fab") (uuid "j1-val"))
		(pad "1" thru_hole rect (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net "GND") (uuid "j1-p1"))
		(pad "2" thru_hole circle (at 2.54 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net "VIN") (uuid "j1-p2"))
		(pad "" np_thru_hole circle (at 5 0) (size 2 2) (drill 2) (layers "*.Cu" "*.Mask") (uuid "j1-mh"))
	)
	(gr_line (start 0 0) (end 50 0) (stroke (width 0.05) (type solid)) (layer "Edge.Cuts") (uuid "edge-1"))
	(gr_text "HELLO" (at 25 5 0) (layer "F.SilkS") (uuid "txt-1") (effects (font (size 1 1.2) (thickness 0.15))))
	(segment (start 10 19.2) (end 30 20) (width 0.25) (layer "F.Cu") (net "GND") (uuid "seg-gnd"))
	(arc (start 10 20.8) (mid 20 23) (end 32.54 20) (width 0.25) (layer "B.Cu") (net "VIN") (uuid "arc-vin"))
	(via (at 20 30) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "via-gnd"))
	(zone (net "GND") (layer "B.Cu") (uuid "zone-gnd") (name "GND pour") (connect_pads (clearance 0.2)) (min_thickness 0.25) (fill yes)
		(polygon (pts (xy 0 25) (xy 50 25) (xy 50 40) (xy 0 40))))
	(zone (layers "F.Cu" "B.Cu") (uuid "keep-1") (connect_pads (clearance 0)) (min_thickness 0.25)
		(keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
		(polygon (pts (xy 40 30) (xy 45 30) (xy 45 35))))
)
`;

async function setup(query: (select: DesignSelect) => Promise<Array<Record<string, unknown>>>) {
  const reg = createRegistry();
  const project = await tempProject("nightly-inspect");
  await writeFile(join(project.dir, "board.kicad_pcb"), NIGHTLY_BOARD);
  const base = mockServices([project]);
  let calls = 0;
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (_dir, select) => {
        calls++;
        return query(select);
      },
    },
  });
  const factory = contextFactory(services, project);
  const inspect = (args: Record<string, unknown>) =>
    reg.invoke("pcb_inspect", args, (ref) =>
      factory({ def: reg.get("pcb_inspect")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }),
    );
  return { inspect, calls: () => calls };
}

const tooNew = () => setup(async () => {
  throw new Error(TOO_NEW);
});

describe("pcb_inspect on a board newer than the bridge's KiCad", () => {
  test("answers components, pads and nets from the file and says so", async () => {
    const { inspect, calls } = await tooNew();
    const result = await inspect({ kinds: ["components", "pads", "nets"] });
    const json = result.json as any;
    // The bridge is asked once; after its refusal every kind comes from the file.
    expect(calls()).toBe(1);
    expect(json.source).toMatchObject({ reader: "file", fileVersion: 20261025, kinds: ["components", "pads", "nets"], unavailable: {} });
    expect(json.source.reason).toContain("KiCad 10.99 or later, file format 20261025");
    expect(result.text).toContain("Read board.kicad_pcb directly: the PCB bridge's KiCad is older than this board");
    expect(json.contract).toEqual({ name: "fabdesk.pcb-inspection", version: "2.0.0" });
    expect(json.revision).toMatch(/^[0-9a-f]{64}$/);

    expect(json.results.components.rows).toEqual([
      { ref: "R1", value: "10k", footprint: "Resistor_SMD:R_0603_1608Metric", x: 10, y: 20, layer: 3, rotation: 90, flipped: false, locked: false },
      { ref: "J1", value: "CONN", footprint: "Connector:Header_1x02", x: 30, y: 20, layer: 34, rotation: 0, flipped: true, locked: true },
    ]);

    const pads = json.results.pads.rows as any[];
    expect(json.results.pads.total).toBe(5);
    // R1 is turned 90 degrees: local (-0.8, 0) lands 0.8 mm below its origin (KiCad y is down).
    expect(pads.find((p) => p.id === "r1-p1")).toEqual({
      component: "R1", number: "1", net: "VIN", x: 10, y: 20.8, width: 0.8, height: 0.95, id: "r1-p1", layer: 3, layers: [3], layerNames: ["F.Cu"],
    });
    expect(pads.find((p) => p.id === "r1-p2")).toMatchObject({ x: 10, y: 19.2, net: "GND" });
    // Through-hole pads span every copper layer; the mounting hole has no net.
    expect(pads.find((p) => p.id === "j1-p2")).toMatchObject({ component: "J1", x: 32.54, y: 20, layers: [3, 34], layerNames: ["F.Cu", "B.Cu"] });
    expect(pads.find((p) => p.id === "j1-mh")).toMatchObject({ number: "", net: "", x: 35, y: 20 });

    expect(json.results.nets.rows).toEqual([
      { name: "GND", pads: 2 },
      { name: "VIN", pads: 2 },
    ]);
  });

  test("filters (references, nets, layers, region, near, limits) work on file rows", async () => {
    const { inspect } = await tooNew();
    const byRef = (await inspect({ kinds: ["pads", "tracks", "vias", "zones"], references: ["J1"] })).json as any;
    expect((byRef.results.pads.rows as any[]).map((p) => p.id)).toEqual(["j1-p1", "j1-p2", "j1-mh"]);
    // the GND segment and the VIN arc both end on J1 pads; the via is not on one
    expect((byRef.results.tracks.rows as any[]).map((t) => t.id).sort()).toEqual(["arc-vin", "seg-gnd"]);
    expect(byRef.results.vias.total).toBe(0);

    const backGnd = (await inspect({ kinds: ["pads", "vias", "zones"], nets: ["GND"], layers: ["B.Cu"] })).json as any;
    expect((backGnd.results.pads.rows as any[]).map((p) => p.id)).toEqual(["j1-p1"]);
    expect((backGnd.results.vias.rows as any[]).map((v) => v.id)).toEqual(["via-gnd"]);
    expect(backGnd.results.zones.rows).toEqual([
      expect.objectContaining({ id: "zone-gnd", name: "GND pour", net: "GND", layers: [34], clearance: 0.2, minThickness: 0.25, filled: false }),
    ]);

    const region = (await inspect({ kinds: ["pads", "zones", "keepouts"], region: { minX: 41, minY: 31, maxX: 42, maxY: 32 } })).json as any;
    expect(region.results.pads.total).toBe(0);
    expect((region.results.zones.rows as any[]).map((z) => z.id)).toEqual(["zone-gnd"]);
    expect((region.results.keepouts.rows as any[]).map((z) => z.id)).toEqual(["keep-1"]);
    expect(region.results.keepouts.rows[0].layers).toEqual([3, 34]);

    const near = (await inspect({ kinds: ["vias", "texts", "board_geometry"], near: { x: 25, y: 1, radius: 4.5 } })).json as any;
    expect(near.results.vias.total).toBe(0);
    expect(near.results.texts.rows).toEqual([
      expect.objectContaining({ id: "txt-1", text: "HELLO", x: 25, y: 5, layer: 40, size: { x: 1.2, y: 1 }, thickness: 0.15 }),
    ]);
    expect(near.results.board_geometry.rows).toEqual([
      expect.objectContaining({ id: "edge-1", owner: "board", kind: "segment", layer: 47, start: { x: 0, y: 0 }, end: { x: 50, y: 0 } }),
    ]);

    const limited = (await inspect({ kinds: ["pads"], limitPerKind: 2 })).json as any;
    expect(limited.results.pads).toMatchObject({ total: 5, returned: 2, truncated: true });

    const crt = (await inspect({ kinds: ["footprint_geometry"], references: ["R1"] })).json as any;
    // the courtyard line turns with R1: local (-1.5, -0.7) -> board (9.3, 21.5)
    expect(crt.results.footprint_geometry.rows).toEqual([
      expect.objectContaining({ id: "r1-crt", owner: "R1", layer: 50, start: { x: 9.3, y: 21.5 }, end: { x: 9.3, y: 18.5 } }),
    ]);
  });

  test("unrouted is reported as needing the bridge, not as zero; islandsOfNet still answers", async () => {
    const { inspect } = await tooNew();
    const result = await inspect({ kinds: ["components", "tracks", "unrouted"], islandsOfNet: ["GND"] });
    const json = result.json as any;
    expect(json.results.unrouted).toBeUndefined();
    expect(json.source.kinds).toEqual(["components", "tracks", "islandsOfNet"]);
    expect(json.source.unavailable.unrouted).toContain("ratsnest");
    expect(result.text).toContain("unrouted: not available:");
    expect(json.results.tracks.rows.map((t: any) => t.kind)).toEqual(["Track", "Arc", "Via"]);
    // R1.2 and J1.1 are joined by the GND segment
    const joined = (json.islands as any[]).find((i) => i.pads.length === 2);
    expect(joined.pads.map((p: any) => `${p.component}.${p.number}`).sort()).toEqual(["J1.1", "R1.2"]);
  });

  test("any other bridge error still fails the call", async () => {
    const { inspect } = await setup(async () => {
      throw new Error("FabPlane PCB bridge 502 on /sessions: socket connection was closed by peer");
    });
    await expect(inspect({ kinds: ["components"] })).rejects.toThrow(/closed by peer/);
  });

  test("a bridge that loads the board is used as before, with no file source", async () => {
    const { inspect } = await setup(async (select) =>
      select === "components" ? [{ ref: "R9", x: 1, y: 2, layer: 3 }] : [],
    );
    const json = (await inspect({ kinds: ["components"] })).json as any;
    expect(json.source).toBeUndefined();
    expect(json.results.components.rows).toEqual([{ ref: "R9", x: 1, y: 2, layer: 3 }]);
  });
});

describe("board file rows", () => {
  test("layer names map to the bridge's BoardLayer numbers", () => {
    expect([boardLayerId("F.Cu"), boardLayerId("In2.Cu"), boardLayerId("B.Cu")]).toEqual([3, 5, 34]);
    expect([boardLayerId("F.SilkS"), boardLayerId("Edge.Cuts"), boardLayerId("F.CrtYd")]).toEqual([40, 47, 50]);
    expect([boardLayerId("User.1"), boardLayerId("User.9"), boardLayerId("User.10")]).toEqual([53, 61, 63]);
    expect(boardLayerId("Mystery")).toBe("Mystery");
  });

  test("the pre-10 format's numbered nets resolve to names", () => {
    const rows = boardFileRows(`(kicad_pcb (version 20240108)
      (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal))
      (net 0 "") (net 1 "GND") (net 2 "SIG")
      (footprint "X:Y" (layer "F.Cu") (at 5 5)
        (property "Reference" "U1") (property "Value" "V")
        (pad "1" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 2 "SIG")))
      (segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net 1) (uuid "s"))
      (via blind (at 3 3) (size 0.5) (drill 0.2) (layers "F.Cu" "In1.Cu") (net 2) (uuid "v")))`);
    expect(rows.rows("tracks")![0]).toMatchObject({ net: "GND", length: 1 });
    expect(rows.rows("vias")![0]).toMatchObject({ net: "SIG", layerNames: ["F.Cu", "In1.Cu"] });
    expect(rows.rows("pads")![0]).toMatchObject({ component: "U1", net: "SIG", x: 6, y: 5 });
    expect(rows.rows("nets")).toEqual([
      { name: "GND", code: 1, pads: 0 },
      { name: "SIG", code: 2, pads: 1 },
    ]);
    expect(rows.rows("unrouted")).toBeNull();
  });
});
