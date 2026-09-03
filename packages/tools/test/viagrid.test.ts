import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { VIAGRID_9055, VIAGRID_9055_VIAS, checkViagrid9055, createRegistry, isOnViagrid9055Via, viagrid9055Tsx } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const via = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ type: "pcb_via", pcb_via_id: id, x, y, outer_diameter: 0.6, hole_diameter: 0.3, from_layer: "top", to_layer: "bottom", layers: ["top", "bottom"], ...extra });

describe("Viagrid 9055 template", () => {
  test("the grid has 180 vias and the lookup matches only those positions", () => {
    expect(VIAGRID_9055_VIAS).toHaveLength(180);
    expect(new Set(VIAGRID_9055_VIAS.map(([x, y]) => `${x},${y}`)).size).toBe(180);
    expect(isOnViagrid9055Via(19, 0)).toBe(true);
    expect(isOnViagrid9055Via(19.03, -0.02)).toBe(true);
    expect(isOnViagrid9055Via(0, 0)).toBe(false);
    expect(isOnViagrid9055Via(19, 1)).toBe(false);
    // Rows, columns and the two clusters.
    expect(VIAGRID_9055_VIAS.filter(([, y]) => y === 20.5)).toHaveLength(36);
    expect(VIAGRID_9055_VIAS.filter(([x]) => x === -38)).toHaveLength(15);
    expect(VIAGRID_9055_VIAS.filter(([x, y]) => x >= 13 && x <= 25 && Math.abs(y) < 14)).toHaveLength(39);
  });

  test("the generated component marks every via assignable and stays valid JSX", () => {
    const tsx = viagrid9055Tsx();
    expect(tsx).toContain("netIsAssignable");
    expect(tsx).toContain(`export const ${VIAGRID_9055.component}`);
    expect(tsx).toContain('key={"vg" + i}');
    expect(tsx).not.toContain("key={}");
  });

  test("checkViagrid9055 accepts claimed factory vias and flags anything else", () => {
    const ok = checkViagrid9055([via("pcb_via_0", 19, 0, { net_is_assignable: true, net_assigned: true }), via("pcb_via_1", 21, 0, { net_is_assignable: true })]);
    expect(ok.violations).toEqual([]);
    expect(ok.vias).toEqual({ total: 2, factory: 2, claimed: 1, added: 0 });

    const bad = checkViagrid9055([
      via("pcb_via_0", 19, 0, { net_is_assignable: true }),
      via("pcb_via_1", 19, 0), // stacked on the factory via instead of claiming it
      via("pcb_via_2", 4.2, -1.1), // nowhere near the grid
      { type: "pcb_smtpad", pcb_smtpad_id: "s1", x: -38, y: 18, width: 1, height: 1, layer: "top", shape: "rect" },
    ]);
    expect(bad.vias.added).toBe(2);
    expect(bad.violations.map((v) => v.kind)).toEqual(["via_off_grid", "via_off_grid", "pad_near_hole"]);
    expect(bad.violations[0]!.detail).toContain("without claiming");
  });

  test("checkViagrid9055 flags a factory via that two nets touch", () => {
    const wire = (id: string, key: string, layer: string, pts: Array<[number, number]>) => ({
      type: "pcb_trace",
      pcb_trace_id: id,
      subcircuit_connectivity_map_key: key,
      route: pts.map(([x, y]) => ({ route_type: "wire", x, y, width: 0.2, layer })),
    });
    const shorted = checkViagrid9055([
      via("pcb_via_0", 19, 0, { net_is_assignable: true, outer_diameter: 1 }),
      wire("t1", "netA", "top", [[17, 0], [21, 0]]), // runs straight over the via on top
      wire("t2", "netB", "bottom", [[19, -2], [19, 2]]), // and another net under it on the bottom
    ]);
    expect(shorted.violations.map((v) => v.kind)).toEqual(["via_shorts_nets"]);
    expect(shorted.violations[0]!.detail).toContain("netA");
    expect(shorted.violations[0]!.detail).toContain("netB");
    const single = checkViagrid9055([via("pcb_via_0", 19, 0, { net_is_assignable: true, outer_diameter: 1 }), wire("t1", "netA", "top", [[17, 0], [21, 0]])]);
    expect(single.violations).toEqual([]);
  });

  test("project_set_board template=viagrid-9055 writes the blank, fixes the board and verify_viagrid runs", async () => {
    const project = await tempProject("vg");
    // The default placeholder circuit.tsx gets replaced by the starter; a custom one would be kept.
    await Bun.write(join(project.dir, "circuit.tsx"), "// Fabdesk project. Write your board with tscircuit; the agent builds, routes and verifies it.\nexport default () => <board width=\"30mm\" height=\"20mm\" />\n");
    const services = mockServices([project]);
    const reg = createRegistry();
    const factory = contextFactory(services, project);
    const call = (name: string, args: Record<string, unknown>) =>
      reg.invoke(name, args, (ref) => factory({ def: reg.get(name)!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));

    const set = await call("project_set_board", { template: "viagrid-9055" });
    expect(set.isError ?? false).toBe(false);
    expect(project.manifest().board).toMatchObject({ layers: 2, widthMm: 90, heightMm: 55, template: "viagrid-9055", rules: { traceWidthMm: 0.2, clearanceMm: 0.2 } });
    expect(await readFile(join(project.dir, VIAGRID_9055.file), "utf8")).toContain("Viagrid9055Blank");
    expect(await readFile(join(project.dir, "circuit.tsx"), "utf8")).toContain("<Viagrid9055Blank />");

    await Bun.write(join(project.dir, "circuit.routed.json"), JSON.stringify([via("pcb_via_0", 19, 0, { net_is_assignable: true, net_assigned: true }), via("pcb_via_1", 1, 1)]));
    const verify = await call("verify_viagrid", {});
    expect(verify.isError).toBe(true);
    expect(verify.text).toContain("1 violation");
    expect(await Bun.file(join(project.dir, "reports", "viagrid.json")).exists()).toBe(true);

    const cleared = await call("project_set_board", { template: "none" });
    expect(cleared.isError ?? false).toBe(false);
    expect(project.manifest().board.template).toBeUndefined();
  });
});
