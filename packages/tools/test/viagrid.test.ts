import { describe, expect, test } from "bun:test";
import {
  VIAGRID_9055,
  VIAGRID_9055_HOLES,
  VIAGRID_9055_VIAS,
  boardToViagrid,
  checkViagrid9055,
  createRegistry,
  isOnViagrid9055Via,
  viagrid9055BoardSpec,
  viagridToBoard,
} from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

/** A via in the board frame, from a blank-frame position. */
const factoryVia = (x: number, y: number, net = "", id?: string) => {
  const [bx, by] = viagridToBoard(x, y);
  return { x: bx, y: by, net, ...(id ? { id } : {}) };
};
const allFactoryVias = (claimed: Array<[number, number, string]> = []) =>
  VIAGRID_9055_VIAS.map(([x, y], i) => factoryVia(x, y, claimed.find(([cx, cy]) => cx === x && cy === y)?.[2] ?? "", `v${i}`));

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

  test("the frames round-trip: blank centre/+y up <-> board top-left/+y down", () => {
    expect(viagridToBoard(0, 0)).toEqual([45, 27.5]);
    expect(viagridToBoard(-38, 20.5)).toEqual([7, 7]);
    expect(viagridToBoard(38.75, -18.25)).toEqual([83.75, 45.75]);
    expect(boardToViagrid(7, 7)).toEqual([-38, 20.5]);
    for (const [x, y] of VIAGRID_9055_VIAS) expect(boardToViagrid(...viagridToBoard(x, y))).toEqual([x, y]);
  });

  test("the board spec carries the blank: outline, 180 free vias, 4 holes and the rules, all inside the outline", () => {
    const spec = viagrid9055BoardSpec();
    expect(spec).toMatchObject({ widthMm: 90, heightMm: 55, copperLayers: 2, rules: { clearanceMm: 0.2, trackWidthMm: 0.2, viaDiameterMm: 1, viaDrillMm: 0.2 } });
    expect(spec.vias).toHaveLength(180);
    expect(spec.holes).toHaveLength(VIAGRID_9055_HOLES.length);
    for (const v of spec.vias!) {
      expect(v.x).toBeGreaterThan(0);
      expect(v.x).toBeLessThan(90);
      expect(v.y).toBeGreaterThan(0);
      expect(v.y).toBeLessThan(55);
      expect(v).toMatchObject({ diameterMm: VIAGRID_9055.viaPadMm, drillMm: VIAGRID_9055.viaDrillMm });
    }
    expect(spec.holes![0]).toMatchObject({ diameterMm: 3.5 });
  });

  test("checkViagrid9055 accepts a complete blank with claimed vias and flags anything else", () => {
    const ok = checkViagrid9055({ vias: allFactoryVias([[19, 0, "N1"]]), pads: [] });
    expect(ok.violations).toEqual([]);
    expect(ok.vias).toEqual({ total: 180, factory: 180, claimed: 1, added: 0 });

    const bad = checkViagrid9055({
      vias: [...allFactoryVias(), factoryVia(19, 0, "N1", "stacked"), factoryVia(4.2, -1.1, "N2", "loose")],
      pads: [{ ...factoryVia(-38, 18), width: 1, height: 1, component: "R1", number: "1" }],
    });
    expect(bad.vias).toEqual({ total: 182, factory: 180, claimed: 0, added: 2 });
    expect(bad.violations.map((v) => v.kind)).toEqual(["via_stacked", "via_off_grid", "pad_near_hole"]);
    expect(bad.violations[0]!.detail).toContain("instead of claiming");
    expect(bad.violations[1]!.detail).toContain("net N2");
  });

  test("checkViagrid9055 reports a board without the blank and uses pad size for the hole keepout", () => {
    const missing = checkViagrid9055({ vias: [], pads: [] });
    expect(missing.violations.map((v) => v.kind)).toEqual(["blank_incomplete"]);
    const wide = checkViagrid9055({ vias: allFactoryVias(), pads: [{ ...factoryVia(-35.5, 18.25), width: 2, height: 1 }] });
    expect(wide.violations.map((v) => v.kind)).toEqual(["pad_near_hole"]);
    const clear = checkViagrid9055({ vias: allFactoryVias(), pads: [{ ...factoryVia(0, 0), width: 2, height: 1 }] });
    expect(clear.violations).toEqual([]);
  });

  test("project_set_board template=viagrid-9055 fixes the board and verify_viagrid reads the design server", async () => {
    const project = await tempProject("vg");
    const services = mockServices([project]);
    const queried: string[] = [];
    services.design = {
      ...services.design,
      query: async (_dir, select) => {
        queried.push(select);
        if (select === "vias") return [...allFactoryVias([[19, 0, "N1"]]), factoryVia(1, 1, "N1", "extra")];
        if (select === "pads") return [{ ...factoryVia(0, 0), width: 1, height: 1, component: "R1", number: "1", net: "N1" }];
        return [];
      },
    };
    const reg = createRegistry();
    const factory = contextFactory(services, project);
    const call = (name: string, args: Record<string, unknown>) =>
      reg.invoke(name, args, (ref) => factory({ def: reg.get(name)!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));

    const set = await call("project_set_board", { template: "viagrid-9055" });
    expect(set.isError ?? false).toBe(false);
    expect(project.manifest().board).toMatchObject({ layers: 2, widthMm: 90, heightMm: 55, template: "viagrid-9055", rules: { traceWidthMm: 0.2, clearanceMm: 0.2, viaDiameterMm: 1, viaDrillMm: 0.2 } });
    expect(set.text).toContain("factory-via-free areas");

    const verify = await call("verify_viagrid", {});
    expect(queried.sort()).toEqual(["pads", "vias"]);
    expect(verify.isError).toBe(true);
    expect(verify.text).toContain("1 violation");
    expect(verify.text).toContain("via_off_grid");
    expect(await Bun.file(`${project.dir}/reports/viagrid.json`).exists()).toBe(true);

    const cleared = await call("project_set_board", { template: "none" });
    expect(cleared.isError ?? false).toBe(false);
    expect(project.manifest().board.template).toBeUndefined();
  });
});
