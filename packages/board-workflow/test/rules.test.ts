/** The acceptance's rules applied to a project before it is judged (toolkit apply_netclasses.py): edit scoring, bench scoring, release. */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { release, applyProjectRules, type Acceptance } from "../src/index";
import { withProjectRules } from "../src/edit/index";

const board = (body: string, outline: [number, number, number, number] = [0, 0, 20, 10]) =>
  `(kicad_pcb (version 20250114) (generator "test")\n  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))${body}\n  (gr_rect (start ${outline[0]} ${outline[1]}) (end ${outline[2]} ${outline[3]}) (layer "Edge.Cuts"))\n)\n`;

const acceptance = (classes: Acceptance["net_classes"]["classes"], native = false): Acceptance =>
  ({
    schema: "TEST",
    manufacturing_rules: {
      adopted: { min_track_width: 0.1, min_clearance: 0.1, default_class: { track_width: 0.2, clearance: 0.15, via_diameter: 0.5, via_drill: 0.25 } },
      scoped_rules: [],
      basis: "",
      native_project_rules: native,
      native_project_rules_basis: "",
    },
    stack_policy: { copper_layers: ["F.Cu", "In1.Cu", "B.Cu"], plane_layers: [], ground_net: "GND", via_spans: { through: ["F.Cu", "B.Cu"] } },
    net_classes: { tap_rule: "", tap_pads: {}, neck_allowance: "", class_clearance: 0.15, router_width_rules: { neck_floor_mm: 0.1 }, classes },
  }) as unknown as Acceptance;

describe("acceptance rules before judging (apply_netclasses)", () => {
  async function project(native: boolean) {
    const dir = await mkdtemp(join(tmpdir(), "rules-"));
    await writeFile(join(dir, "b.kicad_pcb"), board(""));
    await writeFile(join(dir, "b.kicad_pro"), JSON.stringify({ board: { design_settings: { rules: { min_track_width: 0.2 } } }, net_settings: { classes: [] } }, null, 2) + "\n");
    const req = join(dir, ".fabdesk", "board", "requirements");
    await mkdir(req, { recursive: true });
    const acc = acceptance({ PWR_600: { track_width: 0.6, inner_track_width: null, nets: ["VIN"] } }, native);
    for (const [f, v] of Object.entries({ "acceptance.json": acc, "circuit.json": { components: [] }, "mechanical.json": { anchors: [] }, "heights.json": { entries: [] } })) await writeFile(join(req, f), JSON.stringify(v));
    return dir;
  }
  test("a bare board's project gets the classes and rules once; a second run writes nothing", async () => {
    const dir = await project(false);
    const r1 = await applyProjectRules(dir, "b.kicad_pcb");
    expect(r1?.changed).toBe(true);
    const pro = JSON.parse(await readFile(join(dir, "b.kicad_pro"), "utf8"));
    expect(pro.net_settings.netclass_patterns).toEqual([{ netclass: "PWR_600", pattern: "VIN" }]);
    expect(pro.board.design_settings.rules.min_track_width).toBe(0.1);
    expect(await readFile(join(dir, "b.kicad_dru"), "utf8")).toContain('(rule "PWR_600 outer only"');
    const t = (await stat(join(dir, "b.kicad_pro"))).mtimeMs;
    const r2 = await applyProjectRules(dir, "b.kicad_pcb");
    expect(r2).toEqual({ changed: false, text: expect.stringContaining("already applied") });
    expect((await stat(join(dir, "b.kicad_pro"))).mtimeMs).toBe(t);
  });
  test("native project rules are left alone; no project file or requirements is nothing to apply", async () => {
    const dir = await project(true);
    const before = await readFile(join(dir, "b.kicad_pro"), "utf8");
    expect(await applyProjectRules(dir, "b.kicad_pcb")).toEqual({ changed: false, text: "native project rules kept (b.kicad_pro)" });
    expect(await readFile(join(dir, "b.kicad_pro"), "utf8")).toBe(before);
    expect(await applyProjectRules(dir, "none.kicad_pcb")).toBeNull();
  });
  test("edit scoring applies the rules to the folder it scores before A1-A9", async () => {
    const dir = await project(false);
    let seen = "";
    const runners = withProjectRules({ accept: async (d) => ((seen = await readFile(join(d, "b.kicad_pro"), "utf8")), null as never) });
    await runners.accept(dir, "b.kicad_pcb");
    expect(seen).toContain("PWR_600");
  });
  test("a release STOPs when applying the rules changed the project (the design the review saw)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fab-rules-"));
    await writeFile(join(dir, "b.kicad_pcb"), board(""));
    const calls: string[] = [];
    const inp = {
      project: dir, stem: "b", pcb: join(dir, "b.kicad_pcb"), schematic: null, out: join(dir, "pkg"), cli: { path: "x", version: "" },
      gates: {
        review: async () => (calls.push("review"), { state: "pass" as const }),
        rules: async () => (calls.push("rules"), { changed: true, text: "3 classes" }),
        acceptance: async () => (calls.push("acceptance"), { summary: {} }),
      },
    } as Parameters<typeof release.releaseFab>[0];
    const e = (await release.releaseFab(inp).catch((x) => x)) as release.ReleaseStop;
    expect(e.gate).toBe("acceptance");
    expect(e.message).toContain("run board_review again");
    expect(calls).toEqual(["review", "rules"]);
  });
});
