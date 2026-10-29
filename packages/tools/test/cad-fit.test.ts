import { expect, test } from "bun:test";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import type { MechanicalDesign } from "@fabdesk/protocol";
import { createRegistry, makeContext } from "../src";
import { mockServices, tempProject } from "./mock-services";
import { importedShellScript } from "../src/tools/cad-fit";

const pcb =
  '(kicad_pcb (general (thickness 1.6))(gr_rect (start 0 0)(end 40 20)(layer "Edge.Cuts")))';
async function setup() {
  const project = await tempProject("fit");
  await writeFile(join(project.dir, "board.kicad_pcb"), pcb);
  const services = mockServices([project]);
  const registry = createRegistry();
  const invoke = (args: Record<string, unknown>) =>
    registry.invoke("cad_fit", { project: project.id, ...args }, () =>
      makeContext({ services, project }),
    );
  const design: MechanicalDesign = {
    version: 1,
    mode: "generated",
    confirmed: true,
    source: null,
    space: {
      x: -2,
      y: -2,
      width: 44,
      depth: 24,
      height: 20,
      wall: 2,
      floor: 2,
      lid: 2,
      clearance: 1,
    },
    boards: [{ path: "board.kicad_pcb", x: 0, y: 0, z: 5, rotation: 0 }],
    mounts: [],
    openings: [],
    obstacles: [],
  };
  return { project, services, invoke, design };
}
test("preview leaves designs untouched; ZIP includes matching source hashes and rejects stale PCB", async () => {
  const { invoke, design, project } = await setup();
  const before = await readdir(project.dir);
  const p = await invoke({ action: "preview", design });
  const preview = p.json as { revision: string };
  expect(await readdir(project.dir)).toEqual(before);
  const b = await invoke({ action: "build", design, expectedRevision: preview.revision });
  const result = b.json as { archive: string };
  const zip = unzipSync(await readFile(join(project.dir, result.archive)));
  expect(strFromU8(zip["boards/board.kicad_pcb"]!)).toBe(pcb);
  const manifest = JSON.parse(strFromU8(zip["manifest.json"]!));
  for (const [name, hash] of Object.entries(manifest.files))
    expect(createHash("sha256").update(zip[name]!).digest("hex")).toBe(hash);
  expect(zip["case.stl"]).toBeDefined();
  expect(zip["lid.stl"]).toBeDefined();
  expect(zip["case.step"]).toBeDefined();
  await writeFile(join(project.dir, "board.kicad_pcb"), pcb + "\n");
  await expect(
    invoke({ action: "build", design, expectedRevision: preview.revision }),
  ).rejects.toThrow(/changed/);
});
test("save requires current settings revision and build blocks collisions", async () => {
  const { invoke, design } = await setup();
  const saved = await invoke({ action: "save", design, expectedDesignRevision: null });
  await expect(invoke({ action: "save", design, expectedDesignRevision: null })).rejects.toThrow(
    /changed/,
  );
  design.obstacles = [{ name: "battery", x: 0, y: 0, z: 5, width: 10, depth: 10, height: 10 }];
  const p = await invoke({ action: "preview", design });
  const r = p.json as { revision: string; report: { status: string } };
  expect(r.report.status).toBe("blocked");
  await expect(invoke({ action: "build", design, expectedRevision: r.revision })).rejects.toThrow(
    /Saved enclosure settings differ/,
  );
  await invoke({
    action: "save",
    design,
    expectedDesignRevision: (saved.json as { designRevision: string }).designRevision,
  });
  await expect(invoke({ action: "build", design, expectedRevision: r.revision })).rejects.toThrow(
    /battery/,
  );
});
test("import editing fails honestly without a native bridge and preserves source", async () => {
  const { invoke, design, project } = await setup();
  await writeFile(join(project.dir, "case.stl"), "original");
  design.mode = "imported";
  design.source = { path: "case.stl", scale: 1, position: [0, 0, 0], rotation: [0, 0, 0] };
  await expect(invoke({ action: "preview", design })).rejects.toThrow(/FreeCAD/);
  expect(await readFile(join(project.dir, "case.stl"), "utf8")).toBe("original");
  const script = importedShellScript(design, 'C:/test/quote"case.stl', "C:/test/out");
  expect(script).toContain("shape.cut");
  expect(script).toContain("shape.fuse");
  expect(script).toContain("isSolid");
});
test("actual PCB changes use native transactions and reject stale revisions", async () => {
  const { invoke, design, services } = await setup();
  let edits: unknown;
  services.design.editBoardGeometry = async (_dir, e) => {
    edits = e;
    return {
      created: { graphics: 1 },
      createdIds: [],
      deletedIds: [],
      revision: 1,
      saved: true,
    } as never;
  };
  const hash = createHash("sha256").update(pcb).digest("hex");
  await invoke({
    action: "edit_board",
    design,
    expectedPcbRevision: hash,
    edit: { holes: [{ x: 10, y: 10, diameter: 3 }] },
  });
  expect(edits).toMatchObject({
    graphics: [
      { kind: "circle", layer: 47, center: { x: 10, y: 10 }, radiusPoint: { x: 11.5, y: 10 } },
    ],
  });
  await expect(
    invoke({
      action: "edit_board",
      design,
      expectedPcbRevision: "0".repeat(64),
      edit: { holes: [{ x: 10, y: 10, diameter: 3 }] },
    }),
  ).rejects.toThrow(/changed/);
});
test("outline replacement preserves circular cutouts and uses inspected IDs", async () => {
  const { invoke, design, services } = await setup();
  let edits: unknown;
  const base = await services.design.inspectBoardGeometry("");
  services.design.inspectBoardGeometry = async () => ({
    ...base,
    graphics: [
      { id: "edge", kind: "rectangle", layer: 47, start: { x: 0, y: 0 }, end: { x: 40, y: 20 } },
      { id: "hole", kind: "circle", layer: 47 },
    ],
  });
  services.design.editBoardGeometry = async (_dir, e) => {
    edits = e;
    return {
      created: { graphics: 4 },
      createdIds: [],
      deletedIds: [],
      revision: 1,
      saved: true,
    } as never;
  };
  await invoke({
    action: "edit_board",
    design,
    expectedPcbRevision: createHash("sha256").update(pcb).digest("hex"),
    edit: {
      outline: [
        { x: 0, y: 0 },
        { x: 35, y: 0 },
        { x: 35, y: 18 },
        { x: 0, y: 18 },
      ],
    },
  });
  expect(edits).toMatchObject({ deleteItemIds: ["edge"] });
});
