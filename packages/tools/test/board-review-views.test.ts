import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createRegistry, type CoreServices } from "../src";
import { ResourceGovernor, setGovernor } from "../src/resources";
import { contextFactory, mockServices, tempProject } from "./mock-services";

// a kicad-cli that plots a layer as a one-path SVG and fails a 3D render
const SCRIPT = `#!/bin/bash
out=""; prev=""
for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
case "$1 $2 $3" in
  "pcb export svg") echo '<svg viewBox="0 0 40 30"><title>t</title><path fill="#000000" d="M0 0"/></svg>' > "$out" ;;
  "pcb render "*) echo "no GL" >&2; exit 1 ;;
esac
exit 0
`;

/** A 40 x 30 board with one connector whose contact pads sit at its -X side (mouth +X at rot 0). */
const board = (ref: string, x: number, rot: number, extra = "") => `(kicad_pcb (version 20250114)
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))
	(footprint "Conn:FFC" (layer "F.Cu") (at ${x} 15 ${rot})
		(property "Reference" "${ref}" (at 0 0)) (property "Value" "FFC" (at 0 0))
		(fp_rect (start -2 -3) (end 2 3) (layer "F.CrtYd"))
		(pad "1" smd rect (at -1.5 -1) (size 0.5 1) (layers "F.Cu") (net "A"))
		(pad "2" smd rect (at -1.5 1) (size 0.5 1) (layers "F.Cu") (net "B")))
	${extra}
)`;

let cli = "";
beforeAll(async () => {
  const d = await mkdtemp(join(tmpdir(), "fake-kicad-"));
  cli = join(d, "kicad-cli");
  await writeFile(cli, SCRIPT);
  await chmod(cli, 0o755);
  setGovernor(new ResourceGovernor(async () => ({ memTotalGiB: 32, memAvailableGiB: 24, swapUsedGiB: 0, load1: 0, cpus: 8, disk: [] })));
});
afterAll(() => setGovernor(null));

async function setup() {
  const project = await tempProject("views");
  await writeFile(join(project.dir, "board.kicad_pcb"), board("J1", 38, 0));
  // the mating board lives beside the project, as in a multi-board product
  await mkdir(join(project.dir, "..", "carrier"), { recursive: true });
  await writeFile(join(project.dir, "..", "carrier", "carrier.kicad_pcb"), board("J2", 2, 180));
  const base = mockServices([project]);
  const services: CoreServices = { ...base, kicad: { ...base.kicad, resolveCli: async () => ({ path: cli, version: "fake" }) } };
  const def = createRegistry().get("board_review")!;
  const ctx = () => contextFactory(services, project)({ def, projectRef: undefined, signal: new AbortController().signal, progress: () => {} } as never);
  const call = async (args: object) => (def.handler as unknown as (a: object, c: unknown) => Promise<{ text: string; json?: Record<string, unknown> }>)(args, await ctx());
  return { project, call };
}

const chassis = {
  frames: {
    near: { basis: "carrier 20 mm right of the board", boards: { C: { pcb: "views/board.kicad_pcb", origin: [0, 0], face_z: { F: 1 } }, R: { pcb: "carrier/carrier.kicad_pcb", origin: [60, 0], face_z: { F: 1.6 } } } },
    far: { basis: "carrier 160 mm away", boards: { C: { pcb: "views/board.kicad_pcb", origin: [0, 0] }, R: { pcb: "carrier/carrier.kicad_pcb", origin: [200, 0] } } },
  },
  cables: [{ id: "ffc", a: ["C", "J1"], b: ["R", "J2"], length_mm: 40, tolerance_mm: 1, basis: "catalog 40 mm" }],
};

describe("board_review cable / page / diff", () => {
  test("cable: every frame, PASS/FAIL, record; boards override; sweep", async () => {
    const { project, call } = await setup();
    await writeFile(join(project.dir, "chassis.json"), JSON.stringify(chassis));
    await expect(call({ action: "cable" })).rejects.toThrow(/needs chassis/);
    const r = await call({ action: "cable", chassis: "chassis.json", root: ".." });
    expect(r.text).toContain("near           ffc      PASS");
    expect(r.text).toContain("far            ffc      FAIL");
    expect(r.text).toContain("2 cable checks, 1 FAIL");
    expect(r.json?.["failed"]).toBe(1);
    const rec = JSON.parse(await readFile(join(project.dir, ".fabdesk/board/review/cable.json"), "utf8"));
    expect(rec.results.near[0].slack_mm).toBe(18.4);
    await writeFile(join(project.dir, "moved.kicad_pcb"), board("J1", 20, 0));
    const o = await call({ action: "cable", chassis: "chassis.json", root: "..", frame: "near", boards: { C: "views/moved.kicad_pcb" } });
    expect(o.text).toContain("J1 mouth is 18.0 mm inside its board edge");
    const s = await call({ action: "cable", chassis: "chassis.json", root: "..", sweep: "C:J1", edge: "right", step: 5, frames: ["near"] });
    expect(s.text).toContain("near:ffc: best slack");
    expect((s.json?.["rows"] as unknown[]).length).toBe(5);
    await writeFile(join(project.dir, "bad.json"), JSON.stringify({ ...chassis, frames: { f: { boards: { C: { pcb: "x.txt", origin: [0, 0] } } } } }));
    await expect(call({ action: "cable", chassis: "bad.json" })).rejects.toThrow(/not a .kicad_pcb/);
    await expect(call({ action: "cable", chassis: "../carrier/carrier.kicad_pcb" })).rejects.toThrow(/outside the project/);
  });

  test("diff: change picture of an earlier board against the project's, HTML + SVG", async () => {
    const { project, call } = await setup();
    await writeFile(join(project.dir, "old.kicad_pcb"), board("J1", 30, 0, `(segment (start 1 1) (end 5 1) (width 0.2) (layer "F.Cu") (net "A"))`));
    const r = await call({ action: "diff", old: "old.kicad_pcb" });
    expect(r.text).toContain("tracks +0/-1, vias +0/-0, parts moved 1, added 0, removed 0");
    expect(r.text).toContain("moved: J1 8 mm");
    const html = await readFile(join(project.dir, ".fabdesk/board/review/change.html"), "utf8");
    expect(html).toContain("old: old.kicad_pcb<br>new: board.kicad_pcb");
    expect(await readFile(join(project.dir, ".fabdesk/board/review/change.svg"), "utf8")).toContain("<style>");
    await expect(call({ action: "diff", old: "old.kicad_pcb", out: "../x.html" })).rejects.toThrow(/outside the project/);
  });

  test("page: plots the boards through kicad-cli into one HTML page; a failed 3D render is a note", async () => {
    const { project, call } = await setup();
    await mkdir(join(project.dir, "cand"), { recursive: true });
    await writeFile(join(project.dir, "cand", "board.kicad_pcb"), board("J1", 30, 0));
    await writeFile(join(project.dir, "cand", "acceptance.drc.json"), JSON.stringify({ unconnected_items: [{ items: [{ description: "Pad 1 [A]", pos: { x: 1, y: 2 } }, { description: "Pad 2 [A]", pos: { x: 3, y: 4 } }] }], violations: [] }));
    const r = await call({ action: "page", compare: ["now=board.kicad_pcb", "cand=cand"], out: "pages/cmp.html", render3d: true, drc: false });
    expect(r.text).toContain("now: 7 layers, 0 open, 0 DRC errors");
    expect(r.text).toContain("cand: 7 layers, 1 open, 0 DRC errors");
    expect(r.text).toContain("3D render (top) failed: no GL");
    const html = await readFile(join(project.dir, "pages/cmp.html"), "utf8");
    const data = JSON.parse(/const BOARDS = (.*);\n/.exec(html)![1]!) as Array<{ label: string; layers: Array<{ z: string }> }>;
    expect(data.map((b) => b.label)).toEqual(["now", "cand"]);
    expect(gunzipSync(Buffer.from(data[0]!.layers[0]!.z, "base64")).toString()).toBe('<path fill="currentColor" d="M0 0"/>');
  });
});
