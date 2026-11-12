import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, type CoreServices } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const BOARD = `(kicad_pcb (version 20250114)
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))
	(footprint "L:J1" (layer "F.Cu") (at 5 5) (property "Reference" "J1") (property "Value" "x")
		(pad "1" smd rect (at 0 0) (size 0.4 0.4) (layers "F.Cu") (net "USB_DP"))
		(pad "2" smd rect (at 0 0.9) (size 0.4 0.4) (layers "F.Cu") (net "USB_DN")))
	(footprint "L:U1" (layer "F.Cu") (at 25 5) (property "Reference" "U1") (property "Value" "y")
		(pad "1" smd rect (at 0 0) (size 0.4 0.4) (layers "F.Cu") (net "USB_DP"))
		(pad "2" smd rect (at 0 0.9) (size 0.4 0.4) (layers "F.Cu") (net "USB_DN")))
	(segment (start 5 5) (end 25 5) (width 0.15) (layer "F.Cu") (net "USB_DP") (uuid "a1b2c3d4-0000-4000-8000-000000000001"))
	(segment (start 5 5.9) (end 25 5.9) (width 0.15) (layer "F.Cu") (net "USB_DN") (uuid "a1b2c3d4-0000-4000-8000-000000000002"))
)`;
const PRO = JSON.stringify({
  net_settings: {
    classes: [{ name: "Default", track_width: 0.15, clearance: 0.13 }, { name: "USB", track_width: 0.15, diff_pair_width: 0.15, diff_pair_gap: 0.2 }],
    netclass_patterns: [{ pattern: "USB_*", netclass: "USB" }],
  },
  board: { design_settings: { rules: { min_track_width: 0.1, min_clearance: 0.1 } } },
});

async function setup() {
  const project = await tempProject("lm");
  await writeFile(join(project.dir, "board.kicad_pcb"), BOARD);
  await writeFile(join(project.dir, "board.kicad_pro"), PRO);
  const services: CoreServices = mockServices([project]);
  const def = createRegistry().get("board_lastmile")!;
  const call = async (args: Record<string, unknown>) => {
    const ctx = await contextFactory(services, project)({ def, projectRef: undefined, signal: new AbortController().signal, progress: () => {} } as never);
    return def.handler({ ws: "main", why: true, side: "both", router: "fab_router", noAccept: false, slackA8: 0, maxRounds: 6, adopt: true, ...args } as never, ctx);
  };
  return { project, call };
}

describe("board_lastmile", () => {
  test("is a board-toolset tool with one action input", () => {
    const def = createRegistry().get("board_lastmile")!;
    expect(def.toolset).toBe("board");
    expect(def.name).toBe("board_lastmile");
  });

  test("new, pairs --why, try tighten (pair copper only), status, accept refused at the start, undo", async () => {
    const { project, call } = await setup();
    const n = await call({ action: "new" });
    expect(n.text).toContain("open 0");
    const m = await call({ action: "pairs" });
    expect(m.text).toContain("USB_DP / USB_DN");
    expect(m.text).toContain("share 0.00");
    const t = await call({ action: "try", actions: ["tighten"] });
    expect(t.text).toContain("ACCEPT");
    expect((t.json as { accepted: string }).accepted).toBe("tighten");
    const after = await call({ action: "pairs", why: false });
    expect(after.text).toMatch(/share (0\.9\d|1\.00)/); // tightened to the class spacing (jogs at the pads stay uncoupled)
    expect((await call({ action: "status" })).text).toContain("step 1 of 1");
    expect((await call({ action: "undo" })).text).toContain("step 0");
    await expect(call({ action: "undo" })).rejects.toThrow(/at the start board/);
    await expect(call({ action: "accept" })).rejects.toThrow(/nothing accepted yet/);
    // the project's own board is untouched by any of this
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(BOARD);
  });

  test("fit says what it needs; view writes an SVG; unknown action names list the vocabulary", async () => {
    const { call } = await setup();
    await call({ action: "new" });
    await expect(call({ action: "fit" })).rejects.toThrow(/placement helper/);
    const v = await call({ action: "view", box: [0, 0, 40, 30] });
    expect(String(v.text)).toMatch(/\.(svg|png)$/);
    await expect(call({ action: "try", actions: ["bogus"] })).rejects.toThrow(/unknown action 'bogus'/);
    const i = await call({ action: "info", items: ["J1", "^USB_DP$"] });
    expect(i.text).toContain("J1  x  at 5.00,5.00");
    expect(i.text).toContain("USB_DP  total 20.00 mm");
  });
});
