import { expect, test } from "bun:test";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import type { MechanicalDesign, MechanicalFitReport } from "@fabdesk/protocol";
import type { CadService } from "../src";
import { createRegistry, makeContext } from "../src";
import { mockServices, tempProject } from "./mock-services";
import { importedShellScript } from "../src/tools/cad-fit";
import { joinedEnclosure } from "@fabdesk/kicad/enclosure-solid";
import { enclosureFromDesign } from "@fabdesk/kicad/mechanical-fit";

const pcb =
  '(kicad_pcb (general (thickness 1.6))(gr_rect (start 0 0)(end 40 20)(layer "Edge.Cuts")))';
const planeStl = (z: number) =>
  `solid case\nfacet normal 0 0 1\nouter loop\nvertex -5 -5 ${z}\nvertex 50 -5 ${z}\nvertex -5 50 ${z}\nendloop\nendfacet\nendsolid case`;

test("export rejects a case whose screw mounts exceed the chosen print area", async () => {
  const { invoke, design, project } = await setup();
  design.closure = {
    kind: "screws",
    screwDiameter: 3,
    screwLength: 8,
    pilotDiameter: 2.5,
    clearanceDiameter: 3.4,
    bossDiameter: 8,
  };
  design.layoutLimit = { width: 48, depth: 28 };
  const preview = (await invoke({ action: "preview", design })).json as {
    report: MechanicalFitReport;
    revision: string;
  };
  expect(preview.report.issues.some((i) => i.code === "case-size-limit")).toBe(true);
  expect(preview.report.outsideSize!.width).toBeGreaterThan(48);
  await expect(
    invoke({ action: "build", design, expectedRevision: preview.revision }),
  ).rejects.toThrow("exceeding");
  expect(await readdir(project.dir)).not.toContain("exports");
});

test("coordinated exports include local models and reject a changed model after preview", async () => {
  const { invoke, design, project } = await setup();
  const source = pcb.replace(
    /\)$/,
    '(footprint "test" (property "Reference" "U1") (at 10 10) (model "part.step")))',
  );
  await writeFile(join(project.dir, "board.kicad_pcb"), source);
  await writeFile(join(project.dir, "part.step"), "model first");
  const preview = (await invoke({ action: "preview", design })).json as { revision: string };
  const built = (await invoke({ action: "build", design, expectedRevision: preview.revision }))
    .json as { archive: string };
  const files = unzipSync(await readFile(join(project.dir, built.archive)));
  const dependencies = JSON.parse(strFromU8(files["model-dependencies.json"]!));
  expect(dependencies[0].status).toBe("packaged");
  expect(strFromU8(files[dependencies[0].files[0].path]!)).toBe("model first");
  expect(strFromU8(files["source-boards/board.kicad_pcb"]!)).toBe(source);
  expect(strFromU8(files["boards/board.kicad_pcb"]!)).toContain("${KIPRJMOD}/.fabdesk-models/");
  await writeFile(join(project.dir, "part.step"), "model changed");
  await expect(
    invoke({ action: "build", design, expectedRevision: preview.revision }),
  ).rejects.toThrow(/changed/);
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(source);
});

test("native imported-shell plan carries rounded contours and preserves rectangle compatibility", async () => {
  const { design } = await setup();
  design.openings = [
    { name: "USB-C", wall: "minX", offset: 10, z: 5, width: 10, height: 4, shape: "rounded" },
    { name: "legacy", wall: "maxY", offset: 15, z: 5, width: 10, height: 4 },
  ];
  const script = importedShellScript(design, 'C:/test/quote"case.step', "C:/test/out");
  const encoded = script.match(/^p = json.loads\((.+)\)$/m)![1]!;
  const data = JSON.parse(JSON.parse(encoded));
  expect(data.contours[0].length).toBeGreaterThan(40);
  expect(data.contours[1]).toHaveLength(4);
  expect(script).toContain("Part.Face(Part.makePolygon(pts+[pts[0]])).extrude(direction)");
  expect(data.input).toBe('C:/test/quote"case.step');
});

test("imported preview and export review the modified result, preserve the source, and honor transforms", async () => {
  const { invoke, design, project, services } = await setup();
  design.mode = "imported";
  design.source = { path: "case.stl", scale: 1, position: [0, 0, 3], rotation: [0, 0, 0] };
  const original = planeStl(2);
  await writeFile(join(project.dir, "case.stl"), original);
  const check = (await invoke({ action: "check", design })).json as { report: MechanicalFitReport };
  expect(check.report.issues.some((i) => i.code === "shell-surface")).toBe(true);
  const moved = structuredClone(design);
  moved.source!.position[2] = 30;
  const clear = (await invoke({ action: "check", design: moved })).json as typeof check;
  expect(clear.report.issues.some((i) => i.code === "shell-surface")).toBe(false);
  // This contract stub tests tool plumbing; it does not certify native FreeCAD operations.
  services.cad = {
    status: async () => ({ reachable: true }),
    python: async (_dir: string, script: string) => {
      const encoded = script.match(/^p = json.loads\((.+)\)$/m)![1]!;
      const plan = JSON.parse(JSON.parse(encoded)) as { output: string };
      const closed = await joinedEnclosure(
        enclosureFromDesign({ ...design, mode: "generated", source: null }, []),
      );
      await writeFile(join(plan.output, "case.stl"), closed.baseStl);
      await writeFile(join(plan.output, "case.step"), "contract fixture");
      return { stdout: "", stderr: "" };
    },
  } as CadService;
  const preview = (await invoke({ action: "preview", design })).json as {
    report: MechanicalFitReport;
    revision: string;
  };
  expect(preview.report.issues.some((i) => i.code === "shell-surface")).toBe(false);
  expect(preview.report.issues.some((i) => i.code === "shell-coverage")).toBe(true);
  const built = (await invoke({ action: "build", design, expectedRevision: preview.revision }))
    .json as { archive: string; report: MechanicalFitReport };
  const files = unzipSync(await readFile(join(project.dir, built.archive)));
  expect(JSON.parse(strFromU8(files["fit-review.json"]!))).toEqual(built.report);
  expect(built.report).toEqual(preview.report);
  expect(await readFile(join(project.dir, "case.stl"), "utf8")).toBe(original);
  expect(await readdir(join(project.dir, ".fabdesk/case-preview"))).toEqual([]);
  services.cad.python = async (_dir: string, script: string) => {
    const encoded = script.match(/^p = json.loads\((.+)\)$/m)![1]!;
    const plan = JSON.parse(JSON.parse(encoded)) as { output: string };
    await writeFile(join(plan.output, "case.stl"), planeStl(30));
    await writeFile(join(plan.output, "case.step"), "broken native result");
    return { stdout: "", stderr: "" };
  };
  await expect(invoke({ action: "preview", design })).rejects.toThrow();
  expect(await readFile(join(project.dir, "case.stl"), "utf8")).toBe(original);
});

test("unreadable imported surfaces keep a visible coverage limitation", async () => {
  const { invoke, design, project } = await setup();
  design.mode = "imported";
  design.source = { path: "bad.stl", scale: 1, position: [0, 0, 0], rotation: [0, 0, 0] };
  await writeFile(join(project.dir, "bad.stl"), "broken mesh");
  const result = (await invoke({ action: "check", design })).json as {
    report: MechanicalFitReport;
  };
  expect(result.report.issues.find((i) => i.code === "import-coverage")?.message).toContain(
    "unavailable",
  );
  expect(result.report.issues.some((i) => i.code === "shell-coverage")).toBe(false);
});

test("fit checks identify changed enclosure bytes independently of board placement", async () => {
  const { invoke, design, project } = await setup();
  design.mode = "imported";
  design.source = { path: "case.stl", scale: 1, position: [0, 0, 0], rotation: [0, 0, 0] };
  await writeFile(join(project.dir, "case.stl"), "first mesh");
  const first = (await invoke({ action: "check", design })).json as {
    sourceRevision: string;
    revision: string;
  };
  design.boards[0]!.x = 1;
  const moved = (await invoke({ action: "check", design })).json as typeof first;
  expect(moved.sourceRevision).toBe(first.sourceRevision);
  expect(moved.revision).not.toBe(first.revision);
  await writeFile(join(project.dir, "case.stl"), "changed mesh");
  const changed = (await invoke({ action: "check", design })).json as typeof first;
  expect(changed.sourceRevision).not.toBe(first.sourceRevision);
  expect(changed.revision).not.toBe(moved.revision);
  expect(changed.sourceRevision).toBe(createHash("sha256").update("changed mesh").digest("hex"));
});
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
test("fast shape preview is explicitly unverified and cannot authorize an export", async () => {
  const { invoke, design, services } = await setup();
  design.detailedFit = true;
  let exporterCalled = false;
  services.kicad.resolveCli = async () => {
    exporterCalled = true;
    return null;
  };
  const result = (await invoke({ action: "preview_shape", design })).json as {
    verificationPending: boolean;
    revision?: string;
    meshes: { base: string };
    report: MechanicalFitReport;
  };
  expect(exporterCalled).toBe(false);
  expect(result.verificationPending).toBe(true);
  expect(result.revision).toBeUndefined();
  expect(result.meshes.base.length).toBeGreaterThan(0);
  expect(result.report.issues.some((i) => i.code === "verification-pending")).toBe(true);
  await expect(invoke({ action: "build", design })).rejects.toThrow(/Preview again/);
  await invoke({ action: "preview", design });
  expect(exporterCalled).toBe(true);
});

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

test("native preflight rejects overlapping new holes, mixed edits and an outline outside the enclosure", async () => {
  const { invoke, design, project } = await setup();
  const expectedPcbRevision = createHash("sha256").update(pcb).digest("hex");
  const edit = (change: unknown) =>
    invoke({ action: "edit_board", design, expectedPcbRevision, edit: change });
  await expect(
    edit({
      holes: [
        { x: 10, y: 10, diameter: 3 },
        { x: 11, y: 10, diameter: 3 },
      ],
    }),
  ).rejects.toThrow("overlap each other");
  const outline = [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 20 },
    { x: 0, y: 20 },
  ];
  await expect(edit({ outline, holes: [{ x: 10, y: 10, diameter: 3 }] })).rejects.toThrow(
    "separately",
  );
  await expect(edit({ outline })).rejects.toThrow("usable space");
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(pcb);
});

test("component moves respect other boards and holes require a known rectangular boundary", async () => {
  const { invoke, design, project } = await setup();
  const populated =
    pcb.slice(0, -1) +
    '(footprint "R_0402" (layer "F.Cu")(at 10 10)(property "Reference" "R1")(fp_rect (start -1 -1)(end 1 1)(layer "F.CrtYd"))))';
  await writeFile(join(project.dir, "board.kicad_pcb"), populated);
  await writeFile(join(project.dir, "other.kicad_pcb"), pcb);
  design.space.width = 100;
  design.boards.push({ path: "other.kicad_pcb", x: 20, y: 0, z: 5, rotation: 0 });
  await expect(
    invoke({
      action: "edit_board",
      design,
      expectedPcbRevision: createHash("sha256").update(populated).digest("hex"),
      edit: { footprints: [{ reference: "R1", position: { x: 21, y: 10 } }] },
    }),
  ).rejects.toThrow("overlap other.kicad_pcb");
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(populated);
  const irregular =
    '(kicad_pcb (general (thickness 1.6))(gr_poly (pts (xy 0 0)(xy 40 0)(xy 0 20))(layer "Edge.Cuts")))';
  await writeFile(join(project.dir, "board.kicad_pcb"), irregular);
  await expect(
    invoke({
      action: "edit_board",
      design,
      expectedPcbRevision: createHash("sha256").update(irregular).digest("hex"),
      edit: { holes: [{ x: 30, y: 15, diameter: 3 }] },
    }),
  ).rejects.toThrow("non-rectangular outline");
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(irregular);
});

test("component moves reject off-board anchors and same-side component overlap before native writes", async () => {
  const { invoke, design, project } = await setup();
  const populated =
    pcb.slice(0, -1) +
    '(footprint "R_0402" (layer "F.Cu")(at 10 10)(property "Reference" "R1")(fp_rect (start -1 -1)(end 1 1)(layer "F.CrtYd")))' +
    '(footprint "R_0402" (layer "F.Cu")(at 20 10)(property "Reference" "R2")(fp_rect (start -1 -1)(end 1 1)(layer "F.CrtYd"))))';
  await writeFile(join(project.dir, "board.kicad_pcb"), populated);
  design.space.width = 100;
  const move = (x: number) =>
    invoke({
      action: "edit_board",
      design,
      expectedPcbRevision: createHash("sha256").update(populated).digest("hex"),
      edit: { footprints: [{ reference: "R1", position: { x, y: 10 } }] },
    });
  await expect(move(45)).rejects.toThrow("outside the PCB bounds");
  await expect(move(20)).rejects.toThrow("overlap another component envelope");
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(populated);
});
